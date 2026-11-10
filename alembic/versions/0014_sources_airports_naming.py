"""Airport/Sub-Store source taxonomy, retained nodes, scan scope and stable names."""

from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision = "0014_sources_airports_naming"
down_revision = "0013_export_usage"
branch_labels = depends_on = None


def execute(sql):
    op.execute(sa.text(sql.replace(":", r"\:")))


def upgrade():
    execute(Path(__file__).with_suffix(".sql").read_text())
    # New trigger lookups stay bound to this schema, like 0012.
    connection = op.get_bind()
    schema = connection.scalar(sa.text("SELECT current_schema()"))
    quote = connection.dialect.identifier_preparer.quote
    execute(
        f"ALTER FUNCTION {quote(schema)}.nodema_export_catalog_changed() "
        f"SET search_path TO {quote(schema)}, pg_temp"
    )


def _section(name, start, end):
    text = (Path(__file__).parent / name).read_text()
    first = text.index(start)
    return text[first : text.index(end, first)]


def downgrade():
    connection = op.get_bind()
    if connection.scalar(
        sa.text(
            "SELECT EXISTS(SELECT 1 FROM sources WHERE parent_source_id IS NOT NULL) "
            "OR EXISTS(SELECT 1 FROM providers) "
            "OR EXISTS(SELECT 1 FROM scan_runs WHERE kind='MANUAL')"
        )
    ):
        # Child sources, airports and manual batches cannot be reconstructed safely.
        raise RuntimeError("0014_REQUIRES_BACKUP_FOR_DOWNGRADE")
    execute("DROP TRIGGER nodema_exports_changed ON node_names")
    execute("DROP FUNCTION nodema_catalog(integer,text,text)")
    execute("DROP VIEW nodema_catalog_base")
    execute(
        _section(
            "0009_plaintext_lifetime.sql",
            "CREATE OR REPLACE VIEW nodema_catalog_base",
            "CREATE OR REPLACE FUNCTION nodema_node_page(",
        )
    )
    execute(
        _section(
            "0010_async_exports.sql",
            "CREATE OR REPLACE FUNCTION nodema_node_page(",
            "CREATE FUNCTION nodema_validate_export(",
        )
    )
    for signature in (
        "nodema_validate_template(text)",
        "nodema_render_name(text,text,text,text,text,text,text,text,integer)",
        "nodema_flag(text)",
        "nodema_assign_names()",
        "nodema_asn_label(bigint,text)",
        "nodema_org_short(text)",
    ):
        execute("DROP FUNCTION " + signature)
    execute("DROP VIEW nodema_node_scope")
    execute(
        "DROP FUNCTION nodema_source_usable(boolean,timestamptz,timestamptz,bigint,bigint,bigint)"
    )
    execute("DROP FUNCTION nodema_source_kind(text,text)")
    op.drop_table("node_names")
    op.drop_table("asn_labels")
    op.drop_table("app_settings")
    op.drop_column("node_current_status", "last_exit_asn_org")
    op.drop_column("test_results", "exit_asn_org")
    execute("ALTER TABLE scan_runs DROP CONSTRAINT ck_scan_runs_scope")
    op.drop_column("scan_runs", "scope")
    execute("ALTER TABLE scan_runs DROP CONSTRAINT ck_scan_runs_kind")
    execute(
        "ALTER TABLE scan_runs ADD CONSTRAINT ck_scan_runs_kind "
        "CHECK (kind IN ('DAILY','SUPPLEMENTAL'))"
    )
    execute(
        "UPDATE naming_rules SET template="
        "'{ENTRY_COUNTRY} → {EXIT_COUNTRY} | {PROTOCOL}-{TRANSPORT}-{SECURITY} | {SHORT_ID}' "
        "WHERE template='{FLAG}{ROUTE}|{ASN} {SEQ}'"
    )
    for column in (
        "kind",
        "detected_kind",
        "parent_source_id",
        "origin_key",
        "origin_label",
        "user_agent",
        "provider_id",
        "traffic_upload",
        "traffic_download",
        "traffic_total",
        "expires_at",
        "userinfo_at",
        "profile_title",
        "profile_url",
        "last_success_at",
    ):
        op.drop_column("sources", column)
    op.drop_table("providers")
