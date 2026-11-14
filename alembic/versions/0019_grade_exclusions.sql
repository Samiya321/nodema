-- 0019: a currently available node without a grade row is "not graded" (NULL), not
-- PENDING. Refresh writes a row (PENDING or a letter) for every gradable node; nodes
-- landing on an excluded network (Cloudflare, AS13335) get none and so drop out of
-- grade filters, sorts by grade and best-per-server choices.
CREATE OR REPLACE FUNCTION nodema_effective_grade(status text,grade text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN status IN ('UP','DEGRADED') THEN grade END;
$$;
