import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
import sqlalchemy as sa
from fastapi.testclient import TestClient

from app.actions_usage import collect_actions
from app.api import create_app
from app.checker.health import Observation
from app.database.models import ActionRun, DatabaseSample, ScanShard, UsageEvent
from app.domain import AssetError, SourceType
from app.exports import ExportService
from app.scans import ScanService
from app.usage import Usage

pytestmark = pytest.mark.integration


class Meter:
    def __init__(self):
        self.metrics = {"echo_requests": 0, "echo_failures": 0, "echo_response_bytes": 0}


class Checker:
    def __init__(self):
        self.echo = Meter()
        self.calls = 0

    def preflight(self):
        self.echo.metrics["echo_requests"] += 1
        self.echo.metrics["echo_response_bytes"] += 100

    def close(self):
        pass

    def check(self, *args):
        self.calls += 1
        self.echo.metrics["echo_requests"] += 1
        self.echo.metrics["echo_response_bytes"] += 100
        failed = self.calls == 1
        self.echo.metrics["echo_failures"] += int(failed)
        return Observation(
            status="UNKNOWN" if failed else "UP",
            error_code="ECHO_TIMEOUT" if failed else None,
            timeout_stages=["HTTPS"] if failed else [],
            check_duration_ms=self.calls * 10,
            exit_ip=None if failed else "8.8.8.8",
            exit_country=None if failed else "JP",
            http_duration_ms=5,
        )


def test_usage_counts_retry_and_downloads_without_duplicate_publication(
    service, monitor_settings, fixture_bytes
):
    source = service.create_source(
        name="synthetic", source_type=SourceType.RAW_TEXT, payload=fixture_bytes("sample_vless.txt")
    )
    service.sync_source(source["id"])
    checker = Checker()
    scans = ScanService(service, monitor_settings, checker_factory=lambda: checker)
    run = scans.create()
    scans.run_shard(run["id"], 0)
    scans.finalize(run["id"])
    scans.finalize(run["id"])
    usage = Usage(service.sessions)
    result = usage.summary()
    assert result["totals"]["check_count"] == 2 and result["totals"]["echo_requests"] == 3
    assert result["totals"]["echo_failures"] == 1 and result["totals"]["echo_response_bytes"] == 300
    assert result["health"]["attempts"] == 2 and result["health"]["timeout_ratio"] == 0.5
    assert (
        result["health"]["mean_check_ms"] == 15
        and result["executions"]["completed_executions"] == 1
    )
    exports = ExportService(service, monitor_settings)
    artifact = exports.create("json", build=True)
    raw, _, _ = exports.download(artifact["id"], artifact["token"])
    exports.download(artifact["id"], artifact["token"])
    with pytest.raises(AssetError):
        exports.download(artifact["id"], "wrong-token")
    result = usage.summary()
    assert result["totals"]["subscription_downloads"] == 2
    assert result["totals"]["subscription_bytes"] == 2 * len(raw)
    assert artifact["token"] not in json.dumps(result, default=str)
    assert "00000000-0000-4000-8000" not in json.dumps(result, default=str)
    usage.database_sample()
    usage.database_sample()
    result = usage.summary()
    assert len(result["database_samples"]) == 2
    assert result["database_samples"][0]["table_bytes"] > 0
    assert result["database_growth_bytes"] is not None
    client = TestClient(create_app(monitor_settings, assets=service))
    assert client.get("/api/usage").status_code == 401
    headers = {"Authorization": "Bearer " + monitor_settings.admin_password.get_secret_value()}
    assert client.get("/api/usage", headers=headers).json()["totals"]["echo_requests"] == 3
    detail = client.get(f"/api/exports/{artifact['id']}", headers=headers)
    assert detail.status_code == 200
    assert detail.json()["id"] == str(artifact["id"])
    assert not {"token", "token_hash", "payload_data"} & detail.json().keys()


def test_interrupted_execution_is_reported_without_changing_node_status(
    service, monitor_settings, fixture_bytes
):
    source = service.create_source(
        name="synthetic", source_type=SourceType.RAW_TEXT, payload=fixture_bytes("sample_vless.txt")
    )
    service.sync_source(source["id"])
    scans = ScanService(service, monitor_settings)
    run = scans.create()
    owner = uuid4()
    scans.claim(run["id"], 0, owner)
    usage = Usage(service.sessions)
    usage.record(owner, "CHECK", scan_run_id=run["id"], shard_no=0)
    assert usage.summary()["executions"]["failed_executions"] == 0
    with service.sessions.begin() as session:
        shard = session.get(ScanShard, (run["id"], 0))
        shard.lease_until = datetime.now(UTC) - timedelta(seconds=1)
    assert usage.summary()["executions"]["failed_executions"] == 1
    assert usage.summary()["executions"]["failure_ratio"] == 1
    assert usage.summary()["recent"][0]["outcome"] == "INTERRUPTED"


