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
 * A clinician-only reader reads by these same rules, as a radiologist who did not write the text (the 2026-11-02 decision:
 * clinician reads follow the radiologist's rules). There is no role exception: another physician's Save or Defer is not in
 * a clinician's list, timeline, report read, history, citations, structure or preview either.
 *
 * The writer of the unsigned head is the account that made it: `Report.updatedBySub` (= its version's `authorSub`), judged by
 * owner-identity.ts. `updatedBy` keeps the login email of the time, shown as the writer; an email or display name change
 * does not change whose text it is. Images are not governed here (canReadPreliminary still gates them).
 */
import { ForbiddenException } from '@nestjs/common';
import { canReadPreliminary } from './preliminary-reader';
import { structureArray } from './report-structure';
import { versionDrawings } from './image-report';
import { sameAccount, shownActor, writerShown, type WriterDirectory } from './account-identity';

export type ReportBodyLock = 'preliminary' | 'in-progress' | 'destroyed' | null;

type Reader = { actor: string; sub?: string; roles?: readonly string[]; writers?: WriterDirectory };
/**
 * The head as stored: its writer and text, and - where the caller read its version - storedExtras, whether that version
 * stored a structured item or a drawing (a head without text is judged by them).
 */
type Head = { updatedBy?: string | null; updatedBySub?: string | null; findings?: string | null; conclusion?: string | null; recommendation?: string | null;
  storedExtras?: boolean } | null | undefined;
type VersionRow = { version: number; action: string; author?: string | null; authorSub?: string | null; reason?: string | null };
/** The account whose unsigned work the head holds and its login email as written. */
export type UnsignedWriter = { actor: string; sub: string | null };

/** States whose head text is a reading physician's own unsigned work. */
export const UNSIGNED_STATES: readonly string[] = Object.freeze(['W', 'T', 'H']);
const UNSIGNED_ACTIONS: readonly string[] = Object.freeze(['save', 'defer']);
const SIGNED_ACTIONS: readonly string[] = Object.freeze(['approve', 'amend', 'addendum']);

const hasText = (head: Head) => !!head && !!(head.findings || head.conclusion || head.recommendation);

/**
 * Whether the head version stored anything - text in its three fields, a structured item or a drawing. The one judgement of
 * "there is someone's work here" that the list, the editor, the preview, the server's writes, Reset and the critical-result
 * source all use: a Save of drawings alone is someone's work too.
 */
export function storedContent(head: Head): boolean {
  return hasText(head) || head?.storedExtras === true;
}

/** Whether a stored version row (its structured and drawings columns) holds a structured item or a drawing. */
export function versionExtras(version: { structured?: unknown; drawings?: unknown } | null | undefined): boolean {
  return structureArray(version?.structured).length > 0 || versionDrawings(version?.drawings).length > 0;
}

/**
 * The reading physician whose unsigned work the head holds now (W/T/H with stored content), or null. The state and the head
 * must be of one moment (headVersionsUnchanged after a list read, or one transaction that locked the study row). A head with no recorded writer
 * is not locked (every Save records its writer; an older row without one is a known limit).
 */
export function unsignedAuthor(state: any, head: Head): UnsignedWriter | null {
  if (!UNSIGNED_STATES.includes(state?.rs) || !storedContent(head)) return null;
  return typeof head!.updatedBy === 'string' && head!.updatedBy ? { actor: head!.updatedBy, sub: head!.updatedBySub ?? null } : null;
}

/** Why this reader gets no report text for this study now, or null when the text is theirs to read. */
export function reportBodyLock(state: any, head: Head, reader: Reader): ReportBodyLock {
  if (state?.rs === 'D') return 'destroyed';
  if (!canReadPreliminary(state, reader)) return 'preliminary';
  const author = unsignedAuthor(state, head);
  return author !== null && !sameAccount(author.sub, reader) ? 'in-progress' : null;
}

export const IN_PROGRESS_MESSAGE = '다른 판독의가 Save해 둔 진행 중 판독입니다. 그 판독의만 보고 이어 쓸 수 있습니다 — 이어 쓰려면 Reset으로 Unread로 되돌리세요';

/** The refusal of a read or a write over another physician's unsigned text. Its words never say a version was saved. */
export function inProgressRefusal(author: string | null, authorName: string | null = author): ForbiddenException {
  return new ForbiddenException({ code: 'REPORT_IN_PROGRESS', savedBy: author, savedByName: authorName, message: IN_PROGRESS_MESSAGE });
}

/** Reads of the head's text (citations, structure, drawings, preview): refused while it is another physician's. */
export function assertHeadReadable(state: any, head: Head, reader: Reader): void {
  if (reportBodyLock(state, head, reader) === 'in-progress') {
    const writer = unsignedAuthor(state, head);
    throw inProgressRefusal(writer ? shownActor(writer.actor, writer.sub, reader) : null, writer ? writerShown(writer.actor, writer.sub, reader) : null);
  }
}

/** Writes over the head (draft writes, hold, commits other than Reset): refused while it is another physician's. */
export const assertHeadWritable = assertHeadReadable;

/** The head columns this module reads, for callers that read the head only to ask. */
export const HEAD_AUTHOR_SELECT = { uid: true, version: true, updatedBy: true, updatedBySub: true, findings: true, conclusion: true, recommendation: true } as const;

/**
 * Report heads with storedExtras: a head without text is asked whether its version stored a structured item or a drawing
 * (a head with text is someone's work already, and is not asked).
 */
export async function withStoredExtras<T extends { uid: string; version?: number | null; findings?: string | null;
  conclusion?: string | null; recommendation?: string | null }>(db: any, reports: T[]): Promise<(T & { storedExtras?: boolean })[]> {
  const keyed = reports.filter(report => Number.isSafeInteger(report.version) && (report.version as number) > 0 && !hasText(report));
  if (!keyed.length) return reports;
  const rows: any[] = await db.reportVersion.findMany({ where: { OR: keyed.map(report => ({ uid: report.uid, version: report.version })) },
    select: { uid: true, version: true, structured: true, drawings: true } });
  const extras = new Map(rows.map(row => [row.uid + '|' + row.version, versionExtras(row)]));
  const asked = new Set(keyed);
  return reports.map(report => asked.has(report) ? { ...report, storedExtras: extras.get(report.uid + '|' + report.version) ?? false } : report);
}

/**
 * The list and the bootstrap read the states and the report heads apart. A lock is judged on a state and a head of the same
 * moment when no report version moved between the head read and a state read made after it: every change of RS, designation
 * or head is a commit, and every commit makes a version. So the reader reads the heads, then the states, then checks here.
 */
export async function headVersionsUnchanged(db: any, uids: string[], reports: { uid: string; version?: number | null }[]): Promise<boolean> {
  if (!uids.length) return true;
  const now: { uid: string; version: number }[] = await db.report.findMany({ where: { uid: { in: uids } }, select: { uid: true, version: true } });
  const read = new Map(reports.map(report => [report.uid, report.version ?? 0]));
  return now.length === reports.length && now.every(row => read.has(row.uid) && read.get(row.uid) === row.version);
}
/**
 * The head, read only where it can hold someone's unsigned work in this state: a Save (T) or a Defer (H). Write gates read the
 * state and the head in one transaction that locked the study row, where an Unread (W) head is always empty (Reset empties it).
 */
export async function headForLock(db: any, uid: string, state: any): Promise<Head> {
  if (!['T', 'H'].includes(state?.rs)) return null;
  const head = await db.report.findUnique({ where: { uid }, select: HEAD_AUTHOR_SELECT });
  return head ? (await withStoredExtras(db, [head]))[0] : null;
}

/**
 * Each stored version's text class, walking the versions in order:
 * - 'shared': approve, amend, addendum, preliminary, reset, and a Save/Defer written while the report was Preliminary
 *   (that is still the preliminary reading, kept for its designated pair as before);
 * - 'unsigned': a Save/Defer outside a Preliminary, and a Reset's discarded copy of one - its writer only;
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
export function versionBodyReadable(row: { action: string; authorSub?: string | null },
  kind: 'shared' | 'unsigned' | 'private' | undefined, reader: Reader): boolean {
  if (!kind || kind === 'shared') return true;
  return sameAccount(row.authorSub, reader);
}

/** `versionBodyReadable` for one stored row read alone (a version's citations, a preview, a drawing, a clinician read). */
export async function storedVersionReadable(db: any, uid: string, row: VersionRow, reader: Reader): Promise<boolean> {
  if (SIGNED_ACTIONS.includes(row.action) || row.action === 'reset' || row.action === 'preliminary') return true;
  if (sameAccount(row.authorSub, reader)) return true;
  const rows = await db.reportVersion.findMany({ where: { uid, version: { lte: row.version + 1 } },
    select: { version: true, action: true, reason: true, author: true, authorSub: true } });
  return versionBodyReadable(row, versionClasses(rows).get(row.version), reader);
}

