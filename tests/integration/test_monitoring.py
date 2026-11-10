import json
from datetime import timedelta
from uuid import uuid4

import pytest
import sqlalchemy as sa
from fastapi.testclient import TestClient

from app.api import create_app
from app.catalog import Catalog
from app.checker.health import Observation
from app.database.models import (
    ExportArtifact,
    NodeCurrentStatus,
    NodeDailyStats,
    ScanItem,
    ScanRun,
    ScanShard,
)
from app.database.models import TestResult as Result
from app.domain import AssetError, SourceType
from app.exports import ExportService
from app.scans import ScanService, now

pytestmark = pytest.mark.integration


class Checker:
    def __init__(self, outcomes=None, fail_preflight=False):
        self.outcomes = list(outcomes or [])
        self.fail_preflight = fail_preflight
        self.calls = []

    def preflight(self):
        if self.fail_preflight:
            raise AssetError("ECHO_ENVIRONMENT_ERROR")

    def check(self, identity, short_id):
        self.calls.append(identity["uuid"])
        status = self.outcomes.pop(0) if self.outcomes else "UP"
        return Observation(
            status=status,
            exit_ip="8.8.8.8" if status == "UP" else None,
            exit_country="JP" if status == "UP" else None,
            entry_country="SG",
            exit_asn=64501,
            http_duration_ms=10,
            dns_status="SUCCESS",
            tcp_status="SUCCESS",
            proxy_status="SUCCESS" if status == "UP" else "FAILED",
            http_status="SUCCESS" if status == "UP" else "FAILED",
            error_code="ECHO_REQUEST_FAILED"
            if status == "UNKNOWN"
            else "ECHO_ENVIRONMENT_ERROR"
            if status == "ENVIRONMENT_ERROR"
            else None,
        )

    def close(self):
        pass


def imported(service, fixture_bytes, count=1):
    raw = fixture_bytes("sample_vless.txt")
    if count > 1:
        raw += raw.replace(b"000001", b"000002")
    source = service.create_source(name="synthetic", source_type=SourceType.RAW_TEXT, payload=raw)
    service.sync_source(source["id"])
    return source["id"]


def complete(service, settings, fixture_bytes, outcomes=None):
    imported(service, fixture_bytes)
    checker = Checker(outcomes)
    scans = ScanService(service, settings, checker_factory=lambda: checker)
    run = scans.create()
    for shard in scans.get(run["id"])["shards"]:
        scans.run_shard(run["id"], shard["shard_no"])
    assert scans.finalize(run["id"])["status"] == "COMPLETED"
    return scans, run, checker


def test_snapshot_once_retry_success_and_idempotent_finalization(
    service, monitor_settings, fixture_bytes
):
    scans, run, checker = complete(service, monitor_settings, fixture_bytes, ["UNKNOWN", "UP"])
    assert scans.create()["id"] == run["id"]
    assert len(checker.calls) == 2
    scans.finalize(run["id"])
    with service.sessions() as session:
        assert len(session.scalars(sa.select(Result)).all()) == 2
        assert session.scalars(sa.select(NodeCurrentStatus)).one().status == "UP"
        assert len(session.scalars(sa.select(NodeDailyStats)).all()) == 1
    assert scans.run_shard(run["id"], 0)["skipped"]


def test_two_failures_required_for_down(service, monitor_settings, fixture_bytes):
    scans, run, checker = complete(service, monitor_settings, fixture_bytes, ["UNKNOWN", "UNKNOWN"])
    with service.sessions() as session:
        current = session.scalars(sa.select(NodeCurrentStatus)).one()
        assert current.status == "DOWN" and current.consecutive_failures == 1
    scans.finalize(run["id"])
    with service.sessions() as session:
        assert session.scalars(sa.select(NodeCurrentStatus)).one().consecutive_failures == 1


