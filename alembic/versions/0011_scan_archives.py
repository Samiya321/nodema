"""Bounded scan detail retention with a durable closed-day watermark."""

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision = "0011_scan_archives"
down_revision = "0010_async_exports"
branch_labels = depends_on = None


def upgrade():
    op.add_column("catalog_state", sa.Column("closed_before", sa.Date(), nullable=True))
    op.add_column("scan_runs", sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "scan_runs",
        sa.Column(
            "archive_summary", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
    )


def downgrade():
    # Restoring archived members requires a backup, not silently reopening old days.
    connection = op.get_bind()
    if connection.scalar(
        sa.text("SELECT EXISTS(SELECT 1 FROM scan_runs WHERE archived_at IS NOT NULL)")
    ):
        raise RuntimeError("ARCHIVED_SCANS_REQUIRE_BACKUP_FOR_DOWNGRADE")
    op.drop_column("scan_runs", "archive_summary")
    op.drop_column("scan_runs", "archived_at")
    op.drop_column("catalog_state", "closed_before")
