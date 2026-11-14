-- 0020: nodes that share one credential (VLESS/VMess UUID, or the password of the
-- password protocols) on at least 5 nodes across at least 2 servers belong to one
-- operator, so they count as airport nodes even when their source carries no
-- airport headers (user decision 2026-11-14). The key is an MD5 of the credential
-- (computed the same way by app/ingestion credential_key); the database already
-- keeps configs in plaintext, the key only makes grouping cheap.
ALTER TABLE nodes ADD COLUMN credential_key text CHECK (credential_key ~ '^[0-9a-f]{32}$');
UPDATE nodes n SET credential_key = CASE WHEN coalesce(c.value,'')='' THEN NULL ELSE md5(c.prefix || c.value) END
FROM (SELECT id,
   CASE WHEN protocol IN ('vless','vmess') THEN 'uuid:' ELSE 'pw:' END AS prefix,
   CASE WHEN protocol IN ('vless','vmess') THEN lower(convert_from(config_data,'UTF8')::jsonb->>'uuid')
     ELSE convert_from(config_data,'UTF8')::jsonb->>'password' END AS value
 FROM nodes) c
WHERE c.id=n.id;
CREATE INDEX idx_nodes_credential ON nodes(credential_key, server_host) WHERE credential_key IS NOT NULL;

-- The flag is stored, not computed in the view: grouping 40k nodes inside every
-- catalog query made the 10k-row list 25x slower (rehearsal on a production copy).
-- Ingestion calls the function whenever it creates nodes.
ALTER TABLE nodes ADD COLUMN credential_shared boolean NOT NULL DEFAULT false;
CREATE FUNCTION nodema_mark_shared_credentials() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE changed integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('nodema_shared_credentials'));
 WITH shared AS (
   SELECT credential_key FROM nodes WHERE credential_key IS NOT NULL
   GROUP BY credential_key HAVING count(*)>=5 AND count(DISTINCT server_host)>=2
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

CREATE OR REPLACE VIEW nodema_node_scope AS
 SELECT n.id AS node_id,
  CASE WHEN a.airport OR n.credential_shared THEN 'AIRPORT' ELSE 'SELF_HOSTED' END AS node_group,
  (n.enabled AND (NOT a.airport OR a.usable)) AS eligible,
  a.provider_id,
  (n.credential_shared AND NOT a.airport) AS credential_shared
 FROM nodes n CROSS JOIN LATERAL (
  SELECT coalesce(bool_or(true),false) AS airport,
   coalesce(bool_or(nodema_source_usable(s.enabled,s.deleted_at,s.expires_at,
     s.traffic_upload,s.traffic_download,s.traffic_total)),false) AS usable,
   (array_agg(s.provider_id ORDER BY (s.deleted_at IS NULL) DESC, s.created_at)
     FILTER (WHERE s.provider_id IS NOT NULL))[1] AS provider_id
  FROM node_sources ns JOIN sources s ON s.id=ns.source_id
  WHERE ns.node_id=n.id AND nodema_source_kind(s.kind,s.detected_kind)='AIRPORT'
 ) a;
