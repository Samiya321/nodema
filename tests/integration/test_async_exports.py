"""Exercise queue, snapshot fencing, eligibility and bounded storage on real PostgreSQL."""

from datetime import timedelta
from uuid import UUID

import pytest
import sqlalchemy as sa
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext

from app.database.models import (
    Base,
    CatalogState,
    ExportArtifact,
    ExportMember,
    ExportVersion,
    Node,
)
from app.domain import AssetError
from app.export_render import MAX_EXPORT_BYTES, Renderer, render_snapshot
from app.exports import ExportService
from app.scans import now
from tests.integration.test_monitoring import complete

pytestmark = pytest.mark.integration


def setup(service, settings, fixture_bytes):
    complete(service, settings, fixture_bytes)
    return ExportService(service, settings), service.list_nodes()[0]["id"]


def test_queue_stable_link_versions_and_recovery(service, monitor_settings, fixture_bytes):
    exports, _ = setup(service, monitor_settings, fixture_bytes)
    profile = exports.create("uri", name="My fixed link")
    identifier, token = UUID(profile["id"]), profile["token"]
    assert profile["expires_at"] is None and profile["status"] == "PENDING"
    assert exports.link(identifier)["token"] == token
    with pytest.raises(AssetError, match="EXPORT_PENDING"):
        exports.download(identifier, token)
    assert exports.build_pending() == {"ready": 1, "failed": 0, "superseded": 0}
    first = exports.download(identifier, token)[0]
    assert exports.build_pending()["ready"] == 0
    exports.retry(identifier)
    assert exports.get(identifier)["serving"]  # Last safe file survives a manual rebuild.
    assert exports.build_pending()["ready"] == 1
    assert exports.download(identifier, token)[0] == first
    assert [v["version_no"] for v in exports.versions(identifier)] == [2, 1]
    changed = exports.link(identifier, rotate=True)["token"]
    with pytest.raises(AssetError, match="EXPORT_NOT_AVAILABLE"):
        exports.download(identifier, token)
    assert exports.download(identifier, changed)[0] == first
    assert (
        not {"token", "token_value", "token_hash", "payload_data"} & exports.get(identifier).keys()
    )


@pytest.mark.parametrize("change", ["node", "source", "membership", "config"])
def test_selected_node_changes_block_old_file_immediately(
    service, monitor_settings, fixture_bytes, change
):
    exports, node_id = setup(service, monitor_settings, fixture_bytes)
    profile = exports.create("uri", build=True)
    identifier = UUID(profile["id"])
    with service.sessions.begin() as session:
        if change == "node":
            session.execute(sa.update(Node).where(Node.id == node_id).values(enabled=False))
        elif change == "source":
            session.execute(sa.text("UPDATE sources SET enabled=false"))
        elif change == "membership":
            session.execute(sa.text("UPDATE node_sources SET is_present=false"))
        else:
            session.execute(sa.update(Node).where(Node.id == node_id).values(config_data=b"{}"))
    assert not exports.get(identifier)["serving"]
    with pytest.raises(AssetError, match="EXPORT_PENDING"):
        exports.download(identifier, profile["token"])
    result = exports.build_pending()
    if change == "config":
        assert result["failed"] == 1
        assert not exports.get(identifier)["serving"]
    else:
        assert result["ready"] == 1
        assert exports.download(identifier, profile["token"])[0] == b""


def test_snapshot_mutation_is_fenced_and_other_profiles_make_progress(
    service, monitor_settings, fixture_bytes, monkeypatch
):
    import app.exports as module

    exports, node_id = setup(service, monitor_settings, fixture_bytes)
    first = exports.create("uri")
    second = exports.create("json")
    original, calls = module.render_snapshot, 0

    def mutating(*args, **kwargs):
        nonlocal calls
        result = original(*args, **kwargs)
        calls += 1
        if calls == 1:
            service.set_node_enabled(node_id, False)
        return result

    monkeypatch.setattr(module, "render_snapshot", mutating)
    assert exports.build_pending() == {"ready": 1, "failed": 0, "superseded": 1}
    assert exports.get(UUID(first["id"]))["status"] == "PENDING"
    assert exports.get(UUID(second["id"]))["serving"]
    assert exports.build_pending()["ready"] == 1


def test_expired_lease_cannot_publish_over_edited_profile(service, monitor_settings, fixture_bytes):
    exports, _ = setup(service, monitor_settings, fixture_bytes)
    profile = exports.create("uri")
    identifier = UUID(profile["id"])
    old = exports._claim(identifier)
    assert exports._claim(identifier) is None
    rendered = render_snapshot(service, monitor_settings, old["format"], old["filters"], now())
    exports.update(identifier, {"format": "json"})
    assert exports._publish(old, rendered) == "SUPERSEDED"
    new = exports._claim(identifier)
    with service.sessions.begin() as session:
        session.execute(
            sa.update(ExportArtifact)
            .where(ExportArtifact.id == identifier)
            .values(lease_until=now() - timedelta(seconds=1))
        )
    replacement = exports._claim(identifier)
    assert new["owner"] != replacement["owner"]
    with pytest.raises(AssetError, match="EXPORT_BUILD_SUPERSEDED"):
        exports._heartbeat(new)
    assert exports._publish(new, rendered) == "SUPERSEDED"
    replacement_payload = render_snapshot(
        service, monitor_settings, "json", replacement["filters"], now()
    )
    assert exports._publish(replacement, replacement_payload) == "READY"


