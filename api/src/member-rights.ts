import { createHash, randomUUID } from 'crypto';
import { APP_ROLES } from './clinician-policy';
import type { AccessEventV1, ImmutableIdentity } from './emr-contract/access-event';
import { loginAliases, type WriterDirectory, type WriterMember } from './account-identity';

/** The controller's server-observed request context, never request-body fields. */
export interface RightsRequestFacts {
  surface: string; actor: ImmutableIdentity; roles: readonly string[]; rightsVersion: number;
  institution: string | null; ip: string | null; sessionRef: string | null; requestId: string;
  ipSource?: 'trusted-proxy' | 'request-peer';
}

export function rightsAccessEvent(facts: RightsRequestFacts, affected: ImmutableIdentity,
  version: number, occurredAt: string): AccessEventV1 {
  const nonRecord = { status: 'not-applicable' as const, reason: 'non-record-target' as const };
  return { formatVersion: 1, surface: facts.surface, eventId: randomUUID(),
    userId: { status: 'known', value: facts.actor }, rolesAtTime: { status: 'known', value: facts.roles },
    actingInstitution: facts.institution ? { status: 'known', value: facts.institution }
      : { status: 'unresolved', reason: 'not-observed' },
    managingInstitution: facts.institution ? { status: 'known', value: facts.institution }
      : { status: 'unresolved', reason: 'not-resolved' },
    trustedProxyIp: facts.ip ? { status: 'known', value: { address: facts.ip, source: facts.ipSource ?? 'trusted-proxy' } }
      : { status: 'unresolved', reason: 'not-observed' },
    occurredAt, cause: 'user-view', executor: 'member',
    context: { basis: 'out-of-context', studyId: null, relatedStudyId: null, reason: null },
    targets: [{ kind: 'identity-access', patientLinkSnapshot: nonRecord, studyId: nonRecord,
      recordId: { status: 'known', value: affected.id }, versionId: { status: 'known', value: String(version) } }],
    action: 'modify', result: 'succeeded', requestId: facts.requestId,
    auditLinkId: 'audit:' + randomUUID(), relatedEventId: null };
}

// The same member lock serializes commands, session admission, and proof/refresh writes.
const memberLockKey = (sub: string) => createHash('sha256').update(`${process.env.KC_ISSUER}\n${sub}`).digest().readInt32BE(0);

export async function lockMemberRights(tx: any, sub: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${0x4b494e4d}::int4, ${memberLockKey(sub)}::int4)`;
}

/** Several members in one transaction: always in the order of their lock keys, so two such transactions never wait on
 * each other in a cycle. */
export async function lockMembersInOrder(tx: any, subs: readonly string[]): Promise<void> {
  const ordered = [...new Set(subs)].sort((a, b) => memberLockKey(a) - memberLockKey(b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const sub of ordered) await lockMemberRights(tx, sub);
}

/** An institution's administrators change only under its lock, taken before any member lock: the screen's member
 * changes, the first-administrator command and the administrator replacement all take it, so "who administers X" is
 * decided by one writer at a time. */
export async function lockInstitution(tx: any, institution: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${0x4b494e46}::int4, hashtext(${institution})::int4)`;
}

/**
 * The one place a report screen's signer name comes from: the member's name on the account row (the identity provider's
 * family and given name, or the username when it has none), by account id, read when a version is written and kept with it
 * (report-commit.ts; shown through versionWriterName). It is shown only - the stored login, the account id, the audit and
 * the signed content stay as they are. An account without a row or with a blank name is left out, and the
 * caller keeps what it showed before.
 */
export async function memberNames(db: any, subs: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(subs.filter((sub): sub is string => typeof sub === 'string' && sub.length > 0))];
  if (!wanted.length) return new Map();
  const rows: { sub: string; name: unknown }[] = await db.memberRights.findMany({ where: { sub: { in: wanted } },
    select: { sub: true, name: true } });
  return new Map(rows.filter(row => typeof row.name === 'string' && row.name.trim())
    .map(row => [row.sub, (row.name as string).trim()] as [string, string]));
}

