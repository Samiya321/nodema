-- A compact node projection: the dashboard loads a whole filtered set in one request
-- (only the fields the list shows) and groups/pages it in the browser.

CREATE OR REPLACE FUNCTION nodema_node_page(f jsonb,ordering text,off integer,lim integer,fresh integer,tpl text,projection text DEFAULT 'full')
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
 wh text := 'true'; ord text := ''; key text; val jsonb; item text; parts text[];
 col text; expression text; sql_base text; total bigint; items jsonb; dto text;
 operator_name text := coalesce(f->>'operator','GENERAL');
 text_fields text[] := ARRAY['id','status','protocol','entry_country','exit_country','transport','security',
   'server_host','exit_ip','exit_city','grade','confidence','line_type','line_claim','evidence_level','probe_key',
   'node_group','asn_label'];
 numeric_fields text[] := ARRAY['entry_asn','exit_asn','server_port'];
BEGIN
 IF jsonb_typeof(f)<>'object' OR off<0 OR lim<1 OR lim>100000 OR fresh<1 OR
   operator_name NOT IN ('GENERAL','CT','CU','CM') OR projection NOT IN ('full','identity','report','validate','compact') THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
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
     'server_host','exit_ip','probe_key','line_claim','status','line_type','evidence_level','node_group','asn_label') THEN expression := CASE WHEN key='grade' THEN 'v.quality->>''grade''' ELSE format('v.%I',key) END;
   ELSIF key='confidence' THEN expression := 'CASE v.quality->>''confidence'' WHEN ''MEDIUM'' THEN 2 WHEN ''LOW'' THEN 1 ELSE 0 END';
   ELSIF key IN ('http_duration_ms','http_p50_ms','http_p95_ms','success_rate','timeout_rate','sample_count',
     'entry_asn','exit_asn','server_port','consecutive_failures','source_count','present_source_count','age_days','checked_days','available_days','lifetime_availability') THEN expression := format('v.%I',key);
   ELSIF key IN ('last_checked_at','last_success_at','first_seen_at','last_seen_at','evidence_updated_at') THEN expression := format('v.%I',key);
   ELSE RAISE EXCEPTION 'INVALID_NODE_SORT'; END IF;
   ord := ord || CASE WHEN ord='' THEN '' ELSE ',' END || expression || ' ' || parts[2] || ' NULLS LAST';
 END LOOP;
 ord := ord || ',v.id ASC';
 IF projection='validate' THEN RETURN jsonb_build_object('items','[]'::jsonb,'total',0); END IF;
 sql_base := ' FROM nodema_catalog($2,$3,$4) v WHERE ' || wh;
 EXECUTE 'SELECT count(*)' || sql_base INTO total USING f,fresh,tpl,operator_name;
 dto := CASE projection WHEN 'identity' THEN 'jsonb_build_object(''id'',v.id,''short_id'',v.short_id,''name'',v.name,''last_success_at'',v.last_success_at)'
   WHEN 'report' THEN 'jsonb_build_object(''id'',v.id,''short_id'',v.short_id,''name'',v.name,''protocol'',v.protocol,''server_host'',v.server_host,''server_port'',v.server_port,''transport'',v.transport,''security'',v.security,''status'',v.status,''entry_country'',v.entry_country,''exit_ip'',v.exit_ip,''exit_country'',v.exit_country,''exit_asn'',v.exit_asn,''http_duration_ms'',v.http_duration_ms,''last_success_at'',v.last_success_at,''last_checked_at'',v.last_checked_at,''entry_asn'',v.entry_asn,''grade'',v.quality->''grade'',''confidence'',v.quality->''confidence'',''reasons'',v.quality->''reasons'',''rule_version'',v.quality->''rule_version'',''operator'',v.quality->''operator'',''mainland_reachability'',v.quality->''mainland_reachability'',''sample_count'',v.sample_count,''success_rate'',v.success_rate,''timeout_rate'',v.timeout_rate,''http_p50_ms'',v.http_p50_ms,''http_p95_ms'',v.http_p95_ms,''probe_key'',v.probe_key,''line_claim'',v.line_claim,''evidence_level'',v.evidence_level,''evidence_age_days'',v.quality->''evidence_age_days'',''evidence_updated_at'',v.evidence_updated_at,''tags'',v.tags,''first_seen_at'',v.first_seen_at,''age_days'',v.age_days,''checked_days'',v.checked_days,''available_days'',v.available_days,''lifetime_availability'',v.lifetime_availability,''node_group'',v.node_group,''asn_label'',v.asn_label)'
   WHEN 'compact' THEN 'jsonb_build_object(''id'',v.id,''short_id'',v.short_id,''name'',v.name,''status'',v.status,''protocol'',v.protocol,''enabled'',v.enabled,''node_group'',v.node_group,''entry_country'',v.entry_country,''exit_country'',v.exit_country,''exit_asn'',v.exit_asn,''exit_asn_org'',v.exit_asn_org,''asn_label'',v.asn_label,''org_label'',v.org_label,''exit_ip'',v.exit_ip,''exit_org'',v.exit_org,''exit_region'',v.exit_region,''server_node_count'',v.server_node_count,''present_source_count'',v.present_source_count,''checked_days'',v.checked_days,''available_days'',v.available_days,''lifetime_availability'',v.lifetime_availability,''last_checked_at'',v.last_checked_at)'
   ELSE 'to_jsonb(v)-''quality'' || v.quality' END;
 -- First select only ordered identities. Materialize the bounded page before
 -- rendering names, correlated counts and reference grading for its DTOs.
 EXECUTE 'WITH chosen AS MATERIALIZED (SELECT v.id,row_number() OVER (ORDER BY ' || ord || ') AS pos' || sql_base ||
   ' ORDER BY ' || ord || ' LIMIT $5 OFFSET $6) SELECT coalesce(jsonb_agg(' || dto || ' ORDER BY chosen.pos),''[]''::jsonb) FROM chosen CROSS JOIN LATERAL (SELECT * FROM nodema_catalog($2,$3,$4) c WHERE c.id=chosen.id OFFSET 0) v'
   INTO items USING f,fresh,tpl,operator_name,lim,off;
 RETURN jsonb_build_object('total',total,'items',items);
END;
$$;
