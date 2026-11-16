-- Existing ordinary views and drawings retain their original ungrouped scope.
ALTER TABLE "ReportDrawing" ADD COLUMN "groupId" UUID;
ALTER TABLE "ViewerAutoView" ADD COLUMN "scopeKey" TEXT NOT NULL DEFAULT '';
DROP INDEX "ViewerAutoView_authorSub_studyUid_key";
CREATE UNIQUE INDEX "ViewerAutoView_authorSub_studyUid_scopeKey_key"
  ON "ViewerAutoView"("authorSub", "studyUid", "scopeKey");
