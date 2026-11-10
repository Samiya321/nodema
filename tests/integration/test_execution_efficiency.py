import threading
import time
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
import sqlalchemy as sa

from app.catalog import Catalog
from app.checker.health import Observation
from app.database.models import NodeCurrentStatus, NodeDailyStats, RunnerNodeSummary, ScanItem
from app.database.models import TestResult as Result
from app.domain import SourceType
from app.quality import QualityService
from app.scans import ScanService
from app.usage import Usage

pytestmark = pytest.mark.integration
PROBE = "located:synthetic:JP:64512:4:echo:https-v1"


def source(service, count=1):
    row = service.create_source(
        name="synthetic",
        source_type=SourceType.RAW_TEXT,
        payload="\n".join(
            f"vless://{uuid4()}@fixture.example:443?security=tls" for _ in range(count)
        ).encode(),
    )
    service.sync_source(row["id"])


def finish(scans, day):
    run = scans.create(datetime.now(UTC).date() - timedelta(days=day))
    for shard in scans.get(run["id"])["shards"]:
        scans.run_shard(run["id"], shard["shard_no"])
    assert scans.finalize(run["id"])["status"] == "COMPLETED"
    return run


def test_parallel_batches_reduce_roundtrips_and_isolate_workers(
    service, monitor_settings, db_engine
):
    source(service, 24)
    lock, state = (
        threading.Lock(),
        {"active": 0, "peak": 0, "queries": 0, "seen": {}, "created": 0, "closed": 0},
    )

    class Checker:
        busy = False

        def __init__(self):
            state["created"] += 1

        def preflight(self):
            pass

        def close(self):
            state["closed"] += 1

        def check(self, identity, short_id):
            assert not self.busy
            self.busy = True
            with lock:
                state["active"] += 1
                state["peak"] = max(state["peak"], state["active"])
                calls = state["seen"].get(short_id, 0)
                state["seen"][short_id] = calls + 1
            time.sleep(0.01)
            with lock:
                state["active"] -= 1
            self.busy = False
            return Observation(status="UNKNOWN" if not calls else "UP", probe_key=PROBE)

    def count(*args):
        state["queries"] += 1

    settings = monitor_settings.model_copy(update={"check_concurrency": 4, "check_batch_size": 12})
    scans = ScanService(service, settings, checker_factory=Checker)
    run = scans.create()
    sa.event.listen(db_engine, "before_cursor_execute", count)
    try:
        scans.run_shard(run["id"], 0)
    finally:
        sa.event.remove(db_engine, "before_cursor_execute", count)
    assert 1 < state["peak"] <= 4
    assert state["created"] == state["closed"] == 4
    assert state["queries"] < 24 * 4
    assert scans.finalize(run["id"])["status"] == "COMPLETED"
    with service.sessions() as session:
        assert session.scalar(sa.select(sa.func.count()).select_from(Result)) == 48
        assert (
            session.scalar(
                sa.select(sa.func.count()).select_from(ScanItem).where(ScanItem.status == "DONE")
            )
            == 24
        )
    assert Usage(service.sessions).summary()["totals"]["check_count"] == 48


def test_cooldown_publication_is_idempotent_skips_do_not_extend_failures(service, monitor_settings):
    source(service)
    settings = monitor_settings.model_copy(update={"failure_cooldown_enabled": True})

    class Checker:
        status, kind, probe = "DOWN", "FULL", PROBE

        def preflight(self):
            pass

        def close(self):
            pass

        def check(self, *args):
            return Observation(status=self.status, measurement_kind=self.kind, probe_key=self.probe)

    checker = Checker()
    scans = ScanService(service, settings, checker_factory=lambda: checker)
    for day in (6, 5, 4):
        finish(scans, day)
    with service.sessions() as session:
        current = session.scalars(sa.select(NodeCurrentStatus)).one()
        previous = current.next_full_check_at
        assert current.consecutive_failures == 3
        assert 5.9 < (previous - current.last_checked_at).total_seconds() / 3600 < 6.1
    checker.status, checker.kind = "UNKNOWN", "SKIPPED"
    skipped = finish(scans, 3)
    scans.finalize(skipped["id"])
    with service.sessions() as session:
        current = session.scalars(sa.select(NodeCurrentStatus)).one()
        assert current.consecutive_failures == 3 and current.next_full_check_at == previous
        stats = session.get(NodeDailyStats, (current.node_id, skipped["scan_date"]))
        assert stats.scheduled_count == 1 and stats.failed_count == stats.successful_count == 0
        assert stats.availability_ratio is None
        assert session.scalars(sa.select(RunnerNodeSummary)).one().sample_count == 3
    checker.status, checker.kind = "DOWN", "FULL"
    finish(scans, 2)
    with service.sessions() as session:
        current = session.scalars(sa.select(NodeCurrentStatus)).one()
        assert current.consecutive_failures == 4
        assert (current.next_full_check_at - current.last_checked_at).total_seconds() == 12 * 3600
    checker.probe = "different-runner"
    finish(scans, 1)
    with service.sessions() as session:
        current = session.scalars(sa.select(NodeCurrentStatus)).one()
        assert current.consecutive_failures == 1 and current.next_full_check_at is None
    checker.status = "UP"
    finish(scans, 0)
    with service.sessions() as session:
        current = session.scalars(sa.select(NodeCurrentStatus)).one()
        assert current.consecutive_failures == 0 and current.next_full_check_at is None


