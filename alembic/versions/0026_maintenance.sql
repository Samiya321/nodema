CREATE TABLE host_capacity_samples (
  taken_at timestamptz CONSTRAINT pk_host_capacity_samples PRIMARY KEY DEFAULT now(),
  disk_free bigint NOT NULL CONSTRAINT ck_host_capacity_samples_disk_free CHECK (disk_free >= 0),
  disk_total bigint NOT NULL CONSTRAINT ck_host_capacity_samples_disk_total CHECK (disk_total > 0 AND disk_free <= disk_total),
  db_bytes bigint NOT NULL CONSTRAINT ck_host_capacity_samples_db_bytes CHECK (db_bytes >= 0),
  pg_connections integer NOT NULL CONSTRAINT ck_host_capacity_samples_pg_connections CHECK (pg_connections >= 0),
  mem_available bigint NOT NULL CONSTRAINT ck_host_capacity_samples_mem_available CHECK (mem_available >= 0),
  mem_total bigint NOT NULL CONSTRAINT ck_host_capacity_samples_mem_total CHECK (mem_total > 0 AND mem_available <= mem_total),
  tls_expires_at timestamptz NOT NULL,
  postgres_restarts integer NOT NULL CONSTRAINT ck_host_capacity_samples_postgres_restarts CHECK (postgres_restarts >= 0),
  tunnel_restarts integer NOT NULL CONSTRAINT ck_host_capacity_samples_tunnel_restarts CHECK (tunnel_restarts >= 0)
);

-- Only the root-owned host sampler writes capacity samples. Database runtime roles read them.
DO $$
BEGIN
  IF current_user='nodema_owner' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nodema_api') THEN
    REVOKE INSERT, UPDATE, DELETE ON host_capacity_samples FROM nodema_api;
  END IF;
END $$;

CREATE FUNCTION nodema_source_next_attempt(s sources) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
 SELECT CASE
   WHEN NOT s.enabled OR s.deleted_at IS NOT NULL OR s.type<>'SUBSCRIPTION_URL' THEN NULL
   ELSE ((greatest((now() AT TIME ZONE 'Asia/Shanghai')::date,
     (timing.due AT TIME ZONE 'Asia/Shanghai')::date)::timestamp + interval '4h 17m'
     + CASE WHEN greatest((now() AT TIME ZONE 'Asia/Shanghai')::date,
           (timing.due AT TIME ZONE 'Asia/Shanghai')::date)::timestamp + interval '4h 17m'
           < greatest(now() AT TIME ZONE 'Asia/Shanghai', timing.due AT TIME ZONE 'Asia/Shanghai')
          THEN interval '1 day' ELSE interval '0' END) AT TIME ZONE 'Asia/Shanghai')
 END
 FROM LATERAL (SELECT CASE
   WHEN s.sync_requested_at IS NOT NULL OR s.last_checked_at IS NULL THEN now()
   WHEN s.last_sync_status='FAILED' AND coalesce(s.last_success_at,s.created_at)<=now()-interval '7 days'
     THEN s.last_checked_at + interval '7 days'
   WHEN s.sync_interval_seconds % 86400 = 0
     THEN (((s.last_checked_at AT TIME ZONE 'Asia/Shanghai')::date + s.sync_interval_seconds/86400)::timestamp AT TIME ZONE 'Asia/Shanghai')
   ELSE s.last_checked_at + make_interval(secs=>s.sync_interval_seconds) END AS due) timing
$$;

