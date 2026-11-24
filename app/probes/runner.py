"""One hourly Globalping round: plan within the remaining budget, measure, store.

Only counts reach the output/logs; targets and response bodies never do.
"""

import ipaddress
import random
import re
import time
from concurrent.futures import CancelledError, ThreadPoolExecutor, as_completed
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import dns.exception
import dns.resolver
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import insert

from app.database.models import (
    EntryProbeRejection,
    EntryProbeResult,
    EntryProbeRun,
    EntryRouteTrace,
)
from app.domain import AssetError
from app.grading import CARRIERS, OVERSEAS, is_peak
from app.probes import globalping, planner
from app.probes.policy import load_policy
from app.probes.pool import ClientPool

BEIJING = ZoneInfo("Asia/Shanghai")
WINDOW = timedelta(days=7)
ANONYMOUS_LIMIT, AUTHENTICATED_LIMIT = 250, 500
RESERVE = 5


def beijing_minute(moment: datetime) -> int:
    local = moment.astimezone(BEIJING)
    return local.hour * 60 + local.minute


def excluded_ips(settings) -> set[str]:
    """Keep deployment endpoints out of public measurements."""
    configured = re.split(r"[,\s]+", settings.probe_excluded_ips.get_secret_value().strip())
    host = settings.nodema_postgres_ssh_host.get_secret_value().strip()
    try:
        excluded = {str(ipaddress.ip_address(value)) for value in configured if value}
        if host:
            try:
                excluded.add(str(ipaddress.ip_address(host)))
            except ValueError:
                excluded.update(r.address for r in dns.resolver.resolve(host, "A", lifetime=3))
    except (ValueError, dns.exception.DNSException):
        raise AssetError("INVALID_PROBE_EXCLUSIONS") from None
    return excluded


def load_nodes(
    session, fresh_hours: int, coverage: str, excluded=frozenset()
) -> list[planner.EntryNode]:
    """Distinct entries with a single attributable IPv4 address and node counts."""
    scope = (
        " AND n.id IN (SELECT m.node_id FROM export_members m"
        " JOIN export_artifacts e ON e.id=m.export_id"
        " WHERE e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at>now()))"
        if coverage == "EXPORTS"
        else ""
    )
    rows = session.execute(
        sa.text(
            "SELECT n.protocol,n.server_port,c.entry_asn,"
            " CASE WHEN jsonb_array_length(t.entry_ips)=1 THEN t.entry_ips->>0 END ip,count(*) n,"
            " bool_or(EXISTS(SELECT 1 FROM export_members m"
            "   JOIN export_artifacts e ON e.id=m.export_id"
            "   WHERE m.node_id=n.id AND e.revoked_at IS NULL"
            "   AND (e.expires_at IS NULL OR e.expires_at>now()))) exported"
            " FROM nodes n JOIN node_current_status c ON c.node_id=n.id"
            " JOIN test_results t ON t.id=c.last_result_id"
            " WHERE n.enabled AND c.status IN ('UP','DEGRADED')"
            " AND c.last_checked_at>now()-make_interval(hours=>:fresh)"
            " AND NOT coalesce(c.last_exit_asn,-1)=ANY(CAST(:excluded AS bigint[]))"
            + scope
            + " GROUP BY 1,2,3,4"
        ),
        {"fresh": fresh_hours, "excluded": sorted(planner.EXCLUDED_EXIT_ASNS)},
    )
    entries = []
    for row in rows:
        ip = planner.ipv4([row.ip]) if row.ip else None
        if ip in excluded:
            continue
        entries.extend(
            planner.EntryNode(None, row.protocol, ip, row.server_port, row.entry_asn, row.exported)
            for _ in range(min(row.n, 50))
        )
    return entries


