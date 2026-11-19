-- Worklist Referred: when the referring hospital's Gateway first announced the study (our server's time), written once by
-- the first successful announce of the row and never changed. Additive: two columns, read together as three states -
--   (NULL, open)    the row still waits for its first announce;
--   (time, closed)  recorded;
--   (NULL, closed)  stays blank: whether a later announce would be the first is not known.
-- Every row that exists now is closed in this one transaction. A row the Gateway announce created (origin 'gateway') was
-- created by that announce, so its creation time is that moment exactly and is copied. Every other existing row keeps
-- NULL: it may have been announced before the time was kept, so a later retry must not be recorded as its first.
-- "referredOpen" is added as false, which is what every existing row reads, and its default then becomes true for the rows
-- created from now on (a study a device sent directly or a local import registered first is recorded by its first announce).
-- No CHECK, index, key or grant changes (the runtime's table grants cover new columns).
BEGIN;
ALTER TABLE "StudyState" ADD COLUMN "referredAt" TIMESTAMP(3);
ALTER TABLE "StudyState" ADD COLUMN "referredOpen" BOOLEAN NOT NULL DEFAULT false;
UPDATE "StudyState" SET "referredAt" = "createdAt" WHERE "origin" = 'gateway';
ALTER TABLE "StudyState" ALTER COLUMN "referredOpen" SET DEFAULT true;
COMMIT;
