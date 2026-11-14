"""Nodes sharing one credential across servers count as airport nodes."""

from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision = "0020_shared_credentials"
down_revision = "0019_grade_exclusions"
branch_labels = depends_on = None


def upgrade():
    op.execute(sa.text(Path(__file__).with_suffix(".sql").read_text().replace(":", r"\:")))


def downgrade():
    # nodema_catalog_base depends on the view, so it cannot be dropped and a view
    # cannot lose a column: restore the 0014 rule and leave the new column constant.
    op.execute(
        sa.text(
            """CREATE OR REPLACE VIEW nodema_node_scope AS
 SELECT n.id AS node_id,
  CASE WHEN a.airport THEN 'AIRPORT' ELSE 'SELF_HOSTED' END AS node_group,
  (n.enabled AND (NOT a.airport OR a.usable)) AS eligible,
  a.provider_id,
  false AS credential_shared
 FROM nodes n CROSS JOIN LATERAL (
  SELECT coalesce(bool_or(true),false) AS airport,
   coalesce(bool_or(nodema_source_usable(s.enabled,s.deleted_at,s.expires_at,
     s.traffic_upload,s.traffic_download,s.traffic_total)),false) AS usable,
   (array_agg(s.provider_id ORDER BY (s.deleted_at IS NULL) DESC, s.created_at)
     FILTER (WHERE s.provider_id IS NOT NULL))[1] AS provider_id
  FROM node_sources ns JOIN sources s ON s.id=ns.source_id
  WHERE ns.node_id=n.id AND nodema_source_kind(s.kind,s.detected_kind)='AIRPORT'
 ) a"""
        )
    )
    op.execute(sa.text("DROP INDEX idx_nodes_credential"))
    op.execute(sa.text("ALTER TABLE nodes DROP COLUMN credential_key"))
