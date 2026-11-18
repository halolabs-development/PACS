/*
 * Who may read and write a study's report text, and what its state is called for them. One place: the list, bootstrap,
 * state answers, history, preview, citations, structure, drawings, the clinician reads, draft writes, commits and holds ask
 * this module. (The critical-result source keeps the same rule in its own module: critical-result-policy.ts senderReadsHead.)
 *
 * - P (Preliminary): its designated author and reviewer only (canReadPreliminary, unchanged).
 * - W/T/H text not yet approved (a Save or a Defer in the head version of the report): only the reading physician who
 *   wrote it. Every other reader sees the state and who is on it ("In Progress by ..."), never the text, and cannot
 *   write over it: the only way in is the existing Reset of an in-progress report, which moves that text to its
 *   writer's own private draft.
 * - D (report destroyed at the end of its retention): no text, nothing to write.
 * - A (approved): unchanged - everyone the study is visible to.
 *
 * A clinician-only reader keeps the reads of the 2026-11-02 decision (the radiologist's rules of that day, which
 * included other readers' saved text). That one exception is the open question between that decision and the request
 * that a save is seen only by the physician writing it; it never covers another user's private draft.
 *
 * The writer of the unsigned head is `Report.updatedBy` (= its version's `author`), the account's login identity
 * (actor): a display name change does not change it. Images are not governed here (canReadPreliminary still gates them).
 */
import { ForbiddenException } from '@nestjs/common';
import { canReadPreliminary } from './preliminary-reader';
import { clinicianOnly } from './clinician-policy';

export type ReportBodyLock = 'preliminary' | 'in-progress' | 'destroyed' | null;

type Reader = { actor: string; sub?: string; roles?: readonly string[] };
type Head = { updatedBy?: string | null; findings?: string | null; conclusion?: string | null; recommendation?: string | null } | null | undefined;
type VersionRow = { version: number; action: string; author?: string | null; reason?: string | null };

/** States whose head text is a reading physician's own unsigned work. */
export const UNSIGNED_STATES: readonly string[] = Object.freeze(['W', 'T', 'H']);
const UNSIGNED_ACTIONS: readonly string[] = Object.freeze(['save', 'defer']);
const SIGNED_ACTIONS: readonly string[] = Object.freeze(['approve', 'amend', 'addendum']);

const hasText = (head: Head) => !!head && !!(head.findings || head.conclusion || head.recommendation);

/** The reading physician whose unsigned text the head holds now (W/T/H with text), or null. */
export function unsignedAuthor(state: any, head: Head): string | null {
  return UNSIGNED_STATES.includes(state?.rs) && hasText(head) && typeof head!.updatedBy === 'string' && head!.updatedBy
    ? head!.updatedBy : null;
}

/** Why this reader gets no report text for this study now, or null when the text is theirs to read. */
export function reportBodyLock(state: any, head: Head, reader: Reader): ReportBodyLock {
  if (state?.rs === 'D') return 'destroyed';
  if (!canReadPreliminary(state, reader)) return 'preliminary';
  // The clinician cell of the state table: left as the 2026-11-02 decision has it (clinician role alone; an admin or a
  // radiologist who also holds the clinician role reads as a radiologist).
  if (clinicianOnly(reader.roles)) return null;
  const author = unsignedAuthor(state, head);
  return author && author !== reader.actor ? 'in-progress' : null;
}

export const IN_PROGRESS_MESSAGE = '다른 판독의가 Save해 둔 진행 중 판독입니다. 그 판독의만 보고 이어 쓸 수 있습니다 — 이어 쓰려면 Reset으로 Unread로 되돌리세요';

/** The refusal of a read or a write over another physician's unsigned text. Its words never say a version was saved. */
export function inProgressRefusal(author: string | null): ForbiddenException {
  return new ForbiddenException({ code: 'REPORT_IN_PROGRESS', savedBy: author, message: IN_PROGRESS_MESSAGE });
}

