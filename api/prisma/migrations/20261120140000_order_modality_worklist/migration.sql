-- Modality Worklist: each order's scheduled procedure identifier (VR SH, 16 characters at most) and the Study Instance
-- UID a modality is given for it, both given once by the database to every order row - the existing ones here, every new
-- one by default - and never changed; and the device the order is scheduled on (NULL = not scheduled on a device).
-- Additive only: no existing column changes.

-- A DICOM UID under the UUID root (2.25, ISO/IEC 9834-8): the 128-bit UUID as one decimal number.
CREATE FUNCTION kin_new_uuid_uid() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT '2.25.' || (sum(get_byte(b, i)::numeric * (256::numeric ^ (15 - i))))::numeric(39,0)::text
  FROM (SELECT uuid_send(gen_random_uuid()) AS b) AS u, generate_series(0, 15) AS i
$$;

ALTER TABLE "Order"
  ADD COLUMN "mwlProcedureId" VARCHAR(16) NOT NULL DEFAULT upper(substr(replace((gen_random_uuid())::text, '-'::text, ''::text), 1, 16)),
  ADD COLUMN "mwlStudyUid" VARCHAR(64) NOT NULL DEFAULT kin_new_uuid_uid(),
  ADD COLUMN "scheduledStationAet" VARCHAR(16);

CREATE UNIQUE INDEX "Order_mwlProcedureId_key" ON "Order"("mwlProcedureId");
CREATE UNIQUE INDEX "Order_mwlStudyUid_key" ON "Order"("mwlStudyUid");
