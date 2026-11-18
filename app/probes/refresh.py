"""Recompute node_grades from measurements (after probe rounds and daily checks).

Only currently available, enabled nodes are graded; others have no row and show
their status instead. Nodes landing on an excluded network (Cloudflare) get no row
either: they are "not graded", never "pending". Subscriptions are marked for rebuild
when their grade or measurement inputs change.
"""

from collections import defaultdict
from dataclasses import replace
from datetime import UTC, datetime, time, timedelta
from struct import pack, unpack
from time import perf_counter
from zoneinfo import ZoneInfo

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import insert

from app.database.models import GradingPolicy, NodeGrade
from app.grading import (
    CARRIERS,
    FAILURE_WINDOW,
    OVERSEAS,
    VANTAGE_NAMES,
    VANTAGES,
    Access,
    NodeFacts,
    Sample,
    best_grade,
    combine_cn,
    grade_node,
    prefix_access,
    recent_failure,
    repeated_failure,
)
from app.probes import planner
from app.probes.policy import load_policy

WINDOW = timedelta(days=7)
GRADE_FILTERS = (
    "quality_grade",
    "min_quality_grade",
    "quality_buckets",
    "max_peak_rtt_ms",
    "max_peak_loss",
    "min_avail_7d",
    "unreachable",
    "endpoint_verified",
    "route_asn",
    "best_per_server",
)
EXPORT_FIELDS = (
    "grade",
    "score",
    "peak_rtt_ms",
    "loss",
    "avail_7d",
    "checked_7d",
    "unreachable",
    "endpoint_verified",
    "route_asns",
)


def _probe_key(asn, city) -> str:
    return f"{asn or 0}|{city or ''}"


def load(session, fresh_hours: int):
    nodes = session.execute(
        sa.text(
            "SELECT n.id,n.protocol,n.server_port,c.entry_asn,t.entry_ips,ip.is_proxy,nn.server_key"
            " FROM nodes n JOIN node_current_status c ON c.node_id=n.id"
            " JOIN test_results t ON t.id=c.last_result_id"
            " LEFT JOIN node_names nn ON nn.node_id=n.id"
            " LEFT JOIN ip_info ip ON ip.ip=c.last_exit_ip AND ip.status='SUCCESS'"
            " WHERE n.enabled AND c.status IN ('UP','DEGRADED')"
            " AND c.last_checked_at>now()-make_interval(hours=>:fresh)"
            " AND NOT coalesce(c.last_exit_asn,-1)=ANY(CAST(:excluded AS bigint[]))"
        ),
        {"fresh": fresh_hours, "excluded": sorted(planner.EXCLUDED_EXIT_ASNS)},
    ).all()
    stability = {
        row.node_id: (row.available, row.checked)
        for row in session.execute(
            sa.text(
                "SELECT node_id,count(*) FILTER (WHERE successful_count>0) available,"
                " count(*) FILTER (WHERE successful_count+failed_count>0) checked"
                " FROM node_daily_stats"
                " WHERE stat_date>(now() AT TIME ZONE 'Asia/Shanghai')::date-7"
                " GROUP BY node_id"
            )
        )
    }
    since = datetime.now(UTC) - WINDOW
    quality: dict[tuple, list[Sample]] = defaultdict(list)
    reach: dict[str, list[Sample]] = defaultdict(list)
    for row in session.execute(
        sa.text(
            "SELECT target,prefix,purpose,vantage,peak,measured_at,probe_asn,probe_city,"
            "sent,received,"
            "rtt_avg,jitter FROM entry_probe_results WHERE measured_at>:since"
        ),
        {"since": since},
    ):
        sample = Sample(
            target=row.target,
            sent=row.sent,
            received=row.received,
            rtt_avg=row.rtt_avg,
            jitter=row.jitter,
            peak=row.peak,
            probe=_probe_key(row.probe_asn, row.probe_city),
            measured_at=row.measured_at,
        )
        if row.purpose == "REACH":
            reach[row.target].append(sample)
        else:
            quality[(row.prefix, row.vantage)].append(sample)
    traces = {
        (row.prefix, row.vantage): (list(row.hop_asns or []), row.measured_at)
        for row in session.execute(
            sa.text("SELECT prefix,vantage,hop_asns,measured_at FROM entry_route_traces")
        )
    }
    return nodes, stability, quality, reach, traces


