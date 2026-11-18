import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

/**
 * Which members a hospital administrator may see and change — the one place every member route asks.
 *
 * An administrator works inside the institution of their own verified session. A member belongs to the institution
 * recorded in MemberRights (the durable authority); a member the API has not registered yet is placed by their
 * identity-provider groups. A member without an institution (a self sign-up waiting for approval) is in the shared
 * waiting room: every administrator sees them and may approve them into the administrator's own institution.
 * A member of another institution answers exactly like an unknown id, so an administrator cannot tell whether
 * that person exists.
 */

/** Groups that do not name a single institution: no administrator's scope. */
export const NO_SINGLE_INSTITUTION = Symbol('no-single-institution');
export type MemberInstitution = string | null | typeof NO_SINGLE_INSTITUTION;

export interface ScopeCaller { roles?: readonly string[]; kind?: string; institution?: string | null }

/** The administrator's own institution, or 403 (no admin role, not a member account, or no single institution). */
export function adminInstitution(c: ScopeCaller): string {
  if (!c.roles?.includes('admin')) throw new ForbiddenException('회원 관리는 admin 권한이 필요합니다');
  if (c.kind !== 'member' || typeof c.institution !== 'string' || !c.institution)
    throw new ForbiddenException('소속 기관이 없는 계정은 회원을 관리할 수 없습니다');
  return c.institution;
}

/** MemberRights first; without a row, the provider groups (none = waiting room, two or more = nobody's). */
export function memberInstitution(rights: { institution: string | null } | null | undefined,
  groups?: readonly string[] | null): MemberInstitution {
  if (rights) return rights.institution ?? null;
  const named = groups ?? [];
  if (named.length === 0) return null;
  return named.length === 1 ? named[0] : NO_SINGLE_INSTITUTION;
}

export function inScope(admin: string, institution: MemberInstitution): boolean {
  return institution === null || institution === admin;
}

/** The same answer as an unknown member id. */
export function memberNotFound(): NotFoundException {
  return new NotFoundException('사용자를 찾을 수 없습니다');
}

/** Visible and changeable: the administrator's own institution or the waiting room. */
export function requireInScope(admin: string, institution: MemberInstitution): void {
  if (!inScope(admin, institution)) throw memberNotFound();
}

/** Only the administrator's own institution (not the waiting room): signing keys, identity changes. */
export function requireOwnMember(admin: string, institution: MemberInstitution): void {
  if (institution !== admin) throw memberNotFound();
}

/** An institution being assigned (create, approve, move) can only be the administrator's own. */
export function requireOwnAssignment(admin: string, institution: string): void {
  if (institution !== admin) throw new BadRequestException('회원의 기관은 관리자 자신의 기관으로만 지정할 수 있습니다');
}
