"""British entry measurements and quality grades (ISO country GB)."""

import sqlalchemy as sa

from alembic import op

revision = "0022_uk_probes"
down_revision = "0021_udp_relay"
branch_labels = depends_on = None

VANTAGES = "'CN-CT','CN-CU','CN-CM','CN','HK','SG'"
PAGE = "nodema_node_page(jsonb,text,integer,integer,integer,text,text)"
STATUS = "nodema_probe_status(text)"


def _functions(old, new):
    connection = op.get_bind()
    for signature, before, after in (
        (PAGE, "vantage NOT IN (" + old + ")", "vantage NOT IN (" + new + ")"),
        (STATUS, "vantage IN ('HK','SG')", "vantage IN ('HK','SG','GB')"),
    ):
        if old.endswith("'GB'"):
            if signature == STATUS:
                before, after = after, before
        definition = connection.scalar(
            sa.text("SELECT pg_get_functiondef(to_regprocedure(:signature))"),
            {"signature": signature},
        )
        if not definition or definition.count(before) != 1:
            raise RuntimeError("UK_PROBE_MIGRATION_FUNCTION_MISMATCH")
        definition = definition.replace(before, after)
        if signature == PAGE:
            replacements = (
                ("v.udp_state,v.udp_ms)'", "v.udp_state,v.udp_ms,v.access_band)'"),
                ("'icmp_only','udp','udp_ms'))", "'icmp_only','udp','udp_ms','access_band'))"),
            )
            for previous, following in replacements:
                if old.endswith("'GB'"):
                    previous, following = following, previous
                if definition.count(previous) != 1:
                    raise RuntimeError("UK_PROBE_MIGRATION_COMPACT_MISMATCH")
                definition = definition.replace(previous, following)
        connection.execute(sa.text(definition.replace(":", r"\:")))


def _constraints(vantages):
    for table in ("entry_probe_results", "node_grades"):
        op.execute(f"ALTER TABLE {table} DROP CONSTRAINT {table}_vantage_check")
        op.execute(
            f"ALTER TABLE {table} ADD CONSTRAINT {table}_vantage_check"
            f" CHECK (vantage IN ({vantages}))"
        )


def upgrade():
    op.create_table(
        "entry_probe_rejections",
        sa.Column("ip", sa.Text(), primary_key=True),
        sa.Column("retry_after", sa.DateTime(timezone=True), nullable=False),
    )
    extended = VANTAGES + ",'GB'"
    _constraints(extended)
    _functions(VANTAGES, extended)


def downgrade():
    # Existing GB data intentionally prevents downgrade; never silently delete it.
    _constraints(VANTAGES)
    _functions(VANTAGES + ",'GB'", VANTAGES)
    op.drop_table("entry_probe_rejections")
