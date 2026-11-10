"""Queued subscriptions, bounded version metadata, and transactional invalidation."""

from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision = "0010_async_exports"
down_revision = "0009_plaintext_lifetime"
branch_labels = depends_on = None


def execute(sql):
    op.execute(sa.text(sql.replace(":", r"\:")))


def upgrade():
    execute(Path(__file__).with_suffix(".sql").read_text())


def downgrade():
    for table in (
        "nodes",
        "sources",
        "node_sources",
        "node_current_status",
        "node_annotations",
        "runner_node_summaries",
        "naming_rules",
        "quality_policies",
    ):
        execute(f"DROP TRIGGER nodema_exports_changed ON {table}")
    execute("DROP TRIGGER nodema_export_config ON export_artifacts")
    for signature in (
        "nodema_export_metadata(uuid)",
        "nodema_export_serving(export_artifacts)",
        "nodema_export_config_changed()",
        "nodema_export_catalog_changed()",
        "nodema_invalidate_exports(uuid[])",
        "nodema_bump_catalog()",
        "nodema_validate_export(text,jsonb)",
        "nodema_export_lock()",
    ):
        execute("DROP FUNCTION " + signature)
    op.drop_table("export_members")
    op.drop_table("export_versions")
    op.drop_table("catalog_state")
    for column in (
        "name",
        "token_value",
        "status",
        "request_revision",
        "published_revision",
        "current_version",
        "catalog_revision",
        "invalidated",
        "requested_at",
        "built_at",
        "valid_until",
        "error_code",
        "failed_catalog_revision",
        "lease_owner",
        "lease_until",
        "payload_bytes",
        "payload_hash",
    ):
        op.drop_column("export_artifacts", column)
    execute(
        "UPDATE export_artifacts SET expires_at=now()+interval '1 day' WHERE expires_at IS NULL"
    )
    op.alter_column("export_artifacts", "expires_at", nullable=False)
    op.alter_column("export_artifacts", "payload_data", server_default=None)
    op.alter_column("export_artifacts", "node_count", server_default=None)
    original = Path(__file__).with_name("0009_plaintext_lifetime.sql").read_text()
    execute(original[original.index("CREATE OR REPLACE FUNCTION nodema_node_page(") :])
