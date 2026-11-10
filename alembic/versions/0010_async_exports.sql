CREATE TABLE catalog_state (
 id integer PRIMARY KEY, revision bigint NOT NULL DEFAULT 1,
 changed_at timestamptz NOT NULL DEFAULT now(), max_profiles integer NOT NULL DEFAULT 20,
 max_payload_bytes bigint NOT NULL DEFAULT 67108864, max_members integer NOT NULL DEFAULT 100000,
 version_limit integer NOT NULL DEFAULT 20,
 CONSTRAINT ck_catalog_state_singleton CHECK(id=1)
);
INSERT INTO catalog_state(id) VALUES(1);
ALTER TABLE export_artifacts ALTER COLUMN expires_at DROP NOT NULL,
 ALTER COLUMN payload_data SET DEFAULT '\x'::bytea,
 ALTER COLUMN node_count SET DEFAULT 0,
 ADD COLUMN name text NOT NULL DEFAULT 'Subscription',
 ADD COLUMN token_value text,
 ADD COLUMN status text NOT NULL DEFAULT 'PENDING',
 ADD COLUMN request_revision bigint NOT NULL DEFAULT 1,
 ADD COLUMN published_revision bigint NOT NULL DEFAULT 0,
 ADD COLUMN current_version integer NOT NULL DEFAULT 0,
 ADD COLUMN catalog_revision bigint NOT NULL DEFAULT 0,
 ADD COLUMN invalidated boolean NOT NULL DEFAULT true,
 ADD COLUMN requested_at timestamptz DEFAULT now(), ADD COLUMN built_at timestamptz,
 ADD COLUMN valid_until timestamptz, ADD COLUMN error_code text,
 ADD COLUMN failed_catalog_revision bigint, ADD COLUMN lease_owner uuid,
 ADD COLUMN lease_until timestamptz, ADD COLUMN payload_bytes integer NOT NULL DEFAULT 0,
 ADD COLUMN payload_hash text;
UPDATE export_artifacts SET payload_data='\x'::bytea,node_count=0;
CREATE TABLE export_members (
 export_id uuid NOT NULL REFERENCES export_artifacts(id) ON DELETE CASCADE,
 node_id uuid NOT NULL REFERENCES nodes(id), PRIMARY KEY(export_id,node_id)
);
CREATE INDEX idx_export_members_node ON export_members(node_id,export_id);
CREATE TABLE export_versions (
 export_id uuid NOT NULL REFERENCES export_artifacts(id) ON DELETE CASCADE,
 version_no integer NOT NULL, request_revision bigint NOT NULL, catalog_revision bigint NOT NULL,
 created_at timestamptz NOT NULL, valid_until timestamptz NOT NULL, node_count integer NOT NULL,
 payload_bytes integer NOT NULL,payload_hash text NOT NULL,format text NOT NULL,filter_spec jsonb NOT NULL,
 PRIMARY KEY(export_id,version_no)
);

CREATE FUNCTION nodema_bump_catalog() RETURNS void LANGUAGE plpgsql AS $$
DECLARE marker text := txid_current()::text||':'||current_schema();
BEGIN
 IF current_setting('nodema.catalog_tx',true) IS DISTINCT FROM marker THEN
   UPDATE catalog_state SET revision=revision+1,changed_at=now() WHERE id=1;
   PERFORM set_config('nodema.catalog_tx',marker,true);
 END IF;
END;
$$;
CREATE FUNCTION nodema_invalidate_exports(ids uuid[]) RETURNS void LANGUAGE sql AS $$
 UPDATE export_artifacts e SET invalidated=true,requested_at=coalesce(requested_at,now())
 WHERE NOT e.invalidated AND e.revoked_at IS NULL AND
 (ids IS NULL OR EXISTS(SELECT 1 FROM export_members m WHERE m.export_id=e.id AND m.node_id=ANY(ids)));
