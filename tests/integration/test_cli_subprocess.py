"""Exercise the installed CLI, environment loading, migrations, and stdin end to end."""

import json
import os
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import pytest
import sqlalchemy as sa

from app.database.models import Base

pytestmark = pytest.mark.integration


def test_cli_subprocess_flow(db_engine, tmp_path):
    root = Path(__file__).resolve().parents[2]
    with db_engine.connect() as connection:
        schema = connection.scalar(sa.text("select current_schema()"))
    env = os.environ.copy()
    for key in (
        "DATABASE_URL",
        "MIGRATION_DATABASE_URL",
        "ENCRYPTION_KEY_B64",
        "FINGERPRINT_KEY_B64",
        "ENCRYPTION_KEY_ID",
        "NAME_TEMPLATE",
    ):
        env.pop(key, None)
    env["PGOPTIONS"] = f"-csearch_path={schema}"
    (tmp_path / ".env").write_text(
        "DATABASE_URL=" + db_engine.url.render_as_string(hide_password=False) + "\n"
    )

    def run(args, *, input=None, expected=0, decode=True):
        result = subprocess.run(
            [sys.executable, "-m", *args],
            cwd=tmp_path,
            env=env,
            input=input,
            text=True,
            capture_output=True,
            timeout=20,
        )
        if result.returncode != expected:
            pytest.fail(f"CLI step {args[:2]} failed (exit {result.returncode})")
        assert "Traceback" not in result.stdout + result.stderr
        return json.loads(result.stdout) if decode else result.stdout

    def cli(*args, **kwargs):
        return run(["app.cli", *args], **kwargs)

    cli("keys", "init")
    # Use temporary cwd's .env consistently with Settings; never require keys for migrations.
    run(["alembic", "-c", str(root / "alembic.ini"), "upgrade", "head"], decode=False)
    run(["alembic", "-c", str(root / "alembic.ini"), "check"], decode=False)
    sources = []
    for filename in ("sample_vless.txt", "sample_clash.yaml", "sample_singbox.json"):
        source = cli(
            "source",
            "create",
            "--name",
            filename,
            "--type",
            "UPLOADED_FILE",
            "--input-file",
            str(root / "tests/fixtures" / filename),
        )
        sources.append(source["id"])
        assert cli("source", "sync", source["id"])["status"] == "SUCCESS"
    nodes = cli("node", "list")
    assert len(nodes) == 1 and nodes[0]["eligible"]
    node_id = nodes[0]["id"]
    assert cli("source", "sync", sources[0])["status"] == "UNCHANGED"
    cli("node", "disable", node_id)
    assert not cli("node", "show", node_id)["eligible"]
    cli("node", "enable", node_id)
    cli("source", "update", sources[0], "--no-enabled")
    cli("source", "update", sources[0], "--enabled", "--name", "renamed")
    cli("source", "delete", sources[2])
    assert len(cli("source", "list", "--include-deleted")) == 3
    assert len(cli("source", "list")) == 2
    assert len(cli("naming", "preview")) == 1
    policy = cli("quality", "show")
    policy_file = tmp_path / "quality.json"
    policy_file.write_text(json.dumps({"min_samples": 1, "preferred_entry_countries": ["SG"]}))
    saved = cli(
        "quality",
        "apply",
        "--input-file",
        str(policy_file),
        "--expected-version",
        str(policy["version"]),
    )
    assert saved["version"] == policy["version"] + 1
    annotation_file = tmp_path / "annotation.json"
    annotation_file.write_text(
        json.dumps(
            {
                "tags": ["synthetic-cli"],
                "line_claim": "IEPL",
                "evidence_level": "DOCUMENTED",
                "reference": "https://evidence.example/synthetic",
            }
        )
    )
    annotated = cli("quality", "annotate", node_id, "--input-file", str(annotation_file))
    assert annotated["has_evidence"] and "reference" not in annotated
    filters_file = tmp_path / "filters.json"
    filters_file.write_text(json.dumps({"tags": ["synthetic-cli"], "protocol": "vless"}))
    filtered = cli(
        "node",
        "list",
        "--filters-file",
        str(filters_file),
        "--sort",
        "entry_country:asc,short_id:desc",
        "--limit",
        "1",
        "--with-total",
    )
    assert filtered["total"] == len(filtered["items"]) == 1
    assert filtered["items"][0]["line_type"] == "UNKNOWN"
    artifact = cli(
        "export",
        "create",
        "--format",
        "json",
        "--filters-file",
        str(filters_file),
        "--sort",
        "short_id:desc",
        "--limit",
        "1",
    )
    assert artifact["node_count"] == 0  # No proxy success has been measured by this CLI flow.
    assert artifact["filter_spec"]["limit"] == 1
    raw = (root / "tests/fixtures/sample_vless.txt").read_text()
    source = cli(
        "source",
        "create",
        "--name",
        "stdin-demo",
        "--type",
        "SINGLE_URI",
        "--input-file",
        "-",
        input=raw,
    )
    cli("source", "sync", source["id"])
    invalid = tmp_path / "mixed.txt"
    invalid.write_text(raw + "vmess://invalid\n")
    cli("source", "update", source["id"], "--input-file", str(invalid))
    assert cli("source", "sync", source["id"], expected=2)["status"] == "FAILED"
    mixed = cli(
        "source", "create", "--name", "mixed", "--type", "RAW_TEXT", "--input-file", str(invalid)
    )
    assert cli("source", "sync", mixed["id"], expected=2)["status"] == "PARTIAL"


def test_concurrent_migration_processes_share_one_schema(db_engine):
    schema = "migration_race_" + uuid4().hex
    root = Path(__file__).resolve().parents[2]
    with db_engine.begin() as conn:
        conn.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
    env = {
        **os.environ,
        "DATABASE_URL": db_engine.url.render_as_string(hide_password=False),
        "PGOPTIONS": f"-csearch_path={schema}",
    }
    env.pop("MIGRATION_DATABASE_URL", None)
    children = []
    try:
        for _ in range(2):
            children.append(
                subprocess.Popen(
                    [sys.executable, "-m", "alembic", "upgrade", "head"],
                    cwd=root,
                    env=env,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            )
        for child in children:
            assert child.wait(timeout=20) == 0, "Concurrent migration failed"
        with db_engine.connect() as conn:
            assert (
                conn.scalar(sa.text(f'SELECT version_num FROM "{schema}".alembic_version'))
                == "0013_export_usage"
            )
            tables = set(
                conn.scalars(
                    sa.text(
                        "SELECT table_name FROM information_schema.tables "
                        "WHERE table_schema=:schema AND table_type='BASE TABLE'"
                    ),
                    {"schema": schema},
                )
            )
            assert tables == set(Base.metadata.tables) | {"alembic_version"}
            views = set(
                conn.scalars(
                    sa.text(
                        "SELECT table_name FROM information_schema.views WHERE table_schema=:schema"
                    ),
                    {"schema": schema},
                )
            )
            assert views == {"nodema_catalog_base"}
    finally:
        for child in children:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
        with db_engine.begin() as conn:
            conn.execute(sa.text(f'DROP SCHEMA "{schema}" CASCADE'))
