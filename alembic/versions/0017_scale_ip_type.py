"""Compact node-page projection for large lists; landing IP type and {IPTYPE}."""

from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision = "0017_scale_ip_type"
down_revision = "0016_servers_ipinfo_share"
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
        sa.text("SELECT EXISTS(SELECT 1 FROM naming_rules WHERE template LIKE '%{IPTYPE}%')")
    ):
        raise RuntimeError("CUSTOM_TEMPLATE_USES_0017_TOKENS")
    execute("DROP FUNCTION nodema_catalog(integer,text,text)")
    execute("DROP VIEW nodema_catalog_base")
    execute("DROP FUNCTION nodema_validate_template(text)")
    execute(
        "DROP FUNCTION nodema_render_name("
        "text,text,text,text,text,text,text,text,text,integer,text,text)"
    )
    old = "0016_servers_ipinfo_share.sql"
    execute(
        _section(
            old, "CREATE FUNCTION nodema_render_name(", "CREATE FUNCTION nodema_validate_template("
        )
    )
    execute(
        _section(
            old,
            "CREATE FUNCTION nodema_validate_template(",
            "CREATE OR REPLACE VIEW nodema_catalog_base",
        )
    )
    execute(
        _section(
            old, "CREATE OR REPLACE VIEW nodema_catalog_base AS", "CREATE FUNCTION nodema_catalog("
        )
    )
    execute(_section(old, "CREATE FUNCTION nodema_catalog(", "-- The 0014 default gains"))
    execute(
        _section(
            "0014_sources_airports_naming.sql",
            "CREATE OR REPLACE FUNCTION nodema_node_page(",
            "CREATE OR REPLACE FUNCTION nodema_export_catalog_changed()",
        )
    )
    execute("DROP FUNCTION nodema_ip_type(boolean,boolean)")
    for column in ("is_mobile", "is_proxy", "is_hosting"):
        op.drop_column("ip_info", column)
