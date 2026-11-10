"""Synthetic SQL catalog scale check; plaintext identities, no network probes."""

import argparse
import base64
import json
import os
import secrets
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import sqlalchemy as sa

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from alembic.config import Config  # noqa: E402

from alembic import command  # noqa: E402
from app.catalog import Catalog  # noqa: E402
from app.config import Settings  # noqa: E402
from app.database.models import Node, NodeCurrentStatus, NodeSource  # noqa: E402
from app.database.session import make_engine, session_factory  # noqa: E402
from app.domain import NormalizedNode, SourceType  # noqa: E402
from app.ingestion.service import AssetService  # noqa: E402
from app.security.crypto import canonical_json, fingerprint  # noqa: E402


def benchmark(url, count):
    admin, schema = make_engine(url), "catalog_bench_" + uuid4().hex
    with admin.begin() as conn:
        conn.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
    engine = sa.create_engine(
        url, hide_parameters=True, connect_args={"options": f"-csearch_path={schema}"}
    )
    try:
        with engine.begin() as conn:
            config = Config("alembic.ini")
            config.attributes["connection"] = conn
            command.upgrade(config, "head")
        aes, hmac = secrets.token_bytes(32), secrets.token_bytes(32)
        assets = AssetService(session_factory(engine), hmac)
        settings = Settings(
            _env_file=None,
            database_url=url,
            encryption_key_b64=base64.b64encode(aes).decode(),
            fingerprint_key_b64=base64.b64encode(hmac).decode(),
        )
        source = assets.create_source(
            name="synthetic-scale-metadata",
            source_type=SourceType.RAW_TEXT,
            payload=b"synthetic benchmark generated internally; no external inputs",
        )
        at, ids = datetime.now(UTC), []
        for offset in range(0, count, 1000):
            nodes, links, currents = [], [], []
            for i in range(offset, min(offset + 1000, count)):
                node_id = uuid4()
                ids.append(node_id)
                protocol = "trojan" if i % 10 == 0 else "vless"
                identity = (
                    {
                        "protocol": protocol,
                        "server_host": f"entry-{i // 5}.example",
                        "server_port": 443,
                        "transport": "tcp",
                        "security": "tls",
                        "uuid": str(uuid4()),
                    }
                    if protocol == "vless"
                    else {
                        "protocol": protocol,
                        "server_host": f"entry-{i // 5}.example",
                        "server_port": 443,
                        "transport": "tcp",
                        "security": "tls",
                        "password": "synthetic-" + str(i),
                    }
                )
                nodes.append(
                    dict(
                        id=node_id,
                        short_id=f"N{i + 1:06d}",
                        fingerprint=fingerprint(NormalizedNode(identity), hmac),
                        protocol=protocol,
                        server_host=identity["server_host"],
                        server_port=443,
                        transport="tcp",
                        security="tls",
                        config_data=bytes(canonical_json(identity)),
                        first_seen_at=at,
                        last_seen_at=at,
                    )
                )
                links.append(
                    dict(
                        node_id=node_id,
                        source_id=source["id"],
                        aliases_data=b"[]",
                        first_seen_at=at,
                        last_seen_at=at,
                    )
                )
                currents.append(
                    dict(
                        node_id=node_id,
                        status="UP",
                        last_checked_at=at,
                        last_success_at=at,
                        entry_country="SG",
                        entry_asn=64510,
                        last_exit_country="JP",
                        last_exit_asn=64520,
                        last_http_duration_ms=10 + i % 500,
                        probe_key="located:synthetic:US:64512:4:echo:https-v1",
                    )
                )
            with engine.begin() as conn:
                conn.execute(sa.insert(Node), nodes)
                conn.execute(sa.insert(NodeSource), links)
                conn.execute(sa.insert(NodeCurrentStatus), currents)
        with engine.begin() as conn:
            conn.execute(sa.text("ANALYZE"))
        catalog, results = Catalog(assets, settings), []
        for label, filters, sort in (
            ("default-page", {}, "short_id:asc"),
            ("protocol-index", {"protocol": "trojan"}, "short_id:asc"),
            (
                "geo-and-latency",
                {"entry_country": "SG", "exit_asn": 64520, "max_http_ms": 50},
                "http_duration_ms:asc,short_id:asc",
            ),
            ("theoretical-grade", {"grade": "U"}, "short_id:asc"),
        ):
            timings = []
            for _ in range(3):
                started = time.monotonic()
                page = catalog.page(filters, sort=sort, limit=50)
                timings.append(round((time.monotonic() - started) * 1000, 2))
            results.append(
                dict(
                    query=label,
                    total=page["total"],
                    returned=len(page["items"]),
                    milliseconds=timings,
                    response_bytes=len(json.dumps(page, default=str).encode()),
                )
            )
        with engine.connect() as conn:
            plan = conn.scalar(
                sa.text(
                    "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id "
                    "FROM nodema_catalog(36,'{SHORT_ID}','GENERAL') "
                    "WHERE protocol='trojan' ORDER BY short_id LIMIT 50"
                )
            )[0]
        return dict(nodes=count, queries=results, index_query_plan=plan)
    finally:
        engine.dispose()
        with admin.begin() as conn:
            conn.execute(sa.text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sizes", type=int, nargs="+", default=[15000, 50000])
    args = parser.parse_args()
    if any(not 1 <= n <= 100000 for n in args.sizes):
        raise ValueError("INVALID_BENCHMARK_SIZE")
    results = [benchmark(os.environ["TEST_DATABASE_URL"], n) for n in args.sizes]
    print(json.dumps({"benchmark": "synthetic-catalog-sql-pages", "results": results}, indent=2))


if __name__ == "__main__":
    main()
