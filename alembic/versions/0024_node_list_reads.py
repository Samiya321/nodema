"""Use the checked-at index and share the matching rows between count and page."""

import sqlalchemy as sa

from alembic import op

revision = "0024_node_list_reads"
down_revision = "0023_identity_naming"
branch_labels = depends_on = None

PAGE = "nodema_node_page(jsonb,text,integer,integer,integer,text,text)"
STATUS_ANCHOR = "     ELSIF key='id' THEN"
# The freshness condition is already implicit in catalog.status. Stating it
# directly lets PostgreSQL use idx_current_checked before joining the catalog.
LIVE_STATUS = (
    """     ELSIF key='status' AND (f->>key) IN ('AVAILABLE','UP','DEGRADED') THEN
       wh := wh || ' AND v.last_checked_at>=now()-make_interval(hours=>$2)';
       IF f->>key='AVAILABLE' THEN
         wh := wh || ' AND v.status IN (''UP'',''DEGRADED'')';
       ELSE
         wh := wh || ' AND v.status=$1->>''status''';
       END IF;
"""
    + STATUS_ANCHOR
)

COUNT_QUERY = (
    " EXECUTE 'SELECT count(*)' || sql_base INTO total "
    "USING f,fresh,tpl,operator_name,lim,off,vantage;\n"
)
RANKED_IDS = "SELECT v.id,row_number() OVER (ORDER BY ' || ord || ') AS pos' || sql_base ||\n"
PAGE_ROWS = (
    "coalesce(jsonb_agg(' || dto || ' ORDER BY chosen.pos),''[]''::jsonb)"
    " FROM chosen CROSS JOIN LATERAL (' || graded ||"
)
PAGE_QUERY = (
    " EXECUTE 'WITH chosen AS MATERIALIZED ("
    + RANKED_IDS
    + "   ' ORDER BY ' || ord || ' LIMIT $5 OFFSET $6) SELECT "
    + PAGE_ROWS
)
# Share the matched IDs between the total and the page, including an empty page
# beyond the last match. Render the full DTO only for the chosen IDs.
COUNT_AND_PAGE_QUERY = (
    " EXECUTE 'WITH matched AS MATERIALIZED ("
    + RANKED_IDS
    + "   '), chosen AS (SELECT id,pos FROM matched ORDER BY pos LIMIT $5 OFFSET $6)'\n"
    "   || ' SELECT (SELECT count(*) FROM matched)," + PAGE_ROWS
)

PATCHES = (
    (STATUS_ANCHOR, LIVE_STATUS),
    (COUNT_QUERY + " dto := ", " dto := "),
    (PAGE_QUERY, COUNT_AND_PAGE_QUERY),
    ("INTO items USING", "INTO total,items USING"),
)


def _patch(reverse=False):
    connection = op.get_bind()
    definition = connection.scalar(
        sa.text("SELECT pg_get_functiondef(to_regprocedure(:signature))"),
        {"signature": PAGE},
    )
    if not definition:
        raise RuntimeError("NODE_LIST_MIGRATION_FUNCTION_MISMATCH")
    for before, after in reversed(PATCHES) if reverse else PATCHES:
        if reverse:
            before, after = after, before
        if definition.count(before) != 1:
            raise RuntimeError("NODE_LIST_MIGRATION_FUNCTION_MISMATCH")
        definition = definition.replace(before, after)
    connection.execute(sa.text(definition.replace(":", r"\:")))


def upgrade():
    _patch()


def downgrade():
    _patch(reverse=True)
