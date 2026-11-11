"""Restore an actual encrypted pg_dump into a separate disposable database."""

import os
import shutil
from datetime import UTC, datetime
from uuid import uuid4

import pytest
import sqlalchemy as sa
from sqlalchemy.engine import make_url

from app import backup
from app.database.models import NodeDailyStats
from app.database.session import make_engine
from app.domain import SourceType

pytestmark = pytest.mark.integration


def test_real_encrypted_database_restore(
    service, db_engine, cipher, fixture_bytes, tmp_path, monkeypatch
):
    source = service.create_source(
        name="synthetic-backup",
        source_type=SourceType.RAW_TEXT,
        payload=fixture_bytes("sample_vless.txt"),
    )
    service.sync_source(source["id"])
    with service.sessions.begin() as session:
        session.add(
            NodeDailyStats(
                node_id=service.list_nodes()[0]["id"],
                stat_date=datetime.now(UTC).date(),
                scheduled_count=1,
                successful_count=1,
                failed_count=0,
            )
        )
    with db_engine.connect() as conn:
        schema = conn.scalar(sa.text("SELECT current_schema()"))
    container = os.environ.get("TEST_PG_CONTAINER")
    if container:

        def command(tool, docker_client):
            # Real tools in the test database's container, with passwords passed via environment.
            return [
                "docker",
                "exec",
                "-i",
                "-e",
                "PGHOST=127.0.0.1",
                "-e",
                "PGPORT=5432",
                "-e",
                "PGDATABASE",
                "-e",
                "PGUSER",
                "-e",
                "PGPASSWORD",
                "-e",
                "PGSSLMODE",
                container,
                tool,
            ]
    else:

        def command(tool, docker_client):
            executable = shutil.which(tool)
            if not executable:
                pytest.fail(
                    "PostgreSQL client tools or TEST_PG_CONTAINER required for restore test"
                )
            return [executable]

    monkeypatch.setattr(backup, "command", command)
    url = db_engine.url.render_as_string(hide_password=False)
    name = "restore_test_" + uuid4().hex
    target_url = make_url(url).set(database=name)
    with db_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        conn.execute(sa.text(f'CREATE DATABASE "{name}"'))
    target = make_engine(target_url.render_as_string(hide_password=False))
    path = tmp_path / "database.nma"
    try:
        backup.backup_database(url, cipher, path)
        assert path.read_bytes()[:4] == b"NMA1"
        assert b"PGDMP" not in path.read_bytes()
        backup.restore_database(
            target_url.render_as_string(hide_password=False), cipher, path, confirmed=True
        )
        with target.connect() as conn:
            assert conn.scalar(sa.text(f'SELECT count(*) FROM "{schema}".nodes')) == 1
            encrypted = conn.scalar(sa.text(f'SELECT config_data FROM "{schema}".nodes'))
            assert conn.execute(
                sa.text(f'SELECT checked_days,available_days FROM "{schema}".nodes')
            ).one() == (1, 1)
            assert bytes(encrypted).startswith(b"{")
            assert (
                conn.scalar(sa.text(f'SELECT version_num FROM "{schema}".alembic_version'))
                == "0016_servers_ipinfo_share"
            )
        # Clean restores are repeatable and perform real writes to the target.
        with target.begin() as conn:
            # A restored schema must work even when the caller uses the default public path.
            conn.execute(sa.text("SET LOCAL search_path TO public"))
            conn.execute(sa.text(f'UPDATE "{schema}".nodes SET enabled=false'))
        backup.restore_database(
            target_url.render_as_string(hide_password=False), cipher, path, confirmed=True
        )
        with target.connect() as conn:
            assert conn.scalar(sa.text(f'SELECT enabled FROM "{schema}".nodes')) is True
    finally:
        target.dispose()
        with db_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(sa.text(f'DROP DATABASE "{name}" WITH (FORCE)'))
