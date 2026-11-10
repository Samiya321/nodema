ALTER TABLE nodes ADD COLUMN checked_days integer NOT NULL DEFAULT 0,
 ADD COLUMN available_days integer NOT NULL DEFAULT 0,
 ADD CONSTRAINT ck_nodes_lifetime_days CHECK(checked_days>=0 AND available_days>=0 AND available_days<=checked_days);
CREATE INDEX idx_nodes_first_seen ON nodes(first_seen_at);
UPDATE nodes n SET checked_days=d.checked,available_days=d.available FROM (
 SELECT node_id,count(*) FILTER(WHERE successful_count+failed_count>0)::integer AS checked,
 count(*) FILTER(WHERE successful_count>0)::integer AS available FROM node_daily_stats GROUP BY node_id
) d WHERE d.node_id=n.id;
CREATE FUNCTION nodema_track_lifetime() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE checked_delta integer; available_delta integer;
BEGIN
 checked_delta := (NEW.successful_count+NEW.failed_count>0)::integer;
 available_delta := (NEW.successful_count>0)::integer;
 IF TG_OP='UPDATE' THEN
   checked_delta := checked_delta-(OLD.successful_count+OLD.failed_count>0)::integer;
   available_delta := available_delta-(OLD.successful_count>0)::integer;
 END IF;
 IF checked_delta<>0 OR available_delta<>0 THEN
   UPDATE nodes SET checked_days=checked_days+checked_delta,available_days=available_days+available_delta WHERE id=NEW.node_id;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER node_daily_lifetime AFTER INSERT OR UPDATE OF successful_count,failed_count ON node_daily_stats
 FOR EACH ROW EXECUTE FUNCTION nodema_track_lifetime();
DROP FUNCTION nodema_catalog(integer,text,text);
CREATE OR REPLACE VIEW nodema_catalog_base AS
 SELECT n.id,n.short_id,n.protocol,n.server_host,n.server_port,n.transport,n.security,
   n.enabled,n.line_type,n.first_seen_at,n.last_seen_at,
   (SELECT count(*)::integer FROM node_sources ns WHERE ns.node_id=n.id) AS source_count,
   (SELECT count(*)::integer FROM node_sources ns JOIN sources s ON s.id=ns.source_id
     WHERE ns.node_id=n.id AND ns.is_present AND s.deleted_at IS NULL) AS present_source_count,
   (n.enabled AND EXISTS(SELECT 1 FROM node_sources ns JOIN sources s ON s.id=ns.source_id
     WHERE ns.node_id=n.id AND ns.is_present AND s.enabled AND s.deleted_at IS NULL)) AS eligible,
   c.status AS raw_status,c.entry_country,c.entry_asn,c.last_exit_ip AS exit_ip,
   c.last_exit_country AS exit_country,c.last_exit_asn AS exit_asn,
   c.last_http_duration_ms AS http_duration_ms,c.last_checked_at,c.last_success_at,c.last_error_code,
   c.consecutive_failures,(to_jsonb(c)->>'next_full_check_at')::timestamptz AS next_full_check_at,c.probe_key,t.probe_metadata,t.measurement_kind,t.precheck_metadata,
   coalesce(t.entry_ips,'[]') AS entry_ips,t.exit_city,
   coalesce(a.tags,'[]') AS tags,coalesce(a.line_claim,'UNKNOWN') AS line_claim,
   coalesce(a.evidence_level,'NONE') AS evidence_level,
   coalesce(a.manual_priority,'NONE') AS manual_priority,
   coalesce(a.operators,'["GENERAL"]') AS operators,
   (a.reference_data IS NOT NULL) AS has_evidence,a.evidence_updated_at,
   coalesce(m.sample_count,0) AS sample_count,m.success_rate,m.timeout_rate,m.http_p50_ms,m.http_p95_ms,
   m.updated_at AS metrics_updated_at,
   greatest(1,(now() AT TIME ZONE 'Asia/Shanghai')::date-(n.first_seen_at AT TIME ZONE 'Asia/Shanghai')::date+1)::integer AS age_days,
   n.checked_days,n.available_days,CASE WHEN n.checked_days>0 THEN n.available_days::double precision/n.checked_days ELSE NULL END AS lifetime_availability
 FROM nodes n LEFT JOIN node_current_status c ON c.node_id=n.id
 LEFT JOIN test_results t ON t.id=c.last_result_id
 LEFT JOIN node_annotations a ON a.node_id=n.id
 LEFT JOIN runner_node_summaries m ON m.node_id=n.id AND m.probe_key=c.probe_key
   AND m.updated_at >= now()-interval '1 day';