def test_runner_statistics_use_final_full_outcomes_same_probe_and_window(service, monitor_settings):
    source(service)

    class Checker:
        outcomes = []
        probe, kind = PROBE, "FULL"

        def preflight(self):
            pass

        def close(self):
            pass

        def check(self, *args):
            status = self.outcomes.pop(0)
            return Observation(
                status=status,
                probe_key=self.probe,
                measurement_kind=self.kind,
                http_duration_ms=20 if status == "UP" else None,
                timeout_stages=["HTTPS"] if status == "UNKNOWN" else [],
            )

    checker = Checker()
    scans = ScanService(service, monitor_settings, checker_factory=lambda: checker)
    checker.outcomes = ["UNKNOWN", "UP"]
    finish(scans, 6)  # The failed attempt must not count separately.
    checker.outcomes = ["UNKNOWN", "UNKNOWN"]
    finish(scans, 5)
    checker.outcomes, checker.kind = ["UNKNOWN"], "SKIPPED"
    finish(scans, 4)
    checker.outcomes, checker.kind = ["DOWN"], "PREFLIGHT"
    finish(scans, 3)
    checker.outcomes, checker.kind, checker.probe = ["UP"], "FULL", "runner2"
    finish(scans, 2)
    checker.outcomes, checker.probe = ["ENVIRONMENT_ERROR"], PROBE
    run = scans.create(datetime.now(UTC).date() - timedelta(days=1))
    from app.domain import AssetError

    with pytest.raises(AssetError):
        scans.run_shard(run["id"], 0)
    with service.sessions() as session:
        summary = session.scalars(
            sa.select(RunnerNodeSummary).where(RunnerNodeSummary.probe_key == PROBE)
        ).one()
        assert summary.sample_count == 2 and summary.success_rate == summary.timeout_rate == 0.5
        assert summary.http_p50_ms == summary.http_p95_ms == 20
        assert (
            session.scalars(
                sa.select(RunnerNodeSummary).where(RunnerNodeSummary.probe_key == "runner2")
            )
            .one()
            .sample_count
            == 1
        )
    # Refresh after aging one full sample out of the measurement window.
    with service.sessions.begin() as session:
        oldest = session.scalars(sa.select(Result).order_by(Result.id)).first()
        session.execute(
            sa.update(Result)
            .where(Result.scan_run_id == oldest.scan_run_id)
            .values(checked_at=datetime.now(UTC) - timedelta(days=8))
        )
    QualityService(service).refresh_metrics()
    with service.sessions() as session:
        summary = session.scalars(
            sa.select(RunnerNodeSummary).where(RunnerNodeSummary.probe_key == PROBE)
        ).one()
        assert summary.sample_count == 1 and summary.success_rate == 0
    assert Catalog(service, monitor_settings).nodes()["total"] == 1


def test_slow_preflights_keep_the_shard_lease_alive(service, monitor_settings, monkeypatch):
    import app.scans as module

    source(service, 4)
    clock = [datetime.now(UTC)]
    monkeypatch.setattr(module, "now", lambda: clock[0])

    class SlowPreflight:
        def preflight(self):
            clock[0] += timedelta(seconds=80)

        def close(self):
            pass

        def check(self, *args):
            return Observation(status="UP", probe_key=PROBE)

    settings = monitor_settings.model_copy(
        update={"check_concurrency": 4, "check_batch_size": 4, "shard_lease_seconds": 180}
    )
    scans = ScanService(service, settings, checker_factory=SlowPreflight)
    run = scans.create()
    assert scans.run_shard(run["id"], 0)["status"] == "COMPLETED"


def test_batch_publication_preserves_each_observation_completion_time(service, monitor_settings):
    source(service, 4)
    completed_at = datetime.now(UTC) - timedelta(minutes=10)

    class Checker:
        def preflight(self):
            pass

        def close(self):
            pass

        def check(self, *args):
            return Observation(status="UP", probe_key=PROBE, checked_at=completed_at)

    settings = monitor_settings.model_copy(update={"check_concurrency": 4, "check_batch_size": 4})
    scans = ScanService(service, settings, checker_factory=Checker)
    finish(scans, 0)
    with service.sessions() as session:
        assert set(session.scalars(sa.select(Result.checked_at))) == {completed_at}
        assert set(session.scalars(sa.select(NodeCurrentStatus.last_success_at))) == {completed_at}


def test_usage_write_failure_does_not_rollback_successful_checks(service, monitor_settings):
    source(service, 4)
    with service.sessions.begin() as session:
        session.execute(
            sa.text("""CREATE FUNCTION reject_usage() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'synthetic telemetry storage failure'; END $$""")
        )
        session.execute(
            sa.text(
                "CREATE TRIGGER reject_usage BEFORE INSERT ON usage_events "
                "FOR EACH ROW EXECUTE FUNCTION reject_usage()"
            )
        )

    class Checker:
        def preflight(self):
            pass

        def close(self):
            pass

        def check(self, *args):
            return Observation(status="UP", probe_key=PROBE)

    settings = monitor_settings.model_copy(update={"check_concurrency": 4, "check_batch_size": 4})
    scans = ScanService(service, settings, checker_factory=Checker)
    finish(scans, 0)
    with service.sessions() as session:
        assert session.scalar(sa.select(sa.func.count()).select_from(Result)) == 4
        assert session.scalar(sa.select(sa.func.count()).select_from(NodeCurrentStatus)) == 4
