-- QC Flag: a technician's image quality mark on a study, with its reason. Additive only: every existing row reads as not
-- flagged (reason, author and time NULL) at revision 0. The revision rises by one on every mark, change and clear and is
-- never lowered; the history of the changes is the AuditLog. No CHECK, index, key or grant changes (the runtime's table
-- grants cover new columns).
BEGIN;
ALTER TABLE "StudyState" ADD COLUMN "qcReason" VARCHAR(500);
ALTER TABLE "StudyState" ADD COLUMN "qcBy" TEXT;
ALTER TABLE "StudyState" ADD COLUMN "qcAt" TIMESTAMP(3);
ALTER TABLE "StudyState" ADD COLUMN "qcRevision" INTEGER NOT NULL DEFAULT 0;
COMMIT;
