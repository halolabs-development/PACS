-- Gateway settings: one institution setting read by the institution's Gateways (routing rules, how long a sent copy is
-- kept, lossless compression), set by its administrator (PUT /api/admin/gateway-settings). Additive only: one nullable
-- column, no backfill (NULL = none set = the Gateway's behaviour before settings). No CHECK, index, key or grant changes
-- (the runtime's table grants cover new columns).
BEGIN;
ALTER TABLE "Institution" ADD COLUMN "gatewaySettings" JSONB;
COMMIT;