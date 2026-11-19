-- Whose draft, hold, saved text, unsigned version, saved search, folder and reading template it is follows the account id
-- (sub), not the login string: an email may change, and an old email may later belong to another account.
-- - New nullable columns name the account beside the login string kept where it is: ReportDraft.authorSub (the draft's
--   record id stays [uid, author]), ReportVersion.authorSub (author keeps the login of the time; not part of the signed
--   row), Report.updatedBySub, StudyState.holderSub.
-- - UserFilter.owner, UserFilterCollection.owner and ReadingTemplate.owner hold the account id from now on.
-- Existing rows are filled from the member table: a stored login (the token's email, else its username, else its sub) names
-- an account only when exactly one member has it as email, username or account id. A row no member can be found for is left
-- as it is: kept, and nobody's (an unresolved live hold simply expires within its five minutes). A Preliminary designation
-- without an account is filled the same way. No CHECK, key or grant changes beyond one unique index (the runtime's table
-- grants cover new columns).
BEGIN;
ALTER TABLE "ReportDraft" ADD COLUMN "authorSub" TEXT;
ALTER TABLE "ReportVersion" ADD COLUMN "authorSub" TEXT;
ALTER TABLE "Report" ADD COLUMN "updatedBySub" TEXT;
ALTER TABLE "StudyState" ADD COLUMN "holderSub" TEXT;

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
-- The owner key moves to the account id only where that account has no row under its id already and no other old key of
-- that account moves too (two keys never merge).
UPDATE "UserFilterCollection" f SET owner = m.sub FROM owner_login_account m
  WHERE f.owner = m.login AND f.owner <> m.sub AND NOT EXISTS (SELECT 1 FROM "UserFilterCollection" x WHERE x.owner = m.sub)
  AND NOT EXISTS (SELECT 1 FROM "UserFilterCollection" y JOIN owner_login_account n ON y.owner = n.login WHERE n.sub = m.sub AND y.owner <> f.owner);
UPDATE "UserFilter" f SET owner = m.sub FROM owner_login_account m
  WHERE f.owner = m.login AND f.owner <> m.sub AND NOT EXISTS (SELECT 1 FROM "UserFilter" x WHERE x.owner = m.sub)
  AND NOT EXISTS (SELECT 1 FROM "UserFilter" y JOIN owner_login_account n ON y.owner = n.login WHERE n.sub = m.sub AND y.owner <> f.owner);
UPDATE "ReadingTemplate" f SET owner = m.sub FROM owner_login_account m
  WHERE f.owner = m.login AND f.owner <> m.sub AND NOT EXISTS (SELECT 1 FROM "ReadingTemplate" x WHERE x.owner = m.sub)
  AND NOT EXISTS (SELECT 1 FROM "ReadingTemplate" y JOIN owner_login_account n ON y.owner = n.login WHERE n.sub = m.sub AND y.owner <> f.owner);

CREATE UNIQUE INDEX "ReportDraft_uid_authorSub_key" ON "ReportDraft"("uid", "authorSub");
COMMIT;
