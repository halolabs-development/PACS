/*
 * Gateway STOW, before the archive is written: is the body the patient the archive already holds under this Study UID?
 *
 * Why: the archive keys a study by (PatientID, StudyInstanceUID). A copy of a study the archive holds, sent again under
 * another PatientID (the patient corrected at the modality, new SOP instances), used to be written first and refused
 * afterwards; the archive then held one Study UID under two patients, every list dropped the study (it is listed only as
 * an identity notice), its reports were locked and the Gateway repeated the same transfer without end. The member's DICOM
 * import refuses the same copy before any write; this is that decision on the Gateway's path.
 *
 * The rule, in one place (gatewayStowRefusal): the archive's own observation of the UID (the read the worklist decides a
 * split from) against the PatientID of the body's first object, compared by the import gate's own function.
 *   no study resource yet       nothing to compare: the first arrival of a study is sent as before
 *   one study resource          its PatientID must equal the body's, or 409 PATIENT_ID_CONFLICT and nothing is sent
 *   two or more                 already unresolved: 409 EXISTING_STUDY_IDENTITY_UNRESOLVED and nothing is sent
 * Only PatientID is compared, because only PatientID splits a study in the archive: a later image of the same PatientID
 * whose name is spelled differently joins the same study today and is not refused here. The identifier is compared as
 * the archive keys it: as written, less the trailing padding spaces. Leading spaces, case and leading zeros are part of
 * it (`A` and ` A`, `12` and `0012` are two patients in the archive, so the second is refused here).
 *
 * The body is read only as far as its first object's PatientID (reading stops once STOW_HEAD_LIMIT bytes are held), then
 * relayed unchanged: a Gateway body may be one object of any size. A Gateway builds a body from one study resource of
 * its own archive, which holds one PatientID, so the first object speaks for the body. A first object whose PatientID
 * cannot be read (not Part 10, a transfer syntax outside the reader's list, an identifier that is neither ASCII nor
 * UTF-8, a header longer than the limit) is not judged and is sent as before: refusing what cannot be read would stop
 * studies that arrive today.
 */
import { compareWithStudyClaim } from './dicom-import-gate.service';
import type { AcceptedFile } from './dicom-import-gate.service';
import { readPatientIdPrefix } from './dicom-part10-reader';
import type { PatientIdPrefix } from './dicom-part10-reader';

export const STOW_HEAD_LIMIT = 4 * 1024 * 1024;
const FIRST_TRY = 64 * 1024;

export type GatewayStowRefusal = 'PATIENT_ID_CONFLICT' | 'EXISTING_STUDY_IDENTITY_UNRESOLVED';
/** The first object's PatientID as far as the held bytes say it: never `more` (the reader's own "not yet"). */
export type StowPatientId = { kind: 'known'; patientId: string } | { kind: 'unreadable' };

/** The RFC 2046 boundary of a multipart Content-Type, or null. */
function boundaryOf(contentType: string): string | null {
  if (!/^\s*multipart\/related\s*(;|$)/i.test(contentType)) return null;
  const found = /;\s*boundary=(?:"([^"]{1,70})"|([^\s;"]{1,70}))/i.exec(contentType);
  return found ? found[1] ?? found[2] : null;
}

/**
 * The first body part of a multipart body, from the body's leading bytes: where its content starts and, when the bytes
 * reach the next delimiter, where it ends (null: the content runs past the bytes held).
 */
function firstPart(head: Buffer, boundary: string): { start: number; end: number | null } | 'more' | 'unreadable' {
  const delimiter = Buffer.from('--' + boundary, 'latin1');
  // The first delimiter opens the body or follows a preamble line.
  let at = head.indexOf(delimiter);
  while (at > 0 && !(head[at - 2] === 0x0d && head[at - 1] === 0x0a)) at = head.indexOf(delimiter, at + 1);
  if (at < 0) return 'more';
  const after = at + delimiter.length;
  if (head.length < after + 2) return 'more';
  if (head[after] === 0x2d && head[after + 1] === 0x2d) return 'unreadable';   // the closing delimiter: no part at all
  const line = head.indexOf('\r\n', after, 'latin1');
  if (line < 0) return 'more';
  // The part's header lines end at the first empty line (with no header line, right after the delimiter line).
  const blank = head.indexOf('\r\n\r\n', line, 'latin1');
  if (blank < 0) return 'more';
  const start = blank + 4;
  const next = head.indexOf(Buffer.concat([Buffer.from('\r\n', 'latin1'), delimiter]), start);
  return { start, end: next < 0 ? null : next };
}

/** What the held leading bytes of a STOW body say of its first object's PatientID; `ended`: they are the whole body. */
export function stowHeadPatientId(head: Buffer, contentType: string, ended: boolean): PatientIdPrefix {
  const boundary = boundaryOf(contentType);
  if (!boundary) return { kind: 'unreadable' };
  const part = firstPart(head, boundary);
  if (part === 'unreadable') return { kind: 'unreadable' };
  if (part === 'more') return ended ? { kind: 'unreadable' } : { kind: 'more' };
  return readPatientIdPrefix(head.subarray(part.start, part.end ?? head.length), part.end !== null || ended);
}

/**
 * Reads the body only until its first object's PatientID is known or cannot be: `next` yields the body's chunks in
 * order. The chunks read are returned for the relay, which sends them first and then the rest of the body.
 */
export async function readStowHead(next: () => Promise<IteratorResult<Buffer>>, contentType: string):
  Promise<{ identity: StowPatientId; chunks: Buffer[]; ended: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0, tryAt = 0, ended = false;
  for (;;) {
    const step = await next();
    if (step.done) ended = true;
    else { chunks.push(step.value); size += step.value.length; }
    if (!ended && size < tryAt) continue;
    const verdict = stowHeadPatientId(Buffer.concat(chunks), contentType, ended);
    if (verdict.kind !== 'more') return { identity: verdict, chunks, ended };
    if (size >= STOW_HEAD_LIMIT) return { identity: { kind: 'unreadable' }, chunks, ended };
    // A longer header is read again from its start: at doubling sizes, so at most a few times.
    tryAt = Math.max(size * 2, FIRST_TRY);
  }
}

/**
 * The one decision. `stored`: the PatientID of every study resource the archive holds for the UID now (the worklist's
 * split observation); `given`: the body's first object, or null when it could not be read (then only an already
 * unresolved UID is refused). The comparison is the import gate's exact equality of the two identifiers, each less its
 * trailing padding spaces and otherwise as written.
 */
export function gatewayStowRefusal(stored: readonly string[], given: StowPatientId | null, institutionId: string): GatewayStowRefusal | null {
  if (stored.length > 1) return 'EXISTING_STUDY_IDENTITY_UNRESOLVED';
  if (stored.length === 0 || !given || given.kind !== 'known') return null;
  const unpadded = (value: string) => value.replace(/ +$/, '');
  // Name, birth date and sex are not this path's question: with none on either side the gate's function decides by
  // PatientID alone.
  const none = { nameKey: null, birthKey: null, sexKey: null };
  const claim = { institutionId, patientId: unpadded(stored[0]), issuerInstitutionId: institutionId, ...none };
  const file = { patientId: unpadded(given.patientId), issuerInstitutionId: institutionId, ...none } as AcceptedFile;
  return compareWithStudyClaim(claim, file, institutionId).code === 'PATIENT_ID_CONFLICT' ? 'PATIENT_ID_CONFLICT' : null;
}
