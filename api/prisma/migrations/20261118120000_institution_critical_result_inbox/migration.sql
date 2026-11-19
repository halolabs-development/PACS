-- Critical result hospital inbox: one institution setting, the member account (its subject id) the hospital uses as its
-- shared receiving point for critical results. The institution's administrator sets or clears it
-- (PATCH /api/admin/critical-result-inbox); the Send Critical Result dialog checks that member by default next to the
-- radiologist's own choice. A delivery to it is an ordinary one-recipient record. Additive only: one nullable column, no
-- backfill (NULL = not set). No CHECK, index, key or grant changes (the runtime's table grants cover new columns).
BEGIN;
ALTER TABLE "Institution" ADD COLUMN "criticalResultInbox" VARCHAR(256);
COMMIT;
