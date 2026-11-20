-- The Gateway receipt's series count: how many distinct series the images it reports sent (successCount) belong to.
-- Additive: one nullable column, no default and no backfill. NULL is "unknown" (a row stored before this column, or a
-- Gateway that does not send the count) and is never read as 0. The CHECK repeats the API rule as a backstop.
BEGIN;
ALTER TABLE "GatewayReceipt" ADD COLUMN "successSeries" BIGINT;
ALTER TABLE "GatewayReceipt" ADD CONSTRAINT "GatewayReceipt_series_check" CHECK ("successSeries" IS NULL
  OR ("successSeries" >= 0 AND "successSeries" <= "successCount" AND (("successSeries" = 0) = ("successCount" = 0))));
COMMIT;
