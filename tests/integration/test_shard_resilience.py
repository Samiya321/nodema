"""One bad node must never discard a whole shard; Runner-wide failures still abort."""

import pytest
import sqlalchemy as sa

from app.checker.health import Observation
from app.database.models import NodeCurrentStatus, ScanShard
from app.domain import AssetError, SourceType
from app.scans import ScanService

pytestmark = pytest.mark.integration


def imported(service, fixture_bytes, count):
    raw = fixture_bytes("sample_vless.txt")
    lines = [raw.replace(b"000001", f"{index:06d}".encode()) for index in range(1, count + 1)]
    source = service.create_source(
        name="synthetic", source_type=SourceType.RAW_TEXT, payload=b"\n".join(lines)
    )
    service.sync_source(source["id"])


class Scripted:
    """Outcome per node uuid suffix; falls back to UP."""

    def __init__(self, plan):
        self.plan, self.calls = plan, []

    def preflight(self):
        pass

    def close(self):
        pass

    def check(self, identity, short_id):
        key = identity["uuid"][-2:]
        self.calls.append(key)
        outcomes = self.plan.get(key)
        status, code = outcomes.pop(0) if outcomes else ("UP", None)
        up = status == "UP"
        return Observation(
            status=status,
            error_code=code,
            exit_ip="8.8.8.8" if up else None,
            exit_country="JP" if up else None,
            http_duration_ms=10 if up else None,
        )


def run_all(scans):
    run = scans.create()
    for shard in scans.get(run["id"])["shards"]:
        scans.run_shard(run["id"], shard["shard_no"])
    return run, scans.finalize(run["id"])


def test_single_node_dns_failure_does_not_abort_shard(service, monitor_settings, fixture_bytes):
    imported(service, fixture_bytes, 4)
    checker = Scripted({"02": [("UNKNOWN", "DNS_TIMEOUT"), ("UNKNOWN", "DNS_TIMEOUT")]})
    scans = ScanService(service, monitor_settings, checker_factory=lambda: checker)
    _, result = run_all(scans)
    assert result["status"] == "COMPLETED"
    with service.sessions() as session:
        statuses = sorted(session.scalars(sa.select(NodeCurrentStatus.status)).all())
    assert statuses == ["DOWN", "UP", "UP", "UP"]


def test_isolated_runtime_error_is_retried_then_unknown(service, monitor_settings, fixture_bytes):
    imported(service, fixture_bytes, 3)
    failure = ("ENVIRONMENT_ERROR", "MIHOMO_START_FAILED")
    checker = Scripted({"01": [failure, failure]})
    scans = ScanService(service, monitor_settings, checker_factory=lambda: checker)
    _, result = run_all(scans)
    assert result["status"] == "COMPLETED"
    assert checker.calls.count("01") == 2
    with service.sessions() as session:
        statuses = sorted(session.scalars(sa.select(NodeCurrentStatus.status)).all())
    assert statuses == ["UNKNOWN", "UP", "UP"]


def test_runner_wide_failures_trip_circuit_breaker(service, monitor_settings, fixture_bytes):
    imported(service, fixture_bytes, 4)
    failure = ("ENVIRONMENT_ERROR", "MIHOMO_START_FAILED")
    checker = Scripted({f"{i:02d}": [failure] for i in range(1, 5)})
    settings = monitor_settings.model_copy(update={"environment_error_limit": 3})
    scans = ScanService(service, settings, checker_factory=lambda: checker)
    run = scans.create()
    with pytest.raises(AssetError, match="MIHOMO_START_FAILED"):
        scans.run_shard(run["id"], 0)
    assert scans.finalize(run["id"])["status"] == "ENVIRONMENT_ERROR"


def test_incomplete_run_publishes_successes_but_never_failures(
    service, monitor_settings, fixture_bytes
):
    imported(service, fixture_bytes, 3)
    # Node 02 fails, then the Runner itself breaks during the retry pass.
    checker = Scripted(
        {
            "02": [
                ("UNKNOWN", "ECHO_REQUEST_FAILED"),
                ("ENVIRONMENT_ERROR", "ECHO_ENVIRONMENT_ERROR"),
            ]
        }
    )
    scans = ScanService(service, monitor_settings, checker_factory=lambda: checker)
    run = scans.create()
    with pytest.raises(AssetError, match="ECHO_ENVIRONMENT_ERROR"):
        scans.run_shard(run["id"], 0)
    assert scans.finalize(run["id"])["status"] == "ENVIRONMENT_ERROR"
    with service.sessions() as session:
        assert session.scalars(sa.select(NodeCurrentStatus.status)).all() == ["UP", "UP"]
        shard = session.scalars(sa.select(ScanShard)).one()
        assert shard.status == "ENVIRONMENT_ERROR"
    scans.run_shard(run["id"], 0)
    assert scans.finalize(run["id"])["status"] == "COMPLETED"
    with service.sessions() as session:
        assert len(session.scalars(sa.select(NodeCurrentStatus)).all()) == 3


def test_parallel_window_checks_every_node_once(service, monitor_settings, fixture_bytes):
    imported(service, fixture_bytes, 9)
    checker = Scripted({})
    settings = monitor_settings.model_copy(update={"check_concurrency": 4, "check_batch_size": 2})
    scans = ScanService(service, settings, checker_factory=lambda: checker)
    _, result = run_all(scans)
    assert result["status"] == "COMPLETED"
    assert sorted(checker.calls) == [f"{i:02d}" for i in range(1, 10)]
