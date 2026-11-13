"""One hourly Globalping round: plan within the remaining budget, measure, store.

Only counts reach the output/logs; targets and response bodies never do.
"""

import random
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import insert

from app.database.models import EntryProbeResult, EntryProbeRun, EntryRouteTrace
from app.grading import CARRIERS, is_peak
from app.probes import globalping, planner
from app.probes.policy import load_policy

BEIJING = ZoneInfo("Asia/Shanghai")
WINDOW = timedelta(days=7)
ANONYMOUS_LIMIT, AUTHENTICATED_LIMIT = 250, 500
RESERVE = 5


def beijing_minute(moment: datetime) -> int:
    local = moment.astimezone(BEIJING)
    return local.hour * 60 + local.minute


def load_nodes(session, fresh_hours: int, coverage: str) -> list[planner.EntryNode]:
    """Distinct entries (protocol, first IPv4, port, entry ASN) with node counts."""
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
            " (SELECT e FROM jsonb_array_elements_text(coalesce(t.entry_ips,'[]')) e"
            "   WHERE e ~ '^[0-9]{1,3}([.][0-9]{1,3}){3}$' LIMIT 1) ip,count(*) n"
            " FROM nodes n JOIN node_current_status c ON c.node_id=n.id"
            " JOIN test_results t ON t.id=c.last_result_id"
            " WHERE n.enabled AND c.status IN ('UP','DEGRADED')"
            " AND c.last_checked_at>now()-make_interval(hours=>:fresh)"
            + scope
            + " GROUP BY 1,2,3,4"
        ),
        {"fresh": fresh_hours},
    )
    entries = []
    for row in rows:
        ip = planner.ipv4([row.ip]) if row.ip else None
        entries.extend(
            planner.EntryNode(None, row.protocol, ip, row.server_port, row.entry_asn)
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
  CASE WHEN count(*) FILTER (WHERE vantage IN ('HK','SG'))=2
    THEN min(last) FILTER (WHERE vantage IN ('HK','SG')) END last_overseas,
  bool_or(NOT peak AND vantage LIKE 'CN-%' AND probes>=:min_probes AND (rtt IS NULL OR rtt>:rtt
    OR (sent>0 AND (1-received::float/sent)*100>:loss))) poor
FROM (SELECT prefix,vantage,bool_or(peak) peak,min(probes) probes,max(last) last,
        sum(sent) sent,sum(received) received,max(rtt) rtt
      FROM q GROUP BY prefix,vantage,CASE WHEN vantage IN ('HK','SG') THEN false ELSE peak END) x
GROUP BY prefix
"""
TARGETS_SQL = """
SELECT target,max(measured_at) FILTER (WHERE purpose='REACH') last,
  count(*)>=2 AND bool_and(received=0)
    AND count(DISTINCT coalesce(probe_asn::text,'')||'|'||coalesce(probe_city,''))>=2 dead
FROM entry_probe_results WHERE measured_at>:since GROUP BY target
HAVING max(measured_at) FILTER (WHERE purpose='REACH') IS NOT NULL
  OR (count(*)>=2 AND bool_and(received=0))
"""


def load_history(session, policy: dict) -> planner.History:
    since = datetime.now(UTC) - WINDOW
    limits = policy["bands"]["CN"]["B"]
    peak_probes, last_peak, last_idle, last_overseas, poor = {}, {}, {}, {}, set()
    for row in session.execute(
        sa.text(HISTORY_SQL),
        {
            "since": since,
            "min_probes": policy["min_probes"],
            "rtt": limits["rtt_ms"],
            "loss": limits["loss_pct"],
        },
    ):
        peak_probes[row.prefix] = row.peak_probes or 0
        last_peak[row.prefix] = row.last_peak
        last_idle[row.prefix] = row.last_idle
        last_overseas[row.prefix] = row.last_overseas
        if row.poor:
            poor.add(row.prefix)
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
        idle_poor=frozenset(poor),
        last_reach=last_reach,
        dead=frozenset(dead),
        last_trace=traces,
    )


def carrier_asns(probes: list[globalping.Probe]) -> tuple[dict[str, list[int]], dict[str, int]]:
    carriers: dict[str, set[int]] = {c: set() for c in CARRIERS}
    counts = {c: 0 for c in (*CARRIERS, "HK", "SG")}
    for probe in probes:
        vantage = planner.vantage_of(probe.country, probe.asn, probe.network)
        if vantage in CARRIERS:
            if "eyeball-network" in probe.tags and probe.asn:
                carriers[vantage].add(probe.asn)
                counts[vantage] += 1
        elif vantage:
            counts[vantage] += 1
    return {c: sorted(v) for c, v in carriers.items()}, counts


def _measure(client: globalping.Client, task: planner.Task) -> tuple[planner.Task, str, list]:
    identifier = client.create(task.request())
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


def run(sessions, settings, *, client: globalping.Client | None = None, clock=None) -> dict:
    clock = clock or (lambda: datetime.now(UTC))
    with sessions() as session:
        policy = load_policy(session)
    if not policy["probe_enabled"]:
        return {"status": "DISABLED"}
    client = client or globalping.Client(
        settings.globalping_url,
        settings.globalping_token.get_secret_value(),
        settings.probe_timeout_seconds,
    )
    started = clock()
    summary = {
        "status": "OK",
        "measurements": 0,
        "tests": 0,
        "stored": 0,
        "failed": 0,
        "rate_limited": 0,
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
            nodes = load_nodes(session, settings.freshness_hours, policy["coverage"])
            history = load_history(session, policy)
        budget = max(0, min(remaining - RESERVE, settings.probe_max_tests_per_run))
        tasks = planner.plan(
            planner.group(nodes),
            history,
            carriers,
            now=started,
            peak=peak,
            budget=budget,
            min_probes=policy["min_probes"],
            rng=random.Random(started.timestamp()),
        )
        summary.update(planned=len(tasks), budget=budget, nodes=len(nodes))
        deadline = time.monotonic() + settings.probe_time_budget_seconds
        with ThreadPoolExecutor(max_workers=settings.probe_concurrency) as pool:
            pending = {pool.submit(_measure, client, task) for task in tasks}
            for future in as_completed(pending):
                try:
                    task, identifier, results = future.result()
                except globalping.RateLimited:
                    summary["rate_limited"] += 1
                    for other in pending:
                        other.cancel()
                    continue
                except globalping.ApiError:
                    summary["failed"] += 1
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
    except globalping.RateLimited:
        summary["rate_limited"] += 1
    except globalping.ApiError as error:
        summary["status"] = "API_ERROR"
        run_row["error_code"] = error.code
    run_row.update(
        {k: summary[k] for k in ("measurements", "tests", "stored", "failed", "rate_limited")}
    )
    run_row["remaining"] = client.remaining
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
