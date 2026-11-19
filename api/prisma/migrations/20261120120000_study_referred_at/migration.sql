-- Worklist Referred: when the referring hospital's Gateway first announced the study (our server's time), written once by
-- the first successful announce and never changed. Additive: one nullable column. A study the Gateway announce created
-- (origin 'gateway') was created by that announce, so its creation time is that moment exactly and is copied; every other
-- row stays NULL (no announce recorded - a study first registered otherwise and announced before this column existed has
-- no stored time to copy). No CHECK, index, key or grant changes (the runtime's table grants cover new columns).
BEGIN;
ALTER TABLE "StudyState" ADD COLUMN "referredAt" TIMESTAMP(3);
UPDATE "StudyState" SET "referredAt" = "createdAt" WHERE "origin" = 'gateway';
COMMIT;
