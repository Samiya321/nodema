import os
from pathlib import Path
from uuid import uuid4

import pytest
import sqlalchemy as sa
from alembic.config import Config
from dotenv import load_dotenv

from alembic import command
from app.config import Settings
from app.database.session import make_engine, session_factory
from app.ingestion.service import AssetService
from app.security.crypto import Cipher

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"


@pytest.fixture
def fixture_bytes():
    return lambda name: (FIXTURES / name).read_bytes()


@pytest.fixture
def cipher():
    return Cipher(b"E" * 32, "test-v1")


@pytest.fixture
def migration_config():
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(ROOT / "alembic"))
    return config


@pytest.fixture
def db_engine(migration_config, monkeypatch):
    import base64

    monkeypatch.setenv("ENCRYPTION_KEY_B64", base64.b64encode(b"E" * 32).decode())
    load_dotenv(ROOT / ".env")
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.fail("TEST_DATABASE_URL required; integration tests are never silently skipped")
    admin = make_engine(url)
    schema = "test_" + uuid4().hex
    with admin.begin() as conn:
        conn.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
    engine = sa.create_engine(
        url, hide_parameters=True, connect_args={"options": f"-csearch_path={schema}"}
    )
    try:
        with engine.begin() as conn:
            migration_config.attributes["connection"] = conn
            command.upgrade(migration_config, "head")
        yield engine
    finally:
        engine.dispose()
        with admin.begin() as conn:
            conn.execute(sa.text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


@pytest.fixture
def service(db_engine, cipher):
    return AssetService(session_factory(db_engine), b"H" * 32)


@pytest.fixture
def monitor_settings():
    import base64

    return Settings(
        _env_file=None,
        database_url="postgresql+psycopg://unused",
        encryption_key_b64=base64.b64encode(b"E" * 32).decode(),
        fingerprint_key_b64=base64.b64encode(b"H" * 32).decode(),
        admin_password="synthetic-admin-token-at-least-32-characters",
        retry_delay_seconds=0,
        check_concurrency=1,
        check_batch_size=1,
        precheck_gate_enabled=False,
        failure_cooldown_enabled=False,
        udp_check_enabled=False,  # UDP has its own tests; fakes here have no real listener
        echo_url="https://echo.example/",
        github_repository="",
        github_dispatch_token="",
    )
