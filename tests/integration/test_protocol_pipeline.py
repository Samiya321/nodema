import json

import pytest
import sqlalchemy as sa

from alembic import command
from app.checker.health import Observation
from app.database.models import Node, NodeCurrentStatus, NodeSource
from app.domain import PROTOCOLS, SourceType
from app.exports import ExportService
from app.parsers import parse_document
from app.scans import ScanService

pytestmark = pytest.mark.integration


def test_all_protocols_import_dedupe_plaintext_scan_and_export(
    service, monitor_settings, fixture_bytes
):
    for filename in ("protocols_all.txt", "protocols_all.yaml", "protocols_all.json"):
        source = service.create_source(
            name=filename, source_type=SourceType.RAW_TEXT, payload=fixture_bytes(filename)
        )
        result = service.sync_source(source["id"])
        assert result["status"] == "SUCCESS" and result["unique_nodes"] == 6
    assert len(service.list_nodes()) == 6
    with service.sessions() as session:
        assert session.scalar(sa.select(sa.func.count()).select_from(NodeSource)) == 18
        for row in session.scalars(sa.select(Node)):
            assert json.loads(row.config_data)["protocol"] == row.protocol
            config = json.loads(bytes(row.config_data))
            assert ("password" in config) == (row.protocol in PROTOCOLS[:4])

    class Checker:
        def preflight(self):
            pass

        def check(self, identity, short_id):
            assert identity["protocol"] in PROTOCOLS
            return Observation(
                status="UP", exit_country="JP", exit_ip="8.8.8.8", http_duration_ms=5
            )

        def close(self):
            pass

    scans = ScanService(service, monitor_settings, checker_factory=Checker)
    run = scans.create()
    for s in scans.get(run["id"])["shards"]:
        scans.run_shard(run["id"], s["shard_no"])
    assert scans.finalize(run["id"])["status"] == "COMPLETED"
    with service.sessions() as session:
        assert len(session.scalars(sa.select(NodeCurrentStatus)).all()) == 6
    exports = ExportService(service, monitor_settings)
    for format in ("mihomo", "singbox", "uri", "json", "csv"):
        artifact = exports.create(format, build=True)
        assert artifact["node_count"] == 6
        raw, _, _ = exports.download(artifact["id"], artifact["token"])
        if format in ("json", "csv"):
            assert b"synthetic-anytls" not in raw and b"synthetic:trojan@secret" not in raw
            assert b"00000000-0000-4000-8000" not in raw
        else:
            parsed = parse_document(raw)
            assert parsed.complete and {n.identity["protocol"] for n in parsed.nodes} == set(
                PROTOCOLS
            )


def test_protocol_upgrade_keeps_existing_vless_identity(
    service, db_engine, migration_config, fixture_bytes
):
    source = service.create_source(
        name="existing", source_type=SourceType.RAW_TEXT, payload=fixture_bytes("sample_vless.txt")
    )
    service.sync_source(source["id"])
    before = service.list_nodes()[0]
    with service.sessions() as session:
        stored = session.get(Node, before["id"])
        fingerprint = stored.fingerprint
        encrypted = stored.config_data
    with db_engine.begin() as conn:
        migration_config.attributes["connection"] = conn
        command.downgrade(migration_config, "0003_import_pipeline")
    with db_engine.begin() as conn:
        migration_config.attributes["connection"] = conn
        command.upgrade(migration_config, "head")
    service.sync_source(source["id"], force=True)
    after = service.list_nodes()[0]
    assert after["id"] == before["id"] and after["short_id"] == before["short_id"]
    with service.sessions() as session:
        stored = session.get(Node, before["id"])
        assert stored.fingerprint == fingerprint and stored.config_data == encrypted