CREATE FUNCTION nodema_maintenance_state() RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH latest AS (
   SELECT id,scan_date,scope,kind,status,node_count,started_at,finished_at FROM scan_runs
   ORDER BY scan_date DESC,started_at DESC,id DESC LIMIT 1
 ), daily AS (
   SELECT id,scan_date,scope,status,node_count,started_at,finished_at,archived_at FROM scan_runs
   WHERE kind='DAILY' ORDER BY scan_date DESC LIMIT 1
 ), complete AS (
   SELECT id,scan_date,scope,finished_at FROM scan_runs
   WHERE kind='DAILY' AND status='COMPLETED' AND finished_at IS NOT NULL
   ORDER BY scan_date DESC LIMIT 1
 ), probes AS (
   SELECT started_at,finished_at,measurements,tests,failed,rate_limited,error_code FROM entry_probe_runs
   ORDER BY started_at DESC LIMIT 1
 ), source_counts AS (
   SELECT count(*) AS total,count(*) FILTER(WHERE enabled) AS enabled,
     count(*) FILTER(WHERE enabled AND (sync_requested_at IS NOT NULL OR last_sync_status='NEVER')) AS pending,
     count(*) FILTER(WHERE enabled AND last_sync_status='FAILED' AND last_success_at IS NOT NULL) AS broken,
     count(*) FILTER(WHERE enabled AND last_sync_status='FAILED' AND last_success_at IS NULL) AS never_worked,
     count(*) FILTER(WHERE parent_source_id IS NULL) AS roots,
     count(*) FILTER(WHERE parent_source_id IS NOT NULL) AS children,
     max(last_checked_at) AS last_checked_at,max(last_success_at) AS last_success_at
   FROM sources WHERE deleted_at IS NULL
 ), export_counts AS (
   SELECT count(*) AS active,count(*) FILTER(WHERE nodema_export_serving(e)) AS serving,
     count(*) FILTER(WHERE invalidated) AS pending,
     count(*) FILTER(WHERE NOT nodema_export_serving(e)
       AND coalesce(requested_at,created_at)<now()-interval '3 hours') AS unavailable,
     max(built_at) AS last_built_at
   FROM export_artifacts e WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())
 )
 SELECT jsonb_build_object(
   'observed_at',now(),
   'daily_enabled',coalesce((SELECT daily_scan_enabled FROM app_settings WHERE id=1),true),
   'daily_scope',coalesce((SELECT daily_scan_scope FROM app_settings WHERE id=1),'SELF_HOSTED'),
   'probe_enabled',coalesce((SELECT (policy->>'probe_enabled')::boolean FROM grading_policy WHERE id=1),true),
   'last_daily',(SELECT to_jsonb(d) || jsonb_build_object('lease_active',EXISTS(
      SELECT 1 FROM scan_shards s WHERE s.scan_run_id=d.id AND s.lease_until>now())) FROM daily d),
   'last_complete',(SELECT to_jsonb(c) FROM complete c),
   'latest_scan',(SELECT to_jsonb(l) || jsonb_build_object('done',CASE WHEN l.status='COMPLETED' THEN l.node_count
     ELSE (SELECT count(*) FROM scan_items i WHERE i.scan_run_id=l.id AND i.status='DONE') END) FROM latest l),
   'queued_scan_at',(SELECT min(requested_at) FROM scan_requests WHERE consumed_at IS NULL),
   'probe',(SELECT to_jsonb(p) FROM probes p),
   'recent_probe_errors',(SELECT count(*) FILTER(WHERE error_code IS NOT NULL) FROM (
     SELECT error_code FROM entry_probe_runs WHERE finished_at IS NOT NULL
     ORDER BY started_at DESC LIMIT 2) latest_probes),
   'sources',(SELECT to_jsonb(s) FROM source_counts s),
   'exports',(SELECT to_jsonb(e) FROM export_counts e),
   'host',(SELECT to_jsonb(h) FROM host_capacity_samples h ORDER BY taken_at DESC LIMIT 1),
   'capacity_24h',(SELECT jsonb_build_object('connections_peak',max(pg_connections),'db_peak_bytes',max(db_bytes),
     'mem_min_bytes',min(mem_available),'samples',count(*)) FROM host_capacity_samples WHERE taken_at>now()-interval '24 hours'),
   'last_daily_capacity',(SELECT jsonb_build_object('scan_date',c.scan_date,
     'connections_peak',max(h.pg_connections),'db_peak_bytes',max(h.db_bytes),
     'mem_min_bytes',min(h.mem_available),'disk_min_bytes',min(h.disk_free),'samples',count(h.taken_at),
     'started_at',c.started_at,'finished_at',c.finished_at,'first_sample_at',min(h.taken_at)) FROM
       (SELECT scan_date,started_at,finished_at FROM scan_runs WHERE kind='DAILY' AND status='COMPLETED'
        AND finished_at IS NOT NULL ORDER BY scan_date DESC LIMIT 1) c
       LEFT JOIN host_capacity_samples h ON h.taken_at BETWEEN c.started_at AND c.finished_at
       GROUP BY c.scan_date,c.started_at,c.finished_at),
   'daily_history',(SELECT coalesce(jsonb_agg(r ORDER BY scan_date),'[]') FROM (
     SELECT id,scan_date,node_count,status FROM scan_runs WHERE kind='DAILY' ORDER BY scan_date DESC LIMIT 7) r)
 )
