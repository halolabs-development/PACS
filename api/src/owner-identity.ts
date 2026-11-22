/*
 * Whose it is: a draft, a hold, the saved text of a report head, an unsigned report version, a saved search, a folder
 * collection, a reading template. Ownership follows the account comparison in account-identity.ts.
 *
 * The login email can change (an administrator corrects it), and an old email can later belong to another account. So
 * every "is this mine" judgement compares the stored account id with the caller's, and a row that names no account (an
 * older row whose historical owner could not be established) is nobody's - it is kept, and never
 * handed to whoever has that email now.
 *
 * The email stays where it is written: as the shown name of a holder or a writer, in history and signed records, and as
 * the author of legacy drafts. Retention and viewing records use the immutable pair [uid, author].
 */
import type { Prisma } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import type { Account } from './account-identity';
export { sameAccount, shownActor, writerShown, PRIVATE_WRITER } from './account-identity';

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

/** The migration fixes a namespace separate from historical author strings. Views and writes use the same account key. */
export async function newDraftAuthor(tx: Prisma.TransactionClient, sub: string): Promise<string> {
  const [row] = await tx.$queryRaw<{ author: string }[]>`SELECT draft_account_author(${sub}::text) AS author`;
  return row.author;
}

/** Historical rows keep the login in author. New rows keep the first writer's login separately. */
export function draftAuthorName(row: { author: string; authorLogin?: string | null }): string {
  return row.authorLogin ?? row.author;
}

/** The where-part that selects only the caller's own draft rows (none when the caller names no account). */
export function ownDraftsWhere(caller: Account): { authorSub: string | { in: string[] } } {
  return typeof caller.sub === 'string' && caller.sub ? { authorSub: caller.sub } : { authorSub: { in: [] } };
}

/** Require an authenticated subject for private settings. */
export function accountOwner(caller: Account): string {
  if (typeof caller.sub !== 'string' || !caller.sub) throw new ForbiddenException('개인 계정으로 로그인하세요');
  return caller.sub;
}
