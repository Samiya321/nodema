import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
import sqlalchemy as sa
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy.exc import IntegrityError
from typer.testing import CliRunner

from alembic import command
from app.cli import app
from app.database.models import Base, Node, NodeSource
from app.domain import AssetError, SourceType
from app.ingestion.service import AssetService

pytestmark = pytest.mark.integration


def create(service, payload, name="synthetic", source_type=SourceType.RAW_TEXT):
    return service.create_source(name=name, source_type=source_type, payload=payload)["id"]


def test_cross_source_cross_format_and_aliases(service, fixture_bytes, cipher):
    ids = [
        create(service, fixture_bytes(f), name=f)
        for f in ("sample_vless.txt", "sample_clash.yaml", "sample_singbox.json")
    ]
    for index, source in enumerate(ids):
        result = service.sync_source(source)
        assert result["status"] == "SUCCESS"
        assert result["created_nodes"] == (1 if index == 0 else 0)
    nodes = service.list_nodes()
    assert len(nodes) == 1 and nodes[0]["eligible"]
    node_id = nodes[0]["id"]
    with service.sessions() as session:
        links = session.scalars(sa.select(NodeSource)).all()
        assert len(links) == 3
        aliases = [json.loads(bytes(x.aliases_data)) for x in links]
        assert {a[0] for a in aliases} == {"Synthetic A", "Synthetic B", "Synthetic C"}
        node = session.get(Node, node_id)
        assert json.loads(bytes(node.config_data))["uuid"].endswith("000001")
    before = nodes[0]["short_id"]
    service.sync_source(ids[0], force=True)
    assert service.list_nodes()[0]["short_id"] == before


def test_rename_and_duplicate_aliases_one_membership(service, fixture_bytes, cipher):
    raw = fixture_bytes("sample_vless.txt")
    source = create(service, raw + raw.replace(b"Synthetic%20A", b"Other"))
    service.sync_source(source)
    with service.sessions() as session:
        link = session.scalars(sa.select(NodeSource)).one()
        aliases = json.loads(bytes(link.aliases_data))
        assert aliases == ["Other", "Synthetic A"]
    node_id = service.list_nodes()[0]["id"]
    service.update_source(source, payload=raw.replace(b"Synthetic%20A", b"Renamed"))
    service.sync_source(source)
    assert service.list_nodes()[0]["id"] == node_id
    assert len(service.get_node(node_id)["sources"]) == 1


def test_credentials_are_distinct_and_manual_disable_survives(service, fixture_bytes):
    raw = fixture_bytes("sample_vless.txt")
    source = create(service, raw + raw.replace(b"000001", b"000002"))
    service.sync_source(source)
    assert len(service.list_nodes()) == 2
    node_id = service.list_nodes()[0]["id"]
    service.set_node_enabled(node_id, False)
    service.sync_source(source, force=True)
    assert not service.get_node(node_id)["eligible"]


def test_unchanged_skips_parser_and_version_change_reparses(service, fixture_bytes, monkeypatch):
    import app.ingestion.service as module

    source = create(service, fixture_bytes("sample_vless.txt"))
    service.sync_source(source)
    initial = service.get_source(source)
    original = module.parse_document
    monkeypatch.setattr(module, "parse_document", lambda *a, **k: pytest.fail("parser invoked"))
    assert service.sync_source(source)["status"] == "UNCHANGED"
    assert service.get_source(source)["last_checked_at"] >= initial["last_checked_at"]
    monkeypatch.setattr(module, "parse_document", original)
    monkeypatch.setattr(module, "PARSER_VERSION", "synthetic-next-parser")
    assert service.sync_source(source)["parsed"]


def test_partial_keeps_old_links_and_full_snapshot_reconciles(service, fixture_bytes):
    a = fixture_bytes("sample_vless.txt")
    b = a.replace(b"000001", b"000002")
    source = create(service, a + b)
    other = create(service, b)
    service.sync_source(source)
    service.sync_source(other)
    service.update_source(source, payload=a + b"vmess://invalid\n")
    assert service.sync_source(source)["status"] == "PARTIAL"
    with service.sessions() as session:
        assert (
            session.scalar(
                sa.select(sa.func.count())
                .select_from(NodeSource)
                .where(NodeSource.source_id == source, NodeSource.is_present.is_(True))
            )
            == 2
        )
    service.update_source(source, payload=a)
    service.sync_source(source)
    assert all(n["eligible"] for n in service.list_nodes())  # second source still holds b
    service.delete_source(other)
    assert sum(n["eligible"] for n in service.list_nodes()) == 1
    assert len(service.list_nodes()) == 2
    assert len(service.list_sources(include_deleted=True)) == 2
    with service.sessions() as session:
        assert len(session.scalars(sa.select(NodeSource)).all()) == 3


