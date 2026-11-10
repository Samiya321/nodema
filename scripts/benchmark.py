"""Synthetic import benchmark in a disposable PostgreSQL schema. No endpoint connections."""

import json
import os
import secrets
import sys
import time
from pathlib import Path
from uuid import uuid4

import sqlalchemy as sa
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from alembic.config import Config  # noqa: E402

from alembic import command  # noqa: E402
from app.database.session import make_engine, session_factory  # noqa: E402
from app.domain import SourceType  # noqa: E402
from app.ingestion.service import AssetService  # noqa: E402


def main():
    load_dotenv(".env")
    url = os.environ["TEST_DATABASE_URL"]
    admin = make_engine(url)
    output = []
    for count in (100, 1000, 5000):
        schema = "benchmark_" + uuid4().hex
        with admin.begin() as conn:
            conn.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
        engine = sa.create_engine(
            url, hide_parameters=True, connect_args={"options": f"-csearch_path={schema}"}
        )
        try:
            config = Config("alembic.ini")
            with engine.begin() as conn:
                config.attributes["connection"] = conn
                command.upgrade(config, "head")
            assets = AssetService(
                session_factory(engine),
                secrets.token_bytes(32),
            )
            payload = "".join(
                f"vless://{uuid4()}@node-{i}.example:443?type=tcp&security=tls#Synthetic-{i}\n"
                for i in range(count)
            ).encode()
            source = assets.create_source(
                name="synthetic-benchmark", source_type=SourceType.RAW_TEXT, payload=payload
            )
            calls = []

            def record(*args, calls=calls):
                calls.append(1)

            sa.event.listen(engine, "before_cursor_execute", record)
            started = time.monotonic()
            imported = assets.sync_source(source["id"])
            first_duration = time.monotonic() - started
            first_calls = len(calls)
            started = time.monotonic()
            assert assets.sync_source(source["id"])["status"] == "UNCHANGED"
            with engine.connect() as conn:
                size = conn.scalar(
                    sa.text(
                        "SELECT sum(pg_total_relation_size(quote_ident(schemaname)||'.'||"
                        "quote_ident(tablename))) FROM pg_tables WHERE schemaname=:schema"
                    ),
                    {"schema": schema},
                )
            output.append(
                {
                    "nodes": count,
                    "import_seconds": round(first_duration, 3),
                    "import_roundtrips": first_calls,
                    "unchanged_seconds": round(time.monotonic() - started, 3),
                    "database_bytes": int(size),
                    "created_nodes": imported["created_nodes"],
                }
            )
        finally:
            engine.dispose()
            with admin.begin() as conn:
                conn.execute(sa.text(f'DROP SCHEMA "{schema}" CASCADE'))
    admin.dispose()
    print(json.dumps({"benchmark": "synthetic-import-only", "results": output}, indent=2))


if __name__ == "__main__":
    main()
