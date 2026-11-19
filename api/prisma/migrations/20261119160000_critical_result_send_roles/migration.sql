BEGIN;
ALTER TABLE "Order" ADD COLUMN "orderingPhysicianSub" TEXT,
  ADD CONSTRAINT "Order_orderingPhysicianSub_fkey" FOREIGN KEY ("orderingPhysicianSub")
  REFERENCES "MemberRights"("sub") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CriticalResult" ADD COLUMN "sendOutcome" JSONB;
COMMIT;
