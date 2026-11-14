"""Aggregate numeric telemetry only. Never store URLs, credentials or arbitrary error text."""

import logging
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import insert

from app.database.models import ActionRun, DatabaseSample, UsageEvent
from app.domain import AssetError

COUNTERS = (
    "full_checks",
    "full_samples",
    "preflight_skips",
    "cooldown_skips",
    "dns_requests",
    "dns_cache_hits",
    "tcp_probes",
    "tcp_socket_attempts",
    "tcp_cache_hits",
    "runtime_starts",
    "runtime_reloads",
    "check_count",
    "check_duration_ms",
    "timeout_checks",
    "echo_requests",
    "echo_failures",
    "echo_response_bytes",
    "source_requests",
    "source_response_bytes",
    "subscription_downloads",
    "subscription_bytes",
    "network_samples",
    "network_rx_bytes",
    "network_tx_bytes",
)
SUMS = ", ".join(f"COALESCE(SUM({key}),0)::bigint AS {key}" for key in COUNTERS)
HEALTH_SQL = """
SELECT COUNT(*)::int AS attempts, COUNT(DISTINCT node_id)::int AS nodes,
 COUNT(*) FILTER (WHERE jsonb_array_length(timeout_stages)>0)::int AS timeout_attempts,
 COUNT(*) FILTER (WHERE status='ENVIRONMENT_ERROR')::int AS environment_attempts,
 ROUND(AVG(check_duration_ms),2) AS mean_check_ms
FROM test_results WHERE checked_at >= :since
"""
EXECUTIONS_SQL = """
SELECT COUNT(*)::int AS executions,
 COUNT(*) FILTER (WHERE u.outcome='ENVIRONMENT_ERROR' OR
   (u.outcome='RUNNING' AND (s.lease_owner IS DISTINCT FROM u.id OR s.lease_until<NOW())))
   ::int AS failed_executions,
 COUNT(*) FILTER (WHERE u.outcome='COMPLETED')::int AS completed_executions
FROM usage_events u LEFT JOIN scan_shards s
 ON s.scan_run_id=u.scan_run_id AND s.shard_no=u.shard_no
WHERE u.kind='CHECK' AND u.started_at>=:since
"""


def snapshot_event(
    session,
    event_id,
    kind,
    *,
    outcome="RUNNING",
    started_at=None,
    scan_run_id=None,
    shard_no=None,
    entity_id=None,
    **counters,
):
    if set(counters) - set(COUNTERS) or any(type(v) is not int or v < 0 for v in counters.values()):
        raise AssetError("INVALID_USAGE_COUNTERS")
    at = datetime.now(UTC)
    values = {
        "id": event_id,
        "kind": kind,
        "outcome": outcome,
        "started_at": started_at or at,
        "updated_at": at,
        "finished_at": None if outcome == "RUNNING" else at,
        "scan_run_id": scan_run_id,
        "shard_no": shard_no,
        "entity_id": entity_id,
        **{k: counters.get(k, 0) for k in COUNTERS},
    }
    statement = insert(UsageEvent).values(values)
    session.execute(
        statement.on_conflict_do_update(
            index_elements=[UsageEvent.id],
            set_={
                key: statement.excluded[key]
                for key in values
                if key not in ("id", "kind", "started_at")
            },
        )
    )


