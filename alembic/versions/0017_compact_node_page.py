"""Compact node-page projection for large lists."""

from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision = "0017_compact_node_page"
down_revision = "0016_servers_ipinfo_share"
branch_labels = depends_on = None


def execute(sql):
    op.execute(sa.text(sql.replace(":", r"\:")))


def upgrade():
    execute(Path(__file__).with_suffix(".sql").read_text())


def downgrade():
    text = (Path(__file__).parent / "0014_sources_airports_naming.sql").read_text()
    start = text.index("CREATE OR REPLACE FUNCTION nodema_node_page(")
    execute(
        text[
            start : text.index("CREATE OR REPLACE FUNCTION nodema_export_catalog_changed()", start)
        ]
    )
