"""Landing-IP details, per-server numbering with protocol suffixes, share links."""

from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision = "0016_servers_ipinfo_share"
down_revision = "0015_exit_asn_numbering"
branch_labels = depends_on = None


def execute(sql):
    op.execute(sa.text(sql.replace(":", r"\:")))


def _section(name, start, end):
    text = (Path(__file__).parent / name).read_text()
    first = text.index(start)
    return text[first : text.index(end, first)]


def upgrade():
    execute(Path(__file__).with_suffix(".sql").read_text())


def downgrade():
    if op.get_bind().scalar(
        sa.text(
            "SELECT EXISTS(SELECT 1 FROM naming_rules "
            "WHERE template ~ '[{](ORG|OPERATOR|VARIANT)[}]' "
            "AND template<>'{FLAG}{ROUTE}|{OPERATOR} {SEQ}{VARIANT}')"
        )
    ):
        raise RuntimeError("CUSTOM_TEMPLATE_USES_0016_TOKENS")
    # IP details and share links are derived data: Actions recreate them after an upgrade.
    execute("DROP FUNCTION nodema_catalog(integer,text,text)")
    execute("DROP VIEW nodema_catalog_base")
    execute("DROP FUNCTION nodema_validate_template(text)")
    execute(
        "DROP FUNCTION nodema_render_name("
        "text,text,text,text,text,text,text,text,text,integer,text)"
    )
    old = "0014_sources_airports_naming.sql"
    execute(
        _section(
            old, "CREATE FUNCTION nodema_render_name(", "CREATE FUNCTION nodema_validate_template("
        )
    )
    execute(
        _section(old, "CREATE FUNCTION nodema_validate_template(", "-- Both runtimes read this row")
    )
    execute(
        _section(
            old,
            "CREATE OR REPLACE VIEW nodema_catalog_base AS",
            "DROP FUNCTION nodema_catalog(integer,text,text);",
        )
    )
    execute(
        _section(
            old, "CREATE FUNCTION nodema_catalog(", "CREATE OR REPLACE FUNCTION nodema_node_page("
        )
    )
    execute(
        _section(
            "0015_exit_asn_numbering.sql",
            "CREATE OR REPLACE FUNCTION nodema_assign_names()",
            "-- One-time renumbering",
        )
    )
    execute("DROP FUNCTION nodema_name_targets()")
    execute("DROP VIEW nodema_name_keys")
    execute("DROP FUNCTION nodema_org_label(text,text,text)")
    execute("DROP FUNCTION nodema_protocol_label(text)")
    execute(
        "UPDATE naming_rules SET template='{FLAG}{ROUTE}|{ASN} {SEQ}',updated_at=now() "
        "WHERE template='{FLAG}{ROUTE}|{OPERATOR} {SEQ}{VARIANT}'"
    )
    execute("DELETE FROM node_names")
    execute("DROP INDEX idx_node_names_server")
    for column in ("server_key", "org_label", "variant"):
        op.drop_column("node_names", column)
    execute(
        "CREATE UNIQUE INDEX uq_node_names_group ON node_names(coalesce(entry_country,''),"
        "coalesce(exit_country,''),coalesce(asn_label,''),seq)"
    )
    op.drop_table("name_servers")
    op.drop_table("node_share_links")
    op.drop_table("ip_info")
    execute("SELECT nodema_assign_names()")