/**
 * The one rule for the name a report version shows for its writer: the member name it was written under
 * (`ReportVersion.authorName`, kept by report-commit.ts from memberNames when the version is written - the login before the @
 * for an account without a name), so renaming the member
 * later does not change who a signed version names. A version without one (written before the name was kept, or a copy kept
 * by Reset or a forced discard) names none, and the screen shows its stored login as before - the account's current name and
 * the time of a rename never stand in for it.
 */
export function versionWriterName(row: { authorName?: unknown } | null | undefined): string | undefined {
  return typeof row?.authorName === 'string' && row.authorName.trim() ? row.authorName.trim() : undefined;
}

/**
 * The caller's institution's members as a writer of a record is shown to this caller (account-identity.ts writerShown), read
 * once at the start of a request that answers who saved, holds or wrote something. The member table is the authority the
 * administrator's commands write (memberUser); a caller of no institution reads none.
 * Colleagues' names are shown as GET colleagues shows them: to a radiologist or an administrator, for an approved, active
 * radiologist of the institution, as the name the member row keeps (its username, else its login, when it has none).
 * The table is put on the caller object itself, read again at every entry: the request's other per-caller state (StudyAccessService
 * keeps its preparations by the caller object) stays with the same object, and an object used again never keeps an older table.
 */
export async function withWriters<C extends { roles?: readonly string[] | null; institution?: string | null; writers?: WriterDirectory }>(
  db: any, c: C): Promise<C> {
  // A store without the member table (a test's partial store) has no members to name; the product store always has it.
  const rows: any[] = c.institution && typeof db?.memberRights?.findMany === 'function' ? await db.memberRights.findMany({ where: { institution: c.institution },
    select: { sub: true, username: true, email: true, name: true, approved: true, suspended: true, institution: true, roles: true } }) : [];
  const bySub = new Map<string, WriterMember>(), taken = new Set<string>();
  for (const row of rows) {
    const login = typeof row.email === 'string' && row.email ? row.email : typeof row.username === 'string' ? row.username : '';
    if (!row.sub || !login) continue;
    const name = (typeof row.name === 'string' && row.name.trim()) || (typeof row.username === 'string' && row.username) || login;
    bySub.set(row.sub, { login, name, colleague: rightsAllow(row) && row.roles.includes('radiologist') });
    for (const alias of [...loginAliases(row.email), ...loginAliases(row.username)]) taken.add(alias);
  }
  const roles = Array.isArray(c.roles) ? c.roles : [];
  c.writers = { names: roles.includes('radiologist') || roles.includes('admin'), bySub, taken };
  return c;
}

export function rightsAllow(row: any): boolean {
  return !!row && row.approved && !row.suspended && !!row.institution
    && row.roles.length > 0 && row.roles.every((role: string) => APP_ROLES.has(role));
}

// The roster keeps provider names; eligibility comes only from this durable authority.
export function rightsUser(row: any) {
  return row && { id: row.sub, username: row.username, email: row.email, emailVerified: row.emailVerified,
    firstName: row.name, lastName: '', enabled: rightsAllow(row), serviceAccountClientId: null,
    groups: row.institution ? [row.institution] : [], roles: row.approved ? row.roles : [] };
}

/**
 * The colleague a picker offers (Assign Reader, Consultation) and a new save names, read from the member table: the
 * authority an administrator's Suspend, Revoke Approval, role and institution changes write. The provider roster is not
 * asked - those commands leave it as it was. No row is no member. Callers judge the person with their own rule over
 * this shape (enabled = rightsAllow, the one institution, the roles of an approved member).
 */
export async function memberUser(db: any, sub: string) {
  return rightsUser(await db.memberRights.findUnique({ where: { sub } })) ?? null;
}

/** Every member row of one institution in that shape, by name; the caller's rule keeps whom it may offer. */
export async function institutionMembers(db: any, institution: string) {
  const rows: any[] = await db.memberRights.findMany({ where: { institution } });
  return rows.map(rightsUser).sort((a, b) => a.firstName.localeCompare(b.firstName) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** An older ordinary publication may have landed after the latest intent was created. */
export function rosterOverlap(records: { state: string; createdAt: Date; settledAt: Date | null }[]): boolean {
  const latest = records[0];
  return !!latest && records.slice(1).some(row => row.state === 'done' && row.settledAt
    && row.settledAt.getTime() > latest.createdAt.getTime());
}
