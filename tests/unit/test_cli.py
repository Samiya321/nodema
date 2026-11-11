import os

from click import unstyle
from typer.testing import CliRunner

from app.cli import app


def test_key_initialization_private_and_non_overwriting(tmp_path):
    path = tmp_path / ".env"
    path.write_text("DATABASE_URL=synthetic\nENCRYPTION_KEY_B64=\nFINGERPRINT_KEY_B64=\n")
    runner = CliRunner()
    result = runner.invoke(app, ["keys", "init", "--env-file", str(path)])
    assert result.exit_code == 0 and "KEYS_INITIALIZED" in result.output
    content = path.read_text()
    assert (os.stat(path).st_mode & 0o777) == 0o600
    for line in content.splitlines():
        if "KEY_B64=" in line:
            assert line.split("=", 1)[1] not in result.output
    second = runner.invoke(app, ["keys", "init", "--env-file", str(path)])
    assert second.exit_code == 1 and "KEY_ALREADY_EXISTS" in second.output
    assert path.read_text() == content


def test_invalid_config_is_redacted(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("SOURCE_MAX_BYTES", "synthetic-config-secret")
    result = CliRunner().invoke(app, ["source", "list"])
    assert result.exit_code == 1
    assert "synthetic-config-secret" not in result.output
    assert "Traceback" not in result.output


def test_documented_required_option_names():
    runner = CliRunner()
    for command, option in (
        (["backup"], "--output-file"),
        (["restore"], "--input-file"),
        (["naming", "apply"], "--template-file"),
    ):
        response = runner.invoke(app, [*command, "--help"])
        assert response.exit_code == 0 and option in unstyle(response.output)


def test_daily_source_due_tolerates_schedule_jitter():
    from datetime import UTC, datetime

    from app.ingestion.service import source_due

    previous = datetime(2026, 11, 5, 20, 32, tzinfo=UTC)
    current = datetime(2026, 11, 6, 20, 17, tzinfo=UTC)
    assert source_due(previous, 86400, current)
    assert not source_due(current, 86400, current)
    assert not source_due(previous, 604800, current)


def test_usage_collection_accepts_default_branch_without_overriding_github_reserved_env(
    monkeypatch,
):
    import base64
    from types import SimpleNamespace

    from app import actions_usage

    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://unused")
    monkeypatch.setenv("FINGERPRINT_KEY_B64", base64.b64encode(b"H" * 32).decode())
    monkeypatch.setenv("GITHUB_REPOSITORY", "synthetic/repo")
    monkeypatch.setenv("GITHUB_TOKEN", "synthetic-token")
    monkeypatch.setenv(
        "GITHUB_WORKFLOW_REF", "synthetic/repo/.github/workflows/usage.yml@refs/heads/main"
    )
    monkeypatch.setattr("app.cli.service", lambda: SimpleNamespace(sessions=None))
    captured = {}

    def collect(*args, **kwargs):
        captured.update(kwargs)
        return {"status": "VERIFIED"}

    monkeypatch.setattr(actions_usage, "collect_actions", collect)
    response = CliRunner().invoke(
        app,
        [
            "usage",
            "collect-actions",
            "--run-id",
            "42",
            "--attempt",
            "1",
            "--trusted-branch",
            "main",
        ],
    )
    assert response.exit_code == 0, response.output
    assert captured["trusted_branch"] == "main"
    assert "synthetic-token" not in response.output


def test_sync_all_survives_an_unexpected_error_in_one_source(monkeypatch):
    import app.cli as cli

    class Fetcher:
        metrics = {}

        def reset_metrics(self):
            pass

        def fetch_meta(self, url, *, user_agent=None):
            raise AssertionError("no fetch expected")

    class Assets:
        sessions = None

        def __init__(self):
            self.fetcher, self.synced = Fetcher(), []

        def list_sources(self):
            return [
                {"id": i, "enabled": True, "sync_requested_at": "now", "last_sync_status": "NEVER"}
                for i in ("a", "b", "c")
            ]

        def fetch_targets(self, ids):
            return []

        def sync_source(self, source_id):
            self.synced.append(source_id)
            if source_id == "b":
                raise RuntimeError("secret https://private.example/sub?token=synthetic")
            return {"source_id": source_id, "status": "SUCCESS"}

    assets = Assets()
    monkeypatch.setattr(cli, "service", lambda: assets)
    monkeypatch.setattr("app.share_links.fill_missing", lambda sessions: {})
    result = CliRunner().invoke(app, ["source", "sync-all"])
    assert assets.synced == ["a", "b", "c"]  # the run continued past the broken source
    assert result.exit_code == 2  # FAILED results still exit 2 (workflow accepts it)
    assert "SYNC_INTERNAL_ERROR" in result.output and "RuntimeError" in result.output
    assert "private.example" not in result.output and "synthetic" not in result.output
