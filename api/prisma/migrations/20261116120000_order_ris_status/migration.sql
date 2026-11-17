-- Order List RIS Status: the order's state as the hospital RIS gives it (confirmed, scheduled or acquired). Additive only:
-- one nullable column, no default and no backfill, and a CHECK on its three values. Until an authoritative order source is
-- connected only test orders carry it, and a missing value stays blank on the Order List.
BEGIN;
ALTER TABLE "Order"
  ADD COLUMN "risStatus" TEXT,
  ADD CONSTRAINT "Order_risStatus_check" CHECK ("risStatus" IS NULL OR "risStatus" IN ('confirmed', 'scheduled', 'acquired'));
COMMIT;
