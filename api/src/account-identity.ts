export type Account = { sub?: string | null; actor?: string | null };

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
