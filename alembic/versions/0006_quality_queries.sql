ALTER TABLE test_results ADD COLUMN probe_key text NOT NULL DEFAULT 'legacy',
  ADD COLUMN probe_metadata jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN measurement_kind text NOT NULL DEFAULT 'FULL',
  ADD COLUMN precheck_metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE node_current_status ADD COLUMN probe_key text NOT NULL DEFAULT 'legacy';

CREATE TABLE node_annotations (
 node_id uuid CONSTRAINT pk_node_annotations PRIMARY KEY
   CONSTRAINT fk_node_annotations_node_id_nodes REFERENCES nodes(id),
 tags jsonb NOT NULL DEFAULT '[]', line_claim text NOT NULL DEFAULT 'UNKNOWN',
 evidence_level text NOT NULL DEFAULT 'NONE', manual_priority text NOT NULL DEFAULT 'NONE',
 operators jsonb NOT NULL DEFAULT '["GENERAL"]', reference_encrypted bytea,
 evidence_updated_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT ck_node_annotations_claim CHECK(line_claim IN ('UNKNOWN','IPLC','IEPL','CN2','OTHER')),
 CONSTRAINT ck_node_annotations_evidence CHECK(evidence_level IN ('NONE','DECLARED','DOCUMENTED')),
 CONSTRAINT ck_node_annotations_priority CHECK(manual_priority IN ('NONE','P1','P2','P3'))
);
CREATE TABLE quality_policies (
 id integer CONSTRAINT pk_quality_policies PRIMARY KEY,
 version integer NOT NULL DEFAULT 1, policy jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT ck_quality_policies_singleton CHECK(id=1 AND version>0)
);
CREATE TABLE quality_policy_revisions (
 version integer CONSTRAINT pk_quality_policy_revisions PRIMARY KEY,
 policy jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE runner_node_summaries (
 node_id uuid NOT NULL CONSTRAINT fk_runner_node_summaries_node_id_nodes REFERENCES nodes(id),
 probe_key text NOT NULL, sample_count integer NOT NULL,
 success_rate double precision, timeout_rate double precision,
 http_p50_ms double precision, http_p95_ms double precision,
 window_start timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT pk_runner_node_summaries PRIMARY KEY(node_id,probe_key)
);
INSERT INTO quality_policies(id,policy) VALUES(1,'{
 "min_samples":3,"poor_success_rate":0.8,"evidence_max_age_days":90,
 "preferred_entry_countries":[],"preferred_exit_countries":[],
 "preferred_entry_asns":[],"preferred_exit_asns":[],"preferred_protocols":[],
 "operator_preferences":{}
}');
INSERT INTO quality_policy_revisions(version,policy) SELECT version,policy FROM quality_policies;

CREATE FUNCTION nodema_refresh_runner_summaries(ids uuid[] DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
 DELETE FROM runner_node_summaries WHERE ids IS NULL OR node_id=ANY(ids);
 WITH final AS (
   SELECT DISTINCT ON(t.scan_run_id,t.node_id) t.*
   FROM test_results t JOIN scan_runs r ON r.id=t.scan_run_id
   WHERE r.status='COMPLETED' AND t.checked_at>=now()-interval '7 days'
     AND (ids IS NULL OR t.node_id=ANY(ids))
   ORDER BY t.scan_run_id,t.node_id,t.attempt_no DESC
 ), samples AS (
   SELECT node_id,probe_key,count(*)::integer AS sample_count,
     avg((status IN ('UP','DEGRADED'))::integer)::double precision AS success_rate,
     avg((jsonb_array_length(timeout_stages)>0)::integer)::double precision AS timeout_rate,
     percentile_cont(0.5) WITHIN GROUP(ORDER BY http_duration_ms)
       FILTER(WHERE status IN ('UP','DEGRADED')) AS p50,
     percentile_cont(0.95) WITHIN GROUP(ORDER BY http_duration_ms)
       FILTER(WHERE status IN ('UP','DEGRADED')) AS p95
   FROM final WHERE measurement_kind='FULL' AND status IN ('UP','DEGRADED','DOWN')
   GROUP BY node_id,probe_key
 )
 INSERT INTO runner_node_summaries(node_id,probe_key,sample_count,success_rate,timeout_rate,
   http_p50_ms,http_p95_ms,window_start,updated_at)
 SELECT node_id,probe_key,sample_count,success_rate,timeout_rate,p50,p95,now()-interval '7 days',now()
 FROM samples ON CONFLICT(node_id,probe_key) DO UPDATE SET sample_count=excluded.sample_count,
   success_rate=excluded.success_rate,timeout_rate=excluded.timeout_rate,
   http_p50_ms=excluded.http_p50_ms,http_p95_ms=excluded.http_p95_ms,
   window_start=excluded.window_start,updated_at=excluded.updated_at;
$$;

CREATE FUNCTION nodema_grade(n jsonb,p jsonb,ver integer,op text)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
 grade text := 'U'; confidence text := 'UNKNOWN'; reasons jsonb := '[]';
 pref jsonb := coalesce(p->'operator_preferences'->op,'{}');
 matched boolean := false; documented boolean := false;
BEGIN
 IF coalesce((n->>'eligible')::boolean,false)=false OR n->>'status'<>'UP' THEN
   reasons := '["NOT_CURRENTLY_AVAILABLE"]';
 ELSIF coalesce((n->>'sample_count')::integer,0) < (p->>'min_samples')::integer THEN
   reasons := '["INSUFFICIENT_SAMPLES"]';
 ELSIF coalesce(n->>'probe_key','legacy')='legacy' OR n->>'probe_key' LIKE 'unlocated:%' THEN
   reasons := '["RUNNER_SCOPE_UNKNOWN"]';
 ELSIF (n->>'success_rate')::double precision < (p->>'poor_success_rate')::double precision THEN
   grade := 'P3'; confidence := 'LOW'; reasons := '["RUNNER_HISTORY_UNSTABLE"]';
 ELSIF n->>'entry_country' IS NULL OR n->>'entry_asn' IS NULL OR n->>'exit_country' IS NULL THEN
   reasons := '["MISSING_METADATA"]';
 ELSE
   documented := n->>'evidence_level'='DOCUMENTED' AND (n->>'has_evidence')::boolean
     AND (n->'operators' ? op OR n->'operators' ? 'GENERAL')
     AND (n->>'evidence_updated_at')::timestamptz >= now()-make_interval(days=>(p->>'evidence_max_age_days')::integer);
   IF coalesce(pref->'preferred_entry_countries',p->'preferred_entry_countries') ? (n->>'entry_country') THEN
     reasons := reasons || '["PREFERRED_ENTRY_COUNTRY"]'; matched := true;
   END IF;
   IF coalesce(pref->'preferred_exit_countries',p->'preferred_exit_countries') ? (n->>'exit_country') THEN
     reasons := reasons || '["PREFERRED_EXIT_COUNTRY"]'; matched := true;
   END IF;
   IF coalesce(pref->'preferred_entry_asns',p->'preferred_entry_asns') @> jsonb_build_array((n->>'entry_asn')::bigint) THEN
     reasons := reasons || '["PREFERRED_ENTRY_ASN"]'; matched := true;
   END IF;
   IF coalesce(pref->'preferred_exit_asns',p->'preferred_exit_asns') @> jsonb_build_array((n->>'exit_asn')::bigint) THEN
     reasons := reasons || '["PREFERRED_EXIT_ASN"]'; matched := true;
   END IF;
   IF coalesce(pref->'preferred_protocols',p->'preferred_protocols') ? (n->>'protocol') THEN
     reasons := reasons || '["PREFERRED_PROTOCOL"]'; matched := true;
   END IF;
   confidence := 'LOW';
   IF n->>'manual_priority' IN ('P1','P2','P3') THEN
     grade := n->>'manual_priority'; reasons := reasons || '["MANUAL_PREFERENCE"]';
   ELSIF documented THEN
     grade := 'P1'; confidence := 'MEDIUM'; reasons := reasons || '["DOCUMENTED_REFERENCE"]';
   ELSIF matched THEN grade := 'P1';
   ELSE grade := 'P2'; reasons := reasons || '["RUNNER_AVAILABLE"]';
   END IF;
   IF n->>'evidence_level'='DECLARED' THEN reasons := reasons || '["UNVERIFIED_SOURCE_CLAIM"]'; END IF;
   IF n->>'evidence_level'='DOCUMENTED' AND NOT documented THEN
     reasons := reasons || '["REFERENCE_EXPIRED_OR_NOT_APPLICABLE"]';
   END IF;
 END IF;
 RETURN jsonb_build_object('grade',grade,'confidence',confidence,
   'reasons',reasons || '["NO_MAINLAND_MEASUREMENT"]','rule_version',ver,
   'operator',op,'mainland_reachability','UNKNOWN','evaluated_at',now(),
   'evidence_age_days',CASE WHEN n->>'evidence_updated_at' IS NULL THEN NULL ELSE
     greatest(0,floor(extract(epoch FROM now()-(n->>'evidence_updated_at')::timestamptz)/86400))::integer END);
END;
$$;

CREATE VIEW nodema_catalog_base AS
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
   (a.reference_encrypted IS NOT NULL) AS has_evidence,a.evidence_updated_at,
   coalesce(m.sample_count,0) AS sample_count,m.success_rate,m.timeout_rate,m.http_p50_ms,m.http_p95_ms,
   m.updated_at AS metrics_updated_at
 FROM nodes n LEFT JOIN node_current_status c ON c.node_id=n.id
 LEFT JOIN test_results t ON t.id=c.last_result_id
 LEFT JOIN node_annotations a ON a.node_id=n.id
 LEFT JOIN runner_node_summaries m ON m.node_id=n.id AND m.probe_key=c.probe_key
   AND m.updated_at >= now()-interval '1 day';

CREATE FUNCTION nodema_display_name(tpl text,sid text,proto text,trans text,sec text,entry text,ex text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result text := ''; i integer := 1; closing integer; token text;
BEGIN
 WHILE i<=length(tpl) LOOP
   IF substr(tpl,i,2)='{{' THEN result:=result||'{'; i:=i+2;
   ELSIF substr(tpl,i,2)='}}' THEN result:=result||'}'; i:=i+2;
   ELSIF substr(tpl,i,1)='{' THEN
     closing:=strpos(substr(tpl,i+1),'}');
     IF closing=0 THEN RAISE EXCEPTION 'INVALID_NAME_TEMPLATE'; END IF;
     token:=substr(tpl,i+1,closing-1);
     result:=result||CASE token WHEN 'SHORT_ID' THEN sid WHEN 'PROTOCOL' THEN upper(proto)
       WHEN 'TRANSPORT' THEN upper(coalesce(trans,'UNK')) WHEN 'SECURITY' THEN upper(coalesce(sec,'UNK'))
       WHEN 'ENTRY_COUNTRY' THEN coalesce(entry,'UNK') WHEN 'EXIT_COUNTRY' THEN coalesce(ex,'UNK')
       ELSE '{'||token||'}' END;
     i:=i+closing+1;
   ELSE result:=result||substr(tpl,i,1); i:=i+1;
   END IF;
 END LOOP;
 RETURN result;
END;
$$;

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
 http_p50_ms double precision,http_p95_ms double precision,metrics_updated_at timestamptz,status text,name text,quality jsonb) LANGUAGE sql STABLE AS $$
 WITH base AS (
 SELECT b.*,CASE WHEN raw_status IS NULL THEN 'UNKNOWN'
   WHEN last_checked_at<now()-make_interval(hours=>fresh) THEN 'STALE' ELSE raw_status END AS status
 FROM nodema_catalog_base b
 ), named AS (
 SELECT b.*,nodema_display_name(tpl,short_id,protocol,transport,security,entry_country,exit_country)
   AS name FROM base b
 ) SELECT n.id, n.short_id, n.protocol, n.server_host, n.server_port, n.transport, n.security, n.enabled, n.line_type, n.first_seen_at, n.last_seen_at, n.source_count, n.present_source_count, n.eligible, n.entry_country, n.entry_asn, n.exit_ip, n.exit_country, n.exit_asn, n.http_duration_ms, n.last_checked_at, n.last_success_at, n.last_error_code, n.consecutive_failures, n.next_full_check_at, n.probe_key, n.probe_metadata, n.measurement_kind, n.precheck_metadata, n.entry_ips, n.exit_city, n.tags, n.line_claim, n.evidence_level, n.manual_priority, n.operators, n.has_evidence, n.evidence_updated_at, n.sample_count, n.success_rate, n.timeout_rate, n.http_p50_ms, n.http_p95_ms, n.metrics_updated_at, n.status,n.name,
   nodema_grade(jsonb_build_object('eligible',n.eligible,'status',n.status,'sample_count',n.sample_count,'probe_key',n.probe_key,'success_rate',n.success_rate,'entry_country',n.entry_country,'entry_asn',n.entry_asn,'exit_country',n.exit_country,'exit_asn',n.exit_asn,'protocol',n.protocol,'has_evidence',n.has_evidence,'evidence_updated_at',n.evidence_updated_at,'evidence_level',n.evidence_level,'operators',n.operators,'manual_priority',n.manual_priority),p.policy,p.version,operator_name)
 FROM named n CROSS JOIN quality_policies p WHERE p.id=1;
$$;

CREATE FUNCTION nodema_node_page(f jsonb,ordering text,off integer,lim integer,fresh integer,tpl text)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
 wh text := 'true'; ord text := ''; key text; val jsonb; item text; parts text[];
 col text; expression text; sql_base text; total bigint; items jsonb;
 operator_name text := coalesce(f->>'operator','GENERAL');
 text_fields text[] := ARRAY['id','status','protocol','entry_country','exit_country','transport','security',
   'server_host','exit_ip','exit_city','grade','confidence','line_type','line_claim','evidence_level','probe_key'];
 numeric_fields text[] := ARRAY['entry_asn','exit_asn','server_port'];
BEGIN
 IF jsonb_typeof(f)<>'object' OR off<0 OR lim<1 OR lim>100000 OR fresh<1 OR
   operator_name NOT IN ('GENERAL','CT','CU','CM') THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
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
   ELSIF key IN ('min_success_rate','max_timeout_rate','max_http_ms','max_http_p95_ms','min_samples') THEN
     IF (f->>key)!~'^[0-9]+([.][0-9]+)?$' OR length(f->>key)>15 THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     IF key IN ('min_success_rate','max_timeout_rate') AND (f->>key)::numeric>1 THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     IF key='min_samples' AND (f->>key)!~'^[0-9]+$' THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
     col := CASE key WHEN 'min_success_rate' THEN 'success_rate' WHEN 'max_timeout_rate' THEN 'timeout_rate'
       WHEN 'max_http_ms' THEN 'http_duration_ms' WHEN 'max_http_p95_ms' THEN 'http_p95_ms' ELSE 'sample_count' END;
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
     'entry_asn','exit_asn','server_port','consecutive_failures','source_count','present_source_count') THEN expression := format('v.%I',key);
   ELSIF key IN ('last_checked_at','last_success_at','first_seen_at','last_seen_at','evidence_updated_at') THEN expression := format('v.%I',key);
   ELSE RAISE EXCEPTION 'INVALID_NODE_SORT'; END IF;
   ord := ord || CASE WHEN ord='' THEN '' ELSE ',' END || expression || ' ' || parts[2] || ' NULLS LAST';
 END LOOP;
 ord := ord || ',v.id ASC';
 sql_base := ' FROM nodema_catalog($2,$3,$4) v WHERE ' || wh;
 EXECUTE 'SELECT count(*)' || sql_base INTO total USING f,fresh,tpl,operator_name;
 -- First select only ordered identities. Materialize the bounded page before
 -- rendering names, correlated counts and reference grading for its DTOs.
 EXECUTE 'WITH chosen AS MATERIALIZED (SELECT v.id,row_number() OVER (ORDER BY ' || ord || ') AS pos' || sql_base ||
   ' ORDER BY ' || ord || ' LIMIT $5 OFFSET $6) SELECT coalesce(jsonb_agg(to_jsonb(v)-''quality'' || v.quality ORDER BY chosen.pos),''[]''::jsonb) FROM chosen CROSS JOIN LATERAL (SELECT * FROM nodema_catalog($2,$3,$4) c WHERE c.id=chosen.id OFFSET 0) v'
   INTO items USING f,fresh,tpl,operator_name,lim,off;
 RETURN jsonb_build_object('total',total,'items',items);
END;
$$;
