"""Entry probes (Globalping), route traces, per-vantage node grades and grading rules."""

from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision = "0018_entry_probes_grading"
down_revision = "0017_scale_ip_type"
branch_labels = depends_on = None


def execute(sql):
    op.execute(sa.text(sql.replace(":", r"\:")))


def _section(name, start, end=None):
    text = (Path(__file__).parent / name).read_text()
    first = text.index(start)
    return text[first : text.index(end, first)] if end else text[first:]


def upgrade():
    execute(Path(__file__).with_suffix(".sql").read_text())


def downgrade():
    execute(
        _section(
            "0017_scale_ip_type.sql",
            "CREATE OR REPLACE FUNCTION nodema_node_page(",
        )
    )
    execute("DROP FUNCTION nodema_probe_status(text)")
    execute("DROP FUNCTION nodema_node_access(uuid)")
    execute("DROP FUNCTION nodema_effective_grade(text,text)")
    execute("DROP FUNCTION nodema_grade_rank(text)")
    for table in (
        "grading_policy_revisions",
        "grading_policy",
        "node_grades",
        "entry_probe_runs",
        "entry_route_traces",
        "entry_probe_results",
    ):
        op.drop_table(table)
