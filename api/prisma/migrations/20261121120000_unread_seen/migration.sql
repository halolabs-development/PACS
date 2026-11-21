-- In-app unread marks: the revision of a question thread or an image request a person's screen last showed them, kept by
-- the server so another PC or tab of the same account shows the same unread count. Additive only: two new tables, no
-- backfill, nothing existing changes. One row per item and person (subjectSub); a write only raises the revision, so a
-- repeated or late write changes nothing. No text, no patient field. A row goes with its item (CASCADE): it is that
-- person's reading state, not a record of the item. The runtime role's table rights come from the EMR-B1 default
-- privileges of schema public.
BEGIN;
CREATE TABLE "StudyQuestionSeen" (
  "questionId" UUID NOT NULL,
  "subjectSub" VARCHAR(256) NOT NULL,
  "revision" INTEGER NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StudyQuestionSeen_pkey" PRIMARY KEY ("questionId", "subjectSub"),
  CONSTRAINT "StudyQuestionSeen_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "StudyQuestion"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "StudyQuestionSeen_revision_check" CHECK ("revision" > 0 AND length("subjectSub") > 0)
);
CREATE TABLE "StudyImageRequestSeen" (
  "imageRequestId" UUID NOT NULL,
  "subjectSub" VARCHAR(256) NOT NULL,
  "revision" INTEGER NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StudyImageRequestSeen_pkey" PRIMARY KEY ("imageRequestId", "subjectSub"),
  CONSTRAINT "StudyImageRequestSeen_imageRequestId_fkey" FOREIGN KEY ("imageRequestId") REFERENCES "StudyImageRequest"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "StudyImageRequestSeen_revision_check" CHECK ("revision" > 0 AND length("subjectSub") > 0)
);
COMMIT;
