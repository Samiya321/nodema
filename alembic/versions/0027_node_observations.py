"""Expose the evidence behind grades and recent node observations."""

import sqlalchemy as sa

from alembic import op

revision = "0027_node_observations"
down_revision = "0026_maintenance"
branch_labels = depends_on = None

PAGE = "nodema_node_page(jsonb,text,integer,integer,integer,text,text)"
PATCHES = (
    (
        "   ELSIF key IN ('quality_grade','min_quality_grade') THEN",
        """   ELSIF key='endpoint_verified' THEN
       IF jsonb_typeof(val)<>'boolean' THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
       wh := wh || ' AND coalesce(v.endpoint_verified,false)=($1->''endpoint_verified'')::boolean';
   ELSIF key='stable_exit' THEN
       IF jsonb_typeof(val)<>'boolean' THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
       wh := wh || ' AND nodema_stable_exit(v.id)=($1->''stable_exit'')::boolean';
   ELSIF key IN ('quality_grade','min_quality_grade') THEN""",
    ),
    (
        "g.reasons AS grade_reasons,g.last_measured_at",
        "g.access_evidence,g.limiting_vantage,g.endpoint_verified,"
        "g.reasons AS grade_reasons,g.last_measured_at",
    ),
    (
        "v.identity_flags,v.exit_observed_at)'",
        "v.identity_flags,v.exit_observed_at,v.access_evidence,v.limiting_vantage,v.endpoint_verified)'",
    ),
    (
        "'identity_flags','exit_observed_at'))",
        "'identity_flags','exit_observed_at','access_evidence','limiting_vantage','endpoint_verified'))",
    ),
    (
        "NULLS LAST,g.score DESC NULLS LAST,c.id) AS server_rank",
        "NULLS LAST,g.endpoint_verified DESC NULLS LAST,"
        "g.score DESC NULLS LAST,c.id) AS server_rank",
    ),
    (
        "PARTITION BY coalesce(c.server_key,c.id::text) ORDER BY",
        "PARTITION BY coalesce(c.server_key,c.id::text),"
        "CASE WHEN $1 ? ''endpoint_verified'' THEN coalesce(g.endpoint_verified,false) END,"
        "CASE WHEN $1 ? ''stable_exit'' THEN nodema_stable_exit(c.id) END ORDER BY",
    ),
    (
        "|| ' NULLS LAST,v.quality_score '",
        "|| ' NULLS LAST,v.endpoint_verified DESC NULLS LAST,v.quality_score '",
    ),
)


def patch_page(reverse=False):
    connection = op.get_bind()
    definition = connection.scalar(
        sa.text("SELECT pg_get_functiondef(to_regprocedure(:signature))"),
        {"signature": PAGE},
    )
    for before, after in reversed(PATCHES) if reverse else PATCHES:
        if reverse:
            before, after = after, before
        if not definition or definition.count(before) != 1:
            raise RuntimeError("OBSERVATION_PAGE_MIGRATION_FUNCTION_MISMATCH")
        definition = definition.replace(before, after)
    connection.execute(sa.text(definition.replace(":", r"\:")))


OBSERVATIONS = """
CREATE FUNCTION nodema_recent_exit(nid uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH bounds AS (SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date AS today),
 exits AS (
   SELECT (checked_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
     exit_ip,exit_country,exit_asn,checked_at,
     lag(exit_ip) OVER (ORDER BY checked_at,id) AS previous_ip
   FROM test_results CROSS JOIN bounds
   WHERE node_id=nid AND status IN ('UP','DEGRADED') AND exit_ip IS NOT NULL
     AND checked_at >= (today-6)::timestamp AT TIME ZONE 'Asia/Shanghai'
     AND checked_at < (today+1)::timestamp AT TIME ZONE 'Asia/Shanghai'
 )
 SELECT jsonb_build_object(
   'observed_days',count(DISTINCT day),'ip_count',count(DISTINCT exit_ip),
   'country_count',count(DISTINCT exit_country),'asn_count',count(DISTINCT exit_asn),
   'last_change_at',max(checked_at) FILTER (WHERE previous_ip<>exit_ip),
   'last_observed_at',max(checked_at)) FROM exits
$$;

CREATE FUNCTION nodema_stable_exit(nid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT (e->>'observed_days')::int>=5 AND (e->>'ip_count')::int=1
 FROM (SELECT nodema_recent_exit(nid) e OFFSET 0) summary
$$;

CREATE FUNCTION nodema_node_observations(nid uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
 WITH bounds AS (
   SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date AS today
 ), dates AS (
   SELECT today-i AS day FROM bounds CROSS JOIN generate_series(0,6) i
 ), daily AS (
   SELECT day,
     CASE WHEN coalesce(s.successful_count,0)>0 THEN 'UP'
          WHEN coalesce(s.failed_count,0)>0 THEN 'DOWN' ELSE 'UNTESTED' END AS status,
     coalesce(s.successful_count,0) AS successful,coalesce(s.failed_count,0) AS failed
   FROM dates LEFT JOIN node_daily_stats s ON s.node_id=nid AND s.stat_date=day
 )
 SELECT jsonb_build_object(
   'days',(SELECT jsonb_agg(to_jsonb(d) ORDER BY day) FROM daily d),
   'exit',nodema_recent_exit(nid)
 )
$$;
"""


def upgrade():
    op.add_column("node_grades", sa.Column("access_evidence", sa.Text()))
    op.add_column("node_grades", sa.Column("limiting_vantage", sa.Text()))
    op.add_column(
        "node_grades",
        sa.Column("endpoint_verified", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.execute(sa.text(OBSERVATIONS.replace(":", r"\:")))
    patch_page()


def downgrade():
    patch_page(reverse=True)
    op.execute("DROP FUNCTION nodema_node_observations(uuid)")
    op.execute("DROP FUNCTION nodema_stable_exit(uuid)")
    op.execute("DROP FUNCTION nodema_recent_exit(uuid)")
    for column in ("access_evidence", "limiting_vantage", "endpoint_verified"):
        op.drop_column("node_grades", column)
