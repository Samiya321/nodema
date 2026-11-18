"""Read the recorded source hierarchy and the last generated subscription."""

from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision = "0025_dashboard_lineage"
down_revision = "0024_node_list_reads"
branch_labels = depends_on = None

PAGE = "nodema_node_page(jsonb,text,integer,integer,integer,text,text)"
GRADE_ANCHOR = "   ELSIF key IN ('quality_grade','min_quality_grade') THEN"
GRADE_BUCKETS = (
    """   ELSIF key='quality_buckets' THEN
     IF jsonb_typeof(val)<>'array' OR jsonb_array_length(val) NOT BETWEEN 1 AND 8 THEN
       RAISE EXCEPTION 'INVALID_NODE_QUERY';
     END IF;
     IF EXISTS(SELECT 1 FROM jsonb_array_elements(val) b WHERE jsonb_typeof(b)<>'string'
       OR b#>>'{}' NOT IN ('S','A','B','C','D','PENDING','NONE','OFF')) THEN
       RAISE EXCEPTION 'INVALID_NODE_QUERY';
     END IF;
     wh := wh || ' AND coalesce(v.quality_grade,CASE WHEN v.status IN (''UP'',''DEGRADED'')'
       || ' THEN ''NONE'' ELSE ''OFF'' END)'
       || ' IN (SELECT jsonb_array_elements_text($1->''quality_buckets''))';
"""
    + GRADE_ANCHOR
)


def _patch(before, after):
    connection = op.get_bind()
    definition = connection.scalar(
        sa.text("SELECT pg_get_functiondef(to_regprocedure(:s))"), {"s": PAGE}
    )
    if not definition or definition.count(before) != 1:
        raise RuntimeError("DASHBOARD_LINEAGE_MIGRATION_FUNCTION_MISMATCH")
    connection.execute(sa.text(definition.replace(before, after).replace(":", r"\:")))


def upgrade():
    op.execute(sa.text(Path(__file__).with_suffix(".sql").read_text().replace(":", r"\:")))
    _patch(GRADE_ANCHOR, GRADE_BUCKETS)


def downgrade():
    _patch(GRADE_BUCKETS, GRADE_ANCHOR)
    for signature in (
        "nodema_export_preview_count(jsonb,timestamptz,integer,text)",
        "nodema_export_candidate_filters(jsonb,timestamptz,integer)",
        "nodema_export_member_page(uuid,integer,integer,integer,text,integer)",
        "nodema_node_lineage(uuid)",
        "nodema_source_lineage(uuid,integer,text,text,integer,integer)",
        "nodema_source_reference_page(uuid,integer,integer)",
        "nodema_source_references(uuid)",
        "nodema_source_children_page(uuid,integer,integer)",
        "nodema_source_node_page(uuid,integer,text,text,integer,integer)",
        "nodema_source_chain(uuid)",
        "nodema_source_label(sources)",
        "nodema_source_counts(sources,integer)",
        "nodema_source_node_rows(sources,integer)",
        "nodema_source_effective_kind(sources)",
    ):
        op.execute(f"DROP FUNCTION {signature}")
    op.drop_table("substore_source_references")