$$;

CREATE FUNCTION nodema_source_attention() RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH RECURSIVE failed AS (
   SELECT id,parent_source_id,name,last_error_code,last_success_at,nodema_source_next_attempt(s) AS next_attempt
   FROM sources s WHERE deleted_at IS NULL AND enabled AND last_sync_status='FAILED'
 ), ancestors(leaf,id,parent,path) AS (
   SELECT id,id,parent_source_id,ARRAY[id] FROM failed
   UNION ALL
   SELECT a.leaf,p.id,p.parent_source_id,a.path||p.id
   FROM ancestors a JOIN sources p ON p.id=a.parent WHERE NOT p.id=ANY(a.path)
 ), roots AS (
   SELECT DISTINCT ON (leaf) leaf,id FROM ancestors ORDER BY leaf,cardinality(path) DESC
 ), grouped AS (
   SELECT p.id,p.name,count(*) AS total,count(*) FILTER(WHERE f.last_success_at IS NOT NULL) AS worked,
     min(f.next_attempt) AS next_attempt,
     (array_agg(f.id ORDER BY f.last_success_at DESC NULLS LAST,f.id))[1] AS example_id
   FROM roots r JOIN failed f ON f.id=r.leaf JOIN sources p ON p.id=r.id GROUP BY p.id,p.name
 ), top_groups AS (
   SELECT g.*,ARRAY(SELECT DISTINCT f.last_error_code FROM roots r JOIN failed f ON f.id=r.leaf
     WHERE r.id=g.id AND f.last_error_code IS NOT NULL ORDER BY f.last_error_code LIMIT 3) AS errors
   FROM grouped g ORDER BY worked DESC,total DESC,id LIMIT 6
 ), airport_risks AS (
   SELECT id,name,expires_at,traffic_total,coalesce(traffic_upload,0)+coalesce(traffic_download,0) AS used,
     CASE WHEN expires_at<=now() THEN 'expired'
          WHEN traffic_total>0 AND coalesce(traffic_upload,0)+coalesce(traffic_download,0)>=traffic_total THEN 'exhausted'
          WHEN expires_at<=now()+interval '7 days' THEN 'soon'
          WHEN traffic_total>0 AND coalesce(traffic_upload,0)+coalesce(traffic_download,0)>traffic_total*0.9 THEN 'low' END AS risk
   FROM sources WHERE deleted_at IS NULL AND enabled AND nodema_source_kind(kind,detected_kind)='AIRPORT'
 ), ranked AS (
   SELECT *,row_number() OVER (PARTITION BY risk ORDER BY expires_at NULLS LAST,id) AS pos,
     count(*) OVER (PARTITION BY risk) AS total FROM airport_risks WHERE risk IS NOT NULL
 )
 SELECT jsonb_build_object(
   'groups',coalesce((SELECT jsonb_agg(g ORDER BY g.worked DESC,g.total DESC,g.id) FROM top_groups g),'[]'),
   'group_total',(SELECT count(*) FROM grouped),
   'substores',coalesce((SELECT jsonb_agg(x) FROM (SELECT s.id,s.name,s.last_error_code,count(*) OVER () AS total
      FROM sources s WHERE s.deleted_at IS NULL AND s.detected_kind='SUBSTORE' AND s.last_sync_status='FAILED'
      ORDER BY s.last_checked_at DESC NULLS LAST,s.id LIMIT 3) x),'[]'),
   'has_exports',EXISTS(SELECT 1 FROM export_artifacts WHERE revoked_at IS NULL),
   'airports',coalesce((SELECT jsonb_agg(to_jsonb(r)-'pos' ORDER BY r.risk,r.pos) FROM ranked r WHERE pos<=3),'[]'),
   'broken',(SELECT count(*) FROM failed WHERE last_success_at IS NOT NULL),
   'never_worked',(SELECT count(*) FROM failed WHERE last_success_at IS NULL)
 )
$$;
