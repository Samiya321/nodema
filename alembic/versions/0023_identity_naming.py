"""Source-aware node identity and conservative display names."""

from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision = "0023_identity_naming"
down_revision = "0022_uk_probes"
branch_labels = depends_on = None

CATALOG = "nodema_catalog(integer,text,text)"
PAGE = "nodema_node_page(jsonb,text,integer,integer,integer,text,text)"
RENDER = "nodema_render_name(text,text,text,text,text,text,text,text,text,integer,text,text)"
SHORT = "nodema_org_short(text)"

PATCHES = (
    (
        RENDER,
        "WHEN entry IS NULL OR entry=ex THEN ex",
        "WHEN entry IS NULL THEN '?->'||ex WHEN entry=ex THEN ex",
        1,
    ),
    (
        SHORT,
        "IF org IS NULL OR btrim(org)='' THEN RETURN NULL; END IF;",
        "IF org IS NULL OR btrim(org)='' OR nodema_org_placeholder(org) THEN RETURN NULL; END IF;",
        1,
    ),
    (
        CATALOG,
        "security,entry_country,exit_country,asn_label",
        "security,nodema_display_entry(entry_country,exit_country,entry_ips,exit_ip),exit_country,asn_label",
        1,
    ),
    (
        CATALOG,
        "n.eligible, n.entry_country, n.entry_asn",
        "n.eligible, nodema_display_entry(n.entry_country,n.exit_country,n.entry_ips,n.exit_ip),"
        " n.entry_asn",
        1,
    ),
    (
        PAGE,
        "u.udp_checked_at,u.udp_success_at';",
        "u.udp_checked_at,u.udp_success_at,ni.flags AS identity_flags,ni.exit_observed_at,"
        "to_jsonb(ni)-''node_id''-''flags'' AS identity';",
        1,
    ),
    (
        PAGE,
        "LEFT JOIN node_current_status u ON u.node_id=c.id",
        "LEFT JOIN node_current_status u ON u.node_id=c.id"
        " LEFT JOIN nodema_identity_info ni ON ni.node_id=c.id",
        2,
    ),
    (
        PAGE,
        "v.udp_state,v.udp_ms,v.access_band)'",
        "v.udp_state,v.udp_ms,v.access_band,v.identity_flags,v.exit_observed_at)'",
        1,
    ),
    (
        PAGE,
        "'icmp_only','udp','udp_ms','access_band'))",
        "'icmp_only','udp','udp_ms','access_band','identity_flags','exit_observed_at'))",
        1,
    ),
)


def _patch(reverse=False):
    connection = op.get_bind()
    for signature, before, after, count in reversed(PATCHES) if reverse else PATCHES:
        if reverse:
            before, after = after, before
        definition = connection.scalar(
            sa.text("SELECT pg_get_functiondef(to_regprocedure(:s))"), {"s": signature}
        )
        if not definition or definition.count(before) != count:
            raise RuntimeError("IDENTITY_MIGRATION_FUNCTION_MISMATCH: " + signature)
        connection.execute(sa.text(definition.replace(before, after).replace(":", r"\:")))


def upgrade():
    op.execute(sa.text(Path(__file__).with_suffix(".sql").read_text().replace(":", r"\:")))
    _patch()
    op.execute("SELECT nodema_assign_names()")
    op.execute("SELECT nodema_bump_catalog()")
    op.execute("SELECT nodema_invalidate_exports(NULL)")


def downgrade():
    _patch(reverse=True)
    # Verified aliases are configuration and survive downgrade (including user edits).
    op.execute("DROP VIEW nodema_identity_info")
    op.execute("ALTER TABLE node_current_status DROP COLUMN exit_observed_at")
    op.execute("DROP FUNCTION nodema_display_entry(text,text,jsonb,text)")
    op.execute("DROP FUNCTION nodema_same_entry_exit(jsonb,text)")
    op.execute("DROP FUNCTION nodema_org_placeholder(text)")
    op.execute("SELECT nodema_assign_names()")
    op.execute("SELECT nodema_invalidate_exports(NULL)")
