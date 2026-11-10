"""Bounded export projections without returning complete observation metadata."""

from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision = "0008_export_projection"
down_revision = "0007_execution_efficiency"
branch_labels = None
depends_on = None


def execute(sql):
    op.execute(sa.text(sql.replace(":", r"\:")))


def upgrade():
    op.execute("DROP FUNCTION nodema_node_page(jsonb,text,integer,integer,integer,text)")
    execute(Path(__file__).with_suffix(".sql").read_text())


def downgrade():
    op.execute("DROP FUNCTION nodema_node_page(jsonb,text,integer,integer,integer,text,text)")
    original = Path(__file__).with_name("0006_quality_queries.sql").read_text()
    execute(original[original.index("CREATE FUNCTION nodema_node_page(") :])
