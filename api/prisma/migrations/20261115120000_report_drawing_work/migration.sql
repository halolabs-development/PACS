-- Image Report: the private draft work a drawing was attached in, so that the destruction of that work at its purpose end
-- (CD-09-P) also destroys the drawings of that work nothing else names. Additive: one nullable column and its index.
-- A drawing attached before this column, that no report version holds, is given the work that names it now (a live
-- draft's work, or an ended work not yet destroyed): a drawing only a draft ever held was attached in that draft's work.
-- Any other stays NULL - a version's drawing may come from an earlier work - and is kept until the report's own
-- retention ends (CD-09-D deletes every drawing of the study).
BEGIN;
ALTER TABLE "ReportDrawing" ADD COLUMN "workUnit" TEXT;
CREATE INDEX "ReportDrawing_workUnit_idx" ON "ReportDrawing"("workUnit");
UPDATE "ReportDrawing" r SET "workUnit" = d."workUnit" FROM "ReportDraft" d
  WHERE r."workUnit" IS NULL AND d.uid = r."studyUid" AND d.present AND d."workUnit" IS NOT NULL AND d.drawings -> 'ids' ? r.id::text
    AND NOT EXISTS (SELECT 1 FROM "ReportVersion" v WHERE v.uid = r."studyUid" AND v.drawings @> jsonb_build_array(jsonb_build_object('id', r.id::text)));
UPDATE "ReportDrawing" r SET "workUnit" = p."disposalUnitId" FROM "ReportDraftPurposeEnd" p
  WHERE r."workUnit" IS NULL AND p.uid = r."studyUid" AND p.drawings -> 'ids' ? r.id::text
    AND NOT EXISTS (SELECT 1 FROM "ReportVersion" v WHERE v.uid = r."studyUid" AND v.drawings @> jsonb_build_array(jsonb_build_object('id', r.id::text)));
COMMIT;