HISTORY_SQL = """
WITH q AS (
  SELECT prefix,vantage,peak,
    count(DISTINCT coalesce(probe_asn::text,'')||'|'||coalesce(probe_city,'')) probes,
    max(measured_at) last,sum(sent) sent,sum(received) received,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY rtt_avg) FILTER (WHERE received>0) rtt
  FROM entry_probe_results WHERE purpose='QUALITY' AND measured_at>:since GROUP BY 1,2,3
)
SELECT prefix,
  CASE WHEN count(*) FILTER (WHERE peak AND vantage LIKE 'CN-%')<3 THEN 0
    ELSE min(probes) FILTER (WHERE peak AND vantage LIKE 'CN-%') END peak_probes,
  CASE WHEN count(*) FILTER (WHERE peak AND vantage LIKE 'CN-%')=3
    THEN min(last) FILTER (WHERE peak AND vantage LIKE 'CN-%') END last_peak,
  CASE WHEN count(*) FILTER (WHERE NOT peak AND vantage LIKE 'CN-%')=3
    THEN min(last) FILTER (WHERE NOT peak AND vantage LIKE 'CN-%') END last_idle,
  max(last) FILTER (WHERE vantage='HK') last_hk,
  max(last) FILTER (WHERE vantage='SG') last_sg,
  max(last) FILTER (WHERE vantage='GB') last_gb,
  max(probes) FILTER (WHERE vantage='HK') probes_hk,
  max(probes) FILTER (WHERE vantage='SG') probes_sg,
  max(probes) FILTER (WHERE vantage='GB') probes_gb,
  array_agg(vantage) FILTER (WHERE probes>=:min_probes AND sent>0
    AND (peak OR vantage IN ('HK','SG','GB'))
    AND rtt<=CASE WHEN vantage LIKE 'CN-%' THEN :cn_a_rtt ELSE :overseas_a_rtt END
    AND (1-received::float/sent)*100<=CASE WHEN vantage LIKE 'CN-%'
        THEN :cn_a_loss ELSE :overseas_a_loss END) AS likely_high,
  bool_or(NOT peak AND vantage LIKE 'CN-%' AND probes>=:min_probes AND (rtt IS NULL OR rtt>:rtt
    OR (sent>0 AND (1-received::float/sent)*100>:loss))) poor
FROM (SELECT prefix,vantage,bool_or(peak) peak,min(probes) probes,max(last) last,
        sum(sent) sent,sum(received) received,max(rtt) rtt
      FROM q GROUP BY prefix,vantage,
        CASE WHEN vantage IN ('HK','SG','GB') THEN false ELSE peak END) x
GROUP BY prefix
"""
TARGETS_SQL = """
SELECT target,max(measured_at) FILTER (WHERE purpose='REACH') last,
  count(*)>=2 AND bool_and(received=0)
    AND count(DISTINCT date_trunc('hour',measured_at))>=2
    AND count(DISTINCT coalesce(probe_asn::text,'')||'|'||coalesce(probe_city,''))>=2 dead
FROM entry_probe_results WHERE measured_at>:since GROUP BY target
HAVING max(measured_at) FILTER (WHERE purpose='REACH') IS NOT NULL
  OR (count(*)>=2 AND bool_and(received=0))
"""
ENDPOINTS_SQL = """
SELECT target,vantage,(vantage LIKE 'CN-%' AND peak) AS peak_period,
  count(DISTINCT (probe_asn,probe_city)) FILTER (WHERE received>0) probes,
  count(DISTINCT (measured_at AT TIME ZONE 'Asia/Shanghai')::date)
    FILTER (WHERE received>0) days,
  max(measured_at) last,
  max(measured_at) FILTER (WHERE received>0) success,
  max(measured_at) FILTER (WHERE received=0) failure
FROM entry_probe_results WHERE purpose='QUALITY' AND protocol='TCP' AND measured_at>:since
GROUP BY 1,2,3
"""


