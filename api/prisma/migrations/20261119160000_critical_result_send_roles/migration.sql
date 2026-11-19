BEGIN;
ALTER TABLE "Order" ADD COLUMN "orderingPhysicianSub" TEXT;
ALTER TABLE "CriticalResult" ADD COLUMN "sendOutcome" JSONB;
COMMIT;
