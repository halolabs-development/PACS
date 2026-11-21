import { createHash, randomUUID } from 'crypto';
import { APP_ROLES } from './clinician-policy';
import type { AccessEventV1, ImmutableIdentity } from './emr-contract/access-event';

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

/** An older ordinary publication may have landed after the latest intent was created. */
export function rosterOverlap(records: { state: string; createdAt: Date; settledAt: Date | null }[]): boolean {
  const latest = records[0];
  return !!latest && records.slice(1).some(row => row.state === 'done' && row.settledAt
    && row.settledAt.getTime() > latest.createdAt.getTime());
}
