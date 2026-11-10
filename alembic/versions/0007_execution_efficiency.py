"""Persistent cooldowns and numeric execution-efficiency telemetry."""

import sqlalchemy as sa

from alembic import op

revision = "0007_execution_efficiency"
down_revision = "0006_quality_queries"
branch_labels = None
depends_on = None

COUNTERS = (
    "full_checks",
    "full_samples",
    "preflight_skips",
    "cooldown_skips",
    "dns_requests",
    "dns_cache_hits",
    "tcp_probes",
    "tcp_socket_attempts",
    "tcp_cache_hits",
    "runtime_starts",
    "runtime_reloads",
)


def upgrade():
    op.create_index("idx_nodes_endpoint", "nodes", ["server_host", "server_port"])
    op.create_index("idx_current_entry", "node_current_status", ["entry_country", "entry_asn"])
    op.create_index(
        "idx_current_exit", "node_current_status", ["last_exit_country", "last_exit_asn"]
    )
    op.create_index("idx_current_checked", "node_current_status", [sa.text("last_checked_at DESC")])
    op.create_index("idx_annotations_tags", "node_annotations", ["tags"], postgresql_using="gin")
    op.add_column(
        "node_current_status", sa.Column("next_full_check_at", sa.DateTime(timezone=True))
    )
    op.add_column(
        "node_current_status",
        sa.Column("measurement_kind", sa.Text(), nullable=False, server_default="FULL"),
    )
    for key in COUNTERS:
        op.add_column(
            "usage_events", sa.Column(key, sa.BigInteger(), nullable=False, server_default="0")
        )
    op.create_check_constraint(
        "optimization_counters", "usage_events", " AND ".join(f"{key} >= 0" for key in COUNTERS)
    )


def downgrade():
    for name, table in (
        ("idx_nodes_endpoint", "nodes"),
        ("idx_current_entry", "node_current_status"),
        ("idx_current_exit", "node_current_status"),
        ("idx_current_checked", "node_current_status"),
        ("idx_annotations_tags", "node_annotations"),
    ):
        op.drop_index(name, table_name=table)
    op.drop_constraint(op.f("ck_usage_events_optimization_counters"), "usage_events", type_="check")
    for key in reversed(COUNTERS):
        op.drop_column("usage_events", key)
    op.drop_column("node_current_status", "measurement_kind")
    op.drop_column("node_current_status", "next_full_check_at")
