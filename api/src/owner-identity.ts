/*
 * Whose it is: a draft, a hold, the saved text of a report head, an unsigned report version, a saved search, a folder
 * collection, a reading template. One rule, here: it is the account's (sub), never the login email's (actor).
 *
 * The login email can change (an administrator corrects it), and an old email can later belong to another account. So
 * every "is this mine" judgement compares the stored account id with the caller's, and a row that names no account (an
 * older row the member table could not resolve when the account ids were filled in) is nobody's - it is kept, and never
 * handed to whoever has that email now.
 *
 * The email stays where it is written: as the shown name of a holder or a writer, in history and signed records, and as
 * the second part of a draft's record id ([uid, author]) that retention and viewing records point to.
 */
import type { Prisma } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';

type Account = { sub?: string | null; actor?: string | null };

/** The one judgement: the stored account id is the caller's. A row without one is nobody's. */
export function sameAccount(storedSub: string | null | undefined, caller: Account): boolean {
  return typeof storedSub === 'string' && storedSub.length > 0 && typeof caller.sub === 'string' && storedSub === caller.sub;
}

/** The words a screen shows for a writer it may not name (the existing private-writer phrase). */
export const PRIVATE_WRITER = '작성자 비공개';

/**
 * The login email of a stored holder or writer as this caller is given it. The screens compare such a value with their own
 * login (`x === user`), so: the caller's own row reads as the caller's login now; another account's row whose stored email is
 * the caller's login now (an email that moved to the caller) never reads as the caller's - it is withheld; any other row
 * reads as stored.
 */
export function shownActor(stored: string, storedSub: string | null | undefined, caller: Account): string {
  if (sameAccount(storedSub, caller)) return typeof caller.actor === 'string' && caller.actor ? caller.actor : stored;
  return stored === caller.actor ? PRIVATE_WRITER : stored;
}

/** The caller's own draft row of a study (by its account), or null. Reads only; `lockedDraftOf` reads it locked. */
export function draftOf(db: any, uid: string, caller: Account, select?: Record<string, boolean>) {
  if (!caller.sub) return Promise.resolve(null);
  return db.reportDraft.findFirst({ where: { uid, authorSub: caller.sub }, ...(select ? { select } : {}) });
}

/** The account's draft row of a study, locked (FOR UPDATE) in the caller's transaction, or null. */
export async function lockedDraftOf(tx: Prisma.TransactionClient, uid: string, sub: string | null | undefined): Promise<any | null> {
  if (!sub) return null;
  const rows = await tx.$queryRaw<any[]>`
    SELECT uid, author, "authorSub", findings, conclusion, recommendation, "baseVersion", citations, structured, drawings, revision,
      present, "updatedAt", "workUnit", "workSince", "workIntent", "groupId"
    FROM "ReportDraft" WHERE uid = ${uid} AND "authorSub" = ${sub} FOR UPDATE`;
  return rows[0] ?? null;
}

/**
 * The record id's second part for the first draft row an account makes on a study: its login email - unless that string was
 * already a draft record id of the study (a row, or an ended work kept for retention: the email belonged to another account
 * then, or the row went with a deleted study), then the email and the account id (and a number, should that be taken too).
 * A record id is never given to a second account. Called under the study row lock every draft write holds.
 */
export async function newDraftAuthor(tx: any, uid: string, sub: string, preferred: string): Promise<string> {
  for (let n = 0; n < 100; n++) {
    const author = n === 0 ? preferred : n === 1 ? `${preferred}#${sub}` : `${preferred}#${sub}#${n}`;
    if (await tx.reportDraft.findUnique({ where: { uid_author: { uid, author } }, select: { uid: true } })) continue;
    if (await tx.reportDraftPurposeEnd.findFirst({ where: { uid, author }, select: { uid: true } })) continue;
    return author;
  }
  throw new Error('no free draft record id');
}

/** The login email a draft row was made under: its record id without the account suffix `newDraftAuthor` may have added. */
export function draftAuthorName(row: { author: string; authorSub?: string | null }): string {
  const at = row.authorSub ? row.author.indexOf('#' + row.authorSub) : -1;
  return at > 0 ? row.author.slice(0, at) : row.author;
}
/**
 * The record id's second part of the caller's draft of a study, for a viewing or writing record: its own row's author
 * (whatever the caller's email is now), or - with no row yet - the author its first row would get.
 */
export async function draftRecordAuthor(db: any, uid: string, caller: { sub?: string | null; actor: string }): Promise<string> {
  if (!caller.sub) return caller.actor;
  const own = await db.reportDraft.findFirst({ where: { uid, authorSub: caller.sub }, select: { author: true } });
  return own ? own.author : newDraftAuthor(db, uid, caller.sub, caller.actor);
}

/** The where-part that selects only the caller's own draft rows (none when the caller names no account). */
export function ownDraftsWhere(caller: Account): { authorSub: string | { in: string[] } } {
  return typeof caller.sub === 'string' && caller.sub ? { authorSub: caller.sub } : { authorSub: { in: [] } };
}

/** The owner value of an account's saved searches, folder collection and reading templates: its account id. */
export function accountOwner(caller: Account): string {
  if (typeof caller.sub !== 'string' || !caller.sub) throw new ForbiddenException('개인 계정으로 로그인하세요');
  return caller.sub;
}

/**
 * The record id's second part of a draft an answer carries, beside the answer (never in it): the viewing record of a list or
 * bootstrap names the draft row it read, whatever the caller's email is now. Keyed by the answer's draft object.
 */
export const draftRecordOf = new WeakMap<object, string>();
