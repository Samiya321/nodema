-- Numbers count up per landing country + ASN (entry no longer splits groups), and
-- never-tested nodes get no group number (their name falls back to the node ID).
-- Test requests can target specific nodes.

ALTER TABLE scan_requests ADD COLUMN node_ids uuid[],
 ADD CONSTRAINT ck_scan_requests_node_ids CHECK (node_ids IS NULL OR cardinality(node_ids) BETWEEN 1 AND 5000);

CREATE OR REPLACE FUNCTION nodema_assign_names() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE changed integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(current_schema()||':nodema-names',0));
 -- Nodes without any landing information are not numbered.
 DELETE FROM node_names nn USING nodes n LEFT JOIN node_current_status c ON c.node_id=n.id
  WHERE nn.node_id=n.id AND c.last_exit_country IS NULL AND c.last_exit_asn IS NULL;
 WITH current_keys AS (
   SELECT n.id AS node_id,n.short_id,c.last_exit_country AS exit_country,
     nodema_asn_label(c.last_exit_asn,c.last_exit_asn_org) AS asn_label
   FROM nodes n JOIN node_current_status c ON c.node_id=n.id
   WHERE c.last_exit_country IS NOT NULL OR c.last_exit_asn IS NOT NULL
 ), moved AS (
   SELECT k.* FROM current_keys k LEFT JOIN node_names nn ON nn.node_id=k.node_id
   WHERE nn.node_id IS NULL OR nn.entry_country IS NOT NULL
     OR ROW(nn.exit_country,nn.asn_label) IS DISTINCT FROM ROW(k.exit_country,k.asn_label)
 )
 INSERT INTO node_names AS target(node_id,entry_country,exit_country,asn_label,seq)
 SELECT m.node_id,NULL,m.exit_country,m.asn_label,
   coalesce((SELECT max(nn.seq) FROM node_names nn
     WHERE coalesce(nn.exit_country,'')=coalesce(m.exit_country,'')
       AND coalesce(nn.asn_label,'')=coalesce(m.asn_label,'')),0)
   + row_number() OVER (PARTITION BY coalesce(m.exit_country,''),coalesce(m.asn_label,'') ORDER BY m.short_id)
 FROM moved m
 ON CONFLICT (node_id) DO UPDATE SET entry_country=NULL,exit_country=excluded.exit_country,
   asn_label=excluded.asn_label,seq=excluded.seq,assigned_at=now();
 GET DIAGNOSTICS changed = ROW_COUNT;
 RETURN changed;
END;
$$;

-- One-time renumbering into the new groups (released the same day as 0014).
DELETE FROM node_names;
SELECT nodema_assign_names();
