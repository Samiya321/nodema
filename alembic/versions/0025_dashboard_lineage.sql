CREATE TABLE substore_source_references (
 parent_id uuid NOT NULL REFERENCES sources(id),
 source_id uuid NOT NULL REFERENCES sources(id),
 origin_label text NOT NULL,
 is_present boolean NOT NULL DEFAULT true,
 first_seen_at timestamptz NOT NULL,
 last_seen_at timestamptz NOT NULL,
 PRIMARY KEY (parent_id,source_id),
 CONSTRAINT ck_substore_source_references_distinct_sources CHECK (parent_id <> source_id)
);
CREATE INDEX idx_substore_references_source ON substore_source_references(source_id);

CREATE FUNCTION nodema_source_effective_kind(s sources) RETURNS text
LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN s.detected_kind='UNKNOWN' AND s.type='SUBSCRIPTION_URL'
   AND convert_from(s.url_data,'UTF8') ~ '/api/subs/?([?#].*)?$' THEN 'SUBSTORE'
   ELSE nodema_source_kind(s.kind,s.detected_kind) END
$$;

CREATE FUNCTION nodema_source_node_rows(s sources, fresh integer)
RETURNS TABLE(node_id uuid, is_present boolean, first_seen_at timestamptz,
  last_seen_at timestamptz, availability text)
LANGUAGE sql STABLE AS $$
 SELECT ns.node_id,ns.is_present,ns.first_seen_at,ns.last_seen_at,
  CASE WHEN ns.is_present AND n.enabled AND s.deleted_at IS NULL
    AND c.status IN ('UP','DEGRADED')
    AND (nodema_source_kind(s.kind,s.detected_kind)<>'AIRPORT'
      OR nodema_source_usable(s.enabled,s.deleted_at,s.expires_at,
        s.traffic_upload,s.traffic_download,s.traffic_total))
   THEN CASE WHEN c.last_checked_at>=now()-make_interval(hours=>fresh) THEN 'current' ELSE 'stale' END
   ELSE NULL END
 FROM node_sources ns JOIN nodes n ON n.id=ns.node_id
 LEFT JOIN node_current_status c ON c.node_id=ns.node_id
 WHERE ns.source_id=s.id
$$;

CREATE FUNCTION nodema_source_counts(s sources, fresh integer)
RETURNS TABLE(node_count integer, present_count integer, up_count integer, stale_up_count integer)
LANGUAGE sql STABLE AS $$
 SELECT count(*)::int, count(*) FILTER (WHERE r.is_present)::int,
   count(*) FILTER (WHERE r.availability='current')::int,
   count(*) FILTER (WHERE r.availability='stale')::int
 FROM nodema_source_node_rows(s,fresh) r
$$;