$$;
CREATE FUNCTION nodema_export_catalog_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ids uuid[]; unsafe boolean := true;
BEGIN
 -- The catalog lock is always acquired before profile locks (also by publishers).
 PERFORM nodema_bump_catalog();
 IF TG_TABLE_NAME='sources' THEN
   unsafe := TG_OP='DELETE';
   IF TG_OP='UPDATE' THEN unsafe := (OLD.enabled AND NOT NEW.enabled) OR
      (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL); END IF;
   IF unsafe THEN
     SELECT array_agg(node_id) INTO ids FROM node_sources WHERE source_id=OLD.id AND is_present;
   END IF;
 ELSIF TG_TABLE_NAME='nodes' THEN
   IF TG_OP='INSERT' THEN unsafe := false;
   ELSIF TG_OP='UPDATE' THEN
     unsafe := ROW(OLD.enabled,OLD.config_data,OLD.first_seen_at,OLD.checked_days,OLD.available_days,
       OLD.server_host,OLD.server_port,OLD.protocol,OLD.transport,OLD.security)
       IS DISTINCT FROM ROW(NEW.enabled,NEW.config_data,NEW.first_seen_at,NEW.checked_days,NEW.available_days,
       NEW.server_host,NEW.server_port,NEW.protocol,NEW.transport,NEW.security);
     ids := ARRAY[NEW.id];
   ELSE ids := ARRAY[OLD.id]; END IF;
 ELSIF TG_TABLE_NAME='node_sources' THEN
   IF TG_OP='INSERT' THEN unsafe := false;
   ELSE
     ids := ARRAY[OLD.node_id];
     IF TG_OP='UPDATE' THEN
       unsafe := ROW(OLD.node_id,OLD.source_id,OLD.is_present)
         IS DISTINCT FROM ROW(NEW.node_id,NEW.source_id,NEW.is_present);
     END IF;
   END IF;
 ELSIF TG_TABLE_NAME IN ('node_current_status','node_annotations','runner_node_summaries') THEN
   IF TG_OP='DELETE' THEN ids := ARRAY[OLD.node_id]; ELSE ids := ARRAY[NEW.node_id]; END IF;
 END IF;
 IF unsafe AND (ids IS NOT NULL OR TG_TABLE_NAME IN ('naming_rules','quality_policies')) THEN
   PERFORM nodema_invalidate_exports(ids);
 END IF;
 RETURN NULL;
END;
$$;
CREATE TRIGGER nodema_exports_changed AFTER INSERT OR UPDATE OR DELETE ON nodes
 FOR EACH ROW EXECUTE FUNCTION nodema_export_catalog_changed();
CREATE TRIGGER nodema_exports_changed AFTER INSERT OR DELETE OR UPDATE OF enabled,deleted_at,url_data,payload_data ON sources
 FOR EACH ROW EXECUTE FUNCTION nodema_export_catalog_changed();
CREATE TRIGGER nodema_exports_changed AFTER INSERT OR UPDATE OR DELETE ON node_sources
 FOR EACH ROW EXECUTE FUNCTION nodema_export_catalog_changed();
CREATE TRIGGER nodema_exports_changed AFTER INSERT OR UPDATE OR DELETE ON node_current_status
 FOR EACH ROW EXECUTE FUNCTION nodema_export_catalog_changed();
CREATE TRIGGER nodema_exports_changed AFTER INSERT OR UPDATE OR DELETE ON node_annotations
 FOR EACH ROW EXECUTE FUNCTION nodema_export_catalog_changed();
CREATE TRIGGER nodema_exports_changed AFTER INSERT OR UPDATE OR DELETE ON runner_node_summaries
 FOR EACH ROW EXECUTE FUNCTION nodema_export_catalog_changed();
CREATE TRIGGER nodema_exports_changed AFTER INSERT OR UPDATE OR DELETE ON naming_rules
 FOR EACH STATEMENT EXECUTE FUNCTION nodema_export_catalog_changed();