def load_history(session, policy: dict, *, now=None) -> planner.History:
    since = (now or datetime.now(UTC)) - WINDOW
    limits = policy["bands"]["CN"]["B"]
    peak_probes, last_peak, last_idle, last_overseas, overseas_probes, poor = (
        {},
        {},
        {},
        {},
        {},
        set(),
    )
    likely_high = set()
    for row in session.execute(
        sa.text(HISTORY_SQL),
        {
            "since": since,
            "min_probes": policy["min_probes"],
            "rtt": limits["rtt_ms"],
            "loss": limits["loss_pct"],
            "cn_a_rtt": policy["bands"]["CN"]["A"]["rtt_ms"],
            "cn_a_loss": policy["bands"]["CN"]["A"]["loss_pct"],
            "overseas_a_rtt": policy["bands"]["OVERSEAS"]["A"]["rtt_ms"],
            "overseas_a_loss": policy["bands"]["OVERSEAS"]["A"]["loss_pct"],
        },
    ):
        peak_probes[row.prefix] = row.peak_probes or 0
        last_peak[row.prefix] = row.last_peak
        last_idle[row.prefix] = row.last_idle
        for region in OVERSEAS:
            last_overseas[(row.prefix, region)] = getattr(row, "last_" + region.lower())
            overseas_probes[(row.prefix, region)] = getattr(row, "probes_" + region.lower()) or 0
        if row.poor:
            poor.add(row.prefix)
        likely_high.update((row.prefix, v) for v in row.likely_high or [])
    last_reach, dead = {}, set()
    for row in session.execute(sa.text(TARGETS_SQL), {"since": since}):
        if row.last:
            last_reach[row.target] = row.last
        if row.dead:
            dead.add(row.target)
    traces = {
        row.prefix: row.oldest
        for row in session.execute(
            sa.text(
                "SELECT prefix,CASE WHEN count(*)=3 THEN min(measured_at) END oldest"
                " FROM entry_route_traces GROUP BY prefix"
            )
        )
    }
    return planner.History(
        peak_probes=peak_probes,
        last_peak=last_peak,
        last_idle=last_idle,
        last_overseas=last_overseas,
        overseas_probes=overseas_probes,
        blocked=frozenset(
            session.scalars(
                sa.select(EntryProbeRejection.ip).where(
                    EntryProbeRejection.retry_after > sa.func.now()
                )
            )
        ),
        idle_poor=frozenset(poor),
        last_reach=last_reach,
        dead=frozenset(dead),
        last_trace=traces,
        likely_high=frozenset(likely_high),
        endpoints={
            (r.target, r.vantage, r.peak_period): planner.EndpointHistory(
                r.probes, r.days, r.last, r.success, r.failure
            )
            for r in session.execute(sa.text(ENDPOINTS_SQL), {"since": since})
        },
    )


def carrier_asns(probes: list[globalping.Probe]) -> tuple[dict[str, list[int]], dict[str, int]]:
    carriers: dict[str, set[int]] = {c: set() for c in CARRIERS}
    counts = {c: 0 for c in (*CARRIERS, *OVERSEAS)}
    for probe in probes:
        vantage = planner.vantage_of(probe.country, probe.asn, probe.network)
        if vantage in CARRIERS:
            if "eyeball-network" in probe.tags and probe.asn:
                carriers[vantage].add(probe.asn)
                counts[vantage] += 1
        elif vantage:
            counts[vantage] += 1
    return {c: sorted(v) for c, v in carriers.items()}, counts


def _measure(
    client: globalping.Client | ClientPool, task: planner.Task
) -> tuple[planner.Task, str, list]:
    request = task.request()
    try:
        identifier = client.create(request)
    except globalping.ApiError as error:
        # No home-broadband probe online in HK/SG right now: any probe there will do.
        if task.kind != "QUALITY_OVERSEAS" or error.code != "HTTP_422":
            raise
        request["locations"] = [
            {"country": item["country"], "limit": item["limit"]} for item in request["locations"]
        ]
        identifier = client.create(request)
    return task, identifier, client.wait(identifier)


