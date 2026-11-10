"""Immutable daily/supplemental snapshots, leased execution, and atomic publication."""

import hashlib
import hmac
import json
import logging
import math
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import UTC, date, datetime, timedelta
from queue import Queue
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import insert

from app.checker.health import HealthChecker
from app.checker.precheck import EndpointCache
from app.database.models import (
    CatalogState,
    Node,
    NodeCurrentStatus,
    NodeDailyStats,
    NodeSource,
    ScanItem,
    ScanRun,
    ScanShard,
    Source,
    TestResult,
    UsageEvent,
)
from app.domain import AssetError

TERMINAL = ("UP", "DOWN", "DEGRADED", "UNKNOWN", "UNSUPPORTED")


def now():
    return datetime.now(UTC)


def eligible_clause():
    return sa.exists(
        sa.select(NodeSource.node_id)
        .join(Source)
        .where(
            NodeSource.node_id == Node.id,
            NodeSource.is_present.is_(True),
            Source.enabled.is_(True),
            Source.deleted_at.is_(None),
        )
    )


class ScanService:
    def __init__(self, assets, settings, *, checker_factory=None):
        self.assets, self.settings = assets, settings
        self.sessions = assets.sessions
        self.checker_factory = checker_factory

    def create(self, scan_date: date | None = None):
        scan_date = scan_date or now().astimezone(ZoneInfo(self.settings.scan_timezone)).date()
        lock = int.from_bytes(
            hashlib.sha256(f"nodema-scan:{scan_date}".encode()).digest()[:8], "big", signed=True
        )
        with self.sessions.begin() as session:
            session.execute(sa.select(sa.func.pg_advisory_xact_lock(lock)))
            existing = session.scalars(
                sa.select(ScanRun)
                .where(ScanRun.scan_date == scan_date)
                .order_by(ScanRun.started_at, ScanRun.id)
            ).all()
            cutoff = session.scalar(
                sa.select(CatalogState.closed_before)
                .where(CatalogState.id == 1)
                .with_for_update(read=True)
            )
            if cutoff is not None and scan_date < cutoff:
                if existing:
                    return self._run_dto(existing[-1])
                raise AssetError("SCAN_DATE_ARCHIVED")
            # Never change a running snapshot. Reserve each node once per calendar day,
            # including nodes in failed/unfinished runs, which will be resumed separately.
            reserved = sa.exists(
                sa.select(ScanItem.node_id)
                .join(ScanRun)
                .where(ScanItem.node_id == Node.id, ScanRun.scan_date == scan_date)
            )
            rows = session.execute(
                sa.select(
                    Node.id, Node.fingerprint, Node.server_host, Node.server_port, Node.protocol
                )
                .where(Node.enabled.is_(True), eligible_clause(), ~reserved)
                .order_by(Node.fingerprint)
            ).all()
            if existing and not rows:
                return self._run_dto(
                    next((r for r in existing if r.status != "COMPLETED"), existing[-1])
                )
            count = math.ceil(len(rows) / self.settings.shard_size)
            run = ScanRun(
                id=uuid4(),
                scan_date=scan_date,
                kind="SUPPLEMENTAL" if existing else "DAILY",
                status="PENDING" if rows else "COMPLETED",
                node_count=len(rows),
                shard_count=count,
                finished_at=None if rows else now(),
            )
            session.add(run)
            session.flush()
            items, sizes = [], [0] * count
            groups = {}
            for node_id, _fingerprint, host, port, protocol in rows:
                key = hmac.digest(
                    self.assets.fingerprint_key,
                    b"nodema:shard:endpoint:v2\0"
                    + json.dumps(
                        [host, port, "UDP" if protocol == "hysteria2" else "TCP"],
                        separators=(",", ":"),
                    ).encode(),
                    "sha256",
                )
                groups.setdefault(key, []).append(node_id)
            # Keep shared endpoints together, split very large groups, and balance
            # deterministically. Credentials never affect grouping or reachability.
            for key in sorted(groups, key=lambda key: (-len(groups[key]), key)):
                group = groups[key]
                for offset in range(0, len(group), self.settings.shard_size):
                    shard = min(range(count), key=lambda index: (sizes[index], index))
                    chunk = group[offset : offset + self.settings.shard_size]
                    items.extend(
                        {"scan_run_id": run.id, "node_id": node_id, "shard_no": shard}
                        for node_id in chunk
                    )
                    sizes[shard] += len(chunk)
            if count:
                session.execute(
                    insert(ScanShard),
                    [
                        {
                            "scan_run_id": run.id,
                            "shard_no": i,
                            "planned_count": size,
                            "status": "PENDING" if size else "COMPLETED",
                        }
                        for i, size in enumerate(sizes)
                    ],
                )
                for offset in range(0, len(items), 500):
                    session.execute(insert(ScanItem), items[offset : offset + 500])
            return self._run_dto(run)

    @staticmethod
    def _run_dto(run):
        return {
            key: getattr(run, key)
            for key in (
                "id",
                "scan_date",
                "kind",
                "status",
                "node_count",
                "shard_count",
                "started_at",
                "finished_at",
                "error_summary",
                "archived_at",
                "archive_summary",
            )
        }

    def list(self):
        with self.sessions() as session:
            return [
                self._run_dto(r)
                for r in session.scalars(
                    sa.select(ScanRun)
                    .order_by(ScanRun.scan_date.desc(), ScanRun.started_at.desc())
                    .limit(100)
                )
            ]

    def get(self, run_id):
        with self.sessions() as session:
            run = session.get(ScanRun, run_id)
            if run is None:
                raise AssetError("SCAN_NOT_FOUND")
            result = self._run_dto(run)
            result["shards"] = [
                {
                    key: getattr(s, key)
                    for key in (
                        "shard_no",
                        "status",
                        "planned_count",
                        "completed_count",
                        "failed_count",
                        "last_heartbeat_at",
                        "started_at",
                        "finished_at",
                        "error_summary",
                    )
                }
                for s in session.scalars(
                    sa.select(ScanShard)
                    .where(ScanShard.scan_run_id == run_id)
                    .order_by(ScanShard.shard_no)
                )
            ]
            result["items"] = dict(
                session.execute(
                    sa.select(ScanItem.status, sa.func.count())
                    .where(ScanItem.scan_run_id == run_id)
                    .group_by(ScanItem.status)
                ).all()
            )
            if run.archived_at is not None:
                result["items"] = run.archive_summary.get("items", {})
            return result

    def plan(self, run_id=None, scan_date=None):
        """Plan every unfinished run that the serialized Actions pipeline can resume."""
        run = self.get(run_id) if run_id else self.create(scan_date)
        if run.get("archived_at") is not None:
            raise AssetError("SCAN_ARCHIVED")
        with self.sessions() as session:
            query = sa.select(ScanRun).where(
                ScanRun.status != "COMPLETED", ScanRun.archived_at.is_(None)
            )
            if run_id:
                query = query.where(ScanRun.id == run_id)
            else:
                # Don't revive historical batches beyond raw-result retention.
                query = query.where(
                    ScanRun.scan_date
                    >= run["scan_date"] - timedelta(days=self.settings.detail_retention_days - 1),
                    ScanRun.scan_date <= run["scan_date"],
                )
            ids = list(
                session.scalars(
                    query.with_only_columns(ScanRun.id).order_by(
                        ScanRun.scan_date, ScanRun.started_at, ScanRun.id
                    )
                )
            )
        runs = [self.get(run_id) for run_id in ids]
        tasks = [
            {"run_id": str(r["id"]), "shard": s["shard_no"]}
            for r in runs
            for s in r["shards"]
            if s["status"] != "COMPLETED"
        ]
        # Normally one shard per job; cap matrix expansion at GitHub's 256 jobs.
        size = max(1, math.ceil(len(tasks) / 256))
        workers = [tasks[i : i + size] for i in range(0, len(tasks), size)]
        return {**run, "runs": runs, "workers": workers}

    def _owned(self, session, run_id, shard_no, owner):
        run = session.scalar(
            sa.select(ScanRun).where(ScanRun.id == run_id).with_for_update(read=True)
        )
        if run is None or run.archived_at is not None:
            raise AssetError("SCAN_ARCHIVED" if run else "SCAN_NOT_FOUND")
        shard = session.scalar(
            sa.select(ScanShard)
            .where(ScanShard.scan_run_id == run_id, ScanShard.shard_no == shard_no)
            .with_for_update()
        )
        if shard is None:
            raise AssetError("SHARD_NOT_FOUND")
        if shard.lease_owner != owner or shard.lease_until is None or shard.lease_until <= now():
            raise AssetError("SHARD_LEASE_LOST")
        shard.last_heartbeat_at = now()
        shard.lease_until = now() + timedelta(seconds=self.settings.shard_lease_seconds)
        return shard

    def claim(self, run_id, shard_no, owner):
        with self.sessions.begin() as session:
            run = session.scalar(sa.select(ScanRun).where(ScanRun.id == run_id).with_for_update())
            if run is None or run.archived_at is not None:
                raise AssetError("SCAN_ARCHIVED" if run else "SCAN_NOT_FOUND")
            shard = session.scalar(
                sa.select(ScanShard)
                .where(ScanShard.scan_run_id == run_id, ScanShard.shard_no == shard_no)
                .with_for_update()
            )
            if shard is None:
                raise AssetError("SHARD_NOT_FOUND")
            if shard.status == "COMPLETED":
                return False
            if shard.lease_owner is not None and shard.lease_until and shard.lease_until > now():
                raise AssetError("SHARD_BUSY")
            shard.status, shard.lease_owner = "RUNNING", owner
            shard.lease_until = now() + timedelta(seconds=self.settings.shard_lease_seconds)
            shard.last_heartbeat_at = now()
            shard.started_at = shard.started_at or now()
            shard.error_summary = {}
            session.execute(
                sa.update(ScanRun)
                .where(ScanRun.id == run_id)
                .values(status="RUNNING", finished_at=None)
            )
            return True

    def _record(self, run_id, shard_no, owner, node_id, attempt, result, terminal, usage=None):
        self._record_many(run_id, shard_no, owner, [(node_id, attempt, result, terminal)], usage)

    def _record_many(self, run_id, shard_no, owner, records, usage=None):
        with self.sessions.begin() as session:
            shard = self._owned(session, run_id, shard_no, owner)
            items = {
                item.node_id: item
                for item in session.scalars(
                    sa.select(ScanItem)
                    .where(
                        ScanItem.scan_run_id == run_id,
                        ScanItem.node_id.in_([r[0] for r in records]),
                    )
                    .with_for_update()
                )
            }
            values = []
            for node_id, attempt, result, terminal in records:
                item = items.get(node_id)
                if item is None or item.attempts != attempt or item.status == "DONE":
                    raise AssetError("ATTEMPT_CONFLICT")
                values.append(
                    dict(
                        scan_run_id=run_id,
                        node_id=node_id,
                        attempt_no=attempt,
                        checked_at=result.checked_at or now(),
                        **result.values(),
                    )
                )
                item.last_error_code, item.updated_at = result.error_code, now()
                item.status = "DONE" if terminal else "RETRYABLE"
                if terminal:
                    shard.completed_count += 1
                    shard.failed_count += int(result.status == "DOWN")
            if values:
                session.execute(
                    insert(TestResult)
                    .values(values)
                    .on_conflict_do_nothing(
                        index_elements=[
                            TestResult.scan_run_id,
                            TestResult.node_id,
                            TestResult.attempt_no,
                        ]
                    )
                )
            if usage is not None:
                from app.usage import snapshot_event

                try:
                    with session.begin_nested():
                        snapshot_event(session, owner, "CHECK", **usage)
                except Exception:
                    logging.getLogger("nodema.usage").warning("USAGE_WRITE_FAILED")

    def _reserve(self, run_id, shard_no, owner, ids):
        with self.sessions.begin() as session:
            self._owned(session, run_id, shard_no, owner)
            attempts = dict(
                session.execute(
                    sa.update(ScanItem)
                    .where(
                        ScanItem.scan_run_id == run_id,
                        ScanItem.node_id.in_(ids),
                        ScanItem.status != "DONE",
                    )
                    .values(attempts=ScanItem.attempts + 1, updated_at=now())
                    .returning(ScanItem.node_id, ScanItem.attempts)
                ).all()
            )
            rows = session.execute(
                sa.select(Node, NodeCurrentStatus)
                .outerjoin(NodeCurrentStatus, Node.id == NodeCurrentStatus.node_id)
                .where(Node.id.in_(attempts))
            )
            jobs = []
            for node, current in rows:
                identity = json.loads(bytes(node.config_data))
                context = dict(
                    round_id=str(run_id),
                    next_full_check_at=current.next_full_check_at if current else None,
                    probe_key=current.probe_key if current else None,
                )
                jobs.append((node.id, attempts[node.id], identity, node.short_id, context))
            return sorted(jobs, key=lambda job: str(job[0]))

    def run_shard(self, run_id: UUID, shard_no: int):
        owner = uuid4()
        if not self.claim(run_id, shard_no, owner):
            return {"status": "COMPLETED", "skipped": True}
        from app.usage import COUNTERS, Usage

        started_at, outcome = now(), "ENVIRONMENT_ERROR"
        counts = {"check_count": 0, "check_duration_ms": 0, "timeout_checks": 0}
        checkers, available = [], Queue()
        cache = EndpointCache(self.settings)

        def usage(status):
            metrics = dict(counts)
            for checker in checkers:
                for source in (
                    getattr(checker, "metrics", {}),
                    getattr(getattr(checker, "echo", None), "metrics", {}),
                    getattr(getattr(checker, "runtime", None), "metrics", {}),
                ):
                    for key, value in source.items():
                        if key in COUNTERS:
                            metrics[key] = metrics.get(key, 0) + value
            caches = {id(cache): cache}
            caches.update(
                {
                    id(checker.cache): checker.cache
                    for checker in checkers
                    if hasattr(checker, "cache")
                }
            )
            for shared in caches.values():
                for key, value in shared.metrics.items():
                    metrics[key] = metrics.get(key, 0) + value
            return dict(
                started_at=started_at,
                scan_run_id=run_id,
                shard_no=shard_no,
                outcome=status,
                **metrics,
            )

        def check(job):
            checker = available.get()
            try:
                node_id, attempt, identity, short_id, context = job
                if hasattr(checker, "set_context"):
                    checker.set_context(**context)
                started = time.monotonic()
                result = checker.check(identity, short_id)
                result.checked_at = result.checked_at or now()
                if result.check_duration_ms is None:
                    result.check_duration_ms = max(0, round((time.monotonic() - started) * 1000))
                return node_id, attempt, result
            finally:
                available.put(checker)

        Usage(self.sessions).best_effort(owner, "CHECK", **usage("RUNNING"))
        try:
            with self.sessions() as session:
                self.assets._verify_keys(session)
                ids = list(
                    session.scalars(
                        sa.select(ScanItem.node_id)
                        .where(
                            ScanItem.scan_run_id == run_id,
                            ScanItem.shard_no == shard_no,
                            ScanItem.status != "DONE",
                        )
                        .order_by(ScanItem.node_id)
                    )
                )
            concurrency = min(self.settings.check_concurrency, max(1, len(ids)))
            for _ in range(concurrency):
                checker = (
                    self.checker_factory()
                    if self.checker_factory
                    else HealthChecker(self.settings, cache=cache)
                )
                checkers.append(checker)
                # Serial core/Echo preflights may exceed the original lease at high concurrency.
                with self.sessions.begin() as session:
                    self._owned(session, run_id, shard_no, owner)
                checker.preflight()
                available.put(checker)
            with ThreadPoolExecutor(
                max_workers=concurrency, thread_name_prefix="nodema-check"
            ) as executor:
                for offset in range(0, len(ids), self.settings.check_batch_size):
                    pending_ids = ids[offset : offset + self.settings.check_batch_size]
                    for retry in range(2):
                        if not pending_ids:
                            break
                        jobs = self._reserve(run_id, shard_no, owner, pending_ids)
                        futures = {executor.submit(check, job) for job in jobs}
                        completed = []
                        heartbeat = time.monotonic()
                        while futures:
                            done, futures = wait(futures, timeout=10, return_when=FIRST_COMPLETED)
                            completed.extend(f.result() for f in done)
                            if time.monotonic() - heartbeat >= 10:
                                with self.sessions.begin() as session:
                                    self._owned(session, run_id, shard_no, owner)
                                heartbeat = time.monotonic()
                        records, pending_ids, environment_error = [], [], None
                        for node_id, attempt, result in completed:
                            counts["check_count"] += 1
                            counts["check_duration_ms"] += result.check_duration_ms
                            counts["timeout_checks"] += int(bool(result.timeout_stages))
                            skipped = result.measurement_kind == "SKIPPED"
                            failed = result.status == "UNKNOWN" and not skipped
                            if failed and retry == 1:
                                result.status = "DOWN"
                            terminal = result.status in TERMINAL and not (failed and retry == 0)
                            records.append((node_id, attempt, result, terminal))
                            if result.status == "ENVIRONMENT_ERROR":
                                environment_error = result.error_code or "CHECK_ENVIRONMENT_ERROR"
                            elif not terminal:
                                pending_ids.append(node_id)
                        if len(records) == 1:
                            self._record(run_id, shard_no, owner, *records[0], usage("RUNNING"))
                        else:
                            self._record_many(run_id, shard_no, owner, records, usage("RUNNING"))
                        if environment_error:
                            raise AssetError(environment_error)
                        if pending_ids:
                            time.sleep(self.settings.retry_delay_seconds)
            with self.sessions.begin() as session:
                shard = self._owned(session, run_id, shard_no, owner)
                pending = session.scalar(
                    sa.select(sa.func.count())
                    .select_from(ScanItem)
                    .where(
                        ScanItem.scan_run_id == run_id,
                        ScanItem.shard_no == shard_no,
                        ScanItem.status != "DONE",
                    )
                )
                shard.status = "COMPLETED" if not pending else "PARTIAL"
                shard.finished_at = now() if not pending else None
                shard.lease_owner = shard.lease_until = None
            outcome = "COMPLETED" if not pending else "PARTIAL"
            return {"status": outcome}
        except Exception as error:
            code = error.code if isinstance(error, AssetError) else "WORKER_ENVIRONMENT_ERROR"
            with self.sessions.begin() as session:
                session.scalar(
                    sa.select(ScanRun).where(ScanRun.id == run_id).with_for_update(read=True)
                )
                shard = session.scalar(
                    sa.select(ScanShard)
                    .where(ScanShard.scan_run_id == run_id, ScanShard.shard_no == shard_no)
                    .with_for_update()
                )
                if shard and shard.lease_owner == owner:
                    shard.status, shard.error_summary = "ENVIRONMENT_ERROR", {"code": code}
                    shard.lease_owner = shard.lease_until = None
            raise AssetError(code) from None
        finally:
            for checker in checkers:
                checker.close()
            Usage(self.sessions).best_effort(owner, "CHECK", **usage(outcome))

    def finalize(self, run_id):
        with self.sessions.begin() as session:
            run = session.scalar(sa.select(ScanRun).where(ScanRun.id == run_id).with_for_update())
            if run is None:
                raise AssetError("SCAN_NOT_FOUND")
            if run.status == "COMPLETED" or run.archived_at is not None:
                return self._run_dto(run)
            shards = session.scalars(
                sa.select(ScanShard).where(ScanShard.scan_run_id == run_id)
            ).all()
            if any(s.status != "COMPLETED" for s in shards):
                run.status = (
                    "ENVIRONMENT_ERROR"
                    if any(s.status == "ENVIRONMENT_ERROR" for s in shards)
                    else "PARTIAL"
                )
                run.error_summary = {
                    "incomplete_shards": [s.shard_no for s in shards if s.status != "COMPLETED"]
                }
                # Publish nothing from an incomplete/environment-failed batch.
                return self._run_dto(run)
            pending = session.scalar(
                sa.select(sa.func.count())
                .select_from(ScanItem)
                .where(ScanItem.scan_run_id == run_id, ScanItem.status != "DONE")
            )
            if pending:
                run.status, run.error_summary = "PARTIAL", {"pending_items": pending}
                return self._run_dto(run)
            latest = (
                sa.select(TestResult.node_id, sa.func.max(TestResult.attempt_no).label("attempt"))
                .where(TestResult.scan_run_id == run_id)
                .group_by(TestResult.node_id)
                .subquery()
            )
            results = session.scalars(
                sa.select(TestResult)
                .join(
                    latest,
                    sa.and_(
                        TestResult.node_id == latest.c.node_id,
                        TestResult.attempt_no == latest.c.attempt,
                    ),
                )
                .where(TestResult.scan_run_id == run_id)
                .order_by(TestResult.node_id)
            ).all()
            if len(results) != run.node_count:
                raise AssetError("SCAN_RESULT_MISSING")
            current_rows, stat_rows = [], []
            for result in results:
                if result.status not in TERMINAL:
                    raise AssetError("SCAN_RESULT_MISSING")
                success = result.status in ("UP", "DEGRADED")
                current_rows.append(
                    {
                        "node_id": result.node_id,
                        "status": result.status,
                        "last_checked_at": result.checked_at,
                        "last_success_at": result.checked_at if success else None,
                        "last_error_code": result.error_code,
                        "consecutive_failures": int(result.status == "DOWN"),
                        "last_result_id": result.id,
                        "last_exit_ip": result.exit_ip,
                        "last_exit_country": result.exit_country,
                        "last_exit_asn": result.exit_asn,
                        "last_http_duration_ms": result.http_duration_ms,
                        "entry_country": result.entry_country,
                        "entry_asn": result.entry_asn,
                        "probe_key": result.probe_key,
                        "measurement_kind": result.measurement_kind,
                        "next_full_check_at": None,
                    }
                )
                success, failure = (
                    int(result.status in ("UP", "DEGRADED")),
                    int(result.status == "DOWN"),
                )
                stats = {
                    "node_id": result.node_id,
                    "stat_date": run.scan_date,
                    "scheduled_count": 1,
                    "successful_count": success,
                    "failed_count": failure,
                    "availability_ratio": success / (success + failure)
                    if success + failure
                    else None,
                    "avg_http_duration_ms": result.http_duration_ms,
                }
                stat_rows.append(stats)
            for offset in range(0, len(current_rows), 250):
                statement = insert(NodeCurrentStatus).values(current_rows[offset : offset + 250])
                excluded = statement.excluded
                updates = {key: excluded[key] for key in current_rows[0] if key != "node_id"}
                updates["last_success_at"] = sa.func.coalesce(
                    excluded.last_success_at, NodeCurrentStatus.last_success_at
                )
                same_probe = excluded.probe_key == NodeCurrentStatus.probe_key
                skipped = (excluded.measurement_kind == "SKIPPED") & same_probe
                failures = sa.case(
                    (skipped, NodeCurrentStatus.consecutive_failures),
                    (
                        excluded.status == "DOWN",
                        sa.case((same_probe, NodeCurrentStatus.consecutive_failures + 1), else_=1),
                    ),
                    else_=0,
                )
                updates["consecutive_failures"] = failures
                hours = sa.func.least(
                    self.settings.failure_cooldown_max_hours,
                    self.settings.failure_cooldown_base_hours
                    * sa.func.power(
                        2, sa.func.least(30, failures - self.settings.failure_cooldown_threshold)
                    ),
                )
                updates["next_full_check_at"] = sa.case(
                    (skipped, NodeCurrentStatus.next_full_check_at),
                    (
                        sa.and_(
                            self.settings.failure_cooldown_enabled,
                            excluded.status == "DOWN",
                            failures >= self.settings.failure_cooldown_threshold,
                        ),
                        excluded.last_checked_at + hours * sa.text("INTERVAL '1 hour'"),
                    ),
                    else_=None,
                )
                for key in (
                    "last_exit_ip",
                    "last_exit_country",
                    "last_exit_asn",
                    "last_http_duration_ms",
                    "entry_country",
                    "entry_asn",
                ):
                    updates[key] = sa.case(
                        (excluded.status.in_(("UP", "DEGRADED")), excluded[key]),
                        else_=sa.func.coalesce(excluded[key], getattr(NodeCurrentStatus, key)),
                    )
                session.execute(
                    statement.on_conflict_do_update(
                        index_elements=[NodeCurrentStatus.node_id],
                        set_=updates,
                        where=NodeCurrentStatus.last_checked_at < excluded.last_checked_at,
                    )
                )
                stats = insert(NodeDailyStats).values(stat_rows[offset : offset + 250])
                session.execute(
                    stats.on_conflict_do_update(
                        index_elements=[NodeDailyStats.node_id, NodeDailyStats.stat_date],
                        set_={
                            key: stats.excluded[key]
                            for key in stat_rows[0]
                            if key not in ("node_id", "stat_date")
                        },
                    )
                )
            run.status, run.error_summary = "COMPLETED", {}
            run.finished_at = run.finished_at or now()
            session.flush()
            session.execute(
                sa.text("SELECT nodema_refresh_runner_summaries(CAST(:ids AS uuid[]))"),
                {"ids": [r.node_id for r in results]},
            )
            return self._run_dto(run)

    def cleanup(self):
        at = now()
        raw_cutoff = at - timedelta(days=self.settings.detail_retention_days)
        local_day = at.astimezone(ZoneInfo(self.settings.scan_timezone)).date()
        day_cutoff = local_day - timedelta(days=self.settings.detail_retention_days - 1)
        total = {
            "deleted_results": 0,
            "deleted_daily_stats": 0,
            "archived_runs": 0,
            "deleted_scan_items": 0,
            "deleted_scan_shards": 0,
        }
        with self.sessions.begin() as session:
            state = session.get(CatalogState, 1, with_for_update=True)
            state.closed_before = max(state.closed_before or day_cutoff, day_cutoff)
        with self.sessions.begin() as session:
            total["deleted_results"] = session.execute(
                sa.delete(TestResult).where(
                    TestResult.checked_at < raw_cutoff,
                    sa.exists(
                        sa.select(ScanRun.id).where(
                            ScanRun.id == TestResult.scan_run_id, ScanRun.status == "COMPLETED"
                        )
                    ),
                )
            ).rowcount
            total["deleted_daily_stats"] = session.execute(
                sa.delete(NodeDailyStats).where(
                    NodeDailyStats.stat_date
                    < local_day - timedelta(days=self.settings.stats_retention_days - 1)
                )
            ).rowcount
        while True:
            with self.sessions.begin() as session:
                active = sa.exists(
                    sa.select(ScanShard.shard_no).where(
                        ScanShard.scan_run_id == ScanRun.id, ScanShard.lease_until > at
                    )
                )
                recent = sa.exists(
                    sa.select(TestResult.id).where(
                        TestResult.scan_run_id == ScanRun.id, TestResult.checked_at >= raw_cutoff
                    )
                )
                runs = session.scalars(
                    sa.select(ScanRun)
                    .where(
                        ScanRun.archived_at.is_(None),
                        ScanRun.scan_date < day_cutoff,
                        sa.func.coalesce(ScanRun.finished_at, ScanRun.started_at) < raw_cutoff,
                        ~active,
                        ~recent,
                    )
                    .order_by(ScanRun.scan_date, ScanRun.id)
                    .limit(100)
                    .with_for_update(skip_locked=True)
                ).all()
                if not runs:
                    break
                for run in runs:
                    # All writers lock the parent before the shard; no new claim can enter here.
                    shards = session.scalars(
                        sa.select(ScanShard)
                        .where(ScanShard.scan_run_id == run.id)
                        .with_for_update()
                    ).all()
                    if any(s.lease_until and s.lease_until > now() for s in shards):
                        continue
                    items = dict(
                        session.execute(
                            sa.select(ScanItem.status, sa.func.count())
                            .where(ScanItem.scan_run_id == run.id)
                            .group_by(ScanItem.status)
                        ).all()
                    )
                    statuses = {}
                    for shard in shards:
                        statuses[shard.status] = statuses.get(shard.status, 0) + 1
                    run.archive_summary = {
                        "items": items,
                        "shards": statuses,
                        "node_count": run.node_count,
                        "shard_count": run.shard_count,
                    }
                    run.archived_at = at
                    total["deleted_results"] += session.execute(
                        sa.delete(TestResult).where(TestResult.scan_run_id == run.id)
                    ).rowcount
                    total["deleted_scan_items"] += session.execute(
                        sa.delete(ScanItem).where(ScanItem.scan_run_id == run.id)
                    ).rowcount
                    # Keep numeric usage history, detach its expiring shard detail FK.
                    session.execute(
                        sa.update(UsageEvent)
                        .where(UsageEvent.scan_run_id == run.id)
                        .values(shard_no=None)
                    )
                    total["deleted_scan_shards"] += session.execute(
                        sa.delete(ScanShard).where(ScanShard.scan_run_id == run.id)
                    ).rowcount
                    total["archived_runs"] += 1
        return total
