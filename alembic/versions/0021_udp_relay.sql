-- 0021: UDP through each working node (Wi-Fi Calling) and relay entries as airports.
--
-- test_results keeps each check's UDP outcome; node_current_status the latest one plus
-- the last success. The node list exposes it only for nodes that work now ("udp" in the
-- compact projection, filter {"udp": true}).
ALTER TABLE test_results ADD COLUMN udp_status text
  CHECK (udp_status IN ('NOT_RUN','SUCCESS','FAILED','NOT_SUPPORTED')),
  ADD COLUMN udp_duration_ms integer CHECK (udp_duration_ms >= 0),
  ADD COLUMN udp_exit_ip text;
ALTER TABLE node_current_status ADD COLUMN udp_status text
  CHECK (udp_status IN ('NOT_RUN','SUCCESS','FAILED','NOT_SUPPORTED')),
  ADD COLUMN udp_duration_ms integer CHECK (udp_duration_ms >= 0),
  ADD COLUMN udp_exit_ip text,
  ADD COLUMN udp_checked_at timestamptz,
  ADD COLUMN udp_success_at timestamptz;

-- Neon public network transfer (the Free plan's monthly limit), read from the Neon API
-- by the usage job when a project API key is configured.
ALTER TABLE database_samples ADD COLUMN transfer_bytes bigint CHECK (transfer_bytes >= 0),
  ADD COLUMN transfer_limit_bytes bigint CHECK (transfer_limit_bytes > 0),
  ADD COLUMN transfer_period_end timestamptz;

CREATE OR REPLACE FUNCTION nodema_node_page(f jsonb,ordering text,off integer,lim integer,fresh integer,tpl text,projection text DEFAULT 'full')
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
 wh text := 'true'; ord text := ''; key text; val jsonb; item text; parts text[];
 col text; expression text; sql_base text; total bigint; items jsonb; dto text; graded text; rank_sql text := '';
 operator_name text := coalesce(f->>'operator','GENERAL');
 vantage text := coalesce(f->>'vantage',(SELECT policy->>'default_vantage' FROM grading_policy WHERE id=1),'CN');
 text_fields text[] := ARRAY['id','status','protocol','entry_country','exit_country','transport','security',
   'server_host','exit_ip','exit_city','grade','confidence','line_type','line_claim','evidence_level','probe_key',
   'node_group','asn_label','exit_ip_type'];
 numeric_fields text[] := ARRAY['entry_asn','exit_asn','server_port'];
BEGIN
 IF jsonb_typeof(f)<>'object' OR off<0 OR lim<1 OR lim>100000 OR fresh<1 OR
   operator_name NOT IN ('GENERAL','CT','CU','CM') OR vantage NOT IN ('CN-CT','CN-CU','CN-CM','CN','HK','SG') OR
   projection NOT IN ('full','identity','report','validate','compact') THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
 FOR key,val IN SELECT * FROM jsonb_each(f) LOOP
   IF val='null'::jsonb THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
   IF key=ANY(text_fields) THEN
     IF jsonb_typeof(val)<>'string' OR length(f->>key)>500 THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     IF key IN ('grade','confidence') THEN
       wh := wh || format(' AND v.quality->>%L = $1->>%L',key,key);
     ELSIF key='id' THEN wh := wh || ' AND v.id=($1->>''id'')::uuid';
     ELSE wh := wh || format(' AND v.%I = $1->>%L',key,key); END IF;
   ELSIF key=ANY(numeric_fields) OR key IN ('asn','route_asn') THEN
     IF (f->>key)!~'^[0-9]{1,10}$' OR (f->>key)::bigint>4294967295 THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     IF key='server_port' AND (f->>key)::bigint NOT BETWEEN 1 AND 65535 THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     IF key='asn' THEN wh := wh || ' AND (v.entry_asn=($1->>''asn'')::bigint OR v.exit_asn=($1->>''asn'')::bigint)';
     ELSIF key='route_asn' THEN wh := wh || ' AND ($1->>''route_asn'')::bigint=ANY(v.route_asns)';
     ELSE wh := wh || format(' AND v.%I=($1->>%L)::bigint',key,key); END IF;
   ELSIF key IN ('eligible','enabled','exit_ip_proxy','unreachable','cross_border','best_per_server','udp') THEN
     IF jsonb_typeof(val)<>'boolean' THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     IF key='cross_border' THEN
       wh := wh || ' AND (v.entry_country IS NOT NULL AND v.exit_country IS NOT NULL AND v.entry_country<>v.exit_country)=($1->>''cross_border'')::boolean';
     ELSIF key='udp' THEN
       wh := wh || ' AND (v.udp_state IS NOT DISTINCT FROM ''SUCCESS'')=($1->>''udp'')::boolean';
     ELSIF key='unreachable' THEN
       wh := wh || ' AND coalesce(v.grade_unreachable,false)=($1->>''unreachable'')::boolean';
     ELSIF key='best_per_server' THEN
       IF (f->>key)::boolean THEN wh := wh || ' AND v.server_rank=1'; rank_sql := ',row_number() OVER (PARTITION BY coalesce(c.server_key,c.id::text) ORDER BY nodema_grade_rank(nodema_effective_grade(c.status,g.grade)) NULLS LAST,g.score DESC NULLS LAST,c.id) AS server_rank'; END IF;
     ELSE wh := wh || format(' AND v.%I=($1->>%L)::boolean',key,key); END IF;
   ELSIF key='q' THEN
     IF jsonb_typeof(val)<>'string' OR length(f->>key)>200 THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     wh := wh || ' AND position(lower($1->>''q'') in lower(v.short_id||'' ''||v.name||'' ''||v.server_host))>0';
   ELSIF key='provider_id' THEN
     IF (f->>key)!~'^[0-9a-fA-F-]{36}$' THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     wh := wh || ' AND v.provider_id=($1->>''provider_id'')::uuid';
   ELSIF key='source_id' THEN
     IF (f->>key)!~'^[0-9a-fA-F-]{36}$' THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     wh := wh || ' AND EXISTS(SELECT 1 FROM node_sources ns JOIN sources s ON s.id=ns.source_id WHERE ns.node_id=v.id AND ns.source_id=($1->>''source_id'')::uuid)';
   ELSIF key='entry_ip' THEN
     IF jsonb_typeof(val)<>'string' OR length(f->>key)>64 THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     wh := wh || ' AND v.entry_ips ? ($1->>''entry_ip'')';
   ELSIF key='tags' THEN
     IF jsonb_typeof(val)<>'array' OR jsonb_array_length(val)>16 THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     IF EXISTS(SELECT 1 FROM jsonb_array_elements(val) tag WHERE jsonb_typeof(tag)<>'string' OR length(tag#>>'{}')>40) THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     wh := wh || ' AND v.tags @> ($1->''tags'')';
   ELSIF key IN ('quality_grade','min_quality_grade') THEN
     IF jsonb_typeof(val)<>'string' OR (f->>key) NOT IN ('S','A','B','C','D','PENDING') OR
       (key='min_quality_grade' AND (f->>key)='PENDING') THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     IF key='quality_grade' THEN wh := wh || ' AND v.quality_grade=($1->>''quality_grade'')';
     ELSE wh := wh || ' AND nodema_grade_rank(v.quality_grade)<=nodema_grade_rank($1->>''min_quality_grade'')'; END IF;
   ELSIF key IN ('min_success_rate','max_timeout_rate','max_http_ms','max_http_p95_ms','min_samples','min_age_days','min_checked_days','min_available_days','min_lifetime_availability',
     'max_peak_rtt_ms','max_peak_loss','min_avail_7d') THEN
     IF (f->>key)!~'^[0-9]+([.][0-9]+)?$' OR length(f->>key)>15 THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     IF key IN ('min_success_rate','max_timeout_rate','min_lifetime_availability','max_peak_loss','min_avail_7d') AND (f->>key)::numeric>1 THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     IF key IN ('min_samples','min_age_days','min_checked_days','min_available_days') AND (f->>key)!~'^[0-9]+$' THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     col := CASE key WHEN 'min_success_rate' THEN 'success_rate' WHEN 'max_timeout_rate' THEN 'timeout_rate'
       WHEN 'max_http_ms' THEN 'http_duration_ms' WHEN 'max_http_p95_ms' THEN 'http_p95_ms' WHEN 'min_age_days' THEN 'age_days' WHEN 'min_checked_days' THEN 'checked_days' WHEN 'min_available_days' THEN 'available_days' WHEN 'min_lifetime_availability' THEN 'lifetime_availability'
       WHEN 'max_peak_rtt_ms' THEN 'peak_rtt_ms' WHEN 'max_peak_loss' THEN 'peak_loss' WHEN 'min_avail_7d' THEN 'avail_7d_ratio' ELSE 'sample_count' END;
     wh := wh || format(' AND v.%I %s ($1->>%L)::numeric',col,
       CASE WHEN key LIKE 'min_%%' THEN '>=' ELSE '<=' END,key);
   ELSIF key IN ('last_checked_after','last_success_after') THEN
     IF jsonb_typeof(val)<>'string' OR (f->>key)!~'T.*(Z|[+-][0-9]{2}:[0-9]{2})$'
       OR length(f->>key)>64 THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     PERFORM (f->>key)::timestamptz;
     col := CASE key WHEN 'last_checked_after' THEN 'last_checked_at' ELSE 'last_success_at' END;
     wh := wh || format(' AND v.%I>=($1->>%L)::timestamptz',col,key);
   ELSIF key NOT IN ('operator','vantage') THEN RAISE EXCEPTION 'INVALID_NODE_QUERY';
   END IF;
 END LOOP;
 IF ordering IS NULL OR ordering='' THEN ordering := 'short_id:asc'; END IF;
 IF cardinality(string_to_array(ordering,','))>3 THEN RAISE EXCEPTION 'INVALID_NODE_SORT'; END IF;
 FOREACH item IN ARRAY string_to_array(lower(ordering),',') LOOP
   parts := string_to_array(item,':'); key := parts[1];
   IF cardinality(parts)<>2 OR parts[2] NOT IN ('asc','desc') THEN RAISE EXCEPTION 'INVALID_NODE_SORT'; END IF;
   IF key IN ('short_id','name','protocol','entry_country','exit_country','transport','security','grade',
     'server_host','exit_ip','probe_key','line_claim','status','line_type','evidence_level','node_group','asn_label') THEN expression := CASE WHEN key='grade' THEN 'v.quality->>''grade''' ELSE format('v.%I',key) END;
   ELSIF key='confidence' THEN expression := 'CASE v.quality->>''confidence'' WHEN ''MEDIUM'' THEN 2 WHEN ''LOW'' THEN 1 ELSE 0 END';
   -- Grade then score: "quality_grade:asc" lists S first, best scored first inside a grade.
   ELSIF key='quality_grade' THEN
     ord := ord || CASE WHEN ord='' THEN '' ELSE ',' END || 'nodema_grade_rank(v.quality_grade) ' || parts[2]
       || ' NULLS LAST,v.quality_score ' || CASE parts[2] WHEN 'asc' THEN 'desc' ELSE 'asc' END || ' NULLS LAST';
     CONTINUE;
   ELSIF key IN ('http_duration_ms','http_p50_ms','http_p95_ms','success_rate','timeout_rate','sample_count',
     'entry_asn','exit_asn','server_port','consecutive_failures','source_count','present_source_count','age_days','checked_days','available_days','lifetime_availability',
     'quality_score','peak_rtt_ms','peak_loss') THEN expression := format('v.%I',key);
   ELSIF key='avail_7d' THEN expression := 'v.avail_7d_ratio';
   ELSIF key IN ('last_checked_at','last_success_at','first_seen_at','last_seen_at','evidence_updated_at') THEN expression := format('v.%I',key);
   ELSE RAISE EXCEPTION 'INVALID_NODE_SORT'; END IF;
   ord := ord || CASE WHEN ord='' THEN '' ELSE ',' END || expression || ' ' || parts[2] || ' NULLS LAST';
 END LOOP;
 ord := ord || ',v.id ASC';
 IF projection='validate' THEN RETURN jsonb_build_object('items','[]'::jsonb,'total',0); END IF;
 -- Grade columns for the chosen vantage ($7); the window rank exists only when asked for.
 graded := 'SELECT c.*,nodema_effective_grade(c.status,g.grade) AS quality_grade,g.score AS quality_score,'
   || 'g.peak_rtt_ms,g.idle_rtt_ms,g.loss AS peak_loss,g.jitter_ms,g.samples AS access_samples,g.probes AS access_probes,'
   || 'g.avail_7d,g.checked_7d,CASE WHEN g.checked_7d>0 THEN g.avail_7d::double precision/g.checked_7d END AS avail_7d_ratio,'
   || 'g.unreachable AS grade_unreachable,g.route_asns,g.route_measured_at,g.server_best_grade,g.access_band,g.stability_band,'
   || 'g.reasons AS grade_reasons,g.last_measured_at AS access_measured_at,g.computed_at AS grade_computed_at,'
   -- UDP (Wi-Fi Calling) only describes a node that works now.
   || 'CASE WHEN c.status IN (''UP'',''DEGRADED'') THEN u.udp_status END AS udp_state,u.udp_duration_ms AS udp_ms,u.udp_exit_ip,u.udp_checked_at,u.udp_success_at';
 sql_base := ' FROM (' || graded || rank_sql || ' FROM nodema_catalog($2,$3,$4) c LEFT JOIN node_grades g ON g.node_id=c.id AND g.vantage=$7 LEFT JOIN node_current_status u ON u.node_id=c.id) v WHERE ' || wh;
 EXECUTE 'SELECT count(*)' || sql_base INTO total USING f,fresh,tpl,operator_name,lim,off,vantage;
 dto := CASE projection WHEN 'identity' THEN 'jsonb_build_object(''id'',v.id,''short_id'',v.short_id,''name'',v.name,''last_success_at'',v.last_success_at)'
   WHEN 'report' THEN 'jsonb_build_object(''id'',v.id,''short_id'',v.short_id,''name'',v.name,''protocol'',v.protocol,''server_host'',v.server_host,''server_port'',v.server_port,''transport'',v.transport,''security'',v.security,''status'',v.status,''entry_country'',v.entry_country,''exit_ip'',v.exit_ip,''exit_country'',v.exit_country,''exit_asn'',v.exit_asn,''http_duration_ms'',v.http_duration_ms,''last_success_at'',v.last_success_at,''last_checked_at'',v.last_checked_at,''entry_asn'',v.entry_asn,''grade'',v.quality->''grade'',''confidence'',v.quality->''confidence'',''reasons'',v.quality->''reasons'',''rule_version'',v.quality->''rule_version'',''operator'',v.quality->''operator'',''mainland_reachability'',v.quality->''mainland_reachability'',''sample_count'',v.sample_count,''success_rate'',v.success_rate,''timeout_rate'',v.timeout_rate,''http_p50_ms'',v.http_p50_ms,''http_p95_ms'',v.http_p95_ms,''probe_key'',v.probe_key,''line_claim'',v.line_claim,''evidence_level'',v.evidence_level,''evidence_age_days'',v.quality->''evidence_age_days'',''evidence_updated_at'',v.evidence_updated_at,''tags'',v.tags,''first_seen_at'',v.first_seen_at,''age_days'',v.age_days,''checked_days'',v.checked_days,''available_days'',v.available_days,''lifetime_availability'',v.lifetime_availability,''node_group'',v.node_group,''asn_label'',v.asn_label,'
     || '''vantage'',$7,''quality_grade'',v.quality_grade,''peak_rtt_ms'',v.peak_rtt_ms,''peak_loss'',v.peak_loss,''avail_7d'',v.avail_7d,''checked_7d'',v.checked_7d,''udp'',v.udp_state)'
   WHEN 'compact' THEN 'jsonb_build_array(v.id,v.short_id,v.name,v.status,v.protocol,v.enabled,v.node_group,v.entry_country,v.exit_country,v.exit_asn,v.exit_asn_org,v.asn_label,v.org_label,v.exit_ip,v.exit_org,v.exit_region,v.server_node_count,v.present_source_count,v.checked_days,v.available_days,v.lifetime_availability,v.last_checked_at,v.exit_ip_type,v.exit_ip_proxy,'
     || 'v.quality_grade,v.quality_score,v.peak_rtt_ms,v.peak_loss,v.avail_7d,v.checked_7d,v.server_best_grade,v.grade_unreachable,v.protocol=''hysteria2'',v.udp_state,v.udp_ms)'
   ELSE '(to_jsonb(v)-''quality''-''grade_reasons'') || v.quality || jsonb_build_object(''vantage'',$7,''grade_reasons'',v.grade_reasons)' END;
 -- First select only ordered identities. Materialize the bounded page before
 -- rendering names, correlated counts and reference grading for its DTOs.
 EXECUTE 'WITH chosen AS MATERIALIZED (SELECT v.id,row_number() OVER (ORDER BY ' || ord || ') AS pos' || sql_base ||
   ' ORDER BY ' || ord || ' LIMIT $5 OFFSET $6) SELECT coalesce(jsonb_agg(' || dto || ' ORDER BY chosen.pos),''[]''::jsonb) FROM chosen CROSS JOIN LATERAL (' || graded || ' FROM nodema_catalog($2,$3,$4) c LEFT JOIN node_grades g ON g.node_id=c.id AND g.vantage=$7 LEFT JOIN node_current_status u ON u.node_id=c.id WHERE c.id=chosen.id OFFSET 0) v'
   INTO items USING f,fresh,tpl,operator_name,lim,off,vantage;
 RETURN jsonb_build_object('total',total,'items',items,'vantage',vantage) || CASE WHEN projection='compact'
   THEN jsonb_build_object('fields',jsonb_build_array('id','short_id','name','status','protocol','enabled','node_group','entry_country','exit_country','exit_asn','exit_asn_org','asn_label','org_label','exit_ip','exit_org','exit_region','server_node_count','present_source_count','checked_days','available_days','lifetime_availability','last_checked_at','exit_ip_type','exit_ip_proxy',
     'quality_grade','quality_score','peak_rtt_ms','peak_loss','avail_7d','checked_7d','server_best_grade','unreachable','icmp_only','udp','udp_ms')) ELSE '{}'::jsonb END;
END;
$$;

-- Relay entries: one server with one credential behind >= 5 nodes that land in >= 3
-- countries is an airport's relay (user decision 2026-11-15). Exit countries change
-- with checks, so scan publication also calls this.
CREATE OR REPLACE FUNCTION nodema_mark_shared_credentials() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE changed integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('nodema_shared_credentials'));
 WITH groups AS (
   SELECT n.credential_key, count(*) AS nodes, count(DISTINCT n.server_host) AS hosts,
     count(DISTINCT c.last_exit_country) AS countries
   FROM nodes n LEFT JOIN node_current_status c ON c.node_id=n.id
   WHERE n.credential_key IS NOT NULL GROUP BY n.credential_key
 ), shared AS (
   SELECT credential_key FROM groups WHERE nodes>=5 AND (hosts>=2 OR countries>=3)
 ), target AS (
   SELECT n.id, (s.credential_key IS NOT NULL) AS shared
   FROM nodes n LEFT JOIN shared s ON s.credential_key=n.credential_key
 )
 UPDATE nodes n SET credential_shared=t.shared FROM target t
 WHERE t.id=n.id AND n.credential_shared<>t.shared;
 GET DIAGNOSTICS changed = ROW_COUNT;
 RETURN changed;
END $$;
SELECT nodema_mark_shared_credentials();