def compute(nodes, stability, quality, reach, traces, policy, *, now=None) -> list[dict]:
    now = now or datetime.now(UTC)
    rows: list[dict] = []
    prefix_cache = {}
    target_cache = {}
    by_target = defaultdict(list)
    for (prefix, vantage), samples in quality.items():
        for sample in samples:
            by_target[prefix, vantage, sample.target].append(sample)

    def access_for(entry, vantage):
        key = (entry.prefix, vantage)
        carrier = vantage in CARRIERS
        target_key = (*key, entry.target)
        if entry.protocol != "hysteria2":
            if target_key not in target_cache:
                direct = by_target.get(target_key, [])
                stats, _ = prefix_access(direct, carrier, policy) if direct else (Access(), set())
                failure_at = recent_failure(direct, now) if direct else None
                target_cache[target_key] = replace(
                    stats,
                    evidence="ENDPOINT",
                    failure_at=failure_at,
                    unreachable=failure_at is not None,
                    last_measured_at=failure_at or stats.last_measured_at,
                )
            exact = target_cache[target_key]
            if exact.unreachable or exact.sufficient:
                return exact
        if key not in prefix_cache:
            samples = quality.get(key, [])
            prefix_cache[key] = prefix_access(samples, carrier, policy)[0] if samples else Access()
        estimated = prefix_cache[key]
        if not estimated.samples:
            return Access()
        evidence = "CF_SHARED" if entry.prefix == planner.CF_PREFIX else "PREFIX"
        return replace(estimated, evidence="ICMP" if entry.protocol == "hysteria2" else evidence)

    for node in nodes:
        ip = planner.ipv4(node.entry_ips)
        entry = planner.EntryNode(node.id, node.protocol, ip, node.server_port, node.entry_asn)
        available, checked = stability.get(node.id, (0, 0))
        cdn = entry.prefix == planner.CF_PREFIX
        facts = NodeFacts(node.protocol, entry.target, available, checked, node.is_proxy, cdn)
        reach_samples = reach.get(entry.target or "", [])
        reach_failed = node.protocol != "hysteria2" and repeated_failure(reach_samples)
        reach_at = max((s.measured_at for s in reach_samples if s.measured_at), default=None)
        reach_evidence = []
        if reach_failed and reach_at:
            reach_evidence.append(f"通用大陆探针重复失败，最近 {reach_at:%Y-%m-%d %H:%M} UTC")
        carriers = {}
        for vantage in (*CARRIERS, *OVERSEAS):
            # HK/SG probes only reach their local CF data centre: never use those samples.
            skip = not entry.prefix or (cdn and vantage not in CARRIERS)
            access = Access() if skip else access_for(entry, vantage)
            result = grade_node(facts, vantage, access, policy)
            if vantage in CARRIERS:
                successful_at = (
                    max(
                        (
                            s.measured_at
                            for s in by_target.get((entry.prefix, vantage, entry.target), ())
                            if s.received and s.measured_at
                        ),
                        default=None,
                    )
                    if reach_evidence
                    else None
                )
                evidence = list(reach_evidence[:1])
                if evidence and successful_at:
                    conflict = (
                        f"证据分歧：{VANTAGE_NAMES[vantage]}探针到同一入口有成功样本，"
                        f"最近 {successful_at:%Y-%m-%d %H:%M} UTC"
                    )
                    evidence.append(conflict)
                    reach_evidence.append(conflict)
                if evidence:
                    result = replace(result, reasons=result.reasons + evidence)
                carriers[vantage] = result
            route, route_at = (
                traces.get((entry.prefix, vantage), (None, None))
                if vantage in CARRIERS
                else (None, None)
            )
            rows.append(_row(node, vantage, result, available, checked, route, route_at))
        combined = combine_cn(carriers)
        combined = replace(combined, reasons=combined.reasons + reach_evidence)
        rows.append(_row(node, "CN", combined, available, checked, None, None))
    groups = defaultdict(list)
    for row in rows:
        groups[(row["_server"], row["vantage"])].append(row["grade"])
    best = {key: best_grade(grades) for key, grades in groups.items()}
    for row in rows:
        row["server_best_grade"] = best[(row.pop("_server"), row["vantage"])]
    return rows