def test_github_usage_is_trusted_idempotent_and_never_stores_job_names(service):
    at = datetime.now(UTC) - timedelta(minutes=3)

    def stamp(delta):
        return (at + timedelta(seconds=delta)).isoformat()

    metadata = {
        "id": 123456,
        "run_attempt": 1,
        "repository": {"full_name": "synthetic/repo"},
        "head_repository": {"full_name": "synthetic/repo"},
        "head_branch": "main",
        "event": "workflow_dispatch",
        "path": ".github/workflows/daily-check.yml",
        "status": "completed",
        "conclusion": "failure",
        "run_started_at": stamp(0),
        "updated_at": stamp(180),
    }
    jobs = [
        {
            "id": 1,
            "run_id": 123456,
            "conclusion": "success",
            "started_at": stamp(0),
            "completed_at": stamp(61),
            "name": "vless://synthetic-secret",
        },
        {
            "id": 2,
            "run_id": 123456,
            "conclusion": "failure",
            "started_at": stamp(0),
            "completed_at": stamp(120),
        },
        {
            "id": 3,
            "run_id": 123456,
            "conclusion": "skipped",
            "started_at": None,
            "completed_at": None,
        },
    ]

    def get(path):
        return metadata if not path else {"total_count": 3, "jobs": jobs}

    for _ in range(2):
        result = collect_actions(
            service.sessions, "synthetic/repo", "synthetic-token", 123456, 1, get=get
        )
        assert result["runner_ms"] == 181000 and result["failed_jobs"] == 1
    with service.sessions() as session:
        assert session.scalar(sa.select(sa.func.count()).select_from(ActionRun)) == 1
    summary = Usage(service.sessions).summary()
    assert summary["runner_minutes"] == pytest.approx(181 / 60)
    assert "synthetic-secret" not in json.dumps(summary, default=str)
    metadata["head_repository"] = {"full_name": "untrusted/fork"}
    with pytest.raises(AssetError, match="UNTRUSTED_ACTIONS_RUN"):
        collect_actions(service.sessions, "synthetic/repo", "synthetic-token", 123456, 1, get=get)
    metadata["head_repository"] = None
    with pytest.raises(AssetError, match="UNTRUSTED_ACTIONS_RUN"):
        collect_actions(service.sessions, "synthetic/repo", "synthetic-token", 123456, 1, get=get)


def test_usage_snapshot_is_idempotent_and_validates_counters(service):
    usage = Usage(service.sessions)
    event_id = uuid4()
    usage.record(
        event_id,
        "SUBSCRIPTION",
        outcome="COMPLETED",
        subscription_downloads=1,
        subscription_bytes=100,
    )
    usage.record(
        event_id,
        "SUBSCRIPTION",
        outcome="COMPLETED",
        subscription_downloads=1,
        subscription_bytes=100,
    )
    assert usage.summary()["totals"]["subscription_downloads"] == 1
    with pytest.raises(AssetError):
        usage.record(uuid4(), "SOURCE", url="synthetic-secret")
    with pytest.raises(AssetError):
        usage.record(uuid4(), "SOURCE", source_requests=-1)
    with service.sessions() as session:
        assert session.scalar(sa.select(sa.func.count()).select_from(UsageEvent)) == 1


def test_usage_totals_are_not_truncated_to_display_limits(service):
    at = datetime.now(UTC) - timedelta(seconds=2000)
    with service.sessions.begin() as session:
        session.execute(
            sa.insert(ActionRun),
            [
                {
                    "run_id": i + 1,
                    "attempt": 1,
                    "workflow": "daily-check",
                    "conclusion": "success",
                    "started_at": at + timedelta(seconds=i),
                    "finished_at": at + timedelta(seconds=i + 1),
                    "runner_ms": 60000,
                    "job_count": 1,
                    "failed_jobs": 0,
                    "unmeasured_jobs": 0,
                }
                for i in range(1001)
            ],
        )
        session.execute(
            sa.insert(DatabaseSample),
            [
                {
                    "id": uuid4(),
                    "taken_at": at + timedelta(seconds=i),
                    "database_bytes": 10000 + i,
                    "table_bytes": 1000 + i,
                    "connections": 2,
                }
                for i in range(1001)
            ],
        )
    summary = Usage(service.sessions).summary(days=2)
    assert len(summary["action_runs"]) == len(summary["database_samples"]) == 1000
    assert summary["runner_minutes"] == 1001
    assert summary["database_growth_bytes"] == 1000
