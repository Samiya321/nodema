import os

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
        assert response.exit_code == 0 and option in response.output


def test_daily_source_due_tolerates_schedule_jitter():
    from datetime import UTC, datetime

    from app.ingestion.service import source_due

    previous = datetime(2026, 11, 5, 20, 32, tzinfo=UTC)
    current = datetime(2026, 11, 6, 20, 17, tzinfo=UTC)
    assert source_due(previous, 86400, current)
    assert not source_due(current, 86400, current)
    assert not source_due(previous, 604800, current)