def test_failure_does_not_spin_and_retry_recovers(
    service, monitor_settings, fixture_bytes, monkeypatch
):
    import app.exports as module

    exports, _ = setup(service, monitor_settings, fixture_bytes)
    profile = exports.create("uri", build=True)
    identifier = UUID(profile["id"])
    original = module.render_snapshot
    exports.retry(identifier)

    def fail(*args, **kwargs):
        raise ValueError("synthetic credential must never reach metadata")

    monkeypatch.setattr(module, "render_snapshot", fail)
    assert exports.build_pending()["failed"] == 1
    assert exports.build_pending()["failed"] == 0
    assert exports.get(identifier)["error_code"] == "EXPORT_BUILD_FAILED"
    assert exports.get(identifier)["serving"]
    exports.retry(identifier)
    monkeypatch.setattr(module, "render_snapshot", original)
    assert exports.build_pending()["ready"] == 1


def test_quotas_versions_expiry_and_cleanup(service, monitor_settings, fixture_bytes):
    exports, _ = setup(service, monitor_settings, fixture_bytes)
    with service.sessions.begin() as session:
        state = session.get(CatalogState, 1)
        state.max_profiles, state.version_limit, state.max_payload_bytes = 1, 2, 1
    profile = exports.create("uri")
    identifier = UUID(profile["id"])
    with pytest.raises(AssetError, match="EXPORT_PROFILE_LIMIT"):
        exports.create("uri")
    assert exports.build_pending()["failed"] == 1
    assert exports.get(identifier)["error_code"] == "EXPORT_STORAGE_LIMIT"
    with service.sessions.begin() as session:
        session.get(CatalogState, 1).max_payload_bytes = 10_000
    for _ in range(4):
        exports.retry(identifier)
        assert exports.build_pending()["ready"] == 1
    assert len(exports.versions(identifier)) == 2
    with service.sessions() as session:
        assert session.scalar(sa.select(sa.func.count()).select_from(ExportMember)) == 1
    with service.sessions.begin() as session:
        session.get(ExportArtifact, identifier).expires_at = now() - timedelta(seconds=1)
    with pytest.raises(AssetError, match="EXPORT_NOT_AVAILABLE"):
        exports.download(identifier, profile["token"])
    assert exports.cleanup() == 1
    with service.sessions() as session:
        assert session.scalar(sa.select(sa.func.count()).select_from(ExportVersion)) == 0
        assert session.scalar(sa.select(sa.func.count()).select_from(ExportMember)) == 0


def test_metadata_does_not_load_payload_and_renderer_is_bounded(
    service, monitor_settings, db_engine
):
    exports = ExportService(service, monitor_settings)
    profile = exports.create("json", build=True)
    queries = []

    def capture(conn, cursor, sql, parameters, context, executemany):
        queries.append(sql)

    sa.event.listen(db_engine, "before_cursor_execute", capture)
    try:
        exports.list()
        exports.get(UUID(profile["id"]))
        exports.link(UUID(profile["id"]))
    finally:
        sa.event.remove(db_engine, "before_cursor_execute", capture)
    assert not any("payload_data" in query for query in queries)
    writer = Renderer("uri")
    writer.push(b"x" * MAX_EXPORT_BYTES)
    with pytest.raises(AssetError, match="EXPORT_TOO_LARGE"):
        writer.push(b"x")


def test_current_model_matches_all_migrations(db_engine):
    with db_engine.connect() as conn:
        context = MigrationContext.configure(
            conn, opts={"compare_type": True, "compare_server_default": True}
        )
        differences = compare_metadata(context, Base.metadata)
    assert differences == []


