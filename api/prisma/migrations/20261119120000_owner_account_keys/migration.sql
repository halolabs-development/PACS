-- Whose draft, hold, saved text, unsigned version, saved search, folder and reading template it is follows the account id
-- (sub), not the login string: an email may change, and an old email may later belong to another account.
-- - New nullable columns name the account beside the login string kept where it is: ReportDraft.authorSub (the draft's
--   record id stays [uid, author]), ReportVersion.authorSub (author keeps the login of the time; not part of the signed
--   row), Report.updatedBySub, StudyState.holderSub.
-- - UserFilter.owner, UserFilterCollection.owner and ReadingTemplate.owner hold the account id from now on.
-- Existing rows are filled from the member table: a stored login (the token's email, else its username, else its sub) names
-- an account only when exactly one member has it as email, username or account id. A row no member can be found for is left
-- as it is: kept, and nobody's (an unresolved live hold simply expires within its five minutes). A Preliminary designation
-- without an account is filled the same way.
BEGIN;
ALTER TABLE "ReportDraft" ADD COLUMN "authorSub" TEXT, ADD COLUMN "authorLogin" TEXT;
ALTER TABLE "ReportVersion" ADD COLUMN "authorSub" TEXT;
ALTER TABLE "Report" ADD COLUMN "updatedBySub" TEXT;
ALTER TABLE "StudyState" ADD COLUMN "holderSub" TEXT;

-- Choose the namespace once, while the old author strings are still available. Even a literal
-- legacy login resembling an account key, or retained work without a live draft, keeps its ID.
-- The installed function depends only on its argument, including after old work is destroyed.
DO $$
DECLARE prefix text := 'account/';
BEGIN
  WHILE EXISTS (SELECT 1 FROM "ReportDraft" WHERE starts_with(author, prefix)
                UNION ALL SELECT 1 FROM "ReportDraftPurposeEnd" WHERE starts_with(author, prefix)
                UNION ALL SELECT 1 FROM emr_access.access_target WHERE target_kind = 'private-draft'
                  AND strpos(record_id, ',"' || prefix) > 0) LOOP
    prefix := prefix || '/';
  END LOOP;
  EXECUTE format('CREATE FUNCTION draft_account_author(text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS %L',
                 format('SELECT %L || $1', prefix));
END $$;

-- Check the original namespace before discarding ambiguous logins. An unresolved owner equal to a
-- different account id would otherwise become visible to that account immediately after deployment.
DO $$
DECLARE collisions bigint;
BEGIN
  SELECT count(*) INTO collisions FROM "MemberRights" a
    JOIN "MemberRights" b ON a.username = b.sub AND a.sub <> b.sub;
  IF collisions > 0 THEN
    RAISE EXCEPTION 'Owner username / other account sub collisions: %', collisions;
  END IF;
END $$;

CREATE TEMPORARY TABLE owner_login_account ON COMMIT DROP AS
  SELECT login, min(sub) AS sub FROM (
    SELECT email AS login, sub FROM "MemberRights" WHERE email <> ''
    UNION SELECT username, sub FROM "MemberRights" WHERE username <> ''
    UNION SELECT sub, sub FROM "MemberRights") k
  GROUP BY login HAVING count(DISTINCT sub) = 1;

-- One account has at most one draft row per study: two rows of a study that resolve to one account stay unresolved.
UPDATE "ReportDraft" d SET "authorSub" = m.sub FROM owner_login_account m WHERE d.author = m.login AND NOT EXISTS (
  SELECT 1 FROM "ReportDraft" o JOIN owner_login_account n ON o.author = n.login WHERE o.uid = d.uid AND n.sub = m.sub AND o.author <> d.author);
UPDATE "ReportVersion" v SET "authorSub" = m.sub FROM owner_login_account m WHERE v.author = m.login;
UPDATE "Report" r SET "updatedBySub" = m.sub FROM owner_login_account m WHERE r."updatedBy" = m.login;
UPDATE "StudyState" s SET "holderSub" = m.sub FROM owner_login_account m WHERE s.holder = m.login;
UPDATE "StudyState" s SET "preDocSub" = m.sub FROM owner_login_account m WHERE s."preDocSub" IS NULL AND s."preDoc" = m.login;
UPDATE "StudyState" s SET "preReviewerSub" = m.sub FROM owner_login_account m WHERE s."preReviewerSub" IS NULL AND s."preReviewer" = m.login;
-- Resolve against the whole account, including rows already keyed by sub. Keep the newest row intact.
CREATE TEMP TABLE search_owner ON COMMIT DROP AS
  SELECT f.id, m.sub, f."isDefault", f."createdAt", first_value(f.id) OVER
    (PARTITION BY m.sub, f.name ORDER BY f."createdAt" DESC, f.id DESC) AS survivor
  FROM "UserFilter" f JOIN owner_login_account m ON m.login = f.owner;
CREATE UNIQUE INDEX ON search_owner(id);

-- Merge only this account's shortcuts. Missing own targets and shared targets are valid preferences.
CREATE TEMP TABLE collection_source ON COMMIT DROP AS
  SELECT m.sub, c.* FROM "UserFilterCollection" c JOIN owner_login_account m ON m.login = c.owner;
CREATE TEMP TABLE collection_entry ON COMMIT DROP AS
  SELECT c.sub, c.owner, kind, pos,
    CASE WHEN kind = 'folders' THEN entry->>'path' ELSE entry->>'id' END AS key,
    CASE WHEN s.id <> s.survivor THEN jsonb_set(entry, '{searchId}', to_jsonb('own:' || s.survivor))
         ELSE entry END AS item
  FROM collection_source c
  CROSS JOIN LATERAL (VALUES ('folders', c.folders), ('shortcuts', c.shortcuts)) AS list(kind, items)
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(items) = 'array' THEN items ELSE '[]' END)
    WITH ORDINALITY AS entries(entry, pos)
  LEFT JOIN search_owner s ON kind = 'shortcuts' AND s.sub = c.sub AND entry->>'searchId' = 'own:' || s.id;

