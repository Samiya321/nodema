"""Operational summaries and bounded dashboard node reads."""

# ruff: noqa: E501
# Migration strings match the installed SQL definition, including whitespace.

from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision = "0026_maintenance"
down_revision = "0025_dashboard_lineage"
branch_labels = depends_on = None

PAGE = "nodema_node_page(jsonb,text,integer,integer,integer,text,text)"
BUCKET = (
    "coalesce(v.quality_grade,CASE WHEN v.status IN (''UP'',''DEGRADED'') "
    "THEN ''NONE'' ELSE ''OFF'' END)"
)
PATCHES = (
    ("items jsonb; dto text", "items jsonb; facets jsonb; pick text := 'true'; dto text"),
    ("'validate','compact')", "'validate','compact','dashboard','ids')"),
    (
        """     wh := wh || ' AND coalesce(v.quality_grade,CASE WHEN v.status IN (''UP'',''DEGRADED'')'
       || ' THEN ''NONE'' ELSE ''OFF'' END)'
       || ' IN (SELECT jsonb_array_elements_text($1->''quality_buckets''))';""",
        """     pick := 'bucket IN (SELECT jsonb_array_elements_text($1->''quality_buckets''))';
     IF projection<>'dashboard' THEN
       wh := wh || ' AND """
        + BUCKET
        + """'
         || ' IN (SELECT jsonb_array_elements_text($1->''quality_buckets''))';
     END IF;""",
    ),
    (
        "   ELSIF key='avail_7d' THEN expression := 'v.avail_7d_ratio';",
        """   ELSIF key='udp_state' THEN
     expression := 'CASE v.udp_state WHEN ''SUCCESS'' THEN 0 WHEN ''FAILED'' THEN 1 WHEN ''NOT_SUPPORTED'' THEN 2 ELSE 3 END';
   ELSIF key='checked_7d' THEN expression := 'v.checked_7d';
   ELSIF key='udp_ms' THEN expression := 'v.udp_ms';
   ELSIF key='operator_label' THEN expression := 'coalesce(v.org_label||''|'','''')||coalesce(v.asn_label,'''')';
   ELSIF key='avail_7d' THEN expression := 'v.avail_7d_ratio';""",
    ),
    (
        "dto := CASE projection WHEN 'identity'",
        "dto := CASE (CASE WHEN projection='dashboard' THEN 'compact' ELSE projection END) WHEN 'identity'",
    ),
    (
        " EXECUTE 'WITH matched AS MATERIALIZED (",
        """ IF projection='ids' THEN
   EXECUTE 'WITH matched AS MATERIALIZED (SELECT v.id' || sql_base
     || '), chosen AS (SELECT id FROM matched ORDER BY id LIMIT $5 OFFSET $6)
     SELECT (SELECT count(*) FROM matched),coalesce(jsonb_agg(jsonb_build_array(id) ORDER BY id),''[]'') FROM chosen'
     INTO total,items USING f,fresh,tpl,operator_name,lim,off,vantage;
   RETURN jsonb_build_object('items',items,'total',total,'vantage',vantage,'fields',jsonb_build_array('id'));
 END IF;
 IF projection='dashboard' THEN
   -- The counts cover the full query before the grade selection. Only the selected page
   -- pays for complete DTOs, source counts and display names.
   EXECUTE 'WITH matched AS MATERIALIZED (SELECT v.id,v.status,v.enabled,v.exit_country,v.exit_ip_type,v.udp_state,'
     || '"""
        + BUCKET
        + """ AS bucket,row_number() OVER (ORDER BY ' || ord || ') AS pos'
     || sql_base || '), chosen AS (SELECT id,pos FROM matched WHERE ' || pick || ' ORDER BY pos LIMIT $5 OFFSET $6)
     SELECT (SELECT count(*) FROM matched WHERE ' || pick || '),
     (SELECT jsonb_build_object(
       ''buckets'',(SELECT jsonb_object_agg(bucket,n) FROM (SELECT bucket,count(*) n FROM matched GROUP BY bucket) g),
       ''countries'',(SELECT jsonb_agg(country ORDER BY country) FROM (SELECT DISTINCT exit_country AS country FROM matched WHERE exit_country IS NOT NULL) c),
       ''total'',count(*),''available'',count(*) FILTER(WHERE status IN (''UP'',''DEGRADED'')),
       ''exportable'',count(*) FILTER(WHERE status=''UP'' AND enabled AND (' || pick || ')),
       ''udp'',count(*) FILTER(WHERE udp_state=''SUCCESS''),
       ''home'',count(*) FILTER(WHERE exit_ip_type=''RESIDENTIAL'')) FROM matched),
     coalesce(jsonb_agg(' || dto || ' ORDER BY chosen.pos),''[]'') FROM chosen
     CROSS JOIN LATERAL (' || graded || '
     FROM nodema_catalog($2,$3,$4) c LEFT JOIN node_grades g ON g.node_id=c.id AND g.vantage=$7
     LEFT JOIN node_current_status u ON u.node_id=c.id LEFT JOIN nodema_identity_info ni ON ni.node_id=c.id
     WHERE c.id=chosen.id OFFSET 0) v'
     INTO total,facets,items USING f,fresh,tpl,operator_name,lim,off,vantage;
 ELSE
 EXECUTE 'WITH matched AS MATERIALIZED (""",
    ),
    (
        " INTO total,items USING f,fresh,tpl,operator_name,lim,off,vantage;\n RETURN",
        " INTO total,items USING f,fresh,tpl,operator_name,lim,off,vantage;\n END IF;\n RETURN",
    ),
    (
        "('total',total,'items',items,'vantage',vantage) || CASE WHEN projection='compact'",
        """('total',total,'items',items,'vantage',vantage)
   || CASE WHEN projection='dashboard' THEN jsonb_build_object('facets',facets) ELSE '{}'::jsonb END
   || CASE WHEN projection IN ('compact','dashboard')""",
    ),
)


def patch_page(reverse=False):
    connection = op.get_bind()
    definition = connection.scalar(
        sa.text("SELECT pg_get_functiondef(to_regprocedure(:signature))"), {"signature": PAGE}
    )
    for before, after in reversed(PATCHES) if reverse else PATCHES:
        if reverse:
            before, after = after, before
        if not definition or definition.count(before) != 1:
            raise RuntimeError("MAINTENANCE_PAGE_MIGRATION_FUNCTION_MISMATCH")
        definition = definition.replace(before, after)
    connection.execute(sa.text(definition.replace(":", r"\:")))


def upgrade():
    op.execute(sa.text(Path(__file__).with_suffix(".sql").read_text().replace(":", r"\:")))
    patch_page()


def downgrade():
    patch_page(reverse=True)
    op.execute("DROP FUNCTION nodema_maintenance_state()")
    op.execute("DROP FUNCTION nodema_source_attention()")
    op.execute("DROP FUNCTION nodema_source_next_attempt(sources)")
    op.drop_table("host_capacity_samples")
