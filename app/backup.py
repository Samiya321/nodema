"""Encrypted pg_dump/pg_restore. Passwords are passed only via the child environment."""

import os
import subprocess
from pathlib import Path

from sqlalchemy.engine import make_url

from app.domain import AssetError

MAX_BACKUP_BYTES = 268_435_456
MAX_ENVELOPE_OVERHEAD = 65


def pg_environment(database_url):
    url = make_url(database_url)
    if not url.drivername.startswith("postgresql"):
        raise AssetError("INVALID_DATABASE_URL")
    env = os.environ.copy()
    env.pop("PGSERVICE", None)
    env.pop("PGOPTIONS", None)
    env.update(
        PGHOST=url.host or "localhost",
        PGPORT=str(url.port or 5432),
        PGDATABASE=url.database or "",
        PGUSER=url.username or "",
        PGPASSWORD=url.password or "",
        PGCONNECT_TIMEOUT="10",
        PGSSLMODE=url.query.get(
            "sslmode", "prefer" if url.host in ("localhost", "127.0.0.1") else "require"
        ),
    )
    return env


def command(tool, docker_client):
    if not docker_client:
        return [tool]
    result = ["docker", "run", "--rm", "-i"]
    for key in (
        "PGHOST",
        "PGPORT",
        "PGDATABASE",
        "PGUSER",
        "PGPASSWORD",
        "PGCONNECT_TIMEOUT",
        "PGSSLMODE",
    ):
        result.extend(["-e", key])
    return result + ["postgres:17-alpine", tool]


def backup_database(database_url, cipher, output, *, docker_client=False):
    try:
        result = subprocess.run(
            command("pg_dump", docker_client)
            + ["-Fc", "--no-owner", "--no-acl", "--lock-wait-timeout=10000"],
            env=pg_environment(database_url),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=300,
            check=True,
        )
        if len(result.stdout) > MAX_BACKUP_BYTES:
            raise AssetError("BACKUP_TOO_LARGE")
        encrypted = cipher.encrypt(result.stdout, context="database-backup:v1")
        path = Path(output)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(encrypted)
    except AssetError:
        raise
    except (OSError, subprocess.SubprocessError):
        raise AssetError("DATABASE_BACKUP_FAILED") from None
    return {"status": "BACKED_UP", "bytes": len(encrypted)}


def restore_database(database_url, cipher, input_path, *, confirmed=False, docker_client=False):
    if not confirmed:
        raise AssetError("RESTORE_CONFIRMATION_REQUIRED")
    try:
        with Path(input_path).open("rb") as stream:
            encrypted = stream.read(MAX_BACKUP_BYTES + MAX_ENVELOPE_OVERHEAD + 1)
        if len(encrypted) > MAX_BACKUP_BYTES + MAX_ENVELOPE_OVERHEAD:
            raise AssetError("BACKUP_TOO_LARGE")
        raw = cipher.decrypt(encrypted, context="database-backup:v1")
        if len(raw) > MAX_BACKUP_BYTES:
            raise AssetError("BACKUP_TOO_LARGE")
        environment = pg_environment(database_url)
        subprocess.run(
            command("pg_restore", docker_client)
            + [
                "--dbname",
                environment["PGDATABASE"],
                "--clean",
                "--if-exists",
                "--no-owner",
                "--no-acl",
                "--exit-on-error",
                "--single-transaction",
            ],
            input=raw,
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=300,
            check=True,
        )
    except AssetError:
        raise
    except (OSError, subprocess.SubprocessError):
        raise AssetError("DATABASE_RESTORE_FAILED") from None
    return {"status": "RESTORED"}
