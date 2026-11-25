ALTER TABLE nodes
 ADD COLUMN classification_override text CONSTRAINT ck_nodes_classification_override
   CHECK (classification_override IN ('SELF_HOSTED','AIRPORT')),
 ADD COLUMN classification_note text CONSTRAINT ck_nodes_classification_note
   CHECK (char_length(classification_note)<=160),
 ADD COLUMN classification_updated_at timestamptz;

CREATE VIEW nodema_node_classification AS
 SELECT n.id AS node_id,
  coalesce(n.classification_override,
    CASE WHEN a.airport OR n.credential_shared THEN 'AIRPORT' ELSE 'SELF_HOSTED' END) AS node_group,
  (n.enabled AND (n.classification_override IS NOT DISTINCT FROM 'SELF_HOSTED' OR NOT a.airport OR a.usable)) AS eligible,
  CASE WHEN n.classification_override='SELF_HOSTED' THEN NULL ELSE a.provider_id END AS provider_id,
  (n.classification_override IS NULL AND n.credential_shared AND NOT a.airport) AS credential_shared,
  CASE WHEN n.classification_override IS NOT NULL THEN 'MANUAL'
       WHEN a.current_airport THEN 'AIRPORT_SOURCE'
       WHEN a.airport THEN 'HISTORICAL_AIRPORT'
       WHEN n.credential_shared THEN 'SHARED_CREDENTIAL'
       ELSE 'UNCONFIRMED' END AS classification_basis,
  n.classification_override,n.classification_note,n.classification_updated_at
 FROM nodes n CROSS JOIN LATERAL (
  SELECT count(*)>0 AS airport,
   coalesce(bool_or(ns.is_present AND s.deleted_at IS NULL),false) AS current_airport,
   coalesce(bool_or(ns.is_present AND nodema_source_usable(s.enabled,s.deleted_at,s.expires_at,
     s.traffic_upload,s.traffic_download,s.traffic_total)),false) AS usable,
   (array_agg(s.provider_id ORDER BY (ns.is_present AND s.deleted_at IS NULL) DESC,
     (s.deleted_at IS NULL) DESC, s.created_at, s.id)
     FILTER (WHERE s.provider_id IS NOT NULL))[1] AS provider_id
  FROM node_sources ns JOIN sources s ON s.id=ns.source_id
  WHERE ns.node_id=n.id AND nodema_source_kind(s.kind,s.detected_kind)='AIRPORT'
 ) a;

CREATE OR REPLACE VIEW nodema_node_scope AS
 SELECT node_id,node_group,eligible,provider_id,credential_shared FROM nodema_node_classification;

CREATE FUNCTION nodema_set_node_classification(nid uuid, chosen text, reason text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE previous nodes%ROWTYPE;
BEGIN
 IF chosen IS NOT NULL AND chosen NOT IN ('SELF_HOSTED','AIRPORT') THEN
   RETURN 'INVALID_NODE_CLASSIFICATION';
 END IF;
 IF reason IS NOT NULL AND (chosen IS NULL OR char_length(reason)>160
      OR reason ~ '[[:cntrl:]]' OR position('://' in reason)>0) THEN
   RETURN 'INVALID_NODE_CLASSIFICATION';
 END IF;
 reason := nullif(btrim(reason),'');
 SELECT * INTO previous FROM nodes WHERE id=nid FOR UPDATE;
 IF NOT FOUND THEN RETURN 'NODE_NOT_FOUND'; END IF;
 IF ROW(previous.classification_override,previous.classification_note)
   IS NOT DISTINCT FROM ROW(chosen,reason) THEN RETURN 'UNCHANGED'; END IF;
 UPDATE nodes SET classification_override=chosen,classification_note=reason,
   classification_updated_at=now() WHERE id=nid;
 RETURN 'UPDATED';
END;
$$;
