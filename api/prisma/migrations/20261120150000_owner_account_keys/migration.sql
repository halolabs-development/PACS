-- Legacy record keys and display strings stay in place. Only the installer supplies
-- the reviewed history (prisma/owner-upgrade.mjs). A current directory is not a history.
BEGIN;
LOCK TABLE "MemberRights" IN SHARE MODE;
ALTER TABLE "ReportDraft" ADD COLUMN "authorSub" TEXT, ADD COLUMN "authorLogin" TEXT;
ALTER TABLE "ReportVersion" ADD COLUMN "authorSub" TEXT;
ALTER TABLE "Report" ADD COLUMN "updatedBySub" TEXT;
ALTER TABLE "StudyState" ADD COLUMN "holderSub" TEXT;
ALTER TABLE "UserFilter" ADD COLUMN "ownerSub" TEXT;
ALTER TABLE "UserFilterCollection" ADD COLUMN "ownerSub" TEXT;
ALTER TABLE "ReadingTemplate" ADD COLUMN "ownerSub" TEXT;

-- Choose the namespace once, while the old author strings are still available. Even a literal
-- legacy login resembling an account key, or retained work without a live draft, keeps its ID.
-- The installed function depends only on its argument, including after old work is destroyed.
DO $$
DECLARE prefix text := 'account/';
BEGIN
  WHILE EXISTS (SELECT 1 FROM "ReportDraft" WHERE starts_with(author, prefix)
                UNION ALL SELECT 1 FROM "UserFilter" WHERE starts_with(owner, prefix)
                UNION ALL SELECT 1 FROM "UserFilterCollection" WHERE starts_with(owner, prefix)
                UNION ALL SELECT 1 FROM "ReportDraftPurposeEnd" WHERE starts_with(author, prefix)
                UNION ALL SELECT 1 FROM emr_access.access_target WHERE target_kind = 'private-draft'
                  AND strpos(record_id, ',"' || prefix) > 0) LOOP
    prefix := prefix || '/';
  END LOOP;
  EXECUTE format('CREATE FUNCTION draft_account_author(text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS %L',
                 format('SELECT %L || $1', prefix));
END $$;

-- The read-only preflight executes the same SELECT. Include empty owner slots so
-- the report also detects removal of a row which never named a holder or writer.
CREATE TEMPORARY TABLE owner_plan ON COMMIT DROP AS
-- BEGIN owner plan
WITH history AS (
  SELECT nullif(current_setting('pacs.owner_history', true), '')::jsonb AS input
), directory AS (
  SELECT login, min(sub) AS sub FROM (
    SELECT sub, email AS login FROM "MemberRights"
    UNION SELECT sub, username FROM "MemberRights"
    UNION SELECT sub, sub FROM "MemberRights"
  ) candidates WHERE login <> '' GROUP BY login HAVING count(*) = 1
), slots(relation, field, id, login, actual, study) AS (
  SELECT 'ReportDraft', 'author', jsonb_build_array(t.uid,t.author)::text, t."author", to_jsonb(t)->>'authorSub', t.uid FROM "ReportDraft" t
  UNION ALL
  SELECT 'ReportVersion', 'author', t.id::text, t."author", to_jsonb(t)->>'authorSub', NULL::text FROM "ReportVersion" t
  UNION ALL
  SELECT 'Report', 'updatedBy', t.uid, t."updatedBy", to_jsonb(t)->>'updatedBySub', NULL::text FROM "Report" t
  UNION ALL
  SELECT 'StudyState', 'holder', t.uid, t."holder", to_jsonb(t)->>'holderSub', NULL::text FROM "StudyState" t
  UNION ALL
  SELECT 'StudyState', 'preDoc', t.uid, t."preDoc", t."preDocSub", NULL::text FROM "StudyState" t
  UNION ALL
  SELECT 'StudyState', 'preReviewer', t.uid, t."preReviewer", t."preReviewerSub", NULL::text FROM "StudyState" t
  UNION ALL
  SELECT 'UserFilter', 'owner', t.id::text, t."owner", to_jsonb(t)->>'ownerSub', NULL::text FROM "UserFilter" t
  UNION ALL
  SELECT 'UserFilterCollection', 'owner', t.owner, t."owner", to_jsonb(t)->>'ownerSub', NULL::text FROM "UserFilterCollection" t
  UNION ALL
  SELECT 'ReadingTemplate', 'owner', t.id::text, t."owner", to_jsonb(t)->>'ownerSub', NULL::text FROM "ReadingTemplate" t
), resolved AS (
  SELECT slots.*, CASE
    WHEN actual IS NOT NULL THEN actual
    WHEN input->'aliases' ? login_hash THEN input->'aliases'->>login_hash
    WHEN input->>'unlisted' = 'unchanged' THEN directory.sub
  END AS candidate
  FROM slots CROSS JOIN history
  CROSS JOIN LATERAL (SELECT encode(sha256(convert_to(login,'UTF8')), 'hex') AS login_hash) h
  LEFT JOIN directory USING (login)
)
SELECT relation, field, id, login, actual,
  CASE WHEN study IS NOT NULL AND count(*) OVER (PARTITION BY study, candidate, relation) > 1
       THEN NULL ELSE candidate END AS expected
