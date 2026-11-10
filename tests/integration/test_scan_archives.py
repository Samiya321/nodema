"""Deleting old scan members must never reopen their dates or erase lifetime counts."""

from datetime import timedelta
from uuid import uuid4

import pytest
import sqlalchemy as sa
from fastapi.testclient import TestClient

from alembic import command
from app.api import create_app
from app.database.models import (
    CatalogState,
    Node,
    NodeDailyStats,
    ScanItem,
    ScanRun,
    ScanShard,
    UsageEvent,
)
from app.database.models import TestResult as Result
from app.domain import AssetError
from app.scans import ScanService, now
from tests.integration.test_monitoring import complete, imported

pytestmark = pytest.mark.integration


def test_archive_removes_detail_preserves_summary_and_lifetime(
    service, monitor_settings, fixture_bytes, monkeypatch, db_engine, migration_config
):
    old = now() - timedelta(days=400)
    with monkeypatch.context() as patch:
        patch.setattr("app.scans.now", lambda: old)
        scans, run, _ = complete(service, monitor_settings, fixture_bytes)
    with service.sessions() as session:
        node = session.scalar(sa.select(Node))
        original = (node.checked_days, node.available_days)
        assert original == (1, 1)
        assert session.scalar(sa.select(sa.func.count()).select_from(UsageEvent)) > 0
    cleaned = scans.cleanup()
    assert (
        cleaned["archived_runs"]
        == cleaned["deleted_scan_items"]
        == cleaned["deleted_scan_shards"]
        == 1
    )
    assert cleaned["deleted_daily_stats"] == cleaned["deleted_results"] == 1
    detail = scans.get(run["id"])
    assert detail["archived_at"] and detail["shards"] == []
    assert detail["items"] == {"DONE": 1}
    assert detail["node_count"] == 1
    with service.sessions() as session:
        node = session.scalar(sa.select(Node))
        assert (node.checked_days, node.available_days) == original
        for model in (ScanItem, ScanShard, Result, NodeDailyStats):
            assert session.scalar(sa.select(sa.func.count()).select_from(model)) == 0
        assert (
            session.scalar(sa.select(UsageEvent.shard_no).where(UsageEvent.kind == "CHECK")) is None
        )
    assert scans.create(run["scan_date"])["id"] == run["id"]
    assert scans.finalize(run["id"])["archived_at"]
    for operation in (lambda: scans.plan(run["id"]), lambda: scans.claim(run["id"], 0, uuid4())):
        with pytest.raises(AssetError, match="SCAN_ARCHIVED"):
            operation()
    with pytest.raises(AssetError, match="SCAN_DATE_ARCHIVED"):
        scans.create(run["scan_date"] - timedelta(days=1))
    assert scans.cleanup()["archived_runs"] == 0
    client = TestClient(create_app(monitor_settings, assets=service))
    headers = {"Authorization": "Bearer " + monitor_settings.admin_password.get_secret_value()}
    assert client.get(f"/api/scans/{run['id']}", headers=headers).json()["items"] == {"DONE": 1}
    assert client.post(f"/api/scans/{run['id']}/retry", headers=headers).status_code == 410
    with db_engine.begin() as conn:
        migration_config.attributes["connection"] = conn
        with pytest.raises(RuntimeError, match="ARCHIVED_SCANS_REQUIRE_BACKUP_FOR_DOWNGRADE"):
            command.downgrade(migration_config, "0010_async_exports")


def test_active_and_locked_runs_survive_archive_then_expired_lease_is_archived(
    service, monitor_settings, fixture_bytes, monkeypatch
):
    imported(service, fixture_bytes)
    scans = ScanService(service, monitor_settings)
    old = now() - timedelta(days=100)
    with monkeypatch.context() as patch:
        patch.setattr("app.scans.now", lambda: old)
        run = scans.create()
    owner = uuid4()
    scans.claim(run["id"], 0, owner)
    assert scans.cleanup()["archived_runs"] == 0
    with service.sessions.begin() as session:
        session.get(ScanShard, (run["id"], 0)).lease_until = now() - timedelta(seconds=1)
        session.get(ScanRun, run["id"]).started_at = old
    with service.sessions.begin() as session:
        session.scalar(sa.select(ScanRun).where(ScanRun.id == run["id"]).with_for_update())
        assert scans.cleanup()["archived_runs"] == 0  # SKIP LOCKED, not an indefinite wait.
    assert scans.cleanup()["archived_runs"] == 1
    assert scans.get(run["id"])["items"] == {"PENDING": 1}
    with service.sessions() as session:
        closed = session.get(CatalogState, 1).closed_before
    assert closed > run["scan_date"]


def test_cleanup_preserves_old_completed_items_in_an_active_partial_run(
    service, monitor_settings, fixture_bytes, monkeypatch
):
    from tests.integration.test_monitoring import Checker

    imported(service, fixture_bytes, count=2)
    scans = ScanService(
        service, monitor_settings, checker_factory=lambda: Checker(["UP", "ENVIRONMENT_ERROR"])
    )
    old = now() - timedelta(days=100)
    with monkeypatch.context() as patch:
        patch.setattr("app.scans.now", lambda: old)
        run = scans.create()
        with pytest.raises(AssetError, match="ECHO_ENVIRONMENT_ERROR"):
            scans.run_shard(run["id"], 0)
    with service.sessions.begin() as session:
        session.get(ScanRun, run["id"]).started_at = old
    scans.claim(run["id"], 0, uuid4())
    assert scans.cleanup()["deleted_results"] == 0
    with service.sessions.begin() as session:
        session.get(ScanShard, (run["id"], 0)).lease_until = now() - timedelta(seconds=1)
    resumed = ScanService(service, monitor_settings, checker_factory=Checker)
    resumed.run_shard(run["id"], 0)
    assert resumed.finalize(run["id"])["status"] == "COMPLETED"
    with service.sessions() as session:
        assert session.scalar(sa.select(sa.func.count()).select_from(NodeDailyStats)) == 2


def test_statistics_retention_uses_china_calendar_and_keeps_lifetime(
    service, monitor_settings, fixture_bytes
):
    from zoneinfo import ZoneInfo

    imported(service, fixture_bytes)
    node_id = service.list_nodes()[0]["id"]
    today = now().astimezone(ZoneInfo("Asia/Shanghai")).date()
    with service.sessions.begin() as session:
        session.add_all(
            [
                NodeDailyStats(
                    node_id=node_id,
                    stat_date=today - timedelta(days=days),
                    scheduled_count=1,
                    successful_count=1,
                    failed_count=0,
                )
                for days in (364, 365)
            ]
        )
    assert ScanService(service, monitor_settings).cleanup()["deleted_daily_stats"] == 1
    with service.sessions() as session:
        assert list(session.scalars(sa.select(NodeDailyStats.stat_date))) == [
            today - timedelta(days=364)
        ]
        node = session.get(Node, node_id)
        assert (node.checked_days, node.available_days) == (2, 2)