def test_environment_error_never_publishes_batch_down_and_resume(
    service, monitor_settings, fixture_bytes
):
    imported(service, fixture_bytes, count=2)
    checker = Checker(["UNKNOWN", "UNKNOWN", "ENVIRONMENT_ERROR"])
    scans = ScanService(service, monitor_settings, checker_factory=lambda: checker)
    run = scans.create()
    with pytest.raises(AssetError, match="ECHO_ENVIRONMENT_ERROR"):
        scans.run_shard(run["id"], 0)
    assert scans.finalize(run["id"])["status"] == "ENVIRONMENT_ERROR"
    with service.sessions() as session:
        assert session.scalar(sa.select(sa.func.count()).select_from(NodeCurrentStatus)) == 0
        done = session.scalar(
            sa.select(sa.func.count()).select_from(ScanItem).where(ScanItem.status == "DONE")
        )
        # Retries are deferred to one pass at the end, so the first failure is still
        # pending when the Runner-wide Echo failure aborts the shard.
        assert done == 0
    scans.run_shard(run["id"], 0)
    assert scans.finalize(run["id"])["status"] == "COMPLETED"
    # Checks in flight when the Runner failed are never trusted, so both nodes resume.
    assert len(checker.calls) == 6


def test_preflight_failure_and_expired_lease_recovery(service, monitor_settings, fixture_bytes):
    imported(service, fixture_bytes)
    scans = ScanService(
        service, monitor_settings, checker_factory=lambda: Checker(fail_preflight=True)
    )
    run = scans.create()
    with pytest.raises(AssetError):
        scans.run_shard(run["id"], 0)
    owner, other = uuid4(), uuid4()
    assert scans.claim(run["id"], 0, owner)
    with pytest.raises(AssetError, match="SHARD_BUSY"):
        scans.claim(run["id"], 0, other)
    with service.sessions.begin() as session:
        shard = session.get(ScanShard, (run["id"], 0))
        shard.lease_until = now() - timedelta(seconds=1)
    assert scans.claim(run["id"], 0, other)
    with pytest.raises(AssetError, match="SHARD_LEASE_LOST"), service.sessions.begin() as session:
        scans._owned(session, run["id"], 0, owner)


@pytest.mark.parametrize("format", ["mihomo", "singbox", "uri", "json", "csv"])
def test_private_exports_freshness_revoke_and_no_internal_fields(
    service, monitor_settings, fixture_bytes, format
):
    complete(service, monitor_settings, fixture_bytes)
    exports = ExportService(service, monitor_settings)
    result = exports.create(format, build=True)
    assert result["node_count"] == 1
    payload, mime, suffix = exports.download(result["id"], result["token"])
    assert payload and mime and suffix
    if format in ("json", "csv"):
        assert b"00000000-0000-4000-8000" not in payload
        assert b"first_seen_at" in payload and b"eligible" not in payload
    else:
        assert b"00000000-0000-4000-8000" in payload
    with pytest.raises(AssetError):
        exports.download(result["id"], "wrong-token")
    with service.sessions() as session:
        stored = session.get(ExportArtifact, result["id"])
        assert result["token"].encode() not in stored.payload_data
    node_id = service.list_nodes()[0]["id"]
    service.set_node_enabled(node_id, False)
    with pytest.raises(AssetError, match="EXPORT_PENDING"):
        exports.download(result["id"], result["token"])
    assert exports.build_pending(result["id"])["ready"] == 1
    refreshed, _, _ = exports.download(result["id"], result["token"])
    assert b"edge.example" not in refreshed
    service.set_node_enabled(node_id, True)
    with service.sessions.begin() as session:
        current = session.get(NodeCurrentStatus, node_id)
        current.last_checked_at = current.last_success_at = now() - timedelta(hours=40)
    assert exports.create(format, build=True)["node_count"] == 0
    exports.revoke(result["id"])
    with pytest.raises(AssetError):
        exports.download(result["id"], result["token"])