CREATE TRIGGER nodema_exports_changed AFTER INSERT OR UPDATE OR DELETE ON quality_policies
 FOR EACH STATEMENT EXECUTE FUNCTION nodema_export_catalog_changed();

CREATE FUNCTION nodema_export_config_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.format,NEW.filter_spec) IS DISTINCT FROM ROW(OLD.format,OLD.filter_spec) THEN
   NEW.request_revision := OLD.request_revision+1; NEW.invalidated := true;
   NEW.requested_at := now(); NEW.status := 'PENDING'; NEW.error_code := NULL;
   NEW.lease_owner := NULL; NEW.lease_until := NULL;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER nodema_export_config BEFORE UPDATE OF format,filter_spec ON export_artifacts
 FOR EACH ROW EXECUTE FUNCTION nodema_export_config_changed();

CREATE FUNCTION nodema_export_serving(e export_artifacts) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at>now())
 AND e.current_version>0 AND NOT e.invalidated AND e.valid_until>now()
 AND e.request_revision=e.published_revision;
$$;
CREATE FUNCTION nodema_export_metadata(target uuid DEFAULT NULL) RETURNS SETOF jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('id',e.id,'name',e.name,'format',e.format,'filter_spec',e.filter_spec,
 'created_at',e.created_at,'expires_at',e.expires_at,'revoked_at',e.revoked_at,'node_count',e.node_count,
 'request_revision',e.request_revision,'published_revision',e.published_revision,'current_version',e.current_version,
 'catalog_revision',e.catalog_revision,'built_at',e.built_at,'valid_until',e.valid_until,
 'payload_bytes',e.payload_bytes,'payload_hash',e.payload_hash,'error_code',e.error_code,
 'serving',nodema_export_serving(e),'build_status',e.status,
 'status',CASE WHEN e.revoked_at IS NOT NULL THEN 'REVOKED'
 WHEN e.expires_at<=now() THEN 'EXPIRED'
 WHEN e.status='BUILDING' AND e.lease_until>now() THEN 'BUILDING'
 WHEN e.status='FAILED' THEN 'FAILED'
 WHEN e.current_version=0 THEN 'PENDING'
 WHEN NOT nodema_export_serving(e) OR e.catalog_revision<>s.revision OR e.requested_at IS NOT NULL THEN 'UPDATING'
 ELSE 'READY' END)
 FROM export_artifacts e CROSS JOIN catalog_state s WHERE s.id=1 AND (target IS NULL OR e.id=target)
 ORDER BY e.created_at DESC LIMIT 100;
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
   operator_name NOT IN ('GENERAL','CT','CU','CM') OR projection NOT IN ('full','identity','report','validate') THEN RAISE EXCEPTION 'INVALID_NODE_QUERY'; END IF;
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
 IF projection='validate' THEN RETURN jsonb_build_object('items','[]'::jsonb,'total',0); END IF;
 sql_base := ' FROM nodema_catalog($2,$3,$4) v WHERE ' || wh;
 EXECUTE 'SELECT count(*)' || sql_base INTO total USING f,fresh,tpl,operator_name;
 dto := CASE projection WHEN 'identity' THEN 'jsonb_build_object(''id'',v.id,''short_id'',v.short_id,''name'',v.name,''last_success_at'',v.last_success_at)'
   WHEN 'report' THEN 'jsonb_build_object(''id'',v.id,''short_id'',v.short_id,''name'',v.name,''protocol'',v.protocol,''server_host'',v.server_host,''server_port'',v.server_port,''transport'',v.transport,''security'',v.security,''status'',v.status,''entry_country'',v.entry_country,''exit_ip'',v.exit_ip,''exit_country'',v.exit_country,''exit_asn'',v.exit_asn,''http_duration_ms'',v.http_duration_ms,''last_success_at'',v.last_success_at,''last_checked_at'',v.last_checked_at,''entry_asn'',v.entry_asn,''grade'',v.quality->''grade'',''confidence'',v.quality->''confidence'',''reasons'',v.quality->''reasons'',''rule_version'',v.quality->''rule_version'',''operator'',v.quality->''operator'',''mainland_reachability'',v.quality->''mainland_reachability'',''sample_count'',v.sample_count,''success_rate'',v.success_rate,''timeout_rate'',v.timeout_rate,''http_p50_ms'',v.http_p50_ms,''http_p95_ms'',v.http_p95_ms,''probe_key'',v.probe_key,''line_claim'',v.line_claim,''evidence_level'',v.evidence_level,''evidence_age_days'',v.quality->''evidence_age_days'',''evidence_updated_at'',v.evidence_updated_at,''tags'',v.tags,''first_seen_at'',v.first_seen_at,''age_days'',v.age_days,''checked_days'',v.checked_days,''available_days'',v.available_days,''lifetime_availability'',v.lifetime_availability)'
   ELSE 'to_jsonb(v)-''quality'' || v.quality' END;
 -- First select only ordered identities. Materialize the bounded page before
 -- rendering names, correlated counts and reference grading for its DTOs.
 EXECUTE 'WITH chosen AS MATERIALIZED (SELECT v.id,row_number() OVER (ORDER BY ' || ord || ') AS pos' || sql_base ||
   ' ORDER BY ' || ord || ' LIMIT $5 OFFSET $6) SELECT coalesce(jsonb_agg(' || dto || ' ORDER BY chosen.pos),''[]''::jsonb) FROM chosen CROSS JOIN LATERAL (SELECT * FROM nodema_catalog($2,$3,$4) c WHERE c.id=chosen.id OFFSET 0) v'
   INTO items USING f,fresh,tpl,operator_name,lim,off;
 RETURN jsonb_build_object('total',total,'items',items);
