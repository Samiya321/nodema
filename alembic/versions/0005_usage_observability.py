"""Safe execution counters, workflow timing and database capacity samples."""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0005_usage_observability"
down_revision = "0004_password_protocols"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("test_results", sa.Column("check_duration_ms", sa.Integer()))
    op.add_column(
        "test_results",
        sa.Column(
            "timeout_stages",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.create_table(
        "usage_events",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("entity_id", sa.Uuid()),
        sa.Column("scan_run_id", sa.Uuid(), sa.ForeignKey("scan_runs.id")),
        sa.Column("shard_no", sa.Integer()),
        sa.Column(
            "started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("outcome", sa.Text(), nullable=False, server_default="RUNNING"),
        *(
            sa.Column(key, sa.BigInteger(), nullable=False, server_default="0")
            for key in (
                "check_count",
                "check_duration_ms",
                "timeout_checks",
                "echo_requests",
                "echo_failures",
                "echo_response_bytes",
                "source_requests",
                "source_response_bytes",
                "subscription_downloads",
                "subscription_bytes",
                "network_samples",
                "network_rx_bytes",
                "network_tx_bytes",
            )
        ),
        sa.CheckConstraint(
            "kind IN ('CHECK','SOURCE','SUBSCRIPTION','JOB')", name=op.f("ck_usage_events_kind")
        ),
        sa.CheckConstraint(
            "outcome IN ('RUNNING','COMPLETED','SUCCESS','UNCHANGED','PARTIAL','FAILED',"
            "'ENVIRONMENT_ERROR','CONFLICT')",
            name=op.f("ck_usage_events_outcome"),
        ),
        sa.CheckConstraint(
            "check_count >= 0 AND check_duration_ms >= 0 AND timeout_checks >= 0 AND "
            "echo_requests >= 0 AND echo_failures >= 0 AND echo_response_bytes >= 0 AND "
            "source_requests >= 0 AND source_response_bytes >= 0 AND "
            "subscription_downloads >= 0 AND subscription_bytes >= 0 AND "
            "network_samples >= 0 AND network_rx_bytes >= 0 AND network_tx_bytes >= 0",
            name=op.f("ck_usage_events_counters"),
        ),
        sa.ForeignKeyConstraint(
            ["scan_run_id", "shard_no"], ["scan_shards.scan_run_id", "scan_shards.shard_no"]
        ),
    )
    op.create_index("idx_usage_events_time", "usage_events", ["started_at", "kind"])
    op.create_table(
        "database_samples",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "taken_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("database_bytes", sa.BigInteger(), nullable=False),
        sa.Column("table_bytes", sa.BigInteger(), nullable=False),
        sa.Column("connections", sa.Integer(), nullable=False),
    )
    op.create_index("idx_database_samples_time", "database_samples", ["taken_at"])
    op.create_table(
        "action_runs",
        sa.Column("run_id", sa.BigInteger(), primary_key=True),
        sa.Column("attempt", sa.Integer(), primary_key=True),
        sa.Column("workflow", sa.Text(), nullable=False),
        sa.Column("conclusion", sa.Text(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("runner_ms", sa.BigInteger(), nullable=False),
        sa.Column("job_count", sa.Integer(), nullable=False),
        sa.Column("failed_jobs", sa.Integer(), nullable=False),
        sa.Column("unmeasured_jobs", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "workflow IN ('daily-check','source-sync','backup')",
            name=op.f("ck_action_runs_workflow"),
        ),
        sa.CheckConstraint(
            "attempt > 0 AND runner_ms >= 0 AND job_count >= 0 "
            "AND failed_jobs >= 0 AND unmeasured_jobs >= 0",
            name=op.f("ck_action_runs_counters"),
        ),
    )
    op.create_index("idx_action_runs_time", "action_runs", ["started_at"])


def downgrade():
    op.drop_table("action_runs")
    op.drop_table("database_samples")
    op.drop_table("usage_events")
    op.drop_column("test_results", "timeout_stages")
    op.drop_column("test_results", "check_duration_ms")
