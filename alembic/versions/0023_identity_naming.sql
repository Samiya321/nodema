-- Country metadata is not a measured physical route. Preserve raw observations.
ALTER TABLE node_current_status ADD COLUMN exit_observed_at timestamptz;
UPDATE node_current_status c SET exit_observed_at=(
 SELECT max(t.checked_at) FROM test_results t
 WHERE t.node_id=c.node_id AND t.exit_ip=c.last_exit_ip
   AND t.status IN ('UP','DEGRADED') AND t.checked_at<=c.last_checked_at
) WHERE c.last_exit_ip IS NOT NULL;

CREATE FUNCTION nodema_same_entry_exit(ips jsonb, ex text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF ex IS NULL OR jsonb_typeof(ips)<>'array' OR jsonb_array_length(ips)<>1 THEN RETURN false; END IF;
 RETURN coalesce((ips->>0)::inet=ex::inet,false);
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;

CREATE FUNCTION nodema_display_entry(entry text, ex text, ips jsonb, exit_ip text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN nodema_same_entry_exit(ips,exit_ip) AND ex IS NOT NULL THEN ex ELSE entry END;
$$;

-- Reject exact placeholders, not arbitrary personal/business names.
CREATE FUNCTION nodema_org_placeholder(org text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT lower(regexp_replace(coalesce(org,''),'[^a-zA-Z0-9]','','g')) IN
 ('private','privatecustomer','customer','unknown','reserved','notdisclosed','individual','na','none');
$$;

-- Public ASN records verified in docs/NAMING_AUDIT_2026_11_17.md. Never override USER.
INSERT INTO asn_labels(asn,label,origin) VALUES
 (141995,'Contabo','BUILTIN'),(40676,'Psychz','BUILTIN'),(3257,'GTT','BUILTIN'),
 (3356,'Lumen','BUILTIN'),(63150,'BAGE','BUILTIN')
ON CONFLICT (asn) DO UPDATE SET label=excluded.label,updated_at=now()
 WHERE asn_labels.origin='BUILTIN';

CREATE OR REPLACE VIEW nodema_name_keys AS
 SELECT k.*,nodema_org_label(k.ip_org,k.asn_label,k.asn_org) AS org_label FROM (
   SELECT n.id AS node_id,n.short_id,n.protocol,coalesce(c.last_exit_ip,'node:'||n.id) AS server_key,
     c.last_exit_country AS exit_country,i.org AS ip_org,
     coalesce(c.last_exit_asn_org,CASE WHEN i.as_number=c.last_exit_asn THEN i.as_org END) AS asn_org,
     nodema_asn_label(c.last_exit_asn,
       coalesce(c.last_exit_asn_org,CASE WHEN i.as_number=c.last_exit_asn THEN i.as_org END)) AS asn_label
   FROM nodes n JOIN node_current_status c ON c.node_id=n.id
   LEFT JOIN ip_info i ON i.ip=c.last_exit_ip AND i.status='SUCCESS'
   WHERE c.last_exit_country IS NOT NULL OR c.last_exit_asn IS NOT NULL
 ) k;

-- One row per node. Compact lists only include the bitset and observation time;
-- full node details expose evidence without repeating it across every list row.
-- Flags: 1=same IP; 2=country conflict; 4=ASN conflict; 8=historical/unconfirmed exit;
-- 16=unknown raw entry country. Missing retained observations stay unknown.
CREATE VIEW nodema_identity_info AS
 SELECT c.node_id,c.exit_observed_at,c.entry_country AS raw_entry_country,
   c.entry_asn AS raw_entry_asn,c.last_exit_country AS observed_exit_country,
   c.last_exit_asn AS observed_exit_asn,c.last_exit_asn_org AS observed_exit_org,
   t.geoip_metadata->'exit'->>'country' AS geolite_exit_country,
   t.geoip_metadata->'exit'->>'asn' AS geolite_exit_asn,
   t.geoip_metadata->'exit'->>'country_source' AS exit_country_source,
   t.geoip_metadata->'exit'->>'asn_source' AS exit_asn_source,
   i.country_code AS ipapi_country,i.as_number AS ipapi_asn,i.as_org AS ipapi_as_org,
   i.queried_at AS ipapi_queried_at,
   (CASE WHEN nodema_same_entry_exit(t.entry_ips,c.last_exit_ip) THEN 1 ELSE 0 END
   + CASE WHEN
       (nodema_same_entry_exit(t.entry_ips,c.last_exit_ip) AND c.entry_country<>c.last_exit_country)
       OR i.country_code<>c.last_exit_country
       OR (t.exit_ip=c.last_exit_ip AND t.geoip_metadata->'exit'->>'country'<>c.last_exit_country)
     THEN 2 ELSE 0 END
   + CASE WHEN i.as_number<>c.last_exit_asn
       OR (t.exit_ip=c.last_exit_ip AND t.geoip_metadata->'exit'->>'asn'<>c.last_exit_asn::text)
     THEN 4 ELSE 0 END
   + CASE WHEN c.last_exit_ip IS NOT NULL AND
       (c.exit_observed_at IS NULL OR c.exit_observed_at<c.last_checked_at) THEN 8 ELSE 0 END
   + CASE WHEN c.entry_country IS NULL AND NOT
       (nodema_same_entry_exit(t.entry_ips,c.last_exit_ip) AND c.last_exit_country IS NOT NULL)
     THEN 16 ELSE 0 END) AS flags
 FROM node_current_status c
 LEFT JOIN test_results t ON t.id=c.last_result_id
 LEFT JOIN ip_info i ON i.ip=c.last_exit_ip AND i.status='SUCCESS';
