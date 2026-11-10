import base64
import json
from datetime import UTC, datetime, timedelta

import pytest
import sqlalchemy as sa
from fastapi.testclient import TestClient

from alembic import command
from app.api import create_app
from app.catalog import Catalog
from app.config import Settings
from app.database.models import Node, NodeDailyStats, Source
from app.domain import AssetError, SourceType
from app.exports import ExportService

pytestmark = pytest.mark.integration


def add_node(service, fixture_bytes):
    source = service.create_source(
        name="synthetic", source_type=SourceType.RAW_TEXT, payload=fixture_bytes("sample_vless.txt")
    )["id"]
    service.sync_source(source)
    return source, service.list_nodes()[0]["id"]


def day(node_id, offset, outcome):
    success, failure = int(outcome == "UP"), int(outcome == "DOWN")
    return dict(
        node_id=node_id,
        stat_date=datetime.now(UTC).date() - timedelta(days=offset),
        scheduled_count=1,
        successful_count=success,
        failed_count=failure,
        availability_ratio=success if success + failure else None,
    )


def test_lifetime_counts_are_idempotent_and_survive_history_cleanup(
    service, monitor_settings, fixture_bytes
):
    _, node_id = add_node(service, fixture_bytes)
    catalog = Catalog(service, monitor_settings)
    initial = catalog.node(node_id)
    assert initial["age_days"] == 1
    assert initial["checked_days"] == initial["available_days"] == 0
    assert initial["lifetime_availability"] is None
    with service.sessions.begin() as session:
        for offset, status in enumerate(["UP", "DOWN", "UP", "SKIPPED", "UNKNOWN"]):
            session.add(NodeDailyStats(**day(node_id, offset, status)))
    node = catalog.node(node_id)
    assert (node["checked_days"], node["available_days"]) == (3, 2)
    assert node["lifetime_availability"] == pytest.approx(2 / 3)
    with service.sessions.begin() as session:
        stats = session.get(NodeDailyStats, (node_id, datetime.now(UTC).date()))
        stats.successful_count = 1
        session.execute(sa.text("UPDATE node_daily_stats SET successful_count=successful_count"))
    assert catalog.node(node_id)["checked_days"] == 3
    # A corrected final outcome changes the daily contribution, not the number of days.
    with service.sessions.begin() as session:
        stats = session.get(NodeDailyStats, (node_id, datetime.now(UTC).date() - timedelta(days=1)))
        stats.successful_count, stats.failed_count = 1, 0
    assert catalog.node(node_id)["lifetime_availability"] == 1
    with service.sessions.begin() as session:
        session.execute(sa.delete(NodeDailyStats))
    assert catalog.node(node_id)["available_days"] == 3
    with service.sessions.begin() as session:
        session.add(NodeDailyStats(**day(node_id, 6, "DOWN")))
    node = catalog.node(node_id)
    assert (node["checked_days"], node["available_days"]) == (4, 3)
    assert node["lifetime_availability"] == 0.75


def test_age_calendar_filters_sort_and_first_seen_stays_stable(
    service, monitor_settings, fixture_bytes
):
    source, node_id = add_node(service, fixture_bytes)
    with service.sessions.begin() as session:
        session.execute(
            sa.text(
                "UPDATE nodes SET first_seen_at="
                "((now() AT TIME ZONE 'Asia/Shanghai')::date-29) AT TIME ZONE 'Asia/Shanghai'"
            )
        )
        session.add(NodeDailyStats(**day(node_id, 1, "UP")))
    before = Catalog(service, monitor_settings).node(node_id)
    assert before["age_days"] == 30
    service.sync_source(source, force=True)
    catalog = Catalog(service, monitor_settings)
    assert catalog.node(node_id)["first_seen_at"] == before["first_seen_at"]
    filters = dict(
        min_age_days=30, min_checked_days=1, min_available_days=1, min_lifetime_availability=1
    )
    page = catalog.page(filters, sort="lifetime_availability:desc,age_days:desc")
    assert page["total"] == 1
    assert catalog.page({"min_age_days": 31})["total"] == 0
    for key, value in [
        ("min_age_days", 1.5),
        ("min_lifetime_availability", 1.01),
        ("min_checked_days", -1),
    ]:
        with pytest.raises(AssetError, match="INVALID_NODE_QUERY"):
            catalog.page({key: value})
    # Report fields are present even for currently unqualified nodes (empty export).
    payload, count = ExportService(service, monitor_settings)._render("json", filters)
    assert count == 0 and json.loads(payload) == []