def test_api_auth_redaction_management_and_export(service, monitor_settings, fixture_bytes):
    client = TestClient(create_app(monitor_settings, assets=service))
    assert client.get("/").status_code == 200
    assert client.get("/api/health").json() == {"status": "ok"}
    assert client.get("/api/sources").status_code == 401
    headers = {"Authorization": "Bearer " + monitor_settings.admin_password.get_secret_value()}
    raw = fixture_bytes("sample_vless.txt").decode()
    response = client.post(
        "/api/sources", headers=headers, json={"name": "demo", "type": "RAW_TEXT", "payload": raw}
    )
    assert response.status_code == 201, response.text
    assert "vless://" not in response.text
    source_id = response.json()["id"]
    assert (
        client.post(f"/api/sources/{source_id}/sync", headers=headers).json()["status"] == "SUCCESS"
    )
    node = client.get("/api/nodes", headers=headers).json()["items"][0]
    assert client.get("/api/nodes/" + node["id"] + "/aliases").status_code == 401
    assert client.get("/api/nodes/" + node["id"] + "/aliases", headers=headers).json()[0][
        "aliases"
    ] == ["Synthetic A"]
    assert client.get("/api/nodes/" + node["id"], headers=headers).status_code == 200
    assert (
        client.patch(
            "/api/nodes/" + node["id"], headers=headers, json={"enabled": False}
        ).status_code
        == 200
    )
    assert client.get("/api/nodes?offset=-1", headers=headers).status_code == 422
    bad = client.post(
        "/api/sources", headers=headers, json={"payload": "synthetic-auth-secret", "type": "bad"}
    )
    assert bad.status_code == 422 and "synthetic-auth-secret" not in bad.text
    assert (
        client.put(
            "/api/naming-rules", headers=headers, json={"template": "{SHORT_ID} {PROTOCOL}"}
        ).status_code
        == 200
    )
    assert client.get("/api/naming-rules", headers=headers).json()["history"]
    result = client.post("/api/exports", headers=headers, json={"format": "json"}).json()
    assert client.get(f"/subscriptions/{result['id']}?token={result['token']}").status_code == 503
    ExportService(service, monitor_settings).build_pending()
    assert client.get(f"/subscriptions/{result['id']}?token={result['token']}").json() == []
    assert client.delete("/api/exports/" + result["id"], headers=headers).status_code == 200
    assert client.get(f"/subscriptions/{result['id']}?token={result['token']}").status_code == 404
    assert client.delete("/api/sources/" + source_id, headers=headers).status_code == 200


def test_catalog_geography_naming_and_retention(service, monitor_settings, fixture_bytes):
    scans, run, _ = complete(service, monitor_settings, fixture_bytes)
    catalog = Catalog(service, monitor_settings)
    # Default: exit flag, entry->exit route, ASN label (number when no organization), number.
    assert catalog.nodes()["items"][0]["name"] == "🇯🇵SG->JP|AS64501 01"
    assert catalog.nodes(exit_country="US")["total"] == 0
    catalog.set_template("{SHORT_ID} | {EXIT_COUNTRY}")
    assert catalog.nodes()["items"][0]["name"].endswith("| JP")
    with service.sessions.begin() as session:
        session.execute(sa.update(Result).values(checked_at=now() - timedelta(days=100)))
    assert scans.cleanup()["deleted_results"] == 1
    assert scans.finalize(run["id"])["status"] == "COMPLETED"
    assert len(scans.get(run["id"])["shards"]) == 1


def test_workflow_cli_arguments_execute_prepare_worker_finalize(
    service, monitor_settings, fixture_bytes, monkeypatch, tmp_path
):
    from typer.testing import CliRunner

    import app.cli as cli

    imported(service, fixture_bytes)
    scans = ScanService(service, monitor_settings, checker_factory=Checker)
    monkeypatch.setattr(cli, "service", lambda: service)
    monkeypatch.setattr(cli, "Settings", lambda: monitor_settings)
    monkeypatch.setattr(cli, "ScanService", lambda *_: scans)
    github_output = tmp_path / "github-output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(github_output))
    runner = CliRunner()
    prepared = runner.invoke(cli.app, ["scan", "prepare"])
    assert prepared.exit_code == 0, prepared.output
    run_id = json.loads(prepared.output)["id"]
    assert "has_work=true" in github_output.read_text()
    worked = runner.invoke(cli.app, ["scan", "worker", "--run-id", run_id, "--shard", "0"])
    assert worked.exit_code == 0, worked.output
    finalized = runner.invoke(cli.app, ["scan", "finalize", "--run-id", run_id])
    assert finalized.exit_code == 0 and json.loads(finalized.output)["status"] == "COMPLETED"


