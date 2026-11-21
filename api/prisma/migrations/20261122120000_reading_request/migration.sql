-- Reading request: a clinician of the owning institution asks for a study to be read. Additive only: five nullable columns,
-- every existing row reads as never requested (all NULL). The latest request of a study is open while readingRequestAt is
-- set and readingRequestClosedAt is NULL; the approval of the report row the study opens on closes it in that approval's
-- transaction. The history of requests is the AuditLog (`study.reading-request`). No CHECK, index, key or grant changes (the
-- runtime's table grants cover new columns).
BEGIN;
ALTER TABLE "StudyState" ADD COLUMN "readingRequestAt" TIMESTAMP(3);
ALTER TABLE "StudyState" ADD COLUMN "readingRequestBySub" VARCHAR(256);
ALTER TABLE "StudyState" ADD COLUMN "readingRequestBy" VARCHAR(256);
ALTER TABLE "StudyState" ADD COLUMN "readingRequestByName" VARCHAR(256);
ALTER TABLE "StudyState" ADD COLUMN "readingRequestClosedAt" TIMESTAMP(3);
COMMIT;
