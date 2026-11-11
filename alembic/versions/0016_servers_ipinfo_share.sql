-- Landing-IP details (ip-api), numbering per landing server with protocol suffixes,
-- an operator token "Org|ASN", and per-node share links for QR codes.

-- Landing IP details, refreshed by Actions after tests. Untrusted text: Python
-- strips control characters and caps lengths before writing.
CREATE TABLE ip_info (
 ip text CONSTRAINT pk_ip_info PRIMARY KEY CHECK (length(ip) <= 64),
 status text NOT NULL CHECK (status IN ('SUCCESS','FAILED')),
 country_code text,
 region text,
 city text,
 isp text,
 org text,
 as_number bigint,
 as_org text,
 queried_at timestamptz NOT NULL DEFAULT now()
);

-- Share links are computed once per node by Python (config never changes for a
-- node). A separate table keeps writes off the nodes export trigger.
CREATE TABLE node_share_links (
 node_id uuid CONSTRAINT pk_node_share_links PRIMARY KEY
   CONSTRAINT fk_node_share_links_node_id_nodes REFERENCES nodes(id) ON DELETE CASCADE,
 uri text CHECK (length(uri) <= 8192),
 error_code text CHECK (length(error_code) <= 64),
 -- Settings a share link cannot carry and that were left out (comma-separated codes).
 omitted text CHECK (length(omitted) <= 200),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT ck_node_share_links_value CHECK ((uri IS NULL) <> (error_code IS NULL))
);

