"""Separate node classification evidence from airport subscription eligibility."""

from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision = "0028_node_classification"
down_revision = "0027_node_observations"
branch_labels = None
depends_on = None

PAGE = "nodema_node_page(jsonb,text,integer,integer,integer,text,text)"
TRIGGER = "nodema_export_catalog_changed()"
BASIS = "(SELECT classification_basis FROM nodema_node_classification WHERE node_id=v.id)"

PAGE_PATCHES = (
    ("v.endpoint_verified)'", f"v.endpoint_verified,{BASIS})'"),
    (
        "'limiting_vantage','endpoint_verified'))",
        "'limiting_vantage','endpoint_verified','classification_basis'))",
    ),
    (
        "''grade_reasons'',v.grade_reasons)' END;",
        f"''grade_reasons'',v.grade_reasons,''classification_basis'',{BASIS})' END;",
    ),
)
TRIGGER_PATCHES = (
    (
        "NEW.server_host,NEW.server_port,NEW.protocol,NEW.transport,NEW.security);",
        "NEW.server_host,NEW.server_port,NEW.protocol,NEW.transport,NEW.security)"
        " OR OLD.classification_override IS DISTINCT FROM NEW.classification_override;",
    ),
    (
        """-- is_present is informational now (retained nodes stay eligible).
       unsafe := ROW(OLD.node_id,OLD.source_id) IS DISTINCT FROM ROW(NEW.node_id,NEW.source_id);""",
        """unsafe := ROW(OLD.node_id,OLD.source_id) IS DISTINCT FROM ROW(NEW.node_id,NEW.source_id)
         OR (OLD.is_present AND NOT NEW.is_present
           AND EXISTS (SELECT 1 FROM sources s WHERE s.id=OLD.source_id
             AND nodema_source_kind(s.kind,s.detected_kind)='AIRPORT')
           AND NOT EXISTS (SELECT 1 FROM nodema_node_scope sc
             WHERE sc.node_id=OLD.node_id AND sc.eligible));""",
    ),
)


def execute(sql):
    op.execute(sa.text(sql.replace(":", r"\:")))


def patch_function(signature, patches, *, reverse=False):
    sql = op.get_bind().scalar(
        sa.text("SELECT pg_get_functiondef(to_regprocedure(:signature))"),
        {"signature": signature},
    )
    for before, after in reversed(patches) if reverse else patches:
        if reverse:
            before, after = after, before
        if not sql or sql.count(before) != 1:
            raise RuntimeError("NODE_CLASSIFICATION_FUNCTION_MIGRATION_MISMATCH")
        sql = sql.replace(before, after)
    execute(sql)


def upgrade():
    execute(Path(__file__).with_suffix(".sql").read_text())
    patch_function(PAGE, PAGE_PATCHES)
    patch_function(TRIGGER, TRIGGER_PATCHES)
    # Published files containing newly ineligible nodes must be rebuilt.
    execute("""
        SELECT nodema_bump_catalog();
        SELECT nodema_invalidate_exports(ARRAY(
          SELECT DISTINCT m.node_id FROM export_members m
          JOIN nodema_node_classification c ON c.node_id=m.node_id
          WHERE c.classification_basis='HISTORICAL_AIRPORT' AND NOT c.eligible
        ));
    """)


def downgrade():
    patch_function(TRIGGER, TRIGGER_PATCHES, reverse=True)
    patch_function(PAGE, PAGE_PATCHES, reverse=True)
    legacy = Path(__file__).with_name("0020_shared_credentials.sql").read_text()
    execute(
        "CREATE OR REPLACE VIEW nodema_node_scope AS"
        + legacy.split("CREATE OR REPLACE VIEW nodema_node_scope AS", 1)[1]
    )
    execute("""
        DROP FUNCTION nodema_set_node_classification(uuid,text,text);
        DROP VIEW nodema_node_classification;
        ALTER TABLE nodes DROP COLUMN classification_override,
          DROP COLUMN classification_note, DROP COLUMN classification_updated_at;
        SELECT nodema_bump_catalog();
    """)
