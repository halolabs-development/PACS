-- The member name a version was written under, kept with the version so a later rename does not change who a signed
-- version shows. A display label only: it is not part of the signed bytes (image-report.ts signedReportRow), the login in
-- "author" stays the testimony. No default and no backfill: a version written before this column has none (NULL), and the
-- screens show the account's current name for it.
ALTER TABLE "ReportVersion" ADD COLUMN "authorName" TEXT;