END;
$$;

CREATE FUNCTION nodema_validate_export(fmt text,f jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE ordering text; lim integer; k text;
BEGIN
 IF fmt IS NULL OR fmt NOT IN ('mihomo','singbox','uri','json','csv') THEN RAISE EXCEPTION 'INVALID_EXPORT_FORMAT'; END IF;
 IF jsonb_typeof(f)<>'object' OR (f ? 'status' AND f->>'status'<>'UP') OR
 (f ? 'eligible' AND f->'eligible'<>'true'::jsonb) THEN RAISE EXCEPTION 'INVALID_EXPORT_FILTER'; END IF;
 IF f ? 'sort' AND jsonb_typeof(f->'sort')<>'string' THEN RAISE EXCEPTION 'INVALID_EXPORT_FILTER'; END IF;
 IF f ? 'limit' AND (jsonb_typeof(f->'limit')<>'number' OR (f->>'limit')!~'^[0-9]+$') THEN RAISE EXCEPTION 'INVALID_EXPORT_FILTER'; END IF;
 ordering := coalesce(f->>'sort','short_id:asc'); lim := coalesce((f->>'limit')::integer,100000);
 FOREACH k IN ARRAY ARRAY['last_checked_after','last_success_after'] LOOP
   IF f ? k THEN PERFORM (f->>k)::timestamptz; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['id','source_id'] LOOP
   IF f ? k THEN PERFORM (f->>k)::uuid; END IF;
 END LOOP;
 PERFORM nodema_node_page(f-'sort'-'limit',ordering,0,lim,36,'{SHORT_ID}','validate');
 RETURN f||jsonb_build_object('sort',ordering,'limit',lim);
EXCEPTION WHEN OTHERS THEN
 IF SQLERRM='INVALID_EXPORT_FORMAT' THEN RAISE EXCEPTION 'INVALID_EXPORT_FORMAT'; END IF;
 RAISE EXCEPTION 'INVALID_EXPORT_FILTER';
END;
$$;

CREATE FUNCTION nodema_export_lock() RETURNS void LANGUAGE sql AS $$
 SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||':nodema-export-quota',0));
$$;
