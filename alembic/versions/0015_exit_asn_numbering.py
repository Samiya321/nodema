"""Number names per landing country + ASN; node-targeted test requests."""

from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision = "0015_exit_asn_numbering"
down_revision = "0014_sources_airports_naming"
branch_labels = depends_on = None


def execute(sql):
    op.execute(sa.text(sql.replace(":", r"\:")))


def _section(name, start, end):
    text = (Path(__file__).parent / name).read_text()
    first = text.index(start)
    return text[first : text.index(end, first)]


def upgrade():
    execute(Path(__file__).with_suffix(".sql").read_text())


def downgrade():
    if op.get_bind().scalar(
        sa.text("SELECT EXISTS(SELECT 1 FROM scan_requests WHERE node_ids IS NOT NULL)")
    ):
        raise RuntimeError("NODE_TEST_REQUESTS_REQUIRE_BACKUP_FOR_DOWNGRADE")
    execute("ALTER TABLE scan_requests DROP CONSTRAINT ck_scan_requests_node_ids")
    op.drop_column("scan_requests", "node_ids")
    execute(
        _section(
            "0014_sources_airports_naming.sql",
            "CREATE FUNCTION nodema_assign_names()",
            "CREATE FUNCTION nodema_flag(",
        ).replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION", 1)
    )
    execute("DELETE FROM node_names")
    execute("SELECT nodema_assign_names()")
