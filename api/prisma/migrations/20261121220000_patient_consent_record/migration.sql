-- A patient's consent for a stated purpose, recorded by a hospital administrator, kept in the same table as the
-- per-study transfer basis. A patient row has no study (studyUid NULL) and names the patient by the exact original
-- Patient ID within its institution; a study row stays exactly as before. A patient row is never transfer evidence:
-- opening a transfer requires a basis of the same study. Existing rows are not changed.
ALTER TABLE "TransferBasis" ALTER COLUMN "studyUid" DROP NOT NULL;
ALTER TABLE "TransferBasis" ADD COLUMN "patientId" VARCHAR(64);
ALTER TABLE "TransferBasis" ADD COLUMN "purpose" VARCHAR(500);
-- The screen's request id and the recording account's fixed id: a lost answer is retried with the same request id and
-- returns the same row.
ALTER TABLE "TransferBasis" ADD COLUMN "requestId" UUID;
ALTER TABLE "TransferBasis" ADD COLUMN "recordedBySub" TEXT;
ALTER TABLE "TransferBasis" ADD CONSTRAINT "TransferBasis_subject_check" CHECK (
  ("studyUid" IS NOT NULL AND "patientId" IS NULL AND "purpose" IS NULL AND "requestId" IS NULL AND "recordedBySub" IS NULL)
  OR ("studyUid" IS NULL AND "kind" = 'PATIENT_CONSENT'
    AND "patientId" IS NOT NULL AND length(btrim("patientId")) > 0
    AND "purpose" IS NOT NULL AND length(btrim("purpose")) > 0
    AND "requestId" IS NOT NULL AND "recordedBySub" IS NOT NULL AND length("recordedBySub") > 0)
);
CREATE INDEX "TransferBasis_institutionId_patientId_id_idx" ON "TransferBasis"("institutionId", "patientId", "id");
CREATE UNIQUE INDEX "TransferBasis_institutionId_recordedBySub_requestId_key" ON "TransferBasis"("institutionId", "recordedBySub", "requestId");