FROM resolved
-- END owner plan
;

DO $$
DECLARE input jsonb := nullif(current_setting('pacs.owner_history', true), '')::jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM owner_plan WHERE login IS NOT NULL AND actual IS NULL)
     AND (input IS NULL OR NOT coalesce(input->>'unlisted' IN ('unchanged', 'unknown')
                                   AND jsonb_typeof(input->'aliases') = 'object', false)) THEN
    RAISE EXCEPTION 'Review historical logins with prisma/owner-upgrade.mjs before upgrading';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(input->'aliases') a
             WHERE a.key !~ '^[0-9a-f]{64}$' OR (a.value <> 'null' AND
               (jsonb_typeof(a.value) <> 'string' OR a.value = '""'))) THEN
    RAISE EXCEPTION 'Invalid historical login mapping';
  END IF;
END $$;

CREATE INDEX ON owner_plan(relation, field);
ANALYZE owner_plan;
UPDATE "ReportDraft" t SET "authorSub" = p.expected FROM owner_plan p
WHERE p.relation = 'ReportDraft' AND p.field = 'author' AND p.id = jsonb_build_array(t.uid,t.author)::text AND p.expected IS NOT NULL AND t."authorSub" IS NULL;
UPDATE "ReportVersion" t SET "authorSub" = p.expected FROM owner_plan p
WHERE p.relation = 'ReportVersion' AND p.field = 'author' AND p.id = t.id::text AND p.expected IS NOT NULL AND t."authorSub" IS NULL;
UPDATE "Report" t SET "updatedBySub" = p.expected FROM owner_plan p
WHERE p.relation = 'Report' AND p.field = 'updatedBy' AND p.id = t.uid AND p.expected IS NOT NULL AND t."updatedBySub" IS NULL;
UPDATE "StudyState" t SET "holderSub" = p.expected FROM owner_plan p
WHERE p.relation = 'StudyState' AND p.field = 'holder' AND p.id = t.uid AND p.expected IS NOT NULL AND t."holderSub" IS NULL;
UPDATE "StudyState" t SET "preDocSub" = p.expected FROM owner_plan p
WHERE p.relation = 'StudyState' AND p.field = 'preDoc' AND p.id = t.uid AND p.expected IS NOT NULL AND t."preDocSub" IS NULL;
UPDATE "StudyState" t SET "preReviewerSub" = p.expected FROM owner_plan p
WHERE p.relation = 'StudyState' AND p.field = 'preReviewer' AND p.id = t.uid AND p.expected IS NOT NULL AND t."preReviewerSub" IS NULL;
UPDATE "UserFilter" t SET "ownerSub" = p.expected FROM owner_plan p
WHERE p.relation = 'UserFilter' AND p.field = 'owner' AND p.id = t.id::text AND p.expected IS NOT NULL AND t."ownerSub" IS NULL;
UPDATE "UserFilterCollection" t SET "ownerSub" = p.expected FROM owner_plan p
WHERE p.relation = 'UserFilterCollection' AND p.field = 'owner' AND p.id = t.owner AND p.expected IS NOT NULL AND t."ownerSub" IS NULL;
UPDATE "ReadingTemplate" t SET "ownerSub" = p.expected FROM owner_plan p
WHERE p.relation = 'ReadingTemplate' AND p.field = 'owner' AND p.id = t.id::text AND p.expected IS NOT NULL AND t."ownerSub" IS NULL;
CREATE UNIQUE INDEX "ReportDraft_uid_authorSub_key" ON "ReportDraft"("uid", "authorSub");
CREATE INDEX "UserFilter_ownerSub_idx" ON "UserFilter"("ownerSub");
CREATE INDEX "UserFilterCollection_ownerSub_idx" ON "UserFilterCollection"("ownerSub");
CREATE INDEX "ReadingTemplate_ownerSub_idx" ON "ReadingTemplate"("ownerSub");
COMMIT;
