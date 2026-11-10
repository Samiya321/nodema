-- Source taxonomy: airports (subscription-userinfo), Sub-Store indexes and their
-- materialized child sources, self-hosted inputs; plus stable display names.

CREATE TABLE providers (
 id uuid CONSTRAINT pk_providers PRIMARY KEY,
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
 match_key text CONSTRAINT uq_providers_match_key UNIQUE,
 website text CHECK (website IS NULL OR length(website) <= 300),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sources
 ADD COLUMN kind text NOT NULL DEFAULT 'AUTO',
 ADD COLUMN detected_kind text NOT NULL DEFAULT 'UNKNOWN',
 ADD COLUMN parent_source_id uuid CONSTRAINT fk_sources_parent_source_id_sources REFERENCES sources(id) ON DELETE RESTRICT,
 ADD COLUMN origin_key text,
 ADD COLUMN origin_label text,
 ADD COLUMN user_agent text,
 ADD COLUMN provider_id uuid CONSTRAINT fk_sources_provider_id_providers REFERENCES providers(id) ON DELETE SET NULL,
 ADD COLUMN traffic_upload bigint,
 ADD COLUMN traffic_download bigint,
 ADD COLUMN traffic_total bigint,
 ADD COLUMN expires_at timestamptz,
 ADD COLUMN userinfo_at timestamptz,
 ADD COLUMN profile_title text,
 ADD COLUMN profile_url text,
 ADD COLUMN last_success_at timestamptz,
 ADD CONSTRAINT ck_sources_kind CHECK (kind IN ('AUTO','AIRPORT','SELF_HOSTED')),
 ADD CONSTRAINT ck_sources_detected_kind CHECK (detected_kind IN ('UNKNOWN','AIRPORT','SELF_HOSTED','SUBSTORE')),
 ADD CONSTRAINT ck_sources_user_agent CHECK (user_agent IS NULL OR length(user_agent) BETWEEN 1 AND 512),
 ADD CONSTRAINT ck_sources_origin_label CHECK (origin_label IS NULL OR length(origin_label) <= 120),
 ADD CONSTRAINT ck_sources_profile CHECK ((profile_title IS NULL OR length(profile_title) <= 120)
   AND (profile_url IS NULL OR length(profile_url) <= 300)),
 ADD CONSTRAINT ck_sources_traffic CHECK (coalesce(traffic_upload,0) >= 0
   AND coalesce(traffic_download,0) >= 0 AND coalesce(traffic_total,0) >= 0);
CREATE INDEX idx_sources_parent ON sources(parent_source_id);
CREATE INDEX idx_sources_provider ON sources(provider_id);
CREATE UNIQUE INDEX uq_sources_origin ON sources(parent_source_id, origin_key)
 WHERE parent_source_id IS NOT NULL AND deleted_at IS NULL;
UPDATE sources SET last_success_at = last_synced_at WHERE last_sync_status IN ('SUCCESS','PARTIAL');

-- Effective kind. Sub-Store indexes never own nodes directly once materialized.
CREATE FUNCTION nodema_source_kind(kind text, detected text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN detected='SUBSTORE' THEN 'SUBSTORE' WHEN kind<>'AUTO' THEN kind
   WHEN detected='AIRPORT' THEN 'AIRPORT' ELSE 'SELF_HOSTED' END;
$$;

-- An airport subscription stops feeding tests/exports when paused, deleted,
-- expired or out of traffic. Self-hosted nodes are kept regardless of source state.
CREATE FUNCTION nodema_source_usable(enabled boolean, deleted timestamptz, expires timestamptz,
 upload bigint, download bigint, total bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT enabled AND deleted IS NULL AND (expires IS NULL OR expires > now())
   AND (total IS NULL OR total <= 0 OR coalesce(upload,0)+coalesce(download,0) < total);
$$;

CREATE VIEW nodema_node_scope AS
 SELECT n.id AS node_id,
  CASE WHEN a.airport THEN 'AIRPORT' ELSE 'SELF_HOSTED' END AS node_group,
  (n.enabled AND (NOT a.airport OR a.usable)) AS eligible,
  a.provider_id
 FROM nodes n CROSS JOIN LATERAL (
  SELECT coalesce(bool_or(true),false) AS airport,
   coalesce(bool_or(nodema_source_usable(s.enabled,s.deleted_at,s.expires_at,
     s.traffic_upload,s.traffic_download,s.traffic_total)),false) AS usable,
   (array_agg(s.provider_id ORDER BY (s.deleted_at IS NULL) DESC, s.created_at)
     FILTER (WHERE s.provider_id IS NOT NULL))[1] AS provider_id
  FROM node_sources ns JOIN sources s ON s.id=ns.source_id
  WHERE ns.node_id=n.id AND nodema_source_kind(s.kind,s.detected_kind)='AIRPORT'
 ) a;

-- Scans: explicit manual runs and a node-group scope.
ALTER TABLE scan_runs DROP CONSTRAINT ck_scan_runs_kind;
ALTER TABLE scan_runs ADD CONSTRAINT ck_scan_runs_kind CHECK (kind IN ('DAILY','SUPPLEMENTAL','MANUAL')),
 ADD COLUMN scope text NOT NULL DEFAULT 'ALL',
 ADD CONSTRAINT ck_scan_runs_scope CHECK (scope IN ('ALL','SELF_HOSTED','AIRPORT'));

CREATE TABLE app_settings (
 id integer CONSTRAINT pk_app_settings PRIMARY KEY CHECK (id = 1),
 daily_scan_enabled boolean NOT NULL DEFAULT true,
 daily_scan_scope text NOT NULL DEFAULT 'SELF_HOSTED' CHECK (daily_scan_scope IN ('ALL','SELF_HOSTED','AIRPORT')),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings(id) VALUES (1);

-- Naming: exit ASN organization, user/builtin labels and stable per-group numbers.
ALTER TABLE test_results ADD COLUMN exit_asn_org text;
ALTER TABLE node_current_status ADD COLUMN last_exit_asn_org text;

CREATE TABLE asn_labels (
 asn bigint CONSTRAINT pk_asn_labels PRIMARY KEY CHECK (asn BETWEEN 0 AND 4294967295),
 label text NOT NULL CHECK (length(label) BETWEEN 1 AND 40 AND label !~ '[|\x00-\x1f]'),
 origin text NOT NULL DEFAULT 'USER' CHECK (origin IN ('BUILTIN','USER')),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO asn_labels(asn,label,origin) VALUES
 (16509,'AWS','BUILTIN'),(14618,'AWS','BUILTIN'),(15169,'Google','BUILTIN'),
 (396982,'GCP','BUILTIN'),(8075,'Azure','BUILTIN'),(13335,'Cloudflare','BUILTIN'),
 (45102,'Aliyun','BUILTIN'),(37963,'Aliyun','BUILTIN'),(132203,'Tencent','BUILTIN'),
 (45090,'Tencent','BUILTIN'),(31898,'Oracle','BUILTIN'),(20473,'Vultr','BUILTIN'),
 (14061,'DigitalOcean','BUILTIN'),(63949,'Linode','BUILTIN'),(24940,'Hetzner','BUILTIN'),
 (16276,'OVH','BUILTIN'),(9009,'M247','BUILTIN'),(60068,'Datacamp','BUILTIN'),
 (21859,'Zenlayer','BUILTIN'),(25820,'IT7','BUILTIN'),(906,'DMIT','BUILTIN'),
 (4760,'HKT','BUILTIN'),(9269,'HKBN','BUILTIN'),(9304,'HGC','BUILTIN'),
 (3491,'PCCW','BUILTIN'),(4609,'CTM','BUILTIN'),(58453,'CMI','BUILTIN'),
 (2914,'NTT','BUILTIN'),(2516,'KDDI','BUILTIN'),(17676,'SoftBank','BUILTIN'),
 (2497,'IIJ','BUILTIN'),(4713,'OCN','BUILTIN'),(3462,'HiNet','BUILTIN'),
 (9808,'CMCC','BUILTIN'),(136907,'HuaweiCloud','BUILTIN'),(135377,'UCloud','BUILTIN');

-- Organization names are reduced to one short brand-like word, e.g.
-- 'WEBBING HONG KONG LIMITED' -> 'Webbing'. Users can override per ASN.
CREATE FUNCTION nodema_org_short(org text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v text; words text[]; w text; kept text[] := '{}';
 drop_words text[] := ARRAY['inc','incorporated','llc','ltd','limited','co','corp','corporation','company',
  'gmbh','ag','sa','sas','srl','bv','pte','pty','plc','kk','oy','ab','as','sro','jsc','ooo','llp','lp','the',
  'network','networks','communication','communications','telecom','telecommunication','telecommunications',
  'technology','technologies','tech','service','services','hosting','host','cloud','global','international',
  'holding','holdings','group','online','datacenter','datacentre','data','center','centre','internet',
  'broadband','solutions','solution','systems','system','enterprise','enterprises','digital','information',
  'infrastructure','server','servers','web','net','of','and','asia','pacific','europe','america','american',
  'hong','kong','hk','singapore','sg','japan','jp','taiwan','tw','korea','kr','usa','us','uk','china',
  'macau','macao','germany','de','ltda','company,','computing','connected','as-','aspac'];
BEGIN
 IF org IS NULL OR btrim(org)='' THEN RETURN NULL; END IF;
 v := regexp_replace(org,'\([^)]*\)',' ','g');
 v := split_part(v,',',1);
 v := regexp_replace(v,'[^A-Za-z0-9&+ .-]',' ','g');
 FOREACH w IN ARRAY regexp_split_to_array(btrim(v),'[ ]+') LOOP
   w := btrim(w,'.-');
   IF w<>'' AND NOT (lower(w) = ANY(drop_words)) AND lower(w) !~ '^(as|asn)[0-9]*$' THEN kept := kept || w; END IF;
 END LOOP;
 IF cardinality(kept)=0 THEN
   words := regexp_split_to_array(btrim(regexp_replace(v,'[^A-Za-z0-9]+',' ','g')),'[ ]+');
   IF cardinality(words)=0 OR words[1]='' THEN RETURN NULL; END IF;
   kept := ARRAY[words[1]];
 END IF;
 w := kept[1];
 IF w ~ '^[A-Z0-9&+.-]+$' AND length(w)>4 THEN w := initcap(lower(w)); END IF;
 RETURN left(w,24);
END;
$$;

CREATE FUNCTION nodema_asn_label(asn bigint, org text) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT l.label FROM asn_labels l WHERE l.asn=$1), nodema_org_short($2),
   CASE WHEN $1 IS NOT NULL THEN 'AS'||$1 END);
$$;

CREATE TABLE node_names (
 node_id uuid CONSTRAINT pk_node_names PRIMARY KEY CONSTRAINT fk_node_names_node_id_nodes REFERENCES nodes(id) ON DELETE CASCADE,
 entry_country text,
 exit_country text,
 asn_label text,
 seq integer NOT NULL CHECK (seq > 0),
 assigned_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_node_names_group ON node_names(coalesce(entry_country,''),coalesce(exit_country,''),coalesce(asn_label,''),seq);

-- Stable numbering: a node keeps its number while its (entry, exit, ASN label) group
-- is unchanged; new members take the next free number in short_id order.
CREATE FUNCTION nodema_assign_names() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE changed integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(current_schema()||':nodema-names',0));
 -- New numbers start above every row already in the target group (including rows of
 -- nodes that are moving away in this statement), so upserts never collide.
 WITH current_keys AS (
   SELECT n.id AS node_id,n.short_id,c.entry_country,c.last_exit_country AS exit_country,
     CASE WHEN c.last_exit_country IS NULL AND c.last_exit_asn IS NULL THEN NULL
       ELSE nodema_asn_label(c.last_exit_asn,c.last_exit_asn_org) END AS asn_label
   FROM nodes n LEFT JOIN node_current_status c ON c.node_id=n.id
 ), moved AS (
   SELECT k.* FROM current_keys k LEFT JOIN node_names nn ON nn.node_id=k.node_id
   WHERE nn.node_id IS NULL OR ROW(nn.entry_country,nn.exit_country,nn.asn_label)
     IS DISTINCT FROM ROW(k.entry_country,k.exit_country,k.asn_label)
 )
 INSERT INTO node_names AS target(node_id,entry_country,exit_country,asn_label,seq)
 SELECT m.node_id,m.entry_country,m.exit_country,m.asn_label,
   coalesce((SELECT max(nn.seq) FROM node_names nn
     WHERE coalesce(nn.entry_country,'')=coalesce(m.entry_country,'')
       AND coalesce(nn.exit_country,'')=coalesce(m.exit_country,'')
       AND coalesce(nn.asn_label,'')=coalesce(m.asn_label,'')),0)
   + row_number() OVER (PARTITION BY coalesce(m.entry_country,''),coalesce(m.exit_country,''),
       coalesce(m.asn_label,'') ORDER BY m.short_id)
 FROM moved m
 ON CONFLICT (node_id) DO UPDATE SET entry_country=excluded.entry_country,
   exit_country=excluded.exit_country,asn_label=excluded.asn_label,seq=excluded.seq,assigned_at=now();
 GET DIAGNOSTICS changed = ROW_COUNT;
 RETURN changed;
END;
$$;

CREATE FUNCTION nodema_flag(country text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN country ~ '^[A-Za-z]{2}$' THEN chr(127397+ascii(upper(substr(country,1,1))))
   || chr(127397+ascii(upper(substr(country,2,1)))) ELSE '🏳' END;
$$;

CREATE FUNCTION nodema_render_name(tpl text,sid text,proto text,trans text,sec text,entry text,ex text,
 asn_label text,seq integer) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result text := ''; i integer := 1; closing integer; token text; route text;
BEGIN
 route := CASE WHEN ex IS NULL AND entry IS NULL THEN '?'
   WHEN ex IS NULL THEN entry||'->?' WHEN entry IS NULL OR entry=ex THEN ex ELSE entry||'->'||ex END;
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
       WHEN 'FLAG' THEN nodema_flag(ex) WHEN 'ENTRY_FLAG' THEN nodema_flag(entry)
       WHEN 'ROUTE' THEN route WHEN 'ASN' THEN coalesce(asn_label,'Unknown')
       WHEN 'SEQ' THEN CASE WHEN seq IS NULL THEN sid ELSE lpad(seq::text,2,'0') END
       ELSE NULL END;
     IF result IS NULL THEN RAISE EXCEPTION 'INVALID_NAME_TEMPLATE'; END IF;
     i:=i+closing+1;
   ELSIF substr(tpl,i,1)='}' THEN RAISE EXCEPTION 'INVALID_NAME_TEMPLATE';
   ELSE result:=result||substr(tpl,i,1); i:=i+1;
   END IF;
 END LOOP;
 IF length(tpl)>200 OR length(result)>500 OR tpl ~ '[\x00-\x1f]' THEN RAISE EXCEPTION 'INVALID_NAME_TEMPLATE'; END IF;
 RETURN result;
END;
$$;

CREATE FUNCTION nodema_validate_template(tpl text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 PERFORM nodema_render_name(tpl,'N000001','vless','ws','tls','HK','SG','Example',1);
 RETURN true;
END;
$$;

-- Both runtimes read this row, so the dashboard and subscriptions always agree.
INSERT INTO naming_rules(id,template) VALUES (1,'{FLAG}{ROUTE}|{ASN} {SEQ}')
 ON CONFLICT (id) DO UPDATE SET template=excluded.template,updated_at=now()
 WHERE naming_rules.template='{ENTRY_COUNTRY} → {EXIT_COUNTRY} | {PROTOCOL}-{TRANSPORT}-{SECURITY} | {SHORT_ID}';

-- Catalog: retained nodes stay eligible; airport scope and stable names are exposed.
CREATE OR REPLACE VIEW nodema_catalog_base AS
 SELECT n.id,n.short_id,n.protocol,n.server_host,n.server_port,n.transport,n.security,
   n.enabled,n.line_type,n.first_seen_at,n.last_seen_at,
   (SELECT count(*)::integer FROM node_sources ns WHERE ns.node_id=n.id) AS source_count,
   (SELECT count(*)::integer FROM node_sources ns JOIN sources s ON s.id=ns.source_id
     WHERE ns.node_id=n.id AND ns.is_present AND s.deleted_at IS NULL) AS present_source_count,
   sc.eligible,
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
   n.checked_days,n.available_days,CASE WHEN n.checked_days>0 THEN n.available_days::double precision/n.checked_days ELSE NULL END AS lifetime_availability,
   sc.node_group,sc.provider_id,nn.asn_label,nn.seq AS name_seq,c.last_exit_asn_org AS exit_asn_org
 FROM nodes n JOIN nodema_node_scope sc ON sc.node_id=n.id
 LEFT JOIN node_current_status c ON c.node_id=n.id
 LEFT JOIN test_results t ON t.id=c.last_result_id
 LEFT JOIN node_annotations a ON a.node_id=n.id
 LEFT JOIN node_names nn ON nn.node_id=n.id
 LEFT JOIN runner_node_summaries m ON m.node_id=n.id AND m.probe_key=c.probe_key
   AND m.updated_at >= now()-interval '1 day';

DROP FUNCTION nodema_catalog(integer,text,text);
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
 http_p50_ms double precision,http_p95_ms double precision,metrics_updated_at timestamptz,status text,name text,quality jsonb,age_days integer,checked_days integer,available_days integer,lifetime_availability double precision,
 node_group text,provider_id uuid,asn_label text,exit_asn_org text) LANGUAGE sql STABLE AS $$
 WITH base AS (
 SELECT b.*,CASE WHEN raw_status IS NULL THEN 'UNKNOWN'
   WHEN last_checked_at<now()-make_interval(hours=>fresh) THEN 'STALE' ELSE raw_status END AS status
 FROM nodema_catalog_base b
 ), named AS (
 SELECT b.*,nodema_render_name(tpl,short_id,protocol,transport,security,entry_country,exit_country,asn_label,name_seq)
   AS name FROM base b
 ) SELECT n.id, n.short_id, n.protocol, n.server_host, n.server_port, n.transport, n.security, n.enabled, n.line_type, n.first_seen_at, n.last_seen_at, n.source_count, n.present_source_count, n.eligible, n.entry_country, n.entry_asn, n.exit_ip, n.exit_country, n.exit_asn, n.http_duration_ms, n.last_checked_at, n.last_success_at, n.last_error_code, n.consecutive_failures, n.next_full_check_at, n.probe_key, n.probe_metadata, n.measurement_kind, n.precheck_metadata, n.entry_ips, n.exit_city, n.tags, n.line_claim, n.evidence_level, n.manual_priority, n.operators, n.has_evidence, n.evidence_updated_at, n.sample_count, n.success_rate, n.timeout_rate, n.http_p50_ms, n.http_p95_ms, n.metrics_updated_at, n.status,n.name,
   nodema_grade(jsonb_build_object('eligible',n.eligible,'status',n.status,'sample_count',n.sample_count,'probe_key',n.probe_key,'success_rate',n.success_rate,'entry_country',n.entry_country,'entry_asn',n.entry_asn,'exit_country',n.exit_country,'exit_asn',n.exit_asn,'protocol',n.protocol,'has_evidence',n.has_evidence,'evidence_updated_at',n.evidence_updated_at,'evidence_level',n.evidence_level,'operators',n.operators,'manual_priority',n.manual_priority),p.policy,p.version,operator_name)
,n.age_days,n.checked_days,n.available_days,n.lifetime_availability,n.node_group,n.provider_id,n.asn_label,n.exit_asn_org
 FROM named n CROSS JOIN quality_policies p WHERE p.id=1;
$$;

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
   ELSE 'to_jsonb(v)-''quality'' || v.quality' END;
 -- First select only ordered identities. Materialize the bounded page before
 -- rendering names, correlated counts and reference grading for its DTOs.
 EXECUTE 'WITH chosen AS MATERIALIZED (SELECT v.id,row_number() OVER (ORDER BY ' || ord || ') AS pos' || sql_base ||
   ' ORDER BY ' || ord || ' LIMIT $5 OFFSET $6) SELECT coalesce(jsonb_agg(' || dto || ' ORDER BY chosen.pos),''[]''::jsonb) FROM chosen CROSS JOIN LATERAL (SELECT * FROM nodema_catalog($2,$3,$4) c WHERE c.id=chosen.id OFFSET 0) v'
   INTO items USING f,fresh,tpl,operator_name,lim,off;
 RETURN jsonb_build_object('total',total,'items',items);
END;
$$;


-- Name changes (e.g. a new ASN label) bump the catalog so subscriptions rebuild.
CREATE TRIGGER nodema_exports_changed AFTER INSERT OR UPDATE OR DELETE ON node_names
 FOR EACH STATEMENT EXECUTE FUNCTION nodema_export_catalog_changed();

SELECT nodema_assign_names();