/** Reads of the head's text (citations, structure, drawings, preview): refused while it is another physician's. */
export function assertHeadReadable(state: any, head: Head, reader: Reader): void {
  if (reportBodyLock(state, head, reader) === 'in-progress') throw inProgressRefusal(unsignedAuthor(state, head));
}

/** Writes over the head (draft writes, hold, commits other than Reset): refused while it is another physician's. */
export const assertHeadWritable = assertHeadReadable;

/** The head columns this module reads, for callers that read the head only to ask. */
export const HEAD_AUTHOR_SELECT = { updatedBy: true, findings: true, conclusion: true, recommendation: true } as const;
/**
 * The head, read only where it can hold someone's unsigned text in this state: a Save (T) or a Defer (H). Write gates read the
 * state and the head in one transaction, where an Unread (W) head is always empty (Reset empties it); the list reads, which
 * read them apart, pass their head to reportBodyLock directly and W is judged there too.
 */
export async function headForLock(db: any, uid: string, state: any): Promise<Head> {
  if (!['T', 'H'].includes(state?.rs)) return null;
  return db.report.findUnique({ where: { uid }, select: HEAD_AUTHOR_SELECT });
}

/**
 * Each stored version's text class, walking the versions in order:
 * - 'shared': approve, amend, addendum, preliminary, reset, and a Save/Defer written while the report was Preliminary
 *   (that is still the preliminary reading, kept for its designated pair as before);
 * - 'unsigned': a Save/Defer outside a Preliminary, and a Reset's discarded copy of one - its writer only (a clinician-only
 *   reader keeps the 2026-11-02 reads);
 * - 'private': a discarded copy that is not a Reset's (an administrator's draft release keeps someone's private draft) -
 *   its writer only, for every reader.
 * A Reset's copy preserved the head of that moment: the newest non-discarded version below it (an administrator's
 * discarded rows never were the head).
 */
export function versionClasses(rows: readonly VersionRow[]): Map<number, 'shared' | 'unsigned' | 'private'> {
  const sorted = [...rows].sort((a, b) => a.version - b.version);
  const out = new Map<number, 'shared' | 'unsigned' | 'private'>();
  let preliminary = false;
  for (const row of sorted) {
    if (row.action === 'preliminary') { preliminary = true; out.set(row.version, 'shared'); continue; }
    if (SIGNED_ACTIONS.includes(row.action) || row.action === 'reset') {
      out.set(row.version, 'shared');
      preliminary = false;
      continue;
    }
    if (UNSIGNED_ACTIONS.includes(row.action)) { out.set(row.version, preliminary ? 'shared' : 'unsigned'); continue; }
    if (row.action === 'discarded') {
      const reset = sorted.find(r => r.version === row.version + 1 && r.action === 'reset');
      if (!reset || row.reason !== `판독 취소로 폐기 (취소자: ${reset.author})`) { out.set(row.version, 'private'); continue; }
      const source = sorted.filter(r => r.version < row.version && r.action !== 'discarded').pop();
      out.set(row.version, source ? out.get(source.version) ?? 'shared' : 'shared');
      continue;
    }
    out.set(row.version, 'shared');
  }
  return out;
}

/** Whether this reader gets the text of a version of the given class. */
export function versionBodyReadable(row: { action: string; author?: string | null },
  kind: 'shared' | 'unsigned' | 'private' | undefined, reader: Reader): boolean {
  if (!kind || kind === 'shared') return true;
  if (!!row.author && row.author === reader.actor) return true;
  return kind === 'unsigned' && clinicianOnly(reader.roles);
}

/** `versionBodyReadable` for one stored row read alone (a version's citations, a preview, a drawing, a clinician read). */
export async function storedVersionReadable(db: any, uid: string, row: VersionRow, reader: Reader): Promise<boolean> {
  if (SIGNED_ACTIONS.includes(row.action) || row.action === 'reset' || row.action === 'preliminary') return true;
  if (!!row.author && row.author === reader.actor) return true;
  const rows = await db.reportVersion.findMany({ where: { uid, version: { lte: row.version + 1 } },
    select: { version: true, action: true, reason: true, author: true } });
  return versionBodyReadable(row, versionClasses(rows).get(row.version), reader);
}