def _rows(task: planner.Task, identifier: str, results: list, peak: bool, measured_at: datetime):
    pings, traces = [], []
    for result in results:
        if task.kind == "TRACE":
            outcome = globalping.parse_trace(result, task.ip)
            vantage = outcome and planner.vantage_of(
                outcome.probe.country, outcome.probe.asn, outcome.probe.network
            )
            if outcome and vantage in CARRIERS:
                traces.append(
                    {
                        "prefix": task.prefix,
                        "vantage": vantage,
                        "measured_at": measured_at,
                        "probe_asn": outcome.probe.asn,
                        "probe_city": outcome.probe.city,
                        "hop_asns": list(outcome.hop_asns),
                        "reached": outcome.reached,
                        "measurement_id": identifier,
                    }
                )
            continue
        packets = planner.REACH_PACKETS if task.kind == "REACH" else planner.PING_PACKETS
        outcome = globalping.parse_ping(result, packets)
        if outcome is None:
            continue
        if task.kind == "REACH":
            vantage = "CN" if outcome.probe.country == "CN" else None
        else:
            vantage = planner.vantage_of(
                outcome.probe.country, outcome.probe.asn, outcome.probe.network
            )
        if vantage is None:
            continue
        pings.append(
            {
                "target": task.target,
                "prefix": task.prefix,
                "purpose": "REACH" if task.kind == "REACH" else "QUALITY",
                "vantage": vantage,
                "protocol": task.protocol,
                "peak": peak,
                "measured_at": measured_at,
                "probe_asn": outcome.probe.asn,
                "probe_city": outcome.probe.city,
                "probe_network": outcome.probe.network,
                "sent": outcome.sent,
                "received": outcome.received,
                "rtt_min": outcome.rtt_min,
                "rtt_avg": outcome.rtt_avg,
                "rtt_max": outcome.rtt_max,
                "jitter": outcome.jitter,
                "measurement_id": identifier,
            }
        )
    return pings, traces


