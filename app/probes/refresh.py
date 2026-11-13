"""Recompute node_grades from measurements (after probe rounds and daily checks).

Only currently available, enabled nodes are graded; others have no row and show
their status instead. Subscriptions that filter or sort by grade are marked for
rebuild when any grade changes.
"""

from collections import defaultdict
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import insert

from app.database.models import NodeGrade
from app.grading import (
    CARRIERS,
    Access,
    NodeFacts,
    Sample,
    access_stats,
    best_grade,
    combine_cn,
    grade_node,
)
from app.probes import planner
from app.probes.policy import load_policy

WINDOW = timedelta(days=7)
GRADE_FILTERS = (
    "quality_grade",
    "min_quality_grade",
    "max_peak_rtt_ms",
    "max_peak_loss",
    "min_avail_7d",
    "unreachable",
    "route_asn",
    "best_per_server",
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
        ),
        {"fresh": fresh_hours},
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


def _reach_failed(samples: list[Sample]) -> bool:
    return (
        len(samples) >= 2
        and len({s.probe for s in samples}) >= 2
        and all(s.received == 0 for s in samples)
    )


def compute(nodes, stability, quality, reach, traces, policy) -> list[dict]:
    rows: list[dict] = []
    for node in nodes:
        ip = planner.ipv4(node.entry_ips)
        entry = planner.EntryNode(node.id, node.protocol, ip, node.server_port, node.entry_asn)
        target = entry.target if node.protocol != "hysteria2" else ip
        available, checked = stability.get(node.id, (0, 0))
        facts = NodeFacts(node.protocol, entry.target, available, checked, node.is_proxy)
        reach_failed = node.protocol != "hysteria2" and _reach_failed(
            reach.get(entry.target or "", [])
        )
        carriers = {}
        for vantage in (*CARRIERS, "HK", "SG"):
            samples = quality.get((entry.prefix, vantage), []) if entry.prefix else []
            access = (
                access_stats(samples, target, vantage in CARRIERS, policy) if samples else Access()
            )
            result = grade_node(facts, vantage, access, reach_failed, policy)
            if vantage in CARRIERS:
                carriers[vantage] = result
            route, route_at = (
                traces.get((entry.prefix, vantage), (None, None))
                if vantage in CARRIERS
                else (None, None)
            )
            rows.append(_row(node, vantage, result, available, checked, route, route_at))
        rows.append(_row(node, "CN", combine_cn(carriers), available, checked, None, None))
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


def refresh(sessions, settings, *, if_due: bool = False, clock=None) -> dict:
    with sessions() as session:
        policy = load_policy(session)
        if if_due:
            last = session.scalar(sa.select(sa.func.max(NodeGrade.computed_at)))
            if not due(last, (clock or (lambda: datetime.now(UTC)))(), policy):
                return {"skipped": True}
        nodes, stability, quality, reach, traces = load(session, settings.freshness_hours)
    rows = compute(nodes, stability, quality, reach, traces, policy)
    now = datetime.now(UTC)
    with sessions.begin() as session:
        before = {
            (r.node_id, r.vantage): r.grade
            for r in session.execute(
                sa.select(NodeGrade.node_id, NodeGrade.vantage, NodeGrade.grade)
            )
        }
        session.execute(sa.delete(NodeGrade))
        for start in range(0, len(rows), 2000):
            session.execute(
                insert(NodeGrade),
                [{**row, "computed_at": now} for row in rows[start : start + 2000]],
            )
        after = {(r["node_id"], r["vantage"]): r["grade"] for r in rows}
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
    return {
        "nodes": len(nodes),
        "rows": len(rows),
        "changed": changed,
        "invalidated_exports": invalidated,
        "grades": dict(counts),
    }
