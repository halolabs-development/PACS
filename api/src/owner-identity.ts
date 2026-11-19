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
 * the original login in a draft's immutable record id ([uid, author]) that retention and viewing records point to.
 */
import type { Prisma } from '@prisma/client';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

type Account = { sub?: string | null; actor?: string | null };

/** The one judgement: the stored account id is the caller's. A row without one is nobody's. */
export function sameAccount(storedSub: string | null | undefined, caller: Account): boolean {
  return typeof storedSub === 'string' && storedSub.length > 0 && typeof caller.sub === 'string' && storedSub === caller.sub;
}

/** The words a screen shows for a writer it may not name (the existing private-writer phrase). */
export const PRIVATE_WRITER = '작성자 비공개';

/**
 * Display the caller's current login on their own row. Withhold a different account's old login if it
 * now names the caller. Ownership booleans are calculated separately with sameAccount.
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
 * Allocate under the study lock shared by first reads and writes. A legacy row (or retained work) can already
 * have the literal login#sub as its id. Its id stays reserved even if its author could not be resolved.
 */
export async function newDraftAuthor(tx: Prisma.TransactionClient, uid: string, sub: string, login: string): Promise<string> {
  const base = `${login}#${sub}`;
  for (let n = 1; ; n++) {
    const author = n === 1 ? base : `${base}#${n}`;
    if (await tx.reportDraft.findUnique({ where: { uid_author: { uid, author } }, select: { uid: true } })) continue;
    if (await tx.reportDraftPurposeEnd.findFirst({ where: { uid, author }, select: { uid: true } })) continue;
    return author;
  }
}

/** Keep the original login verbatim, even when its own text ends in #sub or #sub#2. */
export function draftAuthorName(row: { author: string; authorLogin?: string | null }): string {
  return row.authorLogin ?? row.author;
}

/** An empty first view reserves its key at revision zero. A first write advances the same row to revision one. */
export async function draftRecordAuthor(tx: Prisma.TransactionClient, uid: string, caller: Account & { actor: string }): Promise<string> {
  const sub = accountOwner(caller);
  const own = await draftOf(tx, uid, caller, { author: true });
  if (own) return own.author;
  const state = await tx.$queryRaw<{ uid: string }[]>`SELECT uid FROM "StudyState" WHERE uid = ${uid} FOR UPDATE`;
  if (!state.length) throw new NotFoundException('검사를 찾을 수 없습니다');
  const reserved = await draftOf(tx, uid, caller, { author: true });
  if (reserved) return reserved.author;
  const author = await newDraftAuthor(tx, uid, sub, caller.actor);
  await tx.reportDraft.create({ data: { uid, author, authorSub: sub, authorLogin: caller.actor, firstViewOnly: true, revision: 0, present: false } });
  return author;
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