CREATE FUNCTION nodema_catalog(fresh integer,tpl text,operator_name text)
RETURNS TABLE(id uuid,short_id text,protocol text,server_host text,server_port integer,transport text,security text,
 enabled boolean,line_type text,first_seen_at timestamptz,last_seen_at timestamptz,
 source_count integer,present_source_count integer,eligible boolean,
 entry_country text,entry_asn bigint,exit_ip text,exit_country text,exit_asn bigint,
 http_duration_ms integer,last_checked_at timestamptz,last_success_at timestamptz,last_error_code text,
 consecutive_failures integer,next_full_check_at timestamptz,probe_key text,probe_metadata jsonb,measurement_kind text,precheck_metadata jsonb,
 entry_ips jsonb,exit_city text,tags jsonb,line_claim text,evidence_level text,manual_priority text,
 operators jsonb,has_evidence boolean,evidence_updated_at timestamptz,
 sample_count integer,success_rate double precision,timeout_rate double precision,
 http_p50_ms double precision,http_p95_ms double precision,metrics_updated_at timestamptz,status text,name text,quality jsonb,age_days integer,checked_days integer,available_days integer,lifetime_availability double precision) LANGUAGE sql STABLE AS $$
 WITH base AS (
 SELECT b.*,CASE WHEN raw_status IS NULL THEN 'UNKNOWN'
   WHEN last_checked_at<now()-make_interval(hours=>fresh) THEN 'STALE' ELSE raw_status END AS status
 FROM nodema_catalog_base b
 ), named AS (
 SELECT b.*,nodema_display_name(tpl,short_id,protocol,transport,security,entry_country,exit_country)
   AS name FROM base b
 ) SELECT n.id, n.short_id, n.protocol, n.server_host, n.server_port, n.transport, n.security, n.enabled, n.line_type, n.first_seen_at, n.last_seen_at, n.source_count, n.present_source_count, n.eligible, n.entry_country, n.entry_asn, n.exit_ip, n.exit_country, n.exit_asn, n.http_duration_ms, n.last_checked_at, n.last_success_at, n.last_error_code, n.consecutive_failures, n.next_full_check_at, n.probe_key, n.probe_metadata, n.measurement_kind, n.precheck_metadata, n.entry_ips, n.exit_city, n.tags, n.line_claim, n.evidence_level, n.manual_priority, n.operators, n.has_evidence, n.evidence_updated_at, n.sample_count, n.success_rate, n.timeout_rate, n.http_p50_ms, n.http_p95_ms, n.metrics_updated_at, n.status,n.name,
   nodema_grade(jsonb_build_object('eligible',n.eligible,'status',n.status,'sample_count',n.sample_count,'probe_key',n.probe_key,'success_rate',n.success_rate,'entry_country',n.entry_country,'entry_asn',n.entry_asn,'exit_country',n.exit_country,'exit_asn',n.exit_asn,'protocol',n.protocol,'has_evidence',n.has_evidence,'evidence_updated_at',n.evidence_updated_at,'evidence_level',n.evidence_level,'operators',n.operators,'manual_priority',n.manual_priority),p.policy,p.version,operator_name)
,n.age_days,n.checked_days,n.available_days,n.lifetime_availability
 FROM named n CROSS JOIN quality_policies p WHERE p.id=1;
$$;

CREATE OR REPLACE FUNCTION nodema_node_page(f jsonb,ordering text,off integer,lim integer,fresh integer,tpl text,projection text DEFAULT 'full')
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
 wh text := 'true'; ord text := ''; key text; val jsonb; item text; parts text[];
 col text; expression text; sql_base text; total bigint; items jsonb; dto text;
 operator_name text := coalesce(f->>'operator','GENERAL');
 text_fields text[] := ARRAY['id','status','protocol','entry_country','exit_country','transport','security',
   'server_host','exit_ip','exit_city','grade','confidence','line_type','line_claim','evidence_level','probe_key'];
 numeric_fields text[] := ARRAY['entry_asn','exit_asn','server_port'];
