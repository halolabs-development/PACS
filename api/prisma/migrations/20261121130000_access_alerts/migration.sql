-- Access Alerts: which access ledger entries are a member opening a study, for one institution and period.
-- The admin console counts them per account and looks for many different studies in a short time (api/src/access-alerts.ts).
-- This function is the one place that decides what counts as opening a study. Same scope as review_entries: the
-- institution recorded as managing at the time, occurred_at in [p_from, p_until), one event per event_id (a pair of
-- stream copies is one event). Counted, each only when the member caused it ('user-view') and the account is known:
--  * the first image delivery of an opening (kind 'image', provide-prepared; later deliveries are background fetches);
--  * the same-patient viewing set the person opened or compared (POST studies/viewing-set/resolve, study-metadata);
--  * a report body provided on its own: the clinician's single report (report-version) and the report preview
--    (report-head / report-version / private-draft);
--  * the browser's report that it displayed a report version or its evidence (client-shown).
-- Not counted: worklist and bootstrap lists, related-study lists, thumbnails and preloads, writes, downloads and their
-- follow-ups, sign-in events and audit reads (an audit target may name a study too).
-- Returns one row per counted (event, study); at most p_cap + 1 rows, so the caller can refuse an oversized period.
-- The ledger rows and the grants of the existing functions are untouched.
BEGIN;
SET LOCAL ROLE kin_emr_owner;
CREATE FUNCTION emr_access.alert_entries(p_institution text, p_from timestamptz, p_until timestamptz, p_cap integer)
RETURNS TABLE(entry_id uuid, sequence bigint, event_id text, occurred_at timestamptz, account text, study_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH scoped AS MATERIALIZED (
    SELECT e.entry_id, e.sequence, e.event_id, e.occurred_at, p.event
    FROM emr_access.access_entry e
    CROSS JOIN LATERAL (SELECT e.payload::jsonb AS event OFFSET 0) p
    WHERE e.occurred_at >= p_from AND e.occurred_at < p_until
      AND p.event #>> '{managingInstitution,status}' = 'known'
      AND p.event #>> '{managingInstitution,value}' = p_institution
      AND p.event->>'cause' = 'user-view' AND p.event->>'executor' = 'member'
      AND p.event #>> '{userId,status}' = 'known'
      AND p.event->>'action' IN ('provide-prepared', 'client-shown')
      AND p_cap > 0
  ), events AS (
    SELECT DISTINCT ON (s.event_id) s.* FROM scoped s ORDER BY s.event_id, s.sequence
  ), opened AS (
    SELECT DISTINCT ev.entry_id, ev.sequence, ev.event_id, ev.occurred_at,
      jsonb_build_array(ev.event #>> '{userId,value,id}', ev.event #>> '{userId,value,issuer}',
        ev.event #>> '{userId,value,subject}')::text AS account,
      t #>> '{studyId,value}' AS study_id
    FROM events ev
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ev.event->'targets') = 'array'
      THEN ev.event->'targets' ELSE '[]'::jsonb END) t
    WHERE t #>> '{studyId,status}' = 'known' AND COALESCE(t #>> '{studyId,value}', '') <> ''
      AND ((ev.event->>'action' = 'provide-prepared' AND (
            t->>'kind' = 'image'
            OR (ev.event->>'surface' = 'POST studies/viewing-set/resolve' AND t->>'kind' = 'study-metadata')
            OR (ev.event->>'surface' = 'GET clinician/studies/:uid/report' AND t->>'kind' = 'report-version')
            OR (ev.event->>'surface' = 'GET studies/:uid/report-preview'
                AND t->>'kind' IN ('report-head', 'report-version', 'private-draft'))))
        OR (ev.event->>'action' = 'client-shown' AND t->>'kind' IN ('report-version', 'report-evidence')))
  )
  SELECT o.entry_id, o.sequence, o.event_id, o.occurred_at, o.account, o.study_id FROM opened o
  ORDER BY o.account, o.occurred_at, o.sequence, o.study_id
  LIMIT GREATEST(p_cap, 0) + 1
$$;
RESET ROLE;
REVOKE ALL ON FUNCTION emr_access.alert_entries(text,timestamptz,timestamptz,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emr_access.alert_entries(text,timestamptz,timestamptz,integer) TO kin_runtime;
COMMIT;