-- Dashboard labels expose only recorded relationship metadata and the source host.
CREATE FUNCTION nodema_source_label(s sources) RETURNS jsonb
LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object(
  'id',s.id,'name',s.name,'type',s.type,'effective_kind',nodema_source_effective_kind(s),
  'enabled',s.enabled,'deleted_at',s.deleted_at,'parent_source_id',s.parent_source_id,
  'origin_label',s.origin_label,'provider_id',s.provider_id,
  'provider_name',(SELECT p.name FROM providers p WHERE p.id=s.provider_id),
  'last_sync_status',s.last_sync_status,'last_error_code',s.last_error_code,
  'last_checked_at',s.last_checked_at,'last_success_at',s.last_success_at,'created_at',s.created_at,
  'in_parent',(SELECT CASE WHEN p.last_sync_status='SUCCESS'
    AND jsonb_typeof(p.last_parse_summary #> '{children,missing_from_index}')='array'
    THEN NOT ((p.last_parse_summary #> '{children,missing_from_index}') ? s.id::text) END
    FROM sources p WHERE p.id=s.parent_source_id),
  'url_host',substring(convert_from(s.url_data,'UTF8') from
    '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#]*@)?(\[[^]]+\]|[^/:?#@]+)')
 )
$$;

CREATE FUNCTION nodema_source_chain(start_id uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
 WITH RECURSIVE ancestors(id,parent_id,visited) AS (
  SELECT s.id,s.parent_source_id,ARRAY[s.id] FROM sources s WHERE s.id=start_id
  UNION ALL
  SELECT p.id,p.parent_source_id,a.visited||p.id
  FROM ancestors a JOIN sources p ON p.id=a.parent_id
  WHERE NOT p.id=ANY(a.visited)
 )
 SELECT coalesce(jsonb_agg(nodema_source_label(s) ORDER BY cardinality(a.visited) DESC),'[]'::jsonb)
 FROM ancestors a JOIN sources s ON s.id=a.id
$$;

CREATE FUNCTION nodema_source_node_page(source_id uuid, fresh integer, tpl text,
 relation text, off integer, lim integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH matches AS MATERIALIZED (
  SELECT r.* FROM sources s CROSS JOIN LATERAL nodema_source_node_rows(s,fresh) r
  WHERE s.id=source_id AND (relation='history' OR (relation='present' AND r.is_present)
    OR relation=r.availability)
 ), chosen AS (
  SELECT * FROM matches ORDER BY last_seen_at DESC,node_id LIMIT lim OFFSET off
 )
 SELECT jsonb_build_object('total',(SELECT count(*) FROM matches),
  'items',coalesce(jsonb_agg(
    jsonb_build_object('id',c.node_id,'short_id',n.short_id,'name',n.name,'status',n.status,
      'enabled',n.enabled,'is_present',c.is_present,'availability',c.availability,
      'first_seen_at',c.first_seen_at,'last_seen_at',c.last_seen_at)
    ORDER BY c.last_seen_at DESC,c.node_id),'[]'::jsonb))
 FROM chosen c CROSS JOIN LATERAL (
  SELECT v.short_id,v.name,v.status,v.enabled FROM nodema_catalog(fresh,tpl,'GENERAL') v
  WHERE v.id=c.node_id OFFSET 0
 ) n
$$;

CREATE FUNCTION nodema_source_children_page(parent_id uuid, off integer, lim integer)
RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object(
  'total',(SELECT count(*) FROM sources s WHERE s.parent_source_id=parent_id),
  'items',coalesce(jsonb_agg(nodema_source_label(c) ORDER BY c.deleted_at IS NOT NULL,c.name,c.id),'[]'::jsonb)
 )
 FROM (SELECT * FROM sources s WHERE s.parent_source_id=parent_id
   ORDER BY s.deleted_at IS NOT NULL,s.name,s.id LIMIT lim OFFSET off) c
$$;

CREATE FUNCTION nodema_source_references(target uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_agg(
   jsonb_build_object('chain',nodema_source_chain(r.parent_id),'label',r.origin_label,
    'is_present',r.is_present,'first_seen_at',r.first_seen_at,'last_seen_at',r.last_seen_at)
   ORDER BY r.is_present DESC,r.last_seen_at DESC,r.parent_id),'[]'::jsonb)
 FROM substore_source_references r WHERE r.source_id=target
$$;

CREATE FUNCTION nodema_source_reference_page(parent uuid, off integer, lim integer)
RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object(
  'total',(SELECT count(*) FROM substore_source_references r WHERE r.parent_id=parent),
  'items',coalesce(jsonb_agg(nodema_source_label(s) || jsonb_build_object(
    'ref_label',c.origin_label,'ref_present',c.is_present,
    'ref_first_seen_at',c.first_seen_at,'ref_last_seen_at',c.last_seen_at)
    ORDER BY c.is_present DESC,c.origin_label,c.source_id),'[]'::jsonb)
 )
 FROM (SELECT * FROM substore_source_references r WHERE r.parent_id=parent
   ORDER BY r.is_present DESC,r.origin_label,r.source_id LIMIT lim OFFSET off) c
 JOIN sources s ON s.id=c.source_id
$$;

CREATE FUNCTION nodema_source_lineage(target uuid, fresh integer, default_template text,
 relation text, off integer, lim integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT to_jsonb(counts) || jsonb_build_object(
   'chain',nodema_source_chain(s.id),'references',nodema_source_references(s.id),
   'child_count',(SELECT count(*) FROM sources child WHERE child.parent_source_id=s.id),
   'reference_count',(SELECT count(*) FROM substore_source_references r WHERE r.parent_id=s.id),
   'relation',relation,'page', CASE relation
     WHEN 'children' THEN nodema_source_children_page(s.id,off,lim)
     WHEN 'references' THEN nodema_source_reference_page(s.id,off,lim)
     ELSE nodema_source_node_page(s.id,fresh,coalesce((SELECT template FROM naming_rules WHERE id=1),
       default_template),relation,off,lim)
   END)
 FROM sources s CROSS JOIN LATERAL nodema_source_counts(s,fresh) counts WHERE s.id=target
$$;

CREATE FUNCTION nodema_node_lineage(target uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object(
  'sources',coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'source_id',s.id,'name',s.name,'enabled',s.enabled,'deleted',s.deleted_at IS NOT NULL,
      'is_present',ns.is_present,'first_seen_at',ns.first_seen_at,'last_seen_at',ns.last_seen_at,
      'chain',nodema_source_chain(s.id))
      ORDER BY (ns.is_present AND s.deleted_at IS NULL) DESC,s.name,s.id)
    FROM node_sources ns JOIN sources s ON s.id=ns.source_id WHERE ns.node_id=target
  ),'[]'::jsonb),
  'exports',coalesce((
    SELECT jsonb_agg(jsonb_build_object('id',e.id,'name',e.name,
      'version',e.current_version,'serving',nodema_export_serving(e)) ORDER BY e.name,e.id)
    FROM export_members m JOIN export_artifacts e ON e.id=m.export_id WHERE m.node_id=target
  ),'[]'::jsonb)
 )
$$;

-- One statement keeps the member page and its published version on the same snapshot.
-- Supplying the last-read version prevents mixing pages during a rebuild.
CREATE FUNCTION nodema_export_member_page(target uuid, off integer, lim integer, fresh integer,
 tpl text, expected integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('version',e.current_version,'built_at',e.built_at,
  'total',e.node_count,'serving',nodema_export_serving(e),
  'changed',expected IS NOT NULL AND expected<>e.current_version,
  'items',CASE WHEN expected IS NULL OR expected=e.current_version THEN (
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.node_id,'short_id',n.short_id,
      'name',n.name,'status',n.status) ORDER BY m.node_id),'[]'::jsonb)
    FROM (SELECT member.node_id FROM export_members member WHERE member.export_id=e.id
      ORDER BY member.node_id LIMIT lim OFFSET off) m
    CROSS JOIN LATERAL (
      SELECT v.short_id,v.name,v.status FROM nodema_catalog(fresh,tpl,'GENERAL') v
      WHERE v.id=m.node_id OFFSET 0
    ) n
  ) ELSE '[]'::jsonb END)
 FROM export_artifacts e WHERE e.id=target
$$;

CREATE FUNCTION nodema_export_candidate_filters(f jsonb, at_time timestamptz, fresh integer)
RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT (f-'sort'-'limit') || jsonb_build_object(
   'status','UP','eligible',true,'last_success_after',
   greatest(at_time-make_interval(hours=>fresh),(f->>'last_success_after')::timestamptz)
 )
$$;

CREATE FUNCTION nodema_export_preview_count(f jsonb, at_time timestamptz, fresh integer,
 default_template text) RETURNS integer LANGUAGE sql STABLE AS $$
 SELECT least((f->>'limit')::integer,
  (nodema_node_page(nodema_export_candidate_filters(f,at_time,fresh),f->>'sort',0,1,
    fresh,coalesce((SELECT template FROM naming_rules WHERE id=1),default_template),'identity')
   ->>'total')::integer)
$$;
