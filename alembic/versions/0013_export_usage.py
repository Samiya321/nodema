"""Allow subscription-build attempts in the trusted Actions usage ledger."""

import sqlalchemy as sa

from alembic import op

revision = "0013_export_usage"
down_revision = "0012_trigger_search_path"
branch_labels = depends_on = None


def replace_constraint(workflows):
    op.drop_constraint(op.f("ck_action_runs_workflow"), "action_runs", type_="check")
    op.create_check_constraint(
        op.f("ck_action_runs_workflow"), "action_runs", f"workflow IN ({workflows})"
    )


def upgrade():
    replace_constraint("'daily-check','source-sync','backup','export-build'")


def downgrade():
    if op.get_bind().scalar(
        sa.text("SELECT EXISTS(SELECT 1 FROM action_runs WHERE workflow='export-build')")
    ):
        raise RuntimeError("EXPORT_USAGE_REQUIRES_BACKUP_FOR_DOWNGRADE")
    replace_constraint("'daily-check','source-sync','backup'")
