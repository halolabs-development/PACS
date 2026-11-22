/**
 * A member of the caller's institution as a writer is shown (member-rights.ts withWriters): the account's login now (email,
 * else username - the AuthGuard's actor); its registered name (named: family and given name, null when it has none or only
 * its username - as the page always showed such a colleague by login); the name it is shown to itself (own: the name, else
 * the username, else the login); and whether it is a colleague whose name the institution's radiologists see (an approved,
 * active radiologist).
 */
export type WriterMember = { login: string; named: string | null; own: string; colleague: boolean };
/**
 * The caller's institution's members by account, read once per request, and every login, username and login before the @
 * they have now. `names`: this caller is shown colleagues' names (a radiologist or an administrator, as GET colleagues).
 */
export type WriterDirectory = { names: boolean; bySub: ReadonlyMap<string, WriterMember>; taken: ReadonlySet<string> };
export type Account = { sub?: string | null; actor?: string | null; writers?: WriterDirectory };

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

/** A login and its part before the @, the strings a login is known by. */
export const loginAliases = (login: unknown): string[] =>
  typeof login === 'string' && login ? [...new Set([login, login.split('@')[0]].filter(Boolean))] : [];

/**
 * The one rule for the words a screen shows for who saved, holds or wrote a record (the person, never looked up again by the
 * screen): by the record's account. The caller's own: their name. Another account of the caller's institution: its name when
 * this caller sees colleagues' names and it is one, else its login now. A record whose account is not a member here, or an older
 * record with none: the login it stored - unless that login (or its part before the @) is the caller's or another member's now,
 * then the private-writer words (a login that moved to someone else never names them). Null when there is nothing to show.
 * Whose record it is stays sameAccount's; the stored login and the fields that carry it are unchanged.
 */
export function writerShown(stored: string | null | undefined, storedSub: string | null | undefined, caller: Account): string | null {
  const dir = caller.writers;
  if (sameAccount(storedSub, caller)) {
    const me = dir?.bySub.get(caller.sub as string);
    return me ? me.own : (typeof caller.actor === 'string' && caller.actor ? caller.actor : stored || null);
  }
  const who = typeof storedSub === 'string' && storedSub ? dir?.bySub.get(storedSub) : undefined;
  if (who) return dir!.names && who.colleague && who.named ? who.named : who.login;
  if (typeof stored !== 'string' || !stored) return null;
  const mine = loginAliases(caller.actor);
  return loginAliases(stored).some(alias => mine.includes(alias) || !!dir?.taken.has(alias)) ? PRIVATE_WRITER : stored;
}