BEGIN
 IF jsonb_typeof(f)<>'object' OR off<0 OR lim<1 OR lim>100000 OR fresh<1 OR
   operator_name NOT IN ('GENERAL','CT','CU','CM') OR projection NOT IN ('full','identity','report') THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
 FOR key,val IN SELECT * FROM jsonb_each(f) LOOP
   IF val='null'::jsonb THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
   IF key=ANY(text_fields) THEN
     IF jsonb_typeof(val)<>'string' OR length(f->>key)>500 THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     IF key IN ('grade','confidence') THEN
       wh := wh || format(' AND v.quality->>%L = $1->>%L',key,key);
     ELSIF key='id' THEN wh := wh || ' AND v.id=($1->>''id'')::uuid';
     ELSE wh := wh || format(' AND v.%I = $1->>%L',key,key); END IF;
   ELSIF key=ANY(numeric_fields) OR key='asn' THEN
     IF (f->>key)!~'^[0-9]{1,10}$' OR (f->>key)::bigint>4294967295 THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     IF key='server_port' AND (f->>key)::bigint NOT BETWEEN 1 AND 65535 THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     IF key='asn' THEN wh := wh || ' AND (v.entry_asn=($1->>''asn'')::bigint OR v.exit_asn=($1->>''asn'')::bigint)';
     ELSE wh := wh || format(' AND v.%I=($1->>%L)::bigint',key,key); END IF;
   ELSIF key IN ('eligible','enabled') THEN
     IF jsonb_typeof(val)<>'boolean' THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     wh := wh || format(' AND v.%I=($1->>%L)::boolean',key,key);
   ELSIF key='q' THEN
     IF jsonb_typeof(val)<>'string' OR length(f->>key)>200 THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     wh := wh || ' AND position(lower($1->>''q'') in lower(v.short_id||'' ''||v.name||'' ''||v.server_host))>0';
   ELSIF key='source_id' THEN
     IF (f->>key)!~'^[0-9a-fA-F-]{36}$' THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     wh := wh || ' AND EXISTS(SELECT 1 FROM node_sources ns JOIN sources s ON s.id=ns.source_id WHERE ns.node_id=v.id AND ns.source_id=($1->>''source_id'')::uuid AND ns.is_present AND s.deleted_at IS NULL)';
   ELSIF key='entry_ip' THEN
     IF jsonb_typeof(val)<>'string' OR length(f->>key)>64 THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     wh := wh || ' AND v.entry_ips ? ($1->>''entry_ip'')';
   ELSIF key='tags' THEN
     IF jsonb_typeof(val)<>'array' OR jsonb_array_length(val)>16 THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     IF EXISTS(SELECT 1 FROM jsonb_array_elements(val) tag WHERE jsonb_typeof(tag)<>'string' OR length(tag#>>'{}')>40) THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     wh := wh || ' AND v.tags @> ($1->''tags'')';
   ELSIF key IN ('min_success_rate','max_timeout_rate','max_http_ms','max_http_p95_ms','min_samples','min_age_days','min_checked_days','min_available_days','min_lifetime_availability') THEN
     IF (f->>key)!~'^[0-9]+([.][0-9]+)?$' OR length(f->>key)>15 THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     IF key IN ('min_success_rate','max_timeout_rate','min_lifetime_availability') AND (f->>key)::numeric>1 THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     IF key IN ('min_samples','min_age_days','min_checked_days','min_available_days') AND (f->>key)!~'^[0-9]+$' THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     col := CASE key WHEN 'min_success_rate' THEN 'success_rate' WHEN 'max_timeout_rate' THEN 'timeout_rate'
       WHEN 'max_http_ms' THEN 'http_duration_ms' WHEN 'max_http_p95_ms' THEN 'http_p95_ms' WHEN 'min_age_days' THEN 'age_days' WHEN 'min_checked_days' THEN 'checked_days' WHEN 'min_available_days' THEN 'available_days' WHEN 'min_lifetime_availability' THEN 'lifetime_availability' ELSE 'sample_count' END;
     wh := wh || format(' AND v.%I %s ($1->>%L)::numeric',col,
       CASE WHEN key LIKE 'min_%%' THEN '>=' ELSE '<=' END,key);
   ELSIF key IN ('last_checked_after','last_success_after') THEN
     IF jsonb_typeof(val)<>'string' OR (f->>key)!~'T.*(Z|[+-][0-9]{2}:[0-9]{2})$'
       OR length(f->>key)>64 THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     PERFORM (f->>key)::timestamptz;
     col := CASE key WHEN 'last_checked_after' THEN 'last_checked_at' ELSE 'last_success_at' END;
     wh := wh || format(' AND v.%I>=($1->>%L)::timestamptz',col,key);
   ELSIF key<>'operator' THEN RAISE EXCEPTION 'INVALID_NODE_QUERY';
   END IF;
 END LOOP;
 IF ordering IS NULL OR ordering='' THEN ordering := 'short_id:asc'; END IF;
 IF cardinality(string_to_array(ordering,','))>3 THEN RAISE EXCEPTION 'INVALID_NODE_SORT'; END IF;
 FOREACH item IN ARRAY string_to_array(lower(ordering),',') LOOP
   parts := string_to_array(item,':'); key := parts[1];
   IF cardinality(parts)<>2 OR parts[2] NOT IN ('asc','desc') THEN RAISE EXCEPTION 'INVALID_NODE_SORT'; END IF;
   IF key IN ('short_id','name','protocol','entry_country','exit_country','transport','security','grade',
     'server_host','exit_ip','probe_key','line_claim','status','line_type','evidence_level') THEN expression := CASE WHEN key='grade' THEN 'v.quality->>''grade''' ELSE format('v.%I',key) END;
   ELSIF key='confidence' THEN expression := 'CASE v.quality->>''confidence'' WHEN ''MEDIUM'' THEN 2 WHEN ''LOW'' THEN 1 ELSE 0 END';
   ELSIF key IN ('http_duration_ms','http_p50_ms','http_p95_ms','success_rate','timeout_rate','sample_count',
     'entry_asn','exit_asn','server_port','consecutive_failures','source_count','present_source_count','age_days','checked_days','available_days','lifetime_availability') THEN expression := format('v.%I',key);
   ELSIF key IN ('last_checked_at','last_success_at','first_seen_at','last_seen_at','evidence_updated_at') THEN expression := format('v.%I',key);
   ELSE RAISE EXCEPTION 'INVALID_NODE_SORT'; END IF;
   ord := ord || CASE WHEN ord='' THEN '' ELSE ',' END || expression || ' ' || parts[2] || ' NULLS LAST';
 END LOOP;
 ord := ord || ',v.id ASC';
 sql_base := ' FROM nodema_catalog($2,$3,$4) v WHERE ' || wh;
 EXECUTE 'SELECT count(*)' || sql_base INTO total USING f,fresh,tpl,operator_name;
 dto := CASE projection WHEN 'identity' THEN 'jsonb_build_object(''id'',v.id,''short_id'',v.short_id,''name'',v.name)'
   WHEN 'report' THEN 'jsonb_build_object(''id'',v.id,''short_id'',v.short_id,''name'',v.name,''protocol'',v.protocol,''server_host'',v.server_host,''server_port'',v.server_port,''transport'',v.transport,''security'',v.security,''status'',v.status,''entry_country'',v.entry_country,''exit_ip'',v.exit_ip,''exit_country'',v.exit_country,''exit_asn'',v.exit_asn,''http_duration_ms'',v.http_duration_ms,''last_checked_at'',v.last_checked_at,''entry_asn'',v.entry_asn,''grade'',v.quality->''grade'',''confidence'',v.quality->''confidence'',''reasons'',v.quality->''reasons'',''rule_version'',v.quality->''rule_version'',''operator'',v.quality->''operator'',''mainland_reachability'',v.quality->''mainland_reachability'',''sample_count'',v.sample_count,''success_rate'',v.success_rate,''timeout_rate'',v.timeout_rate,''http_p50_ms'',v.http_p50_ms,''http_p95_ms'',v.http_p95_ms,''probe_key'',v.probe_key,''line_claim'',v.line_claim,''evidence_level'',v.evidence_level,''evidence_age_days'',v.quality->''evidence_age_days'',''evidence_updated_at'',v.evidence_updated_at,''tags'',v.tags,''first_seen_at'',v.first_seen_at,''age_days'',v.age_days,''checked_days'',v.checked_days,''available_days'',v.available_days,''lifetime_availability'',v.lifetime_availability)'
   ELSE 'to_jsonb(v)-''quality'' || v.quality' END;
 -- First select only ordered identities. Materialize the bounded page before
 -- rendering names, correlated counts and reference grading for its DTOs.
 EXECUTE 'WITH chosen AS MATERIALIZED (SELECT v.id,row_number() OVER (ORDER BY ' || ord || ') AS pos' || sql_base ||
   ' ORDER BY ' || ord || ' LIMIT $5 OFFSET $6) SELECT coalesce(jsonb_agg(' || dto || ' ORDER BY chosen.pos),''[]''::jsonb) FROM chosen CROSS JOIN LATERAL (SELECT * FROM nodema_catalog($2,$3,$4) c WHERE c.id=chosen.id OFFSET 0) v'
   INTO items USING f,fresh,tpl,operator_name,lim,off;
 RETURN jsonb_build_object('total',total,'items',items);
END;
$$;