-- One number per landing server (exit IP) inside a landing country + operator group.
CREATE TABLE name_servers (
 server_key text CONSTRAINT pk_name_servers PRIMARY KEY,
 exit_country text,
 org_label text,
 asn_label text,
 seq integer NOT NULL CHECK (seq > 0),
 assigned_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_name_servers_group ON name_servers(coalesce(exit_country,''),coalesce(org_label,''),coalesce(asn_label,''),seq);

-- Nodes on one server share its number; the group key is copied for rendering.
DROP INDEX uq_node_names_group;
ALTER TABLE node_names ADD COLUMN server_key text, ADD COLUMN org_label text, ADD COLUMN variant text;
CREATE INDEX idx_node_names_server ON node_names(server_key);

CREATE FUNCTION nodema_protocol_label(proto text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE proto WHEN 'shadowsocks' THEN 'SS' WHEN 'vmess' THEN 'VMess' WHEN 'vless' THEN 'VLESS'
   WHEN 'trojan' THEN 'Trojan' WHEN 'hysteria2' THEN 'Hy2' WHEN 'anytls' THEN 'AnyTLS' ELSE upper(proto) END;
$$;

-- The netblock holder (ip-api "org"), omitted when it names the same company as the ASN.
CREATE FUNCTION nodema_org_label(org text, asn_label text, asn_org text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s text := nodema_org_short(org);
BEGIN
 IF s IS NULL OR lower(s)=lower(coalesce(asn_label,'')) OR lower(s)=lower(coalesce(nodema_org_short(asn_org),'')) THEN
   RETURN NULL;
 END IF;
 RETURN s;
END;
$$;

-- Naming inputs per node with landing information.
CREATE VIEW nodema_name_keys AS
 SELECT k.*,nodema_org_label(k.ip_org,k.asn_label,k.asn_org) AS org_label FROM (
   SELECT n.id AS node_id,n.short_id,n.protocol,coalesce(c.last_exit_ip,'node:'||n.id) AS server_key,
     c.last_exit_country AS exit_country,i.org AS ip_org,coalesce(c.last_exit_asn_org,i.as_org) AS asn_org,
     nodema_asn_label(c.last_exit_asn,coalesce(c.last_exit_asn_org,i.as_org)) AS asn_label
   FROM nodes n JOIN node_current_status c ON c.node_id=n.id
   LEFT JOIN ip_info i ON i.ip=c.last_exit_ip AND i.status='SUCCESS'
   WHERE c.last_exit_country IS NOT NULL OR c.last_exit_asn IS NOT NULL
 ) k;

-- Desired node rows: a node takes its server's number; nodes sharing a server get a
-- protocol suffix (VMess, VMess-2 when the protocol repeats on that server).
CREATE FUNCTION nodema_name_targets() RETURNS TABLE(node_id uuid,server_key text,exit_country text,
 org_label text,asn_label text,seq integer,variant text) LANGUAGE sql STABLE AS $$
 SELECT x.node_id,x.server_key,x.exit_country,x.org_label,x.asn_label,x.seq,
   CASE WHEN x.members>1 THEN x.label||CASE WHEN x.repeat>1 THEN '-'||x.repeat ELSE '' END END
 FROM (
   SELECT k.node_id,s.server_key,s.exit_country,s.org_label,s.asn_label,s.seq,
     nodema_protocol_label(k.protocol) AS label,
     count(*) OVER (PARTITION BY k.server_key) AS members,
     row_number() OVER (PARTITION BY k.server_key,nodema_protocol_label(k.protocol) ORDER BY k.short_id) AS repeat
   FROM nodema_name_keys k JOIN name_servers s ON s.server_key=k.server_key
 ) x;
$$;

-- Stable numbering: a server keeps its number while its group is unchanged; new
-- servers take the next free number above the group maximum. Node rows are only
-- written when something changed, so the statement-level export trigger stays quiet.
CREATE OR REPLACE FUNCTION nodema_assign_names() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE changed integer := 0; n integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(current_schema()||':nodema-names',0));
 DELETE FROM name_servers s WHERE NOT EXISTS (SELECT 1 FROM nodema_name_keys k WHERE k.server_key=s.server_key);
 WITH servers AS (
   SELECT DISTINCT ON (server_key) server_key,exit_country,org_label,asn_label,
     min(short_id) OVER (PARTITION BY server_key) AS first_short_id
   FROM nodema_name_keys
   ORDER BY server_key,(exit_country IS NULL),(org_label IS NULL),(asn_label IS NULL),short_id
 ), moved AS (
   SELECT v.* FROM servers v LEFT JOIN name_servers s ON s.server_key=v.server_key
   WHERE s.server_key IS NULL
     OR ROW(s.exit_country,s.org_label,s.asn_label) IS DISTINCT FROM ROW(v.exit_country,v.org_label,v.asn_label)
 )
 INSERT INTO name_servers AS target(server_key,exit_country,org_label,asn_label,seq)
 SELECT m.server_key,m.exit_country,m.org_label,m.asn_label,
   coalesce((SELECT max(s.seq) FROM name_servers s
     WHERE coalesce(s.exit_country,'')=coalesce(m.exit_country,'')
       AND coalesce(s.org_label,'')=coalesce(m.org_label,'')
       AND coalesce(s.asn_label,'')=coalesce(m.asn_label,'')),0)
   + row_number() OVER (PARTITION BY coalesce(m.exit_country,''),coalesce(m.org_label,''),coalesce(m.asn_label,'')
       ORDER BY m.first_short_id)
 FROM moved m
 ON CONFLICT (server_key) DO UPDATE SET exit_country=excluded.exit_country,org_label=excluded.org_label,
   asn_label=excluded.asn_label,seq=excluded.seq,assigned_at=now();

 IF EXISTS (SELECT 1 FROM node_names nn WHERE NOT EXISTS (SELECT 1 FROM nodema_name_keys k WHERE k.node_id=nn.node_id)) THEN
   DELETE FROM node_names nn WHERE NOT EXISTS (SELECT 1 FROM nodema_name_keys k WHERE k.node_id=nn.node_id);
   GET DIAGNOSTICS n = ROW_COUNT; changed := changed + n;
 END IF;
 IF EXISTS (
   SELECT 1 FROM nodema_name_targets() t LEFT JOIN node_names nn ON nn.node_id=t.node_id
   WHERE nn.node_id IS NULL OR ROW(nn.server_key,nn.exit_country,nn.org_label,nn.asn_label,nn.seq,nn.variant,nn.entry_country)
     IS DISTINCT FROM ROW(t.server_key,t.exit_country,t.org_label,t.asn_label,t.seq,t.variant,NULL::text)
 ) THEN
   INSERT INTO node_names AS target(node_id,entry_country,server_key,exit_country,org_label,asn_label,seq,variant)
   SELECT t.node_id,NULL,t.server_key,t.exit_country,t.org_label,t.asn_label,t.seq,t.variant
   FROM nodema_name_targets() t
   ON CONFLICT (node_id) DO UPDATE SET entry_country=NULL,server_key=excluded.server_key,
     exit_country=excluded.exit_country,org_label=excluded.org_label,asn_label=excluded.asn_label,
     seq=excluded.seq,variant=excluded.variant,assigned_at=now()
   WHERE ROW(target.server_key,target.exit_country,target.org_label,target.asn_label,target.seq,target.variant,target.entry_country)
     IS DISTINCT FROM ROW(excluded.server_key,excluded.exit_country,excluded.org_label,excluded.asn_label,excluded.seq,excluded.variant,NULL::text);
   GET DIAGNOSTICS n = ROW_COUNT; changed := changed + n;
 END IF;
 RETURN changed;
END;
$$;

-- Renderer: {ORG}, {OPERATOR} and {VARIANT}; the catalog exposes landing-IP details.
DROP FUNCTION nodema_catalog(integer,text,text);
DROP FUNCTION nodema_validate_template(text);
DROP FUNCTION nodema_render_name(text,text,text,text,text,text,text,text,integer);
CREATE FUNCTION nodema_render_name(tpl text,sid text,proto text,trans text,sec text,entry text,ex text,
 asn_label text,org_label text,seq integer,variant text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
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
       WHEN 'ORG' THEN coalesce(org_label,'')
       -- "Greencloud|xTom", or just the ASN label when the netblock holder adds nothing.
       WHEN 'OPERATOR' THEN CASE WHEN org_label IS NULL THEN coalesce(asn_label,'Unknown')
         ELSE org_label||'|'||coalesce(asn_label,'Unknown') END
       -- " VMess" only when several nodes share the landing server.
       WHEN 'VARIANT' THEN CASE WHEN variant IS NULL THEN '' ELSE ' '||variant END
       -- lpad() truncates; pad only 1-9 so 100+ stays intact.
       WHEN 'SEQ' THEN CASE WHEN seq IS NULL THEN sid WHEN seq < 10 THEN '0'||seq ELSE seq::text END
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
 PERFORM nodema_render_name(tpl,'N000001','vless','ws','tls','HK','SG','Example','Org',1,'VLESS');
 RETURN true;
END;
$$;

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
   sc.node_group,sc.provider_id,nn.asn_label,nn.seq AS name_seq,c.last_exit_asn_org AS exit_asn_org,
   nn.org_label,nn.variant AS name_variant,nn.server_key,
   (SELECT count(*)::integer FROM node_names x WHERE x.server_key=nn.server_key) AS server_node_count,
   ip.org AS exit_org,ip.isp AS exit_isp,ip.region AS exit_region,ip.city AS exit_ip_city
 FROM nodes n JOIN nodema_node_scope sc ON sc.node_id=n.id
 LEFT JOIN node_current_status c ON c.node_id=n.id
 LEFT JOIN test_results t ON t.id=c.last_result_id
 LEFT JOIN node_annotations a ON a.node_id=n.id
 LEFT JOIN node_names nn ON nn.node_id=n.id
 LEFT JOIN ip_info ip ON ip.ip=c.last_exit_ip AND ip.status='SUCCESS'
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
 http_p50_ms double precision,http_p95_ms double precision,metrics_updated_at timestamptz,status text,name text,quality jsonb,age_days integer,checked_days integer,available_days integer,lifetime_availability double precision,
 node_group text,provider_id uuid,asn_label text,exit_asn_org text,
 org_label text,name_variant text,server_key text,server_node_count integer,exit_org text,exit_isp text,exit_region text,exit_ip_city text) LANGUAGE sql STABLE AS $$
 WITH base AS (
 SELECT b.*,CASE WHEN raw_status IS NULL THEN 'UNKNOWN'
   WHEN last_checked_at<now()-make_interval(hours=>fresh) THEN 'STALE' ELSE raw_status END AS status
 FROM nodema_catalog_base b
 ), named AS (
 SELECT b.*,nodema_render_name(tpl,short_id,protocol,transport,security,entry_country,exit_country,asn_label,org_label,name_seq,name_variant)
   AS name FROM base b
 ) SELECT n.id, n.short_id, n.protocol, n.server_host, n.server_port, n.transport, n.security, n.enabled, n.line_type, n.first_seen_at, n.last_seen_at, n.source_count, n.present_source_count, n.eligible, n.entry_country, n.entry_asn, n.exit_ip, n.exit_country, n.exit_asn, n.http_duration_ms, n.last_checked_at, n.last_success_at, n.last_error_code, n.consecutive_failures, n.next_full_check_at, n.probe_key, n.probe_metadata, n.measurement_kind, n.precheck_metadata, n.entry_ips, n.exit_city, n.tags, n.line_claim, n.evidence_level, n.manual_priority, n.operators, n.has_evidence, n.evidence_updated_at, n.sample_count, n.success_rate, n.timeout_rate, n.http_p50_ms, n.http_p95_ms, n.metrics_updated_at, n.status,n.name,
   nodema_grade(jsonb_build_object('eligible',n.eligible,'status',n.status,'sample_count',n.sample_count,'probe_key',n.probe_key,'success_rate',n.success_rate,'entry_country',n.entry_country,'entry_asn',n.entry_asn,'exit_country',n.exit_country,'exit_asn',n.exit_asn,'protocol',n.protocol,'has_evidence',n.has_evidence,'evidence_updated_at',n.evidence_updated_at,'evidence_level',n.evidence_level,'operators',n.operators,'manual_priority',n.manual_priority),p.policy,p.version,operator_name)
,n.age_days,n.checked_days,n.available_days,n.lifetime_availability,n.node_group,n.provider_id,n.asn_label,n.exit_asn_org,
 n.org_label,n.name_variant,n.server_key,n.server_node_count,n.exit_org,n.exit_isp,n.exit_region,n.exit_ip_city
 FROM named n CROSS JOIN quality_policies p WHERE p.id=1;
$$;


-- The 0014 default gains the operator and server suffix.
UPDATE naming_rules SET template='{FLAG}{ROUTE}|{OPERATOR} {SEQ}{VARIANT}',updated_at=now()
 WHERE template='{FLAG}{ROUTE}|{ASN} {SEQ}';

-- Renumber per server (names change once with this release).
DELETE FROM node_names;
SELECT nodema_assign_names();
