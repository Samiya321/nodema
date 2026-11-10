"""Durable sync requests and immutable same-day supplemental scans."""

import sqlalchemy as sa

from alembic import op

revision = "0003_import_pipeline"
down_revision = "0002_monitoring"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("sources", sa.Column("sync_requested_at", sa.DateTime(timezone=True)))
    op.add_column("scan_runs", sa.Column("kind", sa.Text(), nullable=False, server_default="DAILY"))
    op.drop_constraint("uq_scan_runs_scan_date", "scan_runs", type_="unique")
    op.create_check_constraint(
        op.f("ck_scan_runs_kind"), "scan_runs", "kind IN ('DAILY','SUPPLEMENTAL')"
    )
    op.create_index(
        "uq_scan_runs_daily",
        "scan_runs",
        ["scan_date"],
        unique=True,
        postgresql_where=sa.text("kind = 'DAILY'"),
    )
    op.create_index("idx_scan_runs_day", "scan_runs", ["scan_date", "started_at"])


def downgrade():
    # Refuse to discard supplemental history or collapse several runs into one day.
    if op.get_bind().scalar(sa.text("SELECT count(*) FROM scan_runs WHERE kind <> 'DAILY'")):
        raise RuntimeError("SUPPLEMENTAL_HISTORY_PREVENTS_DOWNGRADE")
    op.drop_index("idx_scan_runs_day", table_name="scan_runs")
    op.drop_index("uq_scan_runs_daily", table_name="scan_runs")
    op.drop_constraint(op.f("ck_scan_runs_kind"), "scan_runs", type_="check")
    op.create_unique_constraint("uq_scan_runs_scan_date", "scan_runs", ["scan_date"])
    op.drop_column("scan_runs", "kind")
    op.drop_column("sources", "sync_requested_at")
