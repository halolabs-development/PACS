-- Access Review answers a day or a week of entries instead of timing out.
-- Same signature, rows, order and snapshot_top as 20261025120000_access_review; only the query plan changes:
--  * the window ceiling (max sequence of the scoped rows) is computed once. Referenced once, it was inlined
--    into a nested loop and re-aggregated for every scoped row: time grew with the square of the rows in the window;
--  * each row's payload is parsed once (LATERAL ... OFFSET 0, as investigation_entries does), not three times;
--  * the DISTINCT ON sort carries the row keys, not the payload; the served page is read back by entry_id.
-- The ledger rows, their order and the grants are untouched.
BEGIN;
SET LOCAL ROLE kin_emr_owner;
CREATE OR REPLACE FUNCTION emr_access.review_entries(p_institution text, p_from timestamptz, p_until timestamptz,
  p_files boolean, p_top bigint, p_before bigint, p_limit integer)
RETURNS TABLE(entry_id uuid, sequence bigint, event_id text, occurred_at timestamptz,
  recorded_at timestamptz, statutory_act text, payload text, snapshot_top bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH scoped AS MATERIALIZED (
    SELECT e.entry_id, e.sequence, e.event_id,
      (NOT p_files OR p.event->>'action' IN ('download','pdf','copy','disclosure')
        OR p.event->>'surface' LIKE '%original-downloads%'
        OR EXISTS (SELECT FROM jsonb_array_elements(p.event->'targets') t
          WHERE t->>'kind' IN ('download','pdf','copy','disclosure'))) AS wanted
    FROM emr_access.access_entry e
    CROSS JOIN LATERAL (SELECT e.payload::jsonb AS event OFFSET 0) p
    WHERE e.occurred_at >= p_from AND e.occurred_at < p_until
      AND p.event #>> '{managingInstitution,status}' = 'known'
      AND p.event #>> '{managingInstitution,value}' = p_institution
      AND (p_top IS NULL OR e.sequence <= p_top)
      AND p_limit > 0
  ), ceiling AS MATERIALIZED (
    -- Over every scoped row, before the file filter: the continuation pins this top.
    SELECT COALESCE(p_top, max(s.sequence), 0) AS top FROM scoped s
  ), events AS (
    -- Keep a history entry if its viewing copy has expired; a pair is one event.
    SELECT DISTINCT ON (s.event_id) s.entry_id, s.sequence FROM scoped s
    WHERE s.wanted
    ORDER BY s.event_id, s.sequence
  ), page AS (
    SELECT ev.entry_id FROM events ev
    WHERE (p_before IS NULL OR ev.sequence < p_before)
    ORDER BY ev.sequence DESC LIMIT GREATEST(p_limit, 0)
  )
  SELECT e.entry_id, e.sequence, e.event_id, e.occurred_at, e.recorded_at, e.statutory_act, e.payload, c.top
  FROM page pg JOIN emr_access.access_entry e ON e.entry_id = pg.entry_id CROSS JOIN ceiling c
  ORDER BY e.sequence DESC
$$;
RESET ROLE;
REVOKE ALL ON FUNCTION emr_access.review_entries(text,timestamptz,timestamptz,boolean,bigint,bigint,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emr_access.review_entries(text,timestamptz,timestamptz,boolean,bigint,bigint,integer) TO kin_runtime;
COMMIT;