class Usage:
    def __init__(self, sessions):
        self.sessions = sessions

    def record(self, event_id, kind, **values):
        with self.sessions.begin() as session:
            snapshot_event(session, event_id, kind, **values)

    def best_effort(self, event_id, kind, **values):
        try:
            self.record(event_id, kind, **values)
            return True
        except Exception:
            # The health/asset transaction must not be undone by optional telemetry.
            logging.getLogger("nodema.usage").warning("USAGE_WRITE_FAILED")
            return False

    def database_sample(self, transfer=None):
        """transfer: neon_transfer() values, or None when no Neon API key is configured."""
        with self.sessions.begin() as session:
            row = (
                session.execute(
                    sa.text("""
              SELECT pg_database_size(current_database())::bigint AS database_bytes,
              COALESCE((SELECT SUM(pg_total_relation_size(quote_ident(schemaname)||'.'||
                quote_ident(tablename))) FROM pg_tables WHERE schemaname=current_schema()),0)
                ::bigint AS table_bytes,
              (SELECT numbackends FROM pg_stat_database WHERE datname=current_database())
                ::int AS connections
            """)
                )
                .mappings()
                .one()
            )
            sample = DatabaseSample(id=uuid4(), **dict(row), **(transfer or {}))
            session.add(sample)
            session.flush()
            return {c.name: getattr(sample, c.name) for c in DatabaseSample.__table__.columns}

    def summary(self, days=30):
        if type(days) is not int or not 1 <= days <= 365:
            raise AssetError("INVALID_USAGE_WINDOW")
        since = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(
            days=days - 1
        )
        params = {"since": since}
        with self.sessions() as session:
            totals = dict(
                session.execute(
                    sa.text("SELECT " + SUMS + " FROM usage_events WHERE started_at>=:since"),
                    params,
                )
                .mappings()
                .one()
            )
            daily = [
                dict(r)
                for r in session.execute(
                    sa.text(
                        "SELECT (started_at AT TIME ZONE 'UTC')::date::text AS day,"
                        + SUMS
                        + " FROM usage_events WHERE started_at>=:since GROUP BY day ORDER BY day"
                    ),
                    params,
                ).mappings()
            ]
            health = dict(session.execute(sa.text(HEALTH_SQL), params).mappings().one())
            executions = dict(session.execute(sa.text(EXECUTIONS_SQL), params).mappings().one())
            actions = [
                {c.name: getattr(r, c.name) for c in ActionRun.__table__.columns}
                for r in session.scalars(
                    sa.select(ActionRun)
                    .where(ActionRun.started_at >= since)
                    .order_by(ActionRun.started_at.desc())
                    .limit(1000)
                )
            ]
            runner_ms = session.scalar(
                sa.select(sa.func.coalesce(sa.func.sum(ActionRun.runner_ms), 0)).where(
                    ActionRun.started_at >= since
                )
            )
            samples = [
                {c.name: getattr(r, c.name) for c in DatabaseSample.__table__.columns}
                for r in session.scalars(
                    sa.select(DatabaseSample)
                    .where(DatabaseSample.taken_at >= since)
                    .order_by(DatabaseSample.taken_at.desc())
                    .limit(1000)
                )
            ]
            first_sample_bytes = session.scalar(
                sa.select(DatabaseSample.table_bytes)
                .where(DatabaseSample.taken_at >= since)
                .order_by(DatabaseSample.taken_at)
                .limit(1)
            )
            recent = [
                dict(r)
                for r in session.execute(
                    sa.text(
                        "SELECT u.id,u.kind,u.started_at,u.updated_at,u.finished_at,"
                        "CASE WHEN u.kind='CHECK' AND u.outcome='RUNNING' AND "
                        "(s.lease_owner IS DISTINCT FROM u.id OR s.lease_until<NOW()) "
                        "THEN 'INTERRUPTED' ELSE u.outcome END AS outcome,"
                        "u.scan_run_id,u.shard_no,"
                        + ",".join("u." + k for k in COUNTERS)
                        + " FROM usage_events u LEFT JOIN scan_shards s ON "
                        "s.scan_run_id=u.scan_run_id AND s.shard_no=u.shard_no "
                        "WHERE u.started_at>=:since ORDER BY u.started_at DESC LIMIT 100"
                    ),
                    params,
                ).mappings()
            ]
        health["mean_check_ms"] = (
            float(health["mean_check_ms"]) if health["mean_check_ms"] is not None else None
        )
        health["timeout_ratio"] = (
            health["timeout_attempts"] / health["attempts"] if health["attempts"] else None
        )
        ended = executions["completed_executions"] + executions["failed_executions"]
        executions["failure_ratio"] = executions["failed_executions"] / ended if ended else None
        with self.sessions() as session:
            latest = session.execute(
                sa.select(
                    DatabaseSample.taken_at,
                    DatabaseSample.transfer_bytes,
                    DatabaseSample.transfer_limit_bytes,
                    DatabaseSample.transfer_period_end,
                )
                .where(DatabaseSample.transfer_bytes.is_not(None))
                .order_by(DatabaseSample.taken_at.desc())
                .limit(1)
            ).first()
        transfer = dict(latest._mapping) if latest else None
        return {
            "days": days,
            "since": since,
            "timezone": "UTC",
            "totals": totals,
            "daily": daily,
            "health": health,
            "executions": executions,
            "action_runs": actions,
            "database_samples": samples,
            "neon_transfer": transfer,
            "runner_minutes": float(runner_ms) / 60000,
            "database_growth_bytes": samples[0]["table_bytes"] - first_sample_bytes
            if len(samples) > 1
            else None,
            "recent": recent,
        }

    def cleanup(self, days=365):
        before = datetime.now(UTC) - timedelta(days=days)
        with self.sessions.begin() as session:
            return {
                table.__tablename__: session.execute(
                    sa.delete(table).where(getattr(table, column) < before)
                ).rowcount
                for table, column in (
                    (UsageEvent, "started_at"),
                    (DatabaseSample, "taken_at"),
                    (ActionRun, "started_at"),
                )
            }


NEON_API = "https://console.neon.tech/api/v2/projects/"


def neon_transfer(settings, opener=None):
    """This billing period's Neon public network transfer, or None (no key, API error)."""
    import json
    import urllib.request

    key = settings.neon_api_key.get_secret_value()
    if not key or not settings.neon_project_id:
        return None
    request = urllib.request.Request(
        NEON_API + settings.neon_project_id,
        headers={"Authorization": "Bearer " + key, "Accept": "application/json"},
    )
    try:
        with (opener or urllib.request.urlopen)(request, timeout=15) as response:
            project = json.load(response)["project"]
        used = int(project["data_transfer_bytes"])
        end = project.get("consumption_period_end")
        return {
            "transfer_bytes": used,
            "transfer_limit_bytes": settings.neon_transfer_limit_bytes,
            "transfer_period_end": datetime.fromisoformat(end.replace("Z", "+00:00"))
            if end
            else None,
        }
    except Exception as error:  # noqa: BLE001 - usage must never fail a workflow
        logging.getLogger("nodema.usage").warning("NEON_USAGE_UNAVAILABLE %s", type(error).__name__)
        return None