def _row(node, vantage, result, available, checked, route, route_at) -> dict:
    access = result.access
    return {
        "node_id": node.id,
        "vantage": vantage,
        "grade": result.grade,
        "score": result.score,
        "access_band": result.access_band,
        "stability_band": result.stability_band,
        "access_evidence": access.evidence,
        "limiting_vantage": result.limiting_vantage,
        "endpoint_verified": result.endpoint_verified,
        "peak_rtt_ms": access.rtt,
        "idle_rtt_ms": access.idle_rtt,
        "loss": access.loss,
        "jitter_ms": access.jitter,
        "samples": access.samples,
        "probes": access.probes,
        "avail_7d": available,
        "checked_7d": checked,
        "unreachable": result.unreachable,
        "route_asns": route,
        "route_measured_at": route_at,
        "last_measured_at": access.last_measured_at,
        "reasons": result.reasons,
        "_server": node.server_key or str(node.id),
    }


def due(last: datetime | None, now: datetime, policy: dict) -> bool:
    """Hourly probe rounds only recompute when it matters (Neon transfer budget): no
    grades yet, the last recompute is over 12 hours old, or the evening peak window
    has ended since the last recompute."""
    if last is None or now - last > timedelta(hours=12):
        return True
    beijing = ZoneInfo("Asia/Shanghai")
    hours, mins = (int(x) for x in policy["peak_end"].split(":"))
    local = now.astimezone(beijing)
    end = datetime.combine(local.date(), time(hours, mins), beijing)
    if end > local:
        end -= timedelta(days=1)
    return last < end <= now


def _real32(value):
    return None if value is None else unpack("f", pack("f", value))[0]


def reach_refresh_due(session, last, moment):
    """Refresh transitions promptly while keeping the normal quality refresh cadence."""
    return session.scalar(
        sa.text("""
      WITH failed AS (
        SELECT target,vantage FROM entry_probe_results
        WHERE purpose='QUALITY' AND protocol='TCP' AND received=0 AND measured_at>:cutoff
        GROUP BY target,vantage
        HAVING max(measured_at)>:last
           AND count(DISTINCT date_trunc('hour',measured_at))>=2
           AND count(DISTINCT (probe_asn,probe_city))>=2
      ), down AS (
        SELECT (a.ip||':'||n.server_port) target,g.vantage
        FROM node_grades g JOIN nodes n ON n.id=g.node_id
        JOIN node_current_status c ON c.node_id=n.id JOIN test_results t ON t.id=c.last_result_id
        CROSS JOIN LATERAL (
          SELECT ip FROM jsonb_array_elements_text(t.entry_ips) ip
          WHERE ip ~ '^[0-9]{1,3}([.][0-9]{1,3}){3}$' LIMIT 1
        ) a
        WHERE g.unreachable AND g.vantage<>'CN'
      )
      SELECT EXISTS(SELECT 1 FROM failed)
          OR EXISTS(SELECT 1 FROM node_grades WHERE limiting_vantage IS NULL)
          OR EXISTS(
        SELECT 1 FROM down d JOIN entry_probe_results r USING (target,vantage)
        WHERE r.purpose='QUALITY' AND r.protocol='TCP' AND
          ((r.received>0 AND r.measured_at>:last)
           OR (r.received=0 AND r.measured_at>:previous_cutoff AND r.measured_at<=:cutoff))
      )
    """),
        {"last": last, "cutoff": moment - FAILURE_WINDOW, "previous_cutoff": last - FAILURE_WINDOW},
    )


