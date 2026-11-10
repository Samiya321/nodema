import subprocess

import pytest

from app.backup import backup_database, restore_database
from app.domain import AssetError


def test_backup_is_encrypted_and_password_never_in_argv(cipher, tmp_path, monkeypatch):
    calls = []
    raw = b"PGDMP-synthetic-private-database"

    def run(args, **kwargs):
        assert all("synthetic-password" not in arg for arg in args)
        assert kwargs["env"]["PGPASSWORD"] == "synthetic-password"
        assert kwargs["env"]["PGSSLMODE"] == "verify-full"
        assert kwargs["env"]["PGSSLROOTCERT"] == "system"
        assert kwargs["env"]["PGCHANNELBINDING"] == "require"
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(args, 0, stdout=raw)

    monkeypatch.setattr(subprocess, "run", run)
    url = (
        "postgresql+psycopg://user:synthetic-password@db.example/assets"
        "?sslmode=verify-full&sslrootcert=system&channel_binding=require"
    )
    path = tmp_path / "backup.nma"
    assert backup_database(url, cipher, path)["status"] == "BACKED_UP"
    assert raw not in path.read_bytes() and path.stat().st_mode & 0o777 == 0o600
    with pytest.raises(AssetError, match="RESTORE_CONFIRMATION_REQUIRED"):
        restore_database(url, cipher, path)
    restore_database(url, cipher, path, confirmed=True)
    assert calls[-1][1]["input"] == raw
    assert calls[-1][0][1:3] == ["--dbname", "assets"]
    assert "--single-transaction" in calls[-1][0]


def test_backup_plaintext_limit_roundtrips_with_encryption_overhead(cipher, tmp_path, monkeypatch):
    import app.backup as module

    monkeypatch.setattr(module, "MAX_BACKUP_BYTES", 64)
    restored = []
    raw = b"x" * 64

    def run(args, **kwargs):
        if args[0] == "pg_restore":
            restored.append(kwargs["input"])
        return subprocess.CompletedProcess(args, 0, stdout=raw)

    monkeypatch.setattr(subprocess, "run", run)
    path = tmp_path / "bounded.nma"
    url = "postgresql+psycopg://user:synthetic-password@db.example/assets"
    backup_database(url, cipher, path)
    assert path.stat().st_size > 64
    restore_database(url, cipher, path, confirmed=True)
    assert restored == [raw]
    path.write_bytes(cipher.encrypt(b"x" * 65, context="database-backup:v1"))
    with pytest.raises(AssetError, match="BACKUP_TOO_LARGE"):
        restore_database(url, cipher, path, confirmed=True)
    assert restored == [raw]