def run(
    sessions, settings, *, client: globalping.Client | ClientPool | None = None, clock=None
) -> dict:
    clock = clock or (lambda: datetime.now(UTC))
    with sessions() as session:
        policy = load_policy(session)
    if not policy["probe_enabled"]:
        return {"status": "DISABLED"}
    excluded = excluded_ips(settings)
    if client is None:
        credentials = settings.globalping_credentials()
        clients = [
            globalping.Client(settings.globalping_url, token, settings.probe_timeout_seconds)
            for token in credentials
        ]
        client = (
            ClientPool(clients, reserve=RESERVE, max_tests=settings.probe_max_tests_per_run)
            if clients
            else globalping.Client(settings.globalping_url, timeout=settings.probe_timeout_seconds)
        )
    started = clock()
    summary = {
        "status": "OK",
        "measurements": 0,
        "tests": 0,
        "stored": 0,
        "failed": 0,
        "rate_limited": 0,
        "failed_codes": {},  # error code -> count; never targets
        "failed_kinds": {},  # task kind / transport; never targets
    }
    peak = is_peak(beijing_minute(started), policy)
    run_row = {"peak": peak, "authenticated": client.authenticated}
    try:
        remaining = client.limits()
        if remaining is None:
            remaining = AUTHENTICATED_LIMIT if client.authenticated else ANONYMOUS_LIMIT
        carriers, counts = carrier_asns(client.probes())
        run_row["probes"] = counts
        with sessions() as session:
            nodes = load_nodes(session, settings.freshness_hours, policy["coverage"], excluded)
            history = load_history(session, policy, now=started)
        available = client.available if isinstance(client, ClientPool) else remaining - RESERVE
        budget = max(0, min(available, settings.probe_max_tests_per_run))
        options = dict(
            now=started,
            peak=peak,
            min_probes=policy["min_probes"],
            rng=random.Random(started.timestamp()),
        )
        prefixes = planner.group(nodes)
        confirm_budget = budget // 3
        tasks = planner.plan(prefixes, history, carriers, budget=budget - confirm_budget, **options)
        confirm = planner.confirmations(
            nodes, history, carriers, tasks, budget=confirm_budget, **options
        )
        if not confirm and confirm_budget:
            tasks = planner.plan(prefixes, history, carriers, budget=budget, **options)
        tasks = confirm + tasks
        summary.update(planned=len(tasks), budget=budget, nodes=len(nodes))
        deadline = time.monotonic() + settings.probe_time_budget_seconds
        with ThreadPoolExecutor(max_workers=settings.probe_concurrency) as pool:
            pending = {pool.submit(_measure, client, task): task for task in tasks}
            blocked = set()
            for future in as_completed(pending):
                try:
                    task, identifier, results = future.result()
                except CancelledError:
                    continue
                except globalping.RateLimited:
                    summary["rate_limited"] += 1
                    for other in pending:
                        other.cancel()
                    continue
                except globalping.ApiError as error:
                    summary["failed"] += 1
                    codes = summary["failed_codes"]
                    codes[error.code] = codes.get(error.code, 0) + 1
                    kind = pending[future].kind + "/" + pending[future].protocol
                    kinds = summary["failed_kinds"]
                    kinds[kind] = kinds.get(kind, 0) + 1
                    if error.code == "TARGET_NOT_ALLOWED":
                        blocked.add(pending[future].ip)
                        for other, task in pending.items():
                            if task.ip in blocked:
                                other.cancel()
                    continue
                summary["measurements"] += 1
                summary["tests"] += task.cost
                now = clock()
                pings, traces = _rows(
                    task,
                    identifier,
                    results,
                    task.peak and is_peak(beijing_minute(now), policy),
                    now,
                )
                _store(sessions, pings, traces)
                summary["stored"] += len(pings) + len(traces)
                if time.monotonic() > deadline:
                    for other in pending:
                        other.cancel()
        if blocked:
            with sessions.begin() as session:
                for ip in blocked:
                    statement = insert(EntryProbeRejection).values(
                        ip=ip, retry_after=clock() + timedelta(days=7)
                    )
                    session.execute(
                        statement.on_conflict_do_update(
                            index_elements=[EntryProbeRejection.ip],
                            set_={"retry_after": statement.excluded.retry_after},
                        )
                    )
    except globalping.RateLimited:
        summary["rate_limited"] += 1
    except globalping.ApiError as error:
        summary["status"] = "API_ERROR"
        run_row["error_code"] = error.code
    run_row.update(
        {k: summary[k] for k in ("measurements", "tests", "stored", "failed", "rate_limited")}
    )
    run_row["remaining"] = client.remaining
    if isinstance(client, ClientPool):
        summary["accounts"] = len(client.accounts)
        summary["accounts_unavailable"] = sum(not a.enabled for a in client.accounts)
        summary["accounts_rate_limited"] = client.rate_limited
    with sessions.begin() as session:
        session.add(EntryProbeRun(started_at=started, finished_at=clock(), **run_row))
    return {**summary, "peak": peak, "authenticated": client.authenticated}


def _store(sessions, pings: list[dict], traces: list[dict]) -> None:
    if not pings and not traces:
        return
    with sessions.begin() as session:
        if pings:
            session.execute(insert(EntryProbeResult), pings)
        for trace in traces:
            session.execute(
                insert(EntryRouteTrace)
                .values(**trace)
                .on_conflict_do_update(
                    index_elements=[EntryRouteTrace.prefix, EntryRouteTrace.vantage],
                    set_={k: trace[k] for k in trace if k not in ("prefix", "vantage")},
                )
            )


def cleanup(sessions, days: int = 14) -> int:
    with sessions.begin() as session:
        deleted = session.execute(
            sa.delete(EntryProbeResult).where(
                EntryProbeResult.measured_at < datetime.now(UTC) - timedelta(days=days)
            )
        ).rowcount
        session.execute(
            sa.delete(EntryProbeRun).where(
                EntryProbeRun.started_at < datetime.now(UTC) - timedelta(days=60)
            )
        )
    return deleted
