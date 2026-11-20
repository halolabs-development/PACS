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
   without one is not found by a query naming a device. Confirm the console's query keys and character set (answers are
   UTF-8, ISO_IR 192).
4. **An order that cannot be sent in what the console asks for is left out, not sent incomplete.** When the console asks
   back a value DICOM requires (the patient's name or ID, the scheduled device, date, time, modality, the description,
   the identifiers) and an order has none, or holds one its DICOM type cannot carry (a device name that is not an AE
   Title, a text longer than the type allows), that order alone is left out of the answer; the other orders are sent.
   When orders match and every one of them is left out, the query ends Unable to process (0xC003) instead of an empty
   list, so the technician sees a fault rather than "no patients". The audit row of each query counts the orders left
   out: a count above zero means an order needs correcting at its source.
5. **Search keys.** Patient name (with `*` and `?`), patient ID, birth date, sex, accession, the scheduled date and time
   (single or range), modality, scheduled device, procedure and step IDs and the Study Instance UID are compared. A value
   given for another patient attribute (for example the issuer of the patient ID) matches no order, because an order
   holds nothing to compare it with; a value for any other key the worklist does not compare is not used, and the answer
   says so (pending status FF01).

## What the product does and does not decide

- Which orders: the calling modality's hospital, the orders on its Order List (an order taken off with Delete Order is
  not answered; Undo brings it back). A match to a study, the RIS status, receipts, QC and the report do not decide it,
  and a query changes none of them: being queried is not being acquired.
- The worklist accepts only C-FIND (Modality Worklist) and C-ECHO; it takes no images, answers no other query and does
  not take Modality Performed Procedure Step.
- Every query is recorded in the audit log with the modality's AE Title, its hospital, the outcome, the number of
  orders matched and the number of those left out of the answer (no patient or search value).
- The order source itself (how the hospital RIS gives orders) is a separate decision; this worklist answers with whatever
  orders the Order List holds.
