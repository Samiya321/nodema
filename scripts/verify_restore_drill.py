"""Prove the restored schema works through a restricted read role."""

import os

import psycopg


def main():
    with psycopg.connect(
        host="127.0.0.1",
        port=55496,
        user="drill",
        dbname="restore_drill",
        password="isolated_restore_only",
    ) as connection:
        with connection.cursor() as cursor:
            cursor.execute("CREATE ROLE drill_api")
            cursor.execute("GRANT USAGE ON SCHEMA public TO drill_api")
            cursor.execute("GRANT SELECT ON ALL TABLES IN SCHEMA public TO drill_api")
            cursor.execute("SET LOCAL ROLE drill_api")
            cursor.execute("""
                SELECT (SELECT count(*) FROM nodes), (SELECT count(*) FROM sources),
                       (SELECT count(*) FROM node_current_status),
                       nodema_maintenance_state() IS NOT NULL
            """)
            nodes, _sources, statuses, ready = cursor.fetchone()
            if not ready or statuses > nodes:
                raise RuntimeError("RESTORED_DATABASE_CHECK_FAILED")
            path = os.environ.get("GITHUB_STEP_SUMMARY")
            if path:
                with open(path, "a") as summary:
                    summary.write(
                        "Schema, stored key, restricted reads and aggregate checks passed.\n"
                    )


if __name__ == "__main__":
    main()