def test_fetch_failure_does_not_remove_nodes_with_plaintext_url(service, fixture_bytes):
    raw = fixture_bytes("sample_vless.txt")

    class FakeFetcher:
        def fetch(self, url):
            assert url == "https://subscriptions.example/sub?token=synthetic-sub-secret"
            return raw

    service.fetcher = FakeFetcher()
    source = create(
        service,
        b"https://subscriptions.example/sub?token=synthetic-sub-secret",
        source_type=SourceType.SUBSCRIPTION_URL,
    )
    service.sync_source(source)
    before = service.list_nodes()[0]

    def failing(url):
        raise AssetError("FETCH_DNS_FAILED")

    service.fetcher.fetch = failing
    assert service.sync_source(source)["status"] == "FAILED"
    assert service.list_nodes()[0]["eligible"]
    assert service.list_nodes()[0]["last_seen_at"] == before["last_seen_at"]


def test_recovery_to_accepted_hash_clears_stale_errors(service, fixture_bytes):
    raw = fixture_bytes("sample_vless.txt")

    class Fetch:
        payload = raw

        def fetch(self, url):
            return self.payload

    fetcher = Fetch()
    service.fetcher = fetcher
    source = create(
        service, b"https://subscriptions.example/sub", source_type=SourceType.SUBSCRIPTION_URL
    )
    service.sync_source(source)
    fetcher.payload = b'{"outbounds": "bad"}'
    assert service.sync_source(source)["status"] == "FAILED"
    fetcher.payload = raw
    assert service.sync_source(source)["status"] == "UNCHANGED"
    dto = service.get_source(source)
    assert dto["last_sync_status"] == "SUCCESS" and dto["last_error_code"] is None
    assert dto["last_parse_summary"]["issue_count"] == 0


def test_explicit_empty_list_and_blank_response(service, fixture_bytes):
    source = create(service, fixture_bytes("sample_vless.txt"))
    service.sync_source(source)
    # Blanks returned by a remote fetch must never clear associations.
    remote = create(
        service, b"https://subscriptions.example/sub", source_type=SourceType.SUBSCRIPTION_URL
    )

    class Fetch:
        def fetch(self, url):
            return b"  "

    service.fetcher = Fetch()
    assert service.sync_source(remote)["error_code"] == "EMPTY_INPUT"
    service.update_source(source, payload=b"proxies: []")
    assert service.sync_source(source)["status"] == "SUCCESS"
    assert not service.list_nodes()[0]["eligible"]


def test_concurrent_sources_single_node_and_correct_ciphertext(service, fixture_bytes):
    raw = fixture_bytes("sample_vless.txt")
    ids = [create(service, raw), create(service, raw)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(service.sync_source, ids))
    assert all(r["status"] == "SUCCESS" for r in results)
    assert len(service.list_nodes()) == 1
    # Verifies persisted AAD after concurrent ON CONFLICT.
    assert service.sync_source(ids[0], force=True)["status"] == "SUCCESS"


def test_concurrent_same_source_conflict_is_safe(service, fixture_bytes):
    barrier = Barrier(2)
    raw = fixture_bytes("sample_vless.txt")

    class Fetch:
        def fetch(self, url):
            barrier.wait(timeout=5)
            return raw

    service.fetcher = Fetch()
    source = create(
        service, b"https://subscriptions.example/sub", source_type=SourceType.SUBSCRIPTION_URL
    )

    def sync(_):
        try:
            return service.sync_source(source)["status"]
        except AssetError as error:
            return error.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert set(pool.map(sync, range(2))) == {"SUCCESS", "SOURCE_CHANGED_RETRY"}
    assert len(service.list_nodes()) == 1


def test_apply_rollback_and_retry(service, fixture_bytes, monkeypatch):
    source = create(service, fixture_bytes("sample_vless.txt"))
    apply = service._apply

    def failing(*args):
        apply(*args)
        raise AssetError("SYNTHETIC_INTERRUPTION")

    monkeypatch.setattr(service, "_apply", failing)
    with pytest.raises(AssetError, match="SYNTHETIC_INTERRUPTION"):
        service.sync_source(source)
    assert service.list_nodes() == []
    assert service.get_source(source)["last_sync_status"] == "NEVER"
    monkeypatch.setattr(service, "_apply", apply)
    assert service.sync_source(source)["status"] == "SUCCESS"


