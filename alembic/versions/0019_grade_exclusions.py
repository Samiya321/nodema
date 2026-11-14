"""Ungraded available nodes (Cloudflare landings) read as NULL instead of PENDING."""

from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision = "0019_grade_exclusions"
down_revision = "0018_entry_probes_grading"
branch_labels = depends_on = None


def upgrade():
    op.execute(sa.text(Path(__file__).with_suffix(".sql").read_text()))


def downgrade():
    op.execute(
        sa.text(
            "CREATE OR REPLACE FUNCTION nodema_effective_grade(status text,grade text)"
            " RETURNS text LANGUAGE sql IMMUTABLE AS $$"
            " SELECT CASE WHEN status NOT IN ('UP','DEGRADED') THEN NULL"
            " ELSE coalesce(grade,'PENDING') END; $$"
        )
    )