def refresh(sessions, settings, *, if_due: bool = False, clock=None) -> dict:
    started = perf_counter()
    with sessions.begin() as session:
        # Serialize the snapshot and the publish to keep concurrent rounds from
        # overwriting a newer computation with older evidence.
        session.execute(sa.text("SELECT pg_advisory_xact_lock(hashtext('nodema_grade_refresh'))"))
        policy = load_policy(session)
        if if_due:
            last = session.scalar(sa.select(sa.func.max(NodeGrade.computed_at)))
            present = set(session.scalars(sa.select(NodeGrade.vantage).distinct()))
            updated = session.scalar(sa.select(GradingPolicy.updated_at))
            changed_policy = last is not None and updated is not None and updated > last
            moment = (clock or (lambda: datetime.now(UTC)))()
            if (
                present == set(VANTAGES)
                and not changed_policy
                and not due(last, moment, policy)
                and not reach_refresh_due(session, last, moment)
            ):
                return {"skipped": True}
        nodes, stability, quality, reach, traces = load(session, settings.freshness_hours)
        loaded = perf_counter()
        rows = compute(
            nodes,
            stability,
            quality,
            reach,
            traces,
            policy,
            now=(clock or (lambda: datetime.now(UTC)))(),
        )
        computed = perf_counter()
        now = datetime.now(UTC)
        before = {
            (r.node_id, r.vantage): tuple(
                _real32(value) if field in {"score", "peak_rtt_ms", "loss"} else value
                for field, value in zip(EXPORT_FIELDS, r[2:], strict=True)
            )
            for r in session.execute(
                sa.select(
                    NodeGrade.node_id,
                    NodeGrade.vantage,
                    *(getattr(NodeGrade, key) for key in EXPORT_FIELDS),
                )
            )
        }
        after = {
            (row["node_id"], row["vantage"]): tuple(
                _real32(row[key]) if key in {"score", "peak_rtt_ms", "loss"} else row[key]
                for key in EXPORT_FIELDS
            )
            for row in rows
        }
        session.execute(sa.delete(NodeGrade))
        for start in range(0, len(rows), 2000):
            session.execute(
                # Every row supplies the same keys; optional measurement fields
                # must remain NULL rather than fragmenting ORM batches by vantage.
                insert(NodeGrade).execution_options(render_nulls=True),
                [{**row, "computed_at": now} for row in rows[start : start + 2000]],
            )
        changed = before != after
        invalidated = 0
        if changed:
            session.execute(sa.text("SELECT nodema_bump_catalog()"))
            invalidated = session.execute(
                sa.text(
                    "UPDATE export_artifacts"
                    " SET invalidated=true,requested_at=coalesce(requested_at,now())"
                    " WHERE revoked_at IS NULL AND NOT invalidated"
                    " AND (filter_spec ?| CAST(:keys AS text[])"
                    " OR coalesce(filter_spec->>'sort','') ~ '(quality|peak|avail_7d)')"
                ),
                {"keys": list(GRADE_FILTERS)},
            ).rowcount
    counts = defaultdict(int)
    for row in rows:
        if row["vantage"] == policy["default_vantage"]:
            counts[row["grade"]] += 1
    # Phase timings (seconds) in the Actions log: where a slow recompute spends its time.
    timings = {
        "load": round(loaded - started, 1),
        "compute": round(computed - loaded, 1),
        "write": round(perf_counter() - computed, 1),
        "samples": sum(len(v) for v in quality.values()),
    }
    return {
        "nodes": len(nodes),
        "rows": len(rows),
        "timings": timings,
        "changed": changed,
        "invalidated_exports": invalidated,
        "grades": dict(counts),
    }