def test_two_page_snapshot_is_consistent_and_cannot_publish_after_mutation(
    service, monitor_settings
):
    from uuid import uuid4

    from app.database.models import NodeCurrentStatus
    from app.domain import SourceType

    source = service.create_source(
        name="Synthetic pages",
        source_type=SourceType.RAW_TEXT,
        payload="\n".join(
            f"vless://{uuid4()}@pages.example:443?security=tls" for _ in range(1250)
        ).encode(),
    )
    service.sync_source(source["id"])
    with service.sessions.begin() as session:
        nodes = list(session.scalars(sa.select(Node.id).order_by(Node.short_id.desc())))
        session.execute(
            sa.insert(NodeCurrentStatus),
            [
                dict(node_id=n, status="UP", last_checked_at=now(), last_success_at=now())
                for n in nodes
            ],
        )
    exports = ExportService(service, monitor_settings)
    profile = exports.create("uri", {"sort": "short_id:desc", "limit": 1225})
    job = exports._claim(UUID(profile["id"]))
    pages = 0

    def heartbeat():
        nonlocal pages
        pages += 1
        exports._heartbeat(job)
        if pages == 2:
            service.set_node_enabled(nodes[1100], False)

    rendered = render_snapshot(service, monitor_settings, "uri", job["filters"], now(), heartbeat)
    assert pages == 2 and rendered["node_count"] == 1225
    assert str(nodes[1100]) in rendered["members"]  # The same RR snapshot spans both pages.
    assert exports._publish(job, rendered) == "SUPERSEDED"
    assert exports.build_pending()["ready"] == 1
    with service.sessions() as session:
        assert session.get(ExportMember, (UUID(profile["id"]), nodes[1100])) is None
    assert exports.get(UUID(profile["id"]))["node_count"] == 1225


def test_legacy_token_hash_survives_upgrade_without_inventing_a_token(
    db_engine, migration_config, service, monitor_settings
):
    import hashlib
    from uuid import uuid4

    from alembic import command

    identifier, token = uuid4(), "synthetic-legacy-private-token"
    with db_engine.begin() as conn:
        migration_config.attributes["connection"] = conn
        command.downgrade(migration_config, "0009_plaintext_lifetime")
        conn.execute(
            sa.text(
                "INSERT INTO export_artifacts(id,format,filter_spec,expires_at,"
                "token_hash,payload_data,node_count) "
                "VALUES(:id,'uri','{}',now()+interval '1 day',:hash,:payload,0)"
            ),
            {"id": identifier, "hash": hashlib.sha256(token.encode()).digest(), "payload": b""},
        )
        command.upgrade(migration_config, "head")
    exports = ExportService(service, monitor_settings)
    assert exports.get(identifier)["status"] == "PENDING"
    with pytest.raises(AssetError, match="EXPORT_TOKEN_LEGACY"):
        exports.link(identifier)
    assert exports.build_pending()["ready"] == 1
    assert exports.download(identifier, token)[0] == b""
    recovered = exports.link(identifier, rotate=True)["token"]
    with pytest.raises(AssetError, match="EXPORT_NOT_AVAILABLE"):
        exports.download(identifier, token)
    assert exports.download(identifier, recovered)[0] == b""


def test_budget_configuration_and_revision_conflicts(service, monitor_settings):
    exports = ExportService(service, monitor_settings)
    profile = exports.create("json", build=True)
    identifier = UUID(profile["id"])
    assert exports.budgets()["max_profiles"] == 20
    assert exports.budgets({"max_profiles": 2})["max_profiles"] == 2
    for values in ({"max_profiles": 0}, {"max_profiles": True}, {"unknown": 1}):
        with pytest.raises(AssetError, match="INVALID_EXPORT_BUDGET"):
            exports.budgets(values)
    with pytest.raises(AssetError, match="EXPORT_BUDGET_BELOW_USAGE"):
        exports.budgets({"max_payload_bytes": 1})
    exports.update(identifier, {"format": "uri", "expected_revision": 1})
    with pytest.raises(AssetError, match="EXPORT_REVISION_CONFLICT"):
        exports.update(identifier, {"format": "json", "expected_revision": 1})


def test_harmless_seen_timestamp_change_keeps_previous_file_available(
    service, monitor_settings, fixture_bytes
):
    exports, _ = setup(service, monitor_settings, fixture_bytes)
    profile = exports.create("uri", build=True)
    identifier = UUID(profile["id"])
    with service.sessions.begin() as session:
        session.execute(sa.text("UPDATE node_sources SET last_seen_at=now()"))
    current = exports.get(identifier)
    assert current["status"] == "UPDATING" and current["serving"]
    assert exports.download(identifier, profile["token"])[0]
    assert exports.build_pending()["ready"] == 1


def test_concurrent_builders_and_profile_quota_are_serialized(
    service, monitor_settings, monkeypatch
):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier, Event

    import app.exports as module

    exports = ExportService(service, monitor_settings)
    exports.budgets({"max_profiles": 1})
    barrier = Barrier(2)

    def create():
        barrier.wait(timeout=5)
        try:
            return exports.create("json")["id"]
        except AssetError as error:
            return error.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: create(), range(2)))
    assert results.count("EXPORT_PROFILE_LIMIT") == 1
    entered, release = Event(), Event()
    original = module.render_snapshot

    def render(*args, **kwargs):
        entered.set()
        assert release.wait(timeout=5)
        return original(*args, **kwargs)

    monkeypatch.setattr(module, "render_snapshot", render)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(exports.build_pending)
        try:
            assert entered.wait(timeout=5)
            second = pool.submit(exports.build_pending)
            assert second.result(timeout=5)["ready"] == 0
        finally:
            release.set()
        assert first.result(timeout=5)["ready"] == 1
    assert exports.list()[0]["current_version"] == 1
