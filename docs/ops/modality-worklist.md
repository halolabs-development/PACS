# Modality Worklist: what a site must confirm before a modality uses it

The API can answer a modality's DICOM Modality Worklist query (C-FIND, Modality Worklist Information Model - FIND) with
the institution's scheduled orders, so the technician picks the patient and study on the console instead of typing them.
It is off by default: the main and production compose files set nothing and open no port. This page lists what turning
it on needs. They are conditions to confirm with the hospital at deployment; a green CI run against the synthetic overlay
(`docker-compose.mwl.yml`) is not a site check.

## Turning it on

- Set `KIN_MWL_PORT` (the DICOM port inside the API container) on the api service; optionally `KIN_MWL_AET` (this
  worklist's AE Title, `KINMWL` unless set, at most 16 characters) and `KIN_MWL_ANSWER_SECONDS` (how long a query waits
  for the API, 10 unless set; a query not answered in time ends Unable to process, never an empty list).
- Publish that port to the hospital network only, by the site's own deployment decision. The product does not open it.

## Conditions to confirm at the site

1. **Each modality is registered as a device of its hospital.** Members > Held Studies > Register Device records the
   modality's AE Title for the administrator's own institution, for a modality that has sent a held study. A modality
   whose images reach KIN only through the Gateway has no Held Studies row; its AE Title is registered by the same
   administrator request (`POST /api/admin/source-devices` with the value and the hospital confirmation) - there is no
   screen entry for it yet. The registration is the same fact for arrivals: a study this AE Title sends directly is then
   that hospital's. A modality is answered only with its hospital's orders; an AE
   Title no institution registered, or one two institutions registered, is refused (Refused: Not Authorized) and is given
   no order. The AE Title is the modality's identity on the hospital network, not a password: confirm with the hospital
   which AE Title each console uses and that a console shared by two hospitals is not registered to one of them only.
2. **The modality queries this worklist's AE Title, host and port.** An association to another AE Title is rejected.
3. **The orders carry what the modality asks for.** Each order gives its own procedure identifier and Study Instance UID
   (assigned once and kept), the patient's name, ID, birth date and sex, the accession (empty when the order has none -
   none is made up), the scheduled date and time (hospital time, sent with offset +0900), modality and description, the
   requesting physician and the ward. The scheduled device (Scheduled Station AE Title) is the order's own; an order
   without one is not found by a query naming a device, and a query asking for the device back fails (Unable to process)
   rather than send an empty value. Confirm the console's query keys and character set (answers are UTF-8, ISO_IR 192).

## What the product does and does not decide

- Which orders: the calling modality's hospital, the orders on its Order List (an order taken off with Delete Order is
  not answered; Undo brings it back). A match to a study, the RIS status, receipts, QC and the report do not decide it,
  and a query changes none of them: being queried is not being acquired.
- The worklist accepts only C-FIND (Modality Worklist) and C-ECHO; it takes no images, answers no other query and does
  not take Modality Performed Procedure Step.
- Every query is recorded in the audit log with the modality's AE Title, its hospital, the outcome and the number of
  matches (no patient or search value).
- The order source itself (how the hospital RIS gives orders) is a separate decision; this worklist answers with whatever
  orders the Order List holds.
