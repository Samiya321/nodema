"""Shared PostgreSQL catalog, reference grading and Runner summaries."""

from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision = "0006_quality_queries"
down_revision = "0005_usage_observability"
branch_labels = None
depends_on = None


def upgrade():
    # The frozen SQL contains JSON literals and PostgreSQL casts, not bind parameters.
    op.execute(sa.text(Path(__file__).with_suffix(".sql").read_text().replace(":", r"\:")))


def downgrade():
    op.execute("""
    DROP FUNCTION nodema_node_page(jsonb,text,integer,integer,integer,text);
    DROP FUNCTION nodema_catalog(integer,text,text);
    DROP FUNCTION nodema_display_name(text,text,text,text,text,text,text);
    DROP VIEW nodema_catalog_base;
    DROP FUNCTION nodema_grade(jsonb,jsonb,integer,text);
    DROP FUNCTION nodema_refresh_runner_summaries(uuid[]);
    DROP TABLE runner_node_summaries;
    DROP TABLE quality_policy_revisions;
    DROP TABLE quality_policies;
    DROP TABLE node_annotations;
    ALTER TABLE node_current_status DROP COLUMN probe_key;
    ALTER TABLE test_results DROP COLUMN probe_key, DROP COLUMN probe_metadata,
      DROP COLUMN measurement_kind, DROP COLUMN precheck_metadata;
    """)