def test_key_mismatch_fails_before_import(service, fixture_bytes):
    source = create(service, fixture_bytes("sample_vless.txt"))
    service.sync_source(source)
    wrong = AssetService(service.sessions, b"X" * 32)
    with pytest.raises(AssetError, match="FINGERPRINT_KEY_MISMATCH"):
        wrong.sync_source(source)
    assert len(service.list_nodes()) == 1


def test_plain_database_and_redacted_cli(service, db_engine, monkeypatch, caplog):
    import app.cli as cli

    sentinel = "synthetic-private-sentinel"
    auth = "00000000-0000-4000-8000-000000000099"
    raw = (
        f"vless://{auth}@edge.example:443?type=ws&security=reality&pbk={sentinel}"
        f"&sid=ab12&path=/{sentinel}#{sentinel}"
    ).encode()
    source = create(service, raw)
    service.sync_source(source)
    with db_engine.connect() as conn:
        assert auth.encode() in conn.scalar(sa.text("SELECT config_data FROM nodes LIMIT 1"))
        assert raw == conn.scalar(sa.text("SELECT payload_data FROM sources LIMIT 1"))
        assert sentinel.encode() in conn.scalar(
            sa.text("SELECT aliases_data FROM node_sources LIMIT 1")
        )
    monkeypatch.setattr(cli, "service", lambda: service)
    runner = CliRunner()
    for args in (
        ["source", "show", str(source)],
        ["node", "list"],
        ["source", "sync", str(source), "--force"],
        ["node", "show", "invalid"],
    ):
        result = runner.invoke(app, args)
        assert sentinel not in result.output and auth not in result.output
        assert "Traceback" not in result.output
    assert sentinel not in caplog.text and auth not in caplog.text


def test_pause_update_and_synthetic_100(service, fixture_bytes):
    source = create(service, fixture_bytes("synthetic_100.txt"))
    assert service.sync_source(source)["unique_nodes"] == 100
    assert len(service.list_nodes()) == 100
    service.update_source(source, name="renamed label", enabled=False)
    assert not any(n["eligible"] for n in service.list_nodes())
    with pytest.raises(AssetError, match="SOURCE_DISABLED"):
        service.sync_source(source)
    service.update_source(source, enabled=True)
    assert service.sync_source(source)["status"] == "UNCHANGED"


def test_bulk_import_crosses_batch_boundary_with_few_roundtrips(service, db_engine, fixture_bytes):
    raw = fixture_bytes("synthetic_100.txt")
    # Synthetic 400 assets; no network calls and no real subscription data.
    raw += raw.replace(b"@edge-", b"@second-")
    raw += raw.replace(b"@", b"@third-")
    source = create(service, raw)
    calls = []

    def count(*args):
        calls.append(1)

    sa.event.listen(db_engine, "before_cursor_execute", count)
    try:
        result = service.sync_source(source)
    finally:
        sa.event.remove(db_engine, "before_cursor_execute", count)
    assert result["unique_nodes"] == result["created_nodes"] == 400
    assert len(calls) < 30


def test_migrations_roundtrip_constraints_and_no_drift(db_engine, migration_config):
    with db_engine.begin() as conn:
        assert not compare_metadata(
            MigrationContext.configure(
                conn, opts={"compare_type": True, "compare_server_default": True}
            ),
            Base.metadata,
        )
        migration_config.attributes["connection"] = conn
        command.downgrade(migration_config, "base")
        assert "nodes" not in sa.inspect(conn).get_table_names()
        assert "node_short_id_seq" not in sa.inspect(conn).get_sequence_names()
        command.upgrade(migration_config, "head")
        assert "node_short_id_seq" in sa.inspect(conn).get_sequence_names()
    with pytest.raises(IntegrityError), db_engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO sources (id,name,type) VALUES "
                "('00000000-0000-4000-8000-000000000001','synthetic','RAW_TEXT')"
            )
        )


def test_source_only_database_uses_plaintext_without_aes(service, fixture_bytes):
    from app.database.models import Source

    raw = fixture_bytes("sample_vless.txt")
    source_id = create(service, raw)
    with service.sessions() as session:
        assert session.get(Source, source_id).payload_data == raw
    assert service.sync_source(source_id)["status"] == "SUCCESS"