def test_api_database_storage_needs_only_fingerprint_key(db_engine, fixture_bytes):
    with db_engine.connect() as conn:
        schema = conn.scalar(sa.text("SELECT current_schema()"))
    url = db_engine.url.update_query_dict({"options": f"-csearch_path={schema}"})
    settings = Settings(
        _env_file=None,
        database_url=url.render_as_string(hide_password=False),
        encryption_key_b64="",
        fingerprint_key_b64=base64.b64encode(b"H" * 32).decode(),
        admin_password="synthetic-plaintext-admin-password-long-enough",
    )
    assert settings.encryption_key_b64.get_secret_value() == ""
    app = create_app(settings)
    with TestClient(app) as client:
        response = client.post(
            "/api/sources",
            headers={"Authorization": "Bearer " + settings.admin_password.get_secret_value()},
            json={
                "name": "synthetic",
                "type": "RAW_TEXT",
                "payload": fixture_bytes("sample_vless.txt").decode(),
            },
        )
        assert response.status_code == 201
    with app.state.assets.sessions() as session:
        assert session.scalar(sa.select(Source.payload_data)) == fixture_bytes("sample_vless.txt")
    app.state.assets.sessions.kw["bind"].dispose()


def test_legacy_plaintext_migration_is_atomic_and_keeps_ids(
    service, db_engine, migration_config, fixture_bytes, monkeypatch
):
    _, node_id = add_node(service, fixture_bytes)
    with service.sessions() as session:
        row = session.get(Node, node_id)
        config, fingerprint, short_id = row.config_data, row.fingerprint, row.short_id
    with db_engine.begin() as connection:
        migration_config.attributes["connection"] = connection
        command.downgrade(migration_config, "0008_export_projection")
    with db_engine.connect() as connection:
        assert bytes(connection.scalar(sa.text("SELECT config_encrypted FROM nodes"))).startswith(
            b"NMA1"
        )
    for bad_key in ("", base64.b64encode(b"Z" * 32).decode()):
        monkeypatch.setenv("ENCRYPTION_KEY_B64", bad_key)
        with pytest.raises(RuntimeError, match="LEGACY_DATA_KEY_REQUIRED_OR_INVALID"):
            with db_engine.begin() as connection:
                migration_config.attributes["connection"] = connection
                command.upgrade(migration_config, "head")
        with db_engine.connect() as connection:
            assert (
                connection.scalar(sa.text("SELECT version_num FROM alembic_version"))
                == "0008_export_projection"
            )
            assert bytes(
                connection.scalar(sa.text("SELECT config_encrypted FROM nodes"))
            ).startswith(b"NMA1")
    monkeypatch.setenv("ENCRYPTION_KEY_B64", base64.b64encode(b"E" * 32).decode())
    with db_engine.begin() as connection:
        migration_config.attributes["connection"] = connection
        command.upgrade(migration_config, "head")
    with service.sessions() as session:
        row = session.get(Node, node_id)
        assert (row.config_data, row.fingerprint, row.short_id) == (config, fingerprint, short_id)
        assert not row.config_data.startswith(b"NMA1")


def test_finalizing_same_scan_twice_does_not_recount_days(service, monitor_settings, fixture_bytes):
    from app.checker.health import Observation
    from app.scans import ScanService

    _, node_id = add_node(service, fixture_bytes)

    class Checker:
        def preflight(self):
            pass

        def close(self):
            pass

        def check(self, identity, short_id):
            return Observation(status="UP", http_duration_ms=10)

    scans = ScanService(service, monitor_settings, checker_factory=Checker)
    run = scans.create()
    for shard in scans.get(run["id"])["shards"]:
        scans.run_shard(run["id"], shard["shard_no"])
    scans.finalize(run["id"])
    scans.finalize(run["id"])
    node = Catalog(service, monitor_settings).node(node_id)
    assert node["checked_days"] == node["available_days"] == 1