def test_empty_daily_then_import_creates_immutable_supplement(
    service, monitor_settings, fixture_bytes
):
    scans = ScanService(service, monitor_settings, checker_factory=Checker)
    empty = scans.create()
    assert empty["node_count"] == 0 and empty["status"] == "COMPLETED"
    imported(service, fixture_bytes)
    supplement = scans.create()
    assert supplement["id"] != empty["id"] and supplement["kind"] == "SUPPLEMENTAL"
    scans.run_shard(supplement["id"], 0)
    scans.finalize(supplement["id"])
    assert scans.get(empty["id"])["node_count"] == 0
    assert scans.create()["id"] == supplement["id"]
    assert ExportService(service, monitor_settings).create("uri", build=True)["node_count"] == 1


def test_same_day_completed_daily_only_tests_new_nodes(service, monitor_settings, fixture_bytes):
    scans, daily, checker = complete(service, monitor_settings, fixture_bytes)
    raw = fixture_bytes("sample_vless.txt").replace(b"000001", b"000099")
    source = service.create_source(
        name="second batch", source_type=SourceType.RAW_TEXT, payload=raw
    )
    service.sync_source(source["id"])
    supplement = scans.create()
    assert supplement["kind"] == "SUPPLEMENTAL" and supplement["node_count"] == 1
    scans.run_shard(supplement["id"], 0)
    scans.finalize(supplement["id"])
    assert len(checker.calls) == 2
    assert scans.get(daily["id"])["node_count"] == 1
    with service.sessions() as session:
        assert len(session.scalars(sa.select(NodeCurrentStatus)).all()) == 2
        assert all(s.scheduled_count == 1 for s in session.scalars(sa.select(NodeDailyStats)))
    assert ExportService(service, monitor_settings).create("mihomo", build=True)["node_count"] == 2


def test_concurrent_supplement_creation_reserves_each_node_once(
    service, monitor_settings, fixture_bytes
):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    scans = ScanService(service, monitor_settings)
    scans.create()  # empty daily
    imported(service, fixture_bytes)
    barrier = Barrier(2)

    def prepare():
        barrier.wait(timeout=5)
        return scans.create()["id"]

    with ThreadPoolExecutor(max_workers=2) as pool:
        ids = list(pool.map(lambda _: prepare(), range(2)))
    assert ids[0] == ids[1]
    with service.sessions() as session:
        assert session.scalar(sa.select(sa.func.count()).select_from(ScanRun)) == 2
        assert session.scalar(sa.select(sa.func.count()).select_from(ScanItem)) == 1


def test_workflow_plan_resumes_failed_run_and_checks_new_import(
    service, monitor_settings, fixture_bytes, monkeypatch, tmp_path
):
    from typer.testing import CliRunner

    import app.cli as cli

    imported(service, fixture_bytes)
    checker = Checker(fail_preflight=True)
    scans = ScanService(service, monitor_settings, checker_factory=lambda: checker)
    failed = scans.create()
    with pytest.raises(AssetError):
        scans.run_shard(failed["id"], 0)
    scans.finalize(failed["id"])
    raw = fixture_bytes("sample_vless.txt").replace(b"000001", b"000088")
    source = service.create_source(name="new source", source_type=SourceType.RAW_TEXT, payload=raw)
    service.sync_source(source["id"])
    checker.fail_preflight = False
    monkeypatch.setattr(cli, "service", lambda: service)
    monkeypatch.setattr(cli, "Settings", lambda: monitor_settings)
    monkeypatch.setattr(cli, "ScanService", lambda *_: scans)
    path = tmp_path / "plan"
    monkeypatch.setenv("GITHUB_OUTPUT", str(path))
    runner = CliRunner()
    prepared = runner.invoke(cli.app, ["scan", "prepare"])
    assert prepared.exit_code == 0, prepared.output
    outputs = dict(line.split("=", 1) for line in path.read_text().splitlines())
    assert len(json.loads(outputs["run_ids"])) == 2
    tasks = [t for job in json.loads(outputs["workers"]) for t in json.loads(job["tasks_json"])]
    assert len(tasks) == 2
    assert (
        runner.invoke(
            cli.app, ["scan", "worker-batch", "--tasks-json", json.dumps(tasks)]
        ).exit_code
        == 0
    )
    result = runner.invoke(
        cli.app, ["scan", "finalize-batch", "--run-ids-json", outputs["run_ids"]]
    )
    assert result.exit_code == 0, result.output
    assert len(checker.calls) == 2
    assert ExportService(service, monitor_settings).create("uri", build=True)["node_count"] == 2
    assert scans.plan()["workers"] == []