DO $$
DECLARE conflicts bigint;
BEGIN
  SELECT count(DISTINCT sub) INTO conflicts FROM (
    SELECT sub FROM collection_source WHERE jsonb_typeof(folders) <> 'array' OR jsonb_typeof(shortcuts) <> 'array'
    UNION ALL
    SELECT sub FROM collection_entry GROUP BY sub, kind, key HAVING key IS NULL OR count(DISTINCT item) > 1
    UNION ALL
    SELECT sub FROM collection_entry GROUP BY sub, kind HAVING count(DISTINCT key) > 200
  ) bad;
  IF conflicts > 0 THEN
    RAISE EXCEPTION 'Unmergeable filter collection accounts: %', conflicts;
  END IF;
END $$;

-- Identical entries can share a key. Retain the array order from each input, with the account's existing list first.
CREATE TEMP TABLE merged_collection ON COMMIT DROP AS
  WITH first_entry AS (
    SELECT DISTINCT ON (sub, kind, key) * FROM collection_entry
    ORDER BY sub, kind, key, (owner = sub) DESC, owner, pos
  ), lists AS (
    SELECT sub, kind, jsonb_agg(item ORDER BY (owner = sub) DESC, owner, pos) AS items
    FROM first_entry GROUP BY sub, kind
  ), accounts AS (
    SELECT sub, max(revision) + CASE WHEN count(*) > 1 OR EXISTS (
      SELECT 1 FROM search_owner s WHERE s.sub = c.sub AND s.id <> s.survivor
    ) THEN 1 ELSE 0 END AS revision
    FROM collection_source c GROUP BY sub
  )
  SELECT a.sub, a.revision, coalesce(f.items, '[]') AS folders, coalesce(k.items, '[]') AS shortcuts
  FROM accounts a LEFT JOIN lists f ON f.sub = a.sub AND f.kind = 'folders'
                  LEFT JOIN lists k ON k.sub = a.sub AND k.kind = 'shortcuts';

DELETE FROM "UserFilterCollection" c USING collection_source s WHERE c.owner = s.owner AND c.owner <> s.sub;
INSERT INTO "UserFilterCollection" (owner, revision, folders, shortcuts)
  SELECT sub, revision, folders, shortcuts FROM merged_collection
  ON CONFLICT (owner) DO UPDATE SET revision = excluded.revision, folders = excluded.folders, shortcuts = excluded.shortcuts;

DO $$
DECLARE removed bigint;
BEGIN
  DELETE FROM "UserFilter" f USING search_owner s WHERE f.id = s.id AND s.id <> s.survivor;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE LOG 'Duplicate owner searches removed: %', removed;
END $$;
UPDATE "UserFilter" f SET owner = s.sub FROM search_owner s WHERE f.id = s.id AND f.owner <> s.sub;
-- A default names a search. If its id was removed, transfer that choice to the surviving id.
WITH defaults AS (
  SELECT DISTINCT ON (sub) sub, survivor FROM search_owner WHERE "isDefault"
  ORDER BY sub, "createdAt" DESC, id DESC
)
UPDATE "UserFilter" f SET "isDefault" = (f.id = d.survivor)
  FROM defaults d WHERE f.owner = d.sub AND f."isDefault" <> (f.id = d.survivor);
UPDATE "ReadingTemplate" t SET owner = m.sub FROM owner_login_account m WHERE t.owner = m.login AND t.owner <> m.sub;

CREATE UNIQUE INDEX "ReportDraft_uid_authorSub_key" ON "ReportDraft"("uid", "authorSub");
COMMIT;
