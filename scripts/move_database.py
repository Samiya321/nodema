"""Copy the whole database from SOURCE_DATABASE_URL to an empty TARGET_DATABASE_URL.

Runs pg_dump/pg_restore/psql 17 in Docker. Both URLs come from the environment only;
nothing secret is printed. Meant to run on a GitHub runner so the copy stays in the US.

--mode reduced keeps only the test_results rows node_current_status points at (the
older per-test detail is dropped); every other table is copied in full. Neon-only
column options (SET (pg_attver=...)) are removed so any PostgreSQL 17 accepts them.
"""

import argparse
import os
import subprocess
import sys
import tempfile

import sqlalchemy as sa

from app.backup import command, pg_environment
from app.database.session import make_engine

REFERENCED_RESULTS = (
    "SELECT * FROM test_results WHERE id IN"
    " (SELECT last_result_id FROM node_current_status WHERE last_result_id IS NOT NULL)"
)


def run(tool, url, args, *, stdin=None, stdout=None):
    env = pg_environment(url)
    # Local dry runs: containers reach a host-side test database by another name.
    env["PGHOST"] = os.environ.get("MOVE_DOCKER_HOST") or env["PGHOST"]
    process = subprocess.run(
        command(tool, True) + args,
        env=env,
        input=stdin,
        stdout=stdout if stdout is not None else subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if process.returncode:
        # libpq/pg_dump errors name objects and hosts, never passwords.
        sys.stderr.write(process.stderr.decode(errors="replace")[-4000:])
        raise SystemExit(f"{tool} failed ({process.returncode})")
    return process.stdout


def without_neon_options(sql: bytes) -> bytes:
    lines = sql.splitlines(keepends=True)
    kept = [line for line in lines if b"pg_attver" not in line]
    print(f"removed {len(lines) - len(kept)} Neon column-option lines")
    return b"".join(kept)


def psql(url, sql: bytes):
    run("psql", url, ["-q", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-f", "-"], stdin=sql)


def counts(url):
    engine = make_engine(url)
    with engine.connect() as c:
        tables = c.execute(
            sa.text("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")
        ).scalars()
        return {
            t: c.execute(sa.text(f'SELECT count(*) FROM public."{t}"')).scalar() for t in tables
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["full", "reduced"], required=True)
    mode = parser.parse_args().mode
    source, target = os.environ["SOURCE_DATABASE_URL"], os.environ["TARGET_DATABASE_URL"]
    if counts(target):
        raise SystemExit("target database is not empty")
    extra = ["--exclude-table-data=test_results"] if mode == "reduced" else []
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "db.dump")
        with open(path, "wb") as out:
            run(
                "pg_dump",
                source,
                ["-Fc", "--no-owner", "--no-acl", "--lock-wait-timeout=10000", *extra],
                stdout=out,
            )
        print(f"dump {os.path.getsize(path) / 1e6:.1f} MB (compressed)")
        dump = open(path, "rb").read()

        def section(name):
            return run(
                "pg_restore",
                target,
                ["--section", name, "--no-owner", "--no-acl", "-f", "-"],
                stdin=dump,
            )

        psql(target, without_neon_options(section("pre-data")))
        psql(target, section("data"))
        if mode == "reduced":
            rows = run("psql", source, ["-q", "-c", f"\\copy ({REFERENCED_RESULTS}) TO STDOUT"])
            # Same shape as a plain pg_dump script: COPY data inline, ended by \.
            psql(target, b"COPY public.test_results FROM stdin;\n" + rows + b"\\.\n")
            print("test_results: copied", rows.count(b"\n"), "referenced rows")
        psql(target, without_neon_options(section("post-data")))
    before, after = counts(source), counts(target)
    differ = {t: (before.get(t), after.get(t)) for t in before if before.get(t) != after.get(t)}
    print("tables", len(after), "rows", sum(after.values()))
    print("differences", differ or "none")
    allowed = {"test_results"} if mode == "reduced" else set()
    if set(differ) - allowed:
        raise SystemExit("row counts differ")


if __name__ == "__main__":
    main()