def test_pending_request_is_synced_even_when_not_due(
    service, monitor_settings, fixture_bytes, monkeypatch
):
    from typer.testing import CliRunner

    import app.cli as cli

    source_id = imported(service, fixture_bytes)
    before = service.get_source(source_id)
    service.request_sync(source_id)
    assert service.get_source(source_id)["sync_requested_at"] is not None
    monkeypatch.setattr(cli, "service", lambda: service)
    monkeypatch.setattr(cli, "Settings", lambda: monitor_settings)
    result = CliRunner().invoke(cli.app, ["source", "sync-all", "--due-only"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)[0]["status"] == "UNCHANGED"
    after = service.get_source(source_id)
    assert after["sync_requested_at"] is None
    assert after["last_checked_at"] > before["last_checked_at"]


def test_readiness_checks_schema_and_keys_and_redacts_environment_failure(
    service, monitor_settings, fixture_bytes
):
    from app.readiness import readiness

    imported(service, fixture_bytes)
    assert readiness(service, monitor_settings)["ready"]
    failed = readiness(
        service,
        monitor_settings,
        network=True,
        checker_factory=lambda: Checker(fail_preflight=True),
    )
    assert not failed["ready"]
    assert failed["checks"]["runtime_and_echo"] == "ECHO_ENVIRONMENT_ERROR"


def test_new_sync_request_during_fetch_survives_optimistic_conflict(service, fixture_bytes):
    source = service.create_source(
        name="subscription",
        source_type=SourceType.SUBSCRIPTION_URL,
        payload=b"https://subscription.example/authorized",
    )

    class ConcurrentFetcher:
        def fetch(self, url):
            service.request_sync(source["id"])
            return fixture_bytes("sample_vless.txt")

    service.fetcher = ConcurrentFetcher()
    with pytest.raises(AssetError, match="SOURCE_CHANGED_RETRY"):
        service.sync_source(source["id"])
    assert service.get_source(source["id"])["sync_requested_at"] is not None
    assert service.list_nodes() == []


def test_upgrade_existing_monitoring_database_preserves_assets_and_history(
    service, monitor_settings, fixture_bytes, db_engine, migration_config
):
    from alembic import command

    scans, daily, _ = complete(service, monitor_settings, fixture_bytes)
    node_id = service.list_nodes()[0]["id"]
    with db_engine.begin() as connection:
        migration_config.attributes["connection"] = connection
        command.downgrade(migration_config, "0002_monitoring")
    with db_engine.begin() as connection:
        migration_config.attributes["connection"] = connection
        command.upgrade(migration_config, "head")
    assert service.list_nodes()[0]["id"] == node_id
    assert scans.get(daily["id"])["kind"] == "DAILY"
    assert scans.get(daily["id"])["status"] == "COMPLETED"
    assert ExportService(service, monitor_settings).create("uri", build=True)["node_count"] == 1


def test_finalizer_failure_does_not_hide_other_complete_batches(
    service, monitor_settings, fixture_bytes, monkeypatch
):
    from typer.testing import CliRunner

    import app.cli as cli

    scans = ScanService(service, monitor_settings, checker_factory=Checker)
    imported(service, fixture_bytes)
    first = scans.create()
    scans.run_shard(first["id"], 0)
    raw = fixture_bytes("sample_vless.txt").replace(b"000001", b"000066")
    source = service.create_source(name="next", source_type=SourceType.RAW_TEXT, payload=raw)
    service.sync_source(source["id"])
    second = scans.create()
    scans.run_shard(second["id"], 0)
    missing = uuid4()
    monkeypatch.setattr(cli, "service", lambda: service)
    monkeypatch.setattr(cli, "Settings", lambda: monitor_settings)
    monkeypatch.setattr(cli, "ScanService", lambda *_: scans)
    result = CliRunner().invoke(
        cli.app,
        [
            "scan",
            "finalize-batch",
            "--run-ids-json",
            json.dumps([str(missing), str(first["id"]), str(second["id"])]),
        ],
    )
    assert result.exit_code == 2, result.output
    assert scans.get(first["id"])["status"] == scans.get(second["id"])["status"] == "COMPLETED"
