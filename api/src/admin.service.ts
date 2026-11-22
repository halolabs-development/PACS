import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import {
  AUDIT_CANDIDATE_ACTIONS, AUDIT_TARGET_ACTIONS, AuditCursor, AuditLogRow, AuditSource, auditMention, auditPageQuery,
  openAuditCursor, readAuditPage, sealAuditCursor,
} from './admin-audit';
import {
  lockInstitution, lockMemberRights, lockMembersInOrder, rightsAllow, rosterOverlap, rightsAccessEvent, RightsRequestFacts,
} from './member-rights';
import { AuthService, lockWaitExceeded } from './auth.service';
// 역할 목록은 clinician-policy 한 곳에서 온다. 여기서 별도 literal을 두면 guard와 어긋난다.
import { APP_ROLES } from './clinician-policy';
import { IdentityFields, KeycloakService, KeycloakUser, MemberExists, RosterWriteFailure, within } from './keycloak.service';
import { LedgerFailure } from './emr-runtime/store';
import {
  adminInstitution, inScope, memberInstitution, memberNotFound, requireInScope, requireOwnAssignment,
} from './member-scope';
import { Caller } from './pacs.service';
import { PrismaService } from './prisma.service';
import { StudyAccessService } from './study-access.service';
import { sessionEndEvent } from './emr-runtime/auth-events';
import { OutcomeUndetermined } from './first-admin-command';
import type { RequestWorkContext } from './emr-runtime/request-context';
import { adminAuditRead } from './emr-viewing/consumer-read';

export type AdminRequestFacts = RightsRequestFacts & { request: RequestWorkContext };

// 감사 기록 다음 쪽 값의 봉인 키. 프로세스마다 새로 만든다 — API가 다시 시작되면 이어받기는 만료(409)되고
// 처음부터 다시 읽는다. 키를 설정으로 두면 값이 재시작을 넘어 살아남을 이유만 생긴다.
const AUDIT_CURSOR_KEY = randomBytes(32);

/** The operator command's own fields (api/prisma/designate-first-admin.cjs). Never taken from an HTTP body. */
export interface FirstAdminOperator { institution: string; name: string; reason: string }

/** A first-administrator refusal: nothing written, no failure audit (the condition, not the command, failed). */
export class FirstAdminRefusal extends ConflictException {
  constructor(code: string, message: string) { super({ code, message }); }
}

/** Create Member with a username or email that already has an account: nothing was created, the form keeps its input. */
const MEMBER_EXISTS_MESSAGE = {
  username: '같은 아이디의 계정이 이미 있습니다. 다른 아이디로 만드세요.',
  email: '같은 이메일의 계정이 이미 있습니다. 다른 이메일로 만드세요.',
  either: '같은 아이디 또는 이메일의 계정이 이미 있습니다. 아이디나 이메일을 바꿔 다시 만드세요.',
} as const;
const memberExists = (field: 'username' | 'email' | null) =>
  new ConflictException({ code: 'MEMBER_EXISTS', field, message: MEMBER_EXISTS_MESSAGE[field ?? 'either'] });
/** Change Name / Email to an address another account has: the same code and words as Create Member's, nothing changed. */
const emailInUse = () => new ConflictException({ code: 'MEMBER_EXISTS', field: 'email',
  message: '같은 이메일의 계정이 이미 있습니다. 다른 이메일로 바꾸세요.' });

/** The ledger event of an operator command, as for the realm import's service job (member-rights-import.ts). */
const OPERATOR_EVENT = {
  cause: 'service-job', executor: 'service',
  context: { basis: 'service-job', studyId: null, relatedStudyId: null, reason: null },
  trustedProxyIp: { status: 'not-applicable', reason: 'in-process-service' },
} as const;
const OPERATOR_NAME = /^[A-Za-z0-9._@-]{1,64}$/;
/** A signed-in person is not designated: the command never ends a member's session as a service job (the ledger records
 * session ends by the member routes and the idle sweep only). The person signs out, or the session ends, then rerun. */
const signedIn = () => new FirstAdminRefusal('FIRST_ADMIN_TARGET_SIGNED_IN', '대상이 로그인 중입니다. 로그아웃한 뒤 다시 실행하세요');
const activeAdmins = (db: any, institution: string) => db.memberRights.count({
  where: { institution, approved: true, suspended: false, roles: { has: 'admin' } } });
/** The administrator replacement's own ledger surface (emr-contract/routes.ts INTERNAL_SURFACES): the one service job
 * that may end a member's sessions as an isolation. */
export const REPLACEMENT_SURFACE = 'service:sole-admin-replacement';
const OPERATOR_ISSUER = 'urn:kin:pacs:operator';

/** An administrator-replacement refusal: nothing written. */
export class ReplaceAdminRefusal extends ConflictException {
  constructor(code: string, message: string) { super({ code, message }); }
}
/** One run's arguments: a later run with the same ones is the same replacement. */
type ReplacementRun = { institution: string; from: string; to: string; name: string; reason: string };
/** The latest audit rows of this replacement (same institution, pair, operator and reason) — the predecessor's
 * suspension and the successor's approval, written in one transaction — as their parsed details, or null. */
async function savedReplacement(db: any, run: ReplacementRun): Promise<{ from: any; to: any } | null> {
  const rows: { target: string; action: string; detail: string | null }[] = await db.auditLog.findMany({
    where: { target: { in: [run.from, run.to] }, action: { in: ['admin.user.suspend', 'admin.user.approve', 'admin.user.update'] } },
    orderBy: { id: 'desc' } });
  const ours = (row: { detail: string | null }) => {
    const detail = JSON.parse(row.detail ?? '{}'), o = detail?.operator;
    return o && o.by === run.name && o.institution === run.institution && o.reason === run.reason
      && o.replaced?.from === run.from && o.replaced?.to === run.to ? detail : null;
  };
  const from = rows.find(row => row.target === run.from && row.action === 'admin.user.suspend' && ours(row));
  const to = rows.find(row => row.target === run.to && row.action !== 'admin.user.suspend' && ours(row));
  return from && to ? { from: ours(from), to: ours(to) } : null;
}
const adminsOf = (db: any, institution: string): Promise<{ sub: string }[]> => db.memberRights.findMany({
  where: { institution, approved: true, suspended: false, roles: { has: 'admin' } }, select: { sub: true } });
/** The predecessor is X's approved, active administrator, and the only one. */
function replacementGate(fromRow: any, admins: { sub: string }[], from: string, institution: string) {
  if (!fromRow || fromRow.institution !== institution || !fromRow.approved || fromRow.suspended || !fromRow.roles.includes('admin'))
    throw new ReplaceAdminRefusal('REPLACE_ADMIN_FROM_NOT_ADMIN', '전임은 이 기관의 승인·활성 관리자가 아닙니다');
  if (admins.some(admin => admin.sub !== from))
    throw new ReplaceAdminRefusal('REPLACE_ADMIN_NOT_SOLE', '이 기관에는 다른 활성 관리자가 있습니다. 그 관리자가 화면에서 바꿉니다');
}
/**
 * Every condition on the successor, in one place (before the locks, and again under them): their rights row, if any,
 * is X's or the waiting room's and not suspended; they are not isolated; their provider account is a usable person
 * account — enabled, no `gateway` among its effective roles (composites included), in no group but X. Private drafts
 * and report history belong to an account id (owner-identity.ts), so a successor who now has the predecessor's old
 * email or username is not refused: none of the predecessor's rows answers to them.
 */
function successorGate(s: { toRow: any; isolated: boolean; identity: KeycloakUser;
  standing: { groups: string[]; effectiveRoles: string[] }; institution: string }) {
  if (s.toRow?.institution && s.toRow.institution !== s.institution)
    throw new ReplaceAdminRefusal('REPLACE_ADMIN_TO_CONFLICT', '후임은 다른 기관의 회원입니다');
  if (s.toRow?.suspended) throw new ReplaceAdminRefusal('REPLACE_ADMIN_TO_SUSPENDED', '정지된 계정은 후임으로 지정할 수 없습니다');
  if (s.isolated) throw new ReplaceAdminRefusal('REPLACE_ADMIN_TO_ISOLATED', '격리된 계정은 후임으로 지정할 수 없습니다');
  if (!s.identity.enabled || s.standing.effectiveRoles.includes('gateway'))
    throw new ReplaceAdminRefusal('REPLACE_ADMIN_TO_UNUSABLE', '후임 계정은 사용할 수 없는 상태입니다(비활성 또는 게이트웨이 계정)');
  const groups = s.standing.groups;
  if (groups.length && !(groups.length === 1 && groups[0] === s.institution))
    throw new ReplaceAdminRefusal('REPLACE_ADMIN_TO_CONFLICT', '후임의 소속 그룹이 이 기관과 다릅니다');
}
/** How long the identity change waits on the provider while it holds the member's lock (token wait included). */
const IDENTITY_WRITE_MS = 2500, IDENTITY_READ_MS = 1500;
const sameEmail = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
/** The member row's shown name: the provider's family and given name (or the username without either). */
const shownName = (user: { lastName: string; firstName: string; username: string }) =>
  [user.lastName, user.firstName].filter(Boolean).join(' ') || user.username;
const IDENTITY_NOT_CHANGED = () => new ServiceUnavailableException({ code: 'MEMBER_IDENTITY_NOT_CHANGED',
  message: '이메일·이름을 바꾸지 못했습니다. 아무것도 바뀌지 않았습니다. 다시 시도하세요.' });
/** The provider's outcome is not known: no success is claimed and nothing is put back (a late write may still land). */
class IdentityUnconfirmed extends ServiceUnavailableException {
  constructor() { super({ code: 'MEMBER_IDENTITY_UNCONFIRMED',
    message: '바뀌었는지 확인하지 못했습니다. Refresh로 목록을 다시 읽고, 바뀌지 않았으면 같은 값으로 다시 저장하세요.' }); }
}
/** The fields an identity change asks for: an email, a family and given name (together), or both. Only these are checked. */
type IdentityRequest = { version: number; email?: string; firstName?: string; lastName?: string };
function identityRequest(body: any): IdentityRequest {
  if (Object.keys(body).some(key => key !== 'identity' && key !== 'version'))
    throw new BadRequestException('이메일·이름 변경은 다른 회원 변경과 함께 보낼 수 없습니다');
  if (!Number.isSafeInteger(body.version) || body.version < 1) throw new BadRequestException('version이 올바르지 않습니다');
  const value = body.identity;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('identity가 올바르지 않습니다');
  const keys = Object.keys(value);
  if (!keys.length || keys.some(key => !['email', 'firstName', 'lastName'].includes(key)))
    throw new BadRequestException('identity가 올바르지 않습니다');
  if (keys.includes('firstName') !== keys.includes('lastName')) throw new BadRequestException('성과 이름을 함께 보내세요');
  const wanted: IdentityRequest = { version: body.version };
  for (const [key, max] of [['email', 254], ['firstName', 128], ['lastName', 128]] as const) {
    if (!keys.includes(key)) continue;
    if (typeof value[key] === 'string' && /[\x00-\x1f\x7f]/.test(value[key])) throw new BadRequestException(`${key} 길이가 올바르지 않습니다`);
    wanted[key] = text(value[key], key, max);
  }
  if (wanted.email !== undefined && !wanted.email.includes('@')) throw new BadRequestException('email 형식이 올바르지 않습니다');
  return wanted;
}
/** Only an approved member of the administrator's own institution: the change's audit row then belongs to that institution. */
function identityTarget(row: any, admin: string) {
  if (row.institution !== admin || !row.approved)
    throw new BadRequestException('이 기관의 승인된 회원만 이메일·이름을 바꿀 수 있습니다');
}
/** The provider user holds exactly these written fields. */
const holds = (user: KeycloakUser, fields: IdentityFields) => (fields.email === undefined || sameEmail(user.email, fields.email))
  && (fields.emailVerified === undefined || user.emailVerified === fields.emailVerified)
  && (fields.firstName === undefined || user.firstName === fields.firstName)
  && (fields.lastName === undefined || user.lastName === fields.lastName);

function memberSubject(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value.length > 256 || value.trim() !== value) throw new BadRequestException(`${field}가 올바르지 않습니다`);
  return value;
}
function text(value: unknown, field: string, max: number, required = true): string {
  if (value == null && !required) return '';
  if (typeof value !== 'string') throw new BadRequestException(`${field}은(는) 문자열이어야 합니다`);
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > max)
    throw new BadRequestException(`${field} 길이가 올바르지 않습니다`);
  return normalized;
}

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private keycloak: KeycloakService,
    private studyAccess: StudyAccessService,
    private auth: AuthService,
  ) {}

  /** The administrator's own institution: every member route is scoped by it (member-scope.ts). */
  private admin(c: Caller): string {
    return adminInstitution(c);
  }

  private row(user: any) {
    return { id: user.sub, username: user.username, email: user.email, emailVerified: user.emailVerified,
      name: user.name, institution: user.institution, roles: user.roles, version: user.version,
      enabled: !user.suspended, approvalState: user.approved ? 'APPROVED' : 'PENDING' };
  }

  private async member(id: string) {
    const row = await this.prisma.memberRights.findUnique({ where: { sub: id } });
    if (!row) throw new NotFoundException('회원 권한 이관 또는 등록이 필요합니다');
    return row;
  }

  private pendingMember(user: KeycloakUser) {
    return {
      sub: user.id, ...this.identity(user), approved: false, suspended: false, institution: null, roles: [],
      version: null,
    };
  }

  private identity(user: KeycloakUser) {
    return { username: user.username, email: user.email, emailVerified: user.emailVerified,
      name: [user.lastName, user.firstName].filter(Boolean).join(' ') || user.username };
  }

  /**
   * The identity fields a member change writes. A new row, or Change Name / Email (`adopt`): the provider's. Any other
   * change of an existing row keeps the row's email and name — a difference the list marks as unconfirmed is taken only
   * by the explicit, audited change — and refreshes the verification state only for the same address.
   */
  private identityWrite(observed: any, user: KeycloakUser | null, adopt: boolean) {
    if (!user) return {};
    const fresh = this.identity(user);
    if (adopt) return fresh;
    return { username: fresh.username, ...(sameEmail(observed?.email, fresh.email) ? { emailVerified: fresh.emailVerified } : {}) };
  }

  /** The provider identity differs from the member row (email, ignoring case, or the shown name). */
  private identityDiffers(row: any, user: KeycloakUser) {
    return !sameEmail(row.email, user.email) || row.name !== this.identity(user).name;
  }

  private async register(tx: any, user: KeycloakUser) {
    const { version, ...create } = this.pendingMember(user);
    return tx.memberRights.create({ data: create });
  }

  private async managed(id: string, signal?: AbortSignal): Promise<KeycloakUser> {
    const user = await this.keycloak.getUser(id, signal);
    if (!user) throw memberNotFound();
    if (user.serviceAccountClientId)
      throw new ForbiddenException('서비스 계정은 회원 관리 API로 변경할 수 없습니다');
    return user;
  }

  private audit(actor: string, action: string, target: string, detail: any) {
    return this.prisma.auditLog.create({
      data: { actor: actor || 'unknown', action, target, detail: JSON.stringify(detail) },
    });
  }

  private roles(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.some(role => typeof role !== 'string'))
      throw new BadRequestException('roles는 한 개 이상의 역할 배열이어야 합니다');
    const roles = [...new Set(value.map(role => role.trim()))];
    if (roles.some(role => !APP_ROLES.has(role)))
      throw new BadRequestException('허용되지 않은 역할입니다');
    return roles;
  }

  /** An institution being assigned: a real institution group, and only the administrator's own. */
  private async institution(value: unknown, admin: string): Promise<string> {
    const institution = text(value, 'institution', 128);
    const allowed = await this.keycloak.institutions();
    if (!allowed.includes(institution)) throw new BadRequestException('허용되지 않은 기관입니다');
    requireOwnAssignment(admin, institution);
    return institution;
  }

  async listUsers(pageValue: unknown, c: Caller) {
    const admin = this.admin(c);
    const page = pageValue == null || pageValue === '' ? 1 : Number(pageValue);
    if (!Number.isInteger(page) || page < 1) throw new BadRequestException('page는 1 이상의 정수여야 합니다');
    const { realmUsers, pageSize } = await this.keycloak.listUsers(page);
    const rightsRows = await this.prisma.memberRights.findMany({ where: { sub: { in: realmUsers.map(user => user.id) } } });
    const bySub = new Map(rightsRows.map(row => [row.sub, row]));
    // Scope before paging: counts and pages describe only what this administrator may see.
    const visible = realmUsers.filter(user => inScope(admin, memberInstitution(bySub.get(user.id), user.groups)));
    const first = (page - 1) * pageSize;
    const users = [];
    for (const user of visible.slice(first, first + pageSize)) {
      const rights = bySub.get(user.id);
      if (!rights) {
        users.push({ ...this.row(this.pendingMember(user)), rosterUnconfirmed: false });
        continue;
      }
      // Change Name / Email opens on the provider's current values (only for a member it may change); the shown row stays
      // the member row's, and a provider identity that differs from it is marked.
      const editable = rights.approved && rights.institution === admin;
      users.push({ ...this.row(rights), rosterUnconfirmed: await this.rosterUnconfirmed(user.id),
        identityUnconfirmed: this.identityDiffers(rights, user),
        ...(editable ? { provider: { email: user.email, firstName: user.firstName, lastName: user.lastName } } : {}) });
    }
    const pendingCount = visible.filter(user => !bySub.get(user.id)?.approved).length;
    const response = { page, pageSize, total: visible.length, pendingCount, users };
    await this.audit(c.actor, 'admin.user.list', 'admin-users', {
      page, count: response.users.length, pendingCount: response.pendingCount, institution: admin,
    });
    return response;
  }

  private async rosterUnconfirmed(id: string, db: any = this.prisma) {
    const records = await db.providerChange.findMany({ where: { kind: 'credentials', sub: id }, orderBy: { id: 'desc' } });
    const ordinary = records.filter(row => row.target === id);
    const uncertain = (row: any) => row?.state === 'unknown' || row?.state === 'void';
    return uncertain(ordinary[0]) || records.some(row => row.target === 'legacy-enable:' + id && uncertain(row))
      || rosterOverlap(ordinary);
  }

  async createUser(body: any, c: Caller, facts: AdminRequestFacts) {
    const admin = this.admin(c);
    if (!facts?.request || facts.actor.subject !== c.sub)
      throw new ServiceUnavailableException('회원 변경 요청의 접속 사실을 확인할 수 없습니다');
    const username = text(body?.username, 'username', 128);
    if (username.startsWith('service-account-'))
      throw new BadRequestException('Keycloak 서비스 계정 예약 이름은 사용할 수 없습니다');
    const email = text(body?.email, 'email', 254);
    if (!email.includes('@')) throw new BadRequestException('email 형식이 올바르지 않습니다');
    const firstName = text(body?.firstName ?? body?.name, 'firstName', 128);
    const lastName = text(body?.lastName, 'lastName', 128);
    if (body?.verificationOverride !== undefined && typeof body.verificationOverride !== 'boolean')
      throw new BadRequestException('verificationOverride는 boolean이어야 합니다');
    const verificationOverride = body?.verificationOverride !== false;
    if (!verificationOverride && (body?.institution !== undefined || body?.roles !== undefined))
      throw new BadRequestException('기관·역할을 함께 지정하려면 verificationOverride:true가 필요합니다');
    if (verificationOverride && (body?.institution === undefined || body?.roles === undefined))
      throw new BadRequestException('대면 확인 생성에는 institution과 roles가 모두 필요합니다');
    // Validate scope before provider creation, so invalid input cannot leave a disabled orphan.
    if (verificationOverride) {
      if (!facts || facts.actor.subject !== c.sub)
        throw new ServiceUnavailableException('회원 변경 요청의 접속 사실을 확인할 수 없습니다');
      await this.institution(body.institution, admin);
      this.roles(body.roles);
    }

    const temporaryPassword = randomBytes(18).toString('base64url') + 'aA1!';
    let created: KeycloakUser | null = null;
    try {
      await facts.request.requireCurrent();
      created = await this.keycloak.createUser({ username, email, firstName, lastName });
      // 렐름에 default group/role이 나중에 생겨도 기본 생성은 항상 PENDING에서 시작한다.
      await this.keycloak.setGroups(created.id, []);
      await this.keycloak.setRoles(created.id, []);
      await this.keycloak.resetPassword(created.id, 'temp', temporaryPassword);
      await this.keycloak.setEnabled(created.id, true);
      let after;
      if (verificationOverride) {
        after = await this.patchUser(created.id, { institution: body.institution, roles: body.roles, verificationOverride: true, enabled: true }, c, facts);
      } else {
        after = await this.prisma.$transaction(async tx => {
          await lockMemberRights(tx, created!.id);
          await facts.request.requireCurrent(tx);
          const registered = await tx.memberRights.findUnique({ where: { sub: created!.id } });
          // Another institution may have approved the new waiting member already: then no password is shown here.
          if (registered) requireInScope(admin, memberInstitution(registered));
          return this.row(registered ?? await this.register(tx, created!));
        });
      }
      await this.audit(c.actor, 'admin.user.create', created.id, {
        before: null, after, verificationOverride,
      });
      return { ...after, temporaryPassword };
    } catch (error) {
      if (error instanceof MemberExists) throw memberExists(error.field);
      if (!created) throw error;
      let after: any = null;
      try { after = this.row(await this.member(created.id)); } catch {}
      await this.audit(c.actor, 'admin.user.create.failed', created.id, {
        before: null, after, verificationOverride, failed: true,
      });
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException('회원 생성의 일부 처리를 완료하지 못했습니다');
    }
  }

  async patchUser(id: string, body: any, c: Caller, facts: AdminRequestFacts, operator?: FirstAdminOperator) {
    // Change Name / Email arrives through the same member route and gate; it is its own change (changeIdentity).
    if (!operator && body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'identity'))
      return this.changeIdentity(id, body, c, facts);
    const admin = this.admin(c);
    if (!facts?.request || facts.actor.subject !== c.sub)
      throw new ServiceUnavailableException('회원 변경 요청의 접속 사실을 확인할 수 없습니다');
    const existing = await this.prisma.memberRights.findUnique({ where: { sub: id } });
    const identityToRegister = existing ? null : await this.managed(id);
    requireInScope(admin, memberInstitution(existing, identityToRegister?.groups));
    const observed = existing ?? this.pendingMember(identityToRegister!);
    const before = this.row(observed);
    if (existing && body?.version !== undefined && body.version !== observed.version)
      throw new ConflictException({ code: 'MEMBER_VERSION_CONFLICT', message: '회원 상태가 바뀌었습니다. 새로고침하세요' });
    if (body?.enabled !== undefined && typeof body.enabled !== 'boolean')
      throw new BadRequestException('enabled는 boolean이어야 합니다');
    if (body?.verificationOverride !== undefined && typeof body.verificationOverride !== 'boolean')
      throw new BadRequestException('verificationOverride는 boolean이어야 합니다');
    if (body?.approvalState !== undefined && !['APPROVED', 'PENDING'].includes(body.approvalState))
      throw new BadRequestException('approvalState는 APPROVED 또는 PENDING이어야 합니다');
    const approvalMutation = body?.approvalState === 'APPROVED'
      || body?.institution !== undefined || body?.roles !== undefined;
    if (body?.verificationOverride === true && !approvalMutation)
      throw new BadRequestException('verificationOverride는 승인·자격 변경에만 사용할 수 있습니다');
    if (body?.approvalState === 'PENDING' && body?.enabled !== undefined)
      throw new BadRequestException('승인 취소와 활성 상태 변경을 섞을 수 없습니다');

    if (c.sub === id) {
      if (body?.enabled === false) throw new BadRequestException('자기 자신을 정지할 수 없습니다');
      if (body?.approvalState === 'PENDING') throw new BadRequestException('자기 자신의 승인을 취소할 수 없습니다');
      if (body?.roles !== undefined && !this.roles(body.roles).includes('admin'))
        throw new BadRequestException('자기 자신의 admin 역할을 제거할 수 없습니다');
    }

    let action = 'update';
    let preReadError: unknown;
    let institution = observed.institution, roles = observed.roles;
    let approved = observed.approved, suspended = observed.suspended;
    if (body?.approvalState === 'PENDING') {
      if (body?.institution !== undefined || body?.roles !== undefined)
        throw new BadRequestException('승인 취소와 기관·역할 변경을 한 요청에 섞을 수 없습니다');
      // Revoking returns the member to PENDING, suspends the account and clears institution and roles (the button says
      // so): the member leaves this institution for the waiting room, from which an administrator may approve them again.
      action = 'unapprove'; approved = false; suspended = true; institution = null; roles = [];
    } else if (approvalMutation) {
      action = observed.approved ? 'update' : 'approve';
      try { institution = await this.institution(body?.institution ?? observed.institution, admin); }
      catch (error) { preReadError = error; }
      roles = this.roles(body?.roles ?? observed.roles);
      approved = true;
      if (body?.enabled !== undefined) suspended = !body.enabled;
    } else if (body?.enabled === false) {
      action = 'suspend'; suspended = true;
    } else if (body?.enabled === true) {
      action = 'activate';
      if (!rightsAllow({ ...observed, suspended: false }))
        throw new BadRequestException('승인된 회원만 활성화할 수 있습니다');
      suspended = false;
    } else throw new BadRequestException('변경할 회원 상태가 없습니다');

    // Remote reads never hold the member lock. Preserve refusals so a newer committed version
    // wins even during a provider outage; none of these refusals crosses the command/audit boundary.
    let identity = identityToRegister;
    if (!preReadError) {
      try {
        identity ??= approvalMutation ? await this.managed(id)
          : await this.managed(id, within(300)).catch(() => null);
        if (approvalMutation && !identity!.emailVerified && body?.verificationOverride === false)
          throw new BadRequestException('이메일 검증이 끝나지 않은 사용자는 승인할 수 없습니다');
        // The operator's group check holds for the identity this command actually uses (it may be a second read).
        if (operator && identity!.groups.length && !(identity!.groups.length === 1 && identity!.groups[0] === operator.institution))
          throw new FirstAdminRefusal('FIRST_ADMIN_TARGET_CONFLICT', '대상의 소속 그룹이 이 기관과 다릅니다');
      } catch (error) { preReadError = error; }
    }

    // Record the approval that happened, including the default path without a checkbox.
    const verificationOverride = approvalMutation && identity?.emailVerified === false && body?.verificationOverride !== false;
    const work = facts.request.work;
    try {
      // An operator command's actor is a service identity; the member keeps the realm issuer.
      const issuer = operator ? process.env.KC_ISSUER : facts.actor.issuer;
      if (!issuer) throw new Error('Missing member identity issuer');
      const affected = { issuer, subject: id, id: await work.resolveRequestIdentity(issuer, id) };
      const committed = await work.transactionWithRecords(async (tx, record) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        // Every member change of X runs under X's lock, before the member lock (lockInstitution): an administrator
        // replacement or a first-administrator designation of X never interleaves with it.
        await lockInstitution(tx, operator ? operator.institution : admin);
        // The first-administrator condition is decided under the institution lock, before the member lock.
        if (operator) await this.firstAdminGate(tx, id, operator.institution);
        await lockMemberRights(tx, id);
        // Session admission holds this member lock: no sign-in can commit between this check and the session read below.
        if (operator && await tx.authSession.count({ where: { sub: id } })) throw signedIn();
        const current = await tx.memberRights.findUnique({ where: { sub: id } });
        // Scope on the locked row first: a member another institution took meanwhile is unknown here, not a conflict.
        if (current) requireInScope(admin, memberInstitution(current));
        if (existing ? current?.version !== observed.version : !!current)
          throw new ConflictException({ code: 'MEMBER_VERSION_CONFLICT', message: '회원 상태가 바뀌었습니다. 새로고침하세요' });
        if (preReadError) throw preReadError;
        await facts.request.requireCurrent(tx);
        // The observed version precedes the remote pre-read. CAS rejects an older command after any
        // newer command commits, so its captured identity cannot rewind that newer identity. No I/O holds this lock.
        return this.applyMember(tx, record, { id, register: existing ? null : identity!, version: existing ? observed.version : 1,
          observed, identity, fields: { approved, suspended, institution, roles }, action, before, verificationOverride,
          approvalMutation, affected, actor: c.actor, facts, service: !!operator,
          operatorDetail: operator ? { by: operator.name, institution: operator.institution, reason: operator.reason } : null });
      }, { maxWait: 4000, timeout: 8000 });
      if (committed.change) this.auth.publishCredentials({ id: committed.change.id, kind: 'credentials', target: id }, institution!, roles);
      return { ...committed.after, rosterUnconfirmed: committed.rosterUnconfirmed };
    } catch (error) {
      if (error === preReadError || error instanceof FirstAdminRefusal) throw error;
      await this.audit(c.actor, 'admin.user.patch.failed', id, {
        before, after: null, verificationOverride, failed: true,
      });
      if (lockWaitExceeded(error))
        throw new ConflictException({ code: 'MEMBER_BUSY', message: '다른 요청이 회원 상태를 변경하고 있습니다. 잠시 후 다시 시도하세요' });
      throw error;
    }
  }

  /**
   * Change Name / Email: an administrator corrects an approved member's email and/or name, in the identity provider and
   * the member row together. The rule: the change happened when, and only when, the member row's version CAS commits it
   * (with its one audit row `admin.user.identity`, old value -> new value of each field that changed). Under the
   * institution's and the member's locks — taken before the provider is written, so two administrators' changes of one
   * member never interleave — the provider is written (bounded; the caller's authorization checked just before it is
   * sent), read again, and the row committed through applyMember (version, re-login boundary, every product session of
   * the member ended, ledger event, audit row). A provider refusal changes nothing. A lost provider answer that the
   * read-back does not settle, or a lost commit answer that the own audit row does not settle, is reported unconfirmed and
   * nothing is put back. A confirmed non-commit puts back what this request wrote, under the same locks and only while
   * the member and the provider still hold this request's values. The list marks a member whose provider identity differs
   * from the row; saving the same values again makes them one. Ownership is the account id (owner-identity.ts): the member's
   * drafts, saved searches and templates stay theirs, and no stored history is rewritten.
   */
  async changeIdentity(id: string, body: any, c: Caller, facts: AdminRequestFacts) {
    const admin = this.admin(c);
    if (!facts?.request || facts.actor.subject !== c.sub)
      throw new ServiceUnavailableException('회원 변경 요청의 접속 사실을 확인할 수 없습니다');
    const wanted = identityRequest(body);
    // The database first: no row and another institution answer alike, before any provider call.
    const existing = await this.prisma.memberRights.findUnique({ where: { sub: id } });
    if (!existing) throw memberNotFound();
    requireInScope(admin, memberInstitution(existing));
    identityTarget(existing, admin);
    const conflict = () => new ConflictException({ code: 'MEMBER_VERSION_CONFLICT', message: '회원 상태가 바뀌었습니다. 새로고침하세요' });
    if (wanted.version !== existing.version) throw conflict();
    const account = await this.managed(id).catch(error => {
      if (!(error instanceof RosterWriteFailure)) throw error;
      throw new ServiceUnavailableException({ code: 'MEMBER_DIRECTORY_UNAVAILABLE', message: '회원 명부를 읽지 못했습니다. 잠시 뒤 다시 시도하세요.' });
    });
    const target = { email: wanted.email ?? account.email, firstName: wanted.firstName ?? account.firstName,
      lastName: wanted.lastName ?? account.lastName };
    const emailChanging = !sameEmail(account.email, target.email);
    const nameChanging = account.firstName !== target.firstName || account.lastName !== target.lastName;
    const rowSame = sameEmail(existing.email, target.email) && existing.name === shownName({ ...target, username: account.username });
    if (!emailChanging && !nameChanging && rowSame) throw new BadRequestException('바뀐 값이 없습니다');
    if (emailChanging && (await this.keycloak.accountsWithEmail(target.email).catch(() => {
      throw new ServiceUnavailableException({ code: 'MEMBER_DIRECTORY_UNAVAILABLE', message: '회원 명부를 읽지 못했습니다. 잠시 뒤 다시 시도하세요.' });
    })).some(other => other !== id)) throw emailInUse();
    // What this request writes to the provider, and what it puts back on a confirmed non-commit.
    const send: IdentityFields = { ...(emailChanging ? { email: target.email, emailVerified: false } : {}),
      ...(nameChanging ? { firstName: target.firstName, lastName: target.lastName } : {}) };
    const back: IdentityFields = { ...(emailChanging ? { email: account.email, emailVerified: account.emailVerified } : {}),
      ...(nameChanging ? { firstName: account.firstName, lastName: account.lastName } : {}) };
    const issuer = facts.actor.issuer;
    if (!issuer) throw new Error('Missing member identity issuer');
    const affected = { issuer, subject: id, id: await facts.request.work.resolveRequestIdentity(issuer, id) };
    // `committing`: decided and about to commit (a failure from here on is this request's to record, with or without a
    // provider write).
    let sent = false, committing = false, auditId: number | null = null;
    try {
      const committed = await facts.request.work.transactionWithRecords(async (tx: any, record: any) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        await lockInstitution(tx, admin);
        await lockMemberRights(tx, id);
        const current = await tx.memberRights.findUnique({ where: { sub: id } });
        if (!current) throw memberNotFound();
        requireInScope(admin, memberInstitution(current));
        identityTarget(current, admin);
        if (current.version !== existing.version) throw conflict();
        await facts.request.requireCurrent(tx);
        let identity = account;
        if (Object.keys(send).length) {
          const answer = await this.keycloak.updateIdentity(id, send, within(IDENTITY_WRITE_MS), async () => {
            await facts.request.requireCurrent(tx);
            sent = true;
          });
          if (answer.state === 'void') {
            sent = false;
            // A 409 to an email change is the address another account has; to a name change it says nothing we can name.
            if (answer.outcome === 'http_409' && emailChanging) throw emailInUse();
            throw IDENTITY_NOT_CHANGED();
          }
          const reread = await this.keycloak.getUser(id, within(IDENTITY_READ_MS)).catch(() => null);
          if (!reread || !holds(reread, send)) throw new IdentityUnconfirmed();
          identity = reread;
        }
        // Old -> new of each field that changed in either store: the member row's value when the row changed, otherwise
        // the login account's (a correction of the account alone). The name is the shown name, or — when only the family
        // and given parts moved — those parts.
        const name = shownName(identity), changed: Record<string, { from: string; to: string }> = {};
        if (current.email !== identity.email) changed.email = { from: current.email, to: identity.email };
        else if (account.email !== identity.email) changed.email = { from: account.email, to: identity.email };
        const parts = (u: { lastName: string; firstName: string }) => `${u.lastName} / ${u.firstName}`;
        if (current.name !== name) changed.name = { from: current.name, to: name };
        else if (account.firstName !== identity.firstName || account.lastName !== identity.lastName)
          changed.name = { from: parts(account), to: parts(identity) };
        if (!Object.keys(changed).length) throw new BadRequestException('바뀐 값이 없습니다');
        committing = true;
        const [{ boundary }] = await tx.$queryRaw<{ boundary: Date }[]>`SELECT clock_timestamp() AS boundary`;
        const result = await this.applyMember(tx, record, { id, register: null, version: current.version, observed: current,
          identity, adopt: true, fields: { approved: current.approved, suspended: current.suspended, institution: current.institution,
            roles: current.roles }, action: 'identity', before: this.row(current), verificationOverride: false,
          approvalMutation: false, affected, actor: c.actor, facts, service: false, operatorDetail: null, boundary,
          extraDetail: { identity: changed } });
        auditId = result.auditId;
        return result;
      }, { maxWait: 4000, timeout: 10000 });
      return { ...committed.after, rosterUnconfirmed: committed.rosterUnconfirmed };
    } catch (error) {
      if (error instanceof IdentityUnconfirmed) throw error;
      if (error instanceof LedgerFailure && error.code === 'CommitUnknown') {
        // Settled by this request's own audit row alone: written in its transaction, it exists only if that committed.
        const saved = auditId === null ? null : await this.prisma.auditLog.findFirst({
          where: { id: auditId, target: id, action: 'admin.user.identity' } }).catch(() => null);
        if (!saved) throw new IdentityUnconfirmed();
        const after = JSON.parse(saved.detail ?? '{}')?.after;
        return { ...after, rosterUnconfirmed: await this.rosterUnconfirmed(id).catch(() => true) };
      }
      // Not committed: put back what this request wrote, then record the failure.
      if (sent) await this.restoreIdentity(id, admin, existing.version, send, back);
      if (sent || committing) {
        await this.audit(c.actor, 'admin.user.patch.failed', id, { before: this.row(existing), after: null,
          verificationOverride: false, failed: true }).catch(() => undefined);
      }
      if (lockWaitExceeded(error))
        throw new ConflictException({ code: 'MEMBER_BUSY', message: '다른 요청이 회원 상태를 변경하고 있습니다. 잠시 후 다시 시도하세요' });
      throw error;
    }
  }

  /**
   * After a confirmed non-commit of changeIdentity: under the same locks, and only while the member row is as the request
   * found it (same institution, approved, same version) and the provider still holds what the request wrote, write back
   * those fields. Anything else (another administrator's change committed meanwhile, the provider changed, a failure)
   * leaves it: the list then marks the member, and the same save makes the two one.
   */
  private async restoreIdentity(id: string, admin: string, version: number, wrote: IdentityFields, back: IdentityFields) {
    try {
      await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        await lockInstitution(tx, admin);
        await lockMemberRights(tx, id);
        const row = await tx.memberRights.findUnique({ where: { sub: id } });
        if (!row || row.institution !== admin || !row.approved || row.version !== version) return;
        const now = await this.keycloak.getUser(id, within(IDENTITY_READ_MS));
        if (!now || !holds(now, wrote)) return;
        await this.keycloak.updateIdentity(id, back, within(IDENTITY_WRITE_MS), async () => {});
        // Read back: a put-back that did not land leaves the member marked in the list (nothing else to do here).
        const after = await this.keycloak.getUser(id, within(IDENTITY_READ_MS)).catch(() => null);
        if (!after || !holds(after, back)) console.warn('[KIN API] identity put-back not confirmed by the read-back');
      }, { maxWait: 4000, timeout: 10000 });
    } catch {}
  }

  /**
   * One member's rights change inside the caller's records transaction, after the caller has locked the member and decided
   * the change on the locked row: the ledger event, the version CAS, the re-login boundary, every product session of the
   * member ended (isolation), the audit row and — for an approval or a change of institution/roles — the roster intent.
   * Every member change of this service goes through here (the screen's PATCH, and the operator commands).
   * `service`: an operator command's in-process service job (its events carry the service executor, never an address).
   */
  private async applyMember(tx: any, record: any, w: {
    id: string; register: KeycloakUser | null; version: number; observed: any; identity: KeycloakUser | null;
    fields: { approved: boolean; suspended: boolean; institution: string | null; roles: string[] };
    action: string; before: ReturnType<AdminService['row']>; verificationOverride: boolean; approvalMutation: boolean;
    affected: { issuer: string; subject: string; id: string }; actor: string; facts: AdminRequestFacts; service: boolean;
    operatorDetail: Record<string, unknown> | null;
    /** The executor is the operator's service identity alone (the replacement): its rights events record no member
     * roles and no acting institution, as its session ends do; the institution changed stays the managed one. */
    operatorIdentity?: boolean;
    /** The re-login boundary the caller read from the database; by default this transaction's `now()`. */
    boundary?: Date;
    /** Change Name / Email: the row takes the provider's email and name. Otherwise an existing row keeps its own (a
     * difference the list marks is taken only by that explicit, audited change). */
    adopt?: boolean;
    /** More of the audit row's detail (Change Name / Email: `identity`, old -> new of each changed field). */
    extraDetail?: Record<string, unknown>;
  }): Promise<{ after: ReturnType<AdminService['row']>; change: any; rosterUnconfirmed: boolean; auditId: number }> {
    const { id, facts } = w;
    let result: { after: ReturnType<AdminService['row']>; change: any; rosterUnconfirmed: boolean; auditId: number };
    const event = rightsAccessEvent(facts, w.affected, w.version + 1, new Date().toISOString());
    if (w.service) Object.assign(event, OPERATOR_EVENT);
    if (w.operatorIdentity) Object.assign(event, { rolesAtTime: { status: 'known', value: [] },
      actingInstitution: { status: 'not-applicable', reason: 'in-process-service' } });
    await record(event, async () => {
      if (w.register) await this.register(tx, w.register);
      const boundary = w.boundary ?? (await tx.$queryRaw<{ boundary: Date }[]>`SELECT now() AS boundary`)[0].boundary;
      const { count } = await tx.memberRights.updateMany({ where: { sub: id, version: w.version }, data: {
        ...w.fields, ...this.identityWrite(w.observed, w.identity, !!w.register || !!w.adopt),
        version: { increment: 1 }, newAuthAfter: boundary,
      } });
      if (count !== 1) throw new ConflictException({ code: 'MEMBER_VERSION_CONFLICT', message: '회원 상태가 바뀌었습니다. 새로고침하세요' });
      const sessions = await tx.authSession.findMany({ where: { sub: id } });
      for (const session of sessions) {
        const ending = sessionEndEvent({ status: 'known', value: w.affected }, {
          surface: facts.surface, roles: facts.roles, rightsVersion: facts.rightsVersion,
          institution: facts.institution, auditRef: session.auditRef, ip: facts.ip,
          occurredAt: event.occurredAt, endCause: 'isolation', trigger: null,
          ...(w.service ? { service: { status: 'known' as const, value: facts.actor } } : {}),
        });
        ending.userId = { status: 'known', value: facts.actor };
        ending.trustedProxyIp = event.trustedProxyIp;
        ending.requestId = facts.requestId;
        ending.managingInstitution = session.institution ? { status: 'known', value: session.institution }
          : { status: 'unresolved', reason: 'not-resolved' };
        await record(ending, async () => {
          const deleted = await tx.authSession.deleteMany({ where: { sid: session.sid } });
          if (deleted.count !== 1) return null;
          const audit = await tx.auditLog.create({ data: { at: new Date(event.occurredAt),
            actor: w.observed.email || w.observed.username, action: 'auth.logout', target: id,
            detail: JSON.stringify({ institution: session.institution, ip: facts.ip, dataSubject: null, cause: 'isolation' }) } });
          return { kind: 'AuditLog', id: String(audit.id), version: null };
        });
      }
      const after = this.row(await tx.memberRights.findUnique({ where: { sub: id } }));
      const audit = await tx.auditLog.create({ data: { at: new Date(event.occurredAt),
        actor: w.actor, action: `admin.user.${w.action}`, target: id,
        detail: JSON.stringify({ before: w.before, after, verificationOverride: w.verificationOverride,
          ...(w.operatorDetail ? { operator: w.operatorDetail } : {}), ...(w.extraDetail ?? {}) }) } });
      const change = w.approvalMutation ? await tx.providerChange.create({ data: {
        kind: 'credentials', target: id, sub: id, generation: after.version, state: 'unknown', createdAt: new Date(),
      } }) : null;
      result = { after, change, rosterUnconfirmed: !!change || await this.rosterUnconfirmed(id, tx), auditId: audit.id };
      return { kind: 'AuditLog', id: String(audit.id), version: null };
    });
    return result!;
  }

  /**
   * Operator command only (api/prisma/designate-first-admin.cjs; no controller calls it): make one person the first
   * administrator of institution X while X has no approved, active administrator. It is the ordinary approval command
   * (patchUser: rights, version, re-login boundary, session end, audit, roster intent) run for X, with the operator,
   * institution and reason in its audit row. Refused without any write: X unknown or already administered; a service
   * account; a person of another institution or of several; provider groups that disagree with X; a suspended or
   * isolated account, or one that is signed in. Roles are the person's current X roles plus admin — nothing else is chosen here, and passwords,
   * suspension and the account's own OTP are untouched. Concurrent or repeated runs: the institution lock and the
   * re-read under it let one succeed.
   */
  async designateFirstAdmin(sub: string, institutionValue: string, operator: { name: string; reason: string },
    makeFacts: () => Promise<AdminRequestFacts>) {
    const institution = text(institutionValue, 'institution', 128);
    if (typeof sub !== 'string' || !sub || sub.length > 256) throw new BadRequestException('subject가 올바르지 않습니다');
    if (!OPERATOR_NAME.test(operator?.name ?? '')) throw new BadRequestException('operator가 올바르지 않습니다');
    const reason = text(operator?.reason, 'reason', 500);
    if (/[\x00-\x1f\x7f]/.test(reason)) throw new BadRequestException('reason 길이가 올바르지 않습니다');
    if (!(await this.keycloak.institutions()).includes(institution)) throw new BadRequestException('허용되지 않은 기관입니다');
    if (await activeAdmins(this.prisma, institution))
      throw new FirstAdminRefusal('FIRST_ADMIN_EXISTS', '이 기관에는 이미 활성 관리자가 있습니다');
    const identity = await this.managed(sub);
    if (identity.groups.length && !(identity.groups.length === 1 && identity.groups[0] === institution))
      throw new FirstAdminRefusal('FIRST_ADMIN_TARGET_CONFLICT', '대상의 소속 그룹이 이 기관과 다릅니다');
    const existing = await this.prisma.memberRights.findUnique({ where: { sub } });
    if (existing?.institution && existing.institution !== institution)
      throw new FirstAdminRefusal('FIRST_ADMIN_TARGET_CONFLICT', '대상은 다른 기관의 회원입니다');
    if (existing?.suspended) throw new FirstAdminRefusal('FIRST_ADMIN_TARGET_SUSPENDED', '정지된 계정은 지정할 수 없습니다');
    if (await this.prisma.memberIsolation.findUnique({ where: { sub } }))
      throw new FirstAdminRefusal('FIRST_ADMIN_TARGET_ISOLATED', '격리된 계정은 지정할 수 없습니다');
    if (await this.prisma.authSession.count({ where: { sub } })) throw signedIn();
    const roles = [...new Set([...(existing?.approved ? existing.roles : []), 'admin'])];
    // Request facts (and the operator's ledger identity) only after every refusal above: a refusal writes nothing.
    const facts = await makeFacts();
    const c: Caller = { sub: facts.actor.subject, actor: 'operator:' + operator.name, roles: ['admin'], institution, kind: 'member' };
    return this.patchUser(sub, { approvalState: 'APPROVED', institution, roles, verificationOverride: true,
      ...(existing ? { version: existing.version } : {}) }, c, facts, { institution, name: operator.name, reason });
  }

  /**
   * Operator command only (api/prisma/replace-sole-admin.cjs; no controller calls it): the sole administrator of X left
   * while their rights are live; after the hospital's request is confirmed, an operator names the successor.
   * The rule: decided only on the rights rows read again under X's lock — at that moment X's approved, active
   * administrators are exactly the predecessor, and the successor is a person of X (or a waiting member whose provider
   * groups are none or X alone), neither suspended nor isolated, and not the predecessor. That decision and every write
   * run in one transaction under that lock: the predecessor suspended as the screen's Suspend (institution and roles
   * kept; every product session ended), the successor approved as the first-administrator command does (current X
   * roles plus admin; every product session ended), two audit rows naming the operator, X, the reason and the pair, and
   * one roster intent (the successor's). Reads outside the lock only refuse early: a refusal writes nothing — no rights,
   * session, audit, roster intent or ledger identity. The predecessor's drafts and history are not touched.
   * `work` is the records work of this run; the identities of the operator and both members are resolved inside the
   * transaction, after the decision.
   */
  async replaceSoleAdmin(fromValue: unknown, toValue: unknown, institutionValue: unknown,
    operator: { name: unknown; reason: unknown }, work: RequestWorkContext['work']) {
    const institution = text(institutionValue, 'institution', 128);
    const from = memberSubject(fromValue, 'from'), to = memberSubject(toValue, 'to');
    if (typeof operator?.name !== 'string' || !OPERATOR_NAME.test(operator.name)) throw new BadRequestException('operator가 올바르지 않습니다');
    // Control characters are refused before trimming would drop a leading or trailing line break.
    if (typeof operator?.reason === 'string' && /[\x00-\x1f\x7f]/.test(operator.reason))
      throw new BadRequestException('reason 길이가 올바르지 않습니다');
    const reason = text(operator?.reason, 'reason', 500);
    const name = operator.name;
    if (from === to) throw new BadRequestException('전임과 후임이 같습니다');
    const run: ReplacementRun = { institution, from, to, name, reason };
    // The database first, the provider after: an earlier run of this same command is told from the database alone.
    // Unreadable, the state is unknown — an earlier run may have replaced them. Saved by an earlier run (whatever
    // happened since), it is never applied again: the rerun reports it.
    let fromRow: any, admins: { sub: string }[], saved: boolean;
    try {
      fromRow = await this.prisma.memberRights.findUnique({ where: { sub: from } });
      admins = await adminsOf(this.prisma, institution);
      saved = !!await savedReplacement(this.prisma, run);
    } catch { throw new OutcomeUndetermined(); }
    if (saved) {
      const again = await this.replacementAgain(run);
      if (again) return again;
    }
    if (!(await this.keycloak.institutions()).includes(institution)) throw new BadRequestException('허용되지 않은 기관입니다');
    // The predecessor is judged on the rights row alone: a departed person's provider account may already be gone.
    try { replacementGate(fromRow, admins, from, institution); }
    catch (error) { return this.againOr(run, error); }
    // The successor's provider account, then — the last remote read, strict — their groups and effective roles. The
    // identity registered for them is this one, with those groups.
    const account = await this.managed(to);
    const standing = await this.keycloak.memberStanding(to);
    const identity: KeycloakUser = { ...account, groups: standing.groups };
    const toRow = await this.prisma.memberRights.findUnique({ where: { sub: to } });
    successorGate({ toRow, isolated: !!await this.prisma.memberIsolation.findUnique({ where: { sub: to } }),
      identity, standing, institution });
    const issuer = process.env.KC_ISSUER;
    if (!issuer) throw new Error('Missing member identity issuer');
    const conflict = () => new ConflictException({ code: 'MEMBER_VERSION_CONFLICT', message: '회원 상태가 바뀌었습니다. 다시 실행하세요' });
    try {
      const committed = await work.transactionWithRecords(async (tx: any, record: any) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        await lockInstitution(tx, institution);
        await lockMembersInOrder(tx, [from, to]);
        // The decision, again, on what the locks protect.
        const fromNow = await tx.memberRights.findUnique({ where: { sub: from } });
        replacementGate(fromNow, await adminsOf(tx, institution), from, institution);
        const toNow = await tx.memberRights.findUnique({ where: { sub: to } });
        successorGate({ toRow: toNow, isolated: !!await tx.memberIsolation.findUnique({ where: { sub: to } }),
          identity, standing, institution });
        // What was observed before the locks (a missing row included) is the version this command writes over.
        if (fromNow.version !== fromRow!.version || (toRow ? toNow?.version !== toRow.version : !!toNow)) throw conflict();
        const actor = { issuer: OPERATOR_ISSUER, subject: name, id: await work.resolveIdentity(tx, OPERATOR_ISSUER, name) };
        // The executor is the operator's service identity: no member roles (applyMember `operatorIdentity`); X is the
        // managed institution.
        const facts: AdminRequestFacts = { surface: REPLACEMENT_SURFACE, actor, roles: [], rightsVersion: 0, institution,
          ip: null, sessionRef: null, requestId: randomUUID(), request: { work, requireCurrent: async () => {} } } as any;
        const affected = async (sub: string) => ({ issuer, subject: sub, id: await work.resolveIdentity(tx, issuer, sub) });
        // One re-login boundary for both, read after the locks: an authentication issued while this command waited is
        // not one of the new rights (now() would be the transaction's start).
        const [{ boundary }] = await tx.$queryRaw<{ boundary: Date }[]>`SELECT clock_timestamp() AS boundary`;
        const operatorDetail = { by: name, institution, reason, replaced: { from, to } };
        const label = 'operator:' + name;
        await this.applyMember(tx, record, { id: from, register: null, version: fromNow.version, observed: fromNow, identity: null,
          fields: { approved: fromNow.approved, suspended: true, institution: fromNow.institution, roles: fromNow.roles },
          action: 'suspend', before: this.row(fromNow), verificationOverride: false, approvalMutation: false,
          affected: await affected(from), actor: label, facts, service: true, operatorIdentity: true, operatorDetail, boundary });
        const observed = toNow ?? this.pendingMember(identity);
        const roles = [...new Set([...(toNow?.approved ? toNow.roles.filter((role: string) => APP_ROLES.has(role)) : []), 'admin'])];
        return this.applyMember(tx, record, { id: to, register: toNow ? null : identity, version: toNow ? toNow.version : 1,
          observed, identity, fields: { approved: true, suspended: false, institution, roles },
          action: toNow?.approved ? 'update' : 'approve', before: this.row(observed),
          verificationOverride: !identity.emailVerified, approvalMutation: true,
          affected: await affected(to), actor: label, facts, service: true, operatorIdentity: true, operatorDetail, boundary });
      }, { maxWait: 4000, timeout: 8000 });
      return { ...committed.after, rosterUnconfirmed: committed.rosterUnconfirmed };
    } catch (error) {
      // No failure audit here: a refusal wrote nothing, and a lost commit answer may hide a replacement that was saved.
      if (lockWaitExceeded(error))
        throw new ConflictException({ code: 'MEMBER_BUSY', message: '다른 요청이 회원 상태를 변경하고 있습니다. 잠시 후 다시 실행하세요' });
      // Under the locks the predecessor is no longer X's sole administrator: perhaps this same command saved it already.
      if (error instanceof ReplaceAdminRefusal) return this.againOr(run, error);
      throw error;
    }
  }

  /**
   * The same command again (the operator reruns it after a lost answer, exit 3): its own audit rows exist, or the
   * predecessor is no longer X's sole administrator. Decided under X's lock and both members' locks, writing nothing —
   * no rights, session, audit or ledger record:
   *  - this replacement's two audit rows exist (same institution, pair, operator and reason) and neither member changed
   *    since (their versions are those rows' `after`): it stands — `standing`, the successor's latest roster is checked
   *    and completed by the command;
   *  - those rows exist but a member changed since: `changed`, the current state of both, and no roster is sent (an older
   *    roster never overwrites a later change);
   *  - no such rows: null — this replacement was never saved (the caller runs it, or refuses).
   * Anything unreadable here: `OutcomeUndetermined`.
   */
  /** A refusal of the predecessor: this same command's saved replacement if there is one, else the refusal. */
  private async againOr(run: ReplacementRun, refusal: unknown) {
    if (!(refusal instanceof ReplaceAdminRefusal) || !['REPLACE_ADMIN_FROM_NOT_ADMIN', 'REPLACE_ADMIN_NOT_SOLE']
      .includes((refusal.getResponse() as any)?.code)) throw refusal;
    const again = await this.replacementAgain(run);
    if (!again) throw refusal;
    return again;
  }

  private async replacementAgain(run: ReplacementRun) {
    let found: { standing: boolean; from: ReturnType<AdminService['row']>; to: ReturnType<AdminService['row']> } | null;
    try {
      found = await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        await lockInstitution(tx, run.institution);
        await lockMembersInOrder(tx, [run.from, run.to]);
        const saved = await savedReplacement(tx, run);
        if (!saved) return null;
        const fromNow = await tx.memberRights.findUnique({ where: { sub: run.from } });
        const toNow = await tx.memberRights.findUnique({ where: { sub: run.to } });
        if (!fromNow || !toNow) return null;
        return { standing: fromNow.version === saved.from.after?.version && toNow.version === saved.to.after?.version,
          from: this.row(fromNow), to: this.row(toNow) };
      }, { maxWait: 4000, timeout: 8000 });
    } catch { throw new OutcomeUndetermined(); }
    if (!found) return null;
    return found.standing ? { ...found.to, again: 'standing' as const }
      : { ...found.to, again: 'changed' as const, current: { from: found.from, to: found.to } };
  }

  /** Under the institution lock (taken by the caller): X still has no active administrator and the person is not isolated. */
  private async firstAdminGate(tx: any, sub: string, institution: string) {
    if (await activeAdmins(tx, institution))
      throw new FirstAdminRefusal('FIRST_ADMIN_EXISTS', '이 기관에는 이미 활성 관리자가 있습니다');
    if (await tx.memberIsolation.findUnique({ where: { sub } }))
      throw new FirstAdminRefusal('FIRST_ADMIN_TARGET_ISOLATED', '격리된 계정은 지정할 수 없습니다');
  }

  /** `facts`: the request's (AdminController, through its member-change gate). Under the member lock the caller's own
   * authorization is checked again, so a provider write never starts for an administrator replaced meanwhile. */
  async resetPassword(id: string, body: any, c: Caller, facts?: AdminRequestFacts) {
    const admin = this.admin(c);
    if (!['temp', 'email'].includes(body?.mode))
      throw new BadRequestException('mode는 temp 또는 email이어야 합니다');
    const mode: 'temp' | 'email' = body.mode;
    // Password reset has no version CAS, so it never refreshes an existing identity or grants rights.
    // The pre-read validates the realm member and can register a missing pending row without remote I/O under lock.
    // A directory read failure gets a page message, not the provider's words.
    const user = await this.managed(id).catch(error => {
      if (!(error instanceof RosterWriteFailure)) throw error;
      throw new ServiceUnavailableException({ code: 'MEMBER_DIRECTORY_UNAVAILABLE', message: '회원 명부를 읽지 못했습니다. 잠시 뒤 다시 시도하세요.' });
    });
    requireInScope(admin, memberInstitution(await this.prisma.memberRights.findUnique({ where: { sub: id } }), user.groups));
    let before: any;
    try {
      before = this.row(await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        await lockMemberRights(tx, id);
        const row = await tx.memberRights.findUnique({ where: { sub: id } });
        // Decided again on the locked row: a concurrent change may have moved the member.
        requireInScope(admin, memberInstitution(row, user.groups));
        await facts?.request.requireCurrent(tx);
        return row ?? await this.register(tx, user);
      }, { maxWait: 4000, timeout: 8000 }));
    } catch (error) {
      if (lockWaitExceeded(error))
        throw new ConflictException({ code: 'MEMBER_BUSY', message: '다른 요청이 회원 상태를 변경하고 있습니다. 잠시 후 다시 시도하세요' });
      throw error;
    }
    // Again just before the provider write: a replacement committed while the member row was read or registered.
    await facts?.request.requireCurrent();
    if (mode === 'temp') {
      const temporaryPassword = randomBytes(18).toString('base64url') + 'aA1!';
      // And once more after the provider client's token wait, just before its PUT (a replacement committed meanwhile).
      await this.keycloak.resetPassword(id, mode, temporaryPassword, facts ? () => facts.request.requireCurrent() : undefined);
      const after = this.row(await this.member(id));
      await this.audit(c.actor, 'admin.user.reset-password', id, { before, after, mode });
      // The provider write runs outside the member lock. If another institution approved a waiting member meanwhile,
      // the new password is set but never shown here (that institution resets it again).
      requireInScope(admin, memberInstitution(after));
      return { ...after, temporaryPassword };
    }
    // The mail goes to the provider's address: while that differs from the address this console shows, nothing is sent.
    if (user.email && !sameEmail(user.email, before.email)) {
      await this.audit(c.actor, 'admin.user.reset-password.failed', id, { before, after: before, mode, reason: 'address-unconfirmed', failed: true });
      throw new ConflictException({ code: 'RESET_MAIL_ADDRESS_UNCONFIRMED',
        message: '명부의 이메일이 이 화면의 이메일과 다릅니다. Change Name / Email로 주소를 확인해 저장한 뒤 다시 보내세요.' });
    }
    if (!user.email) {
      await this.audit(c.actor, 'admin.user.reset-password.failed', id, { before, after: before, mode, reason: 'no-address', failed: true });
      throw new BadRequestException({ code: 'RESET_MAIL_NO_ADDRESS',
        message: '이 회원은 이메일 주소가 없어 재설정 메일을 보낼 수 없습니다. Temp Password로 임시 비밀번호를 전달하세요.' });
    }
    try {
      await this.keycloak.resetPassword(id, mode);
    } catch {
      // Any failure (refusal, transport, token) gets a page message. Only a confirmed missing mail setting is reported
      // as such; anything else, including failing to read the settings, is a general sending failure. No provider
      // words, addresses or secrets reach the page.
      const configured = await this.keycloak.mailSettings().then(s => s.configured, () => true);
      const reason = configured ? 'send-failed' : 'mail-not-configured';
      await this.audit(c.actor, 'admin.user.reset-password.failed', id, { before, after: before, mode, reason, failed: true });
      throw new ServiceUnavailableException(configured
        ? { code: 'RESET_MAIL_FAILED', message: '재설정 메일을 보내지 못했습니다. 잠시 뒤 다시 시도하거나 Temp Password로 임시 비밀번호를 전달하세요.' }
        : { code: 'RESET_MAIL_NOT_CONFIGURED', message: '메일 발송 설정이 없어 재설정 메일을 보내지 못했습니다. Temp Password로 임시 비밀번호를 전달하고, 운영 담당자에게 메일 발송 설정을 요청하세요.' });
    }
    const after = this.row(await this.member(id));
    await this.audit(c.actor, 'admin.user.reset-password', id, { before, after, mode });
    // As for a temporary password: a member another institution took during the send is not shown here.
    requireInScope(admin, memberInstitution(after));
    return after;
  }

  /**
   * S5-U5b 관리자 감사·보안 기록(`GET /api/admin/audit`). 행의 귀속과 기관별 투영은 admin-audit.ts가 정한다: 행을 쓸 때
   * 남은 기관 값만 보고, 회원의 지금 그룹·검사의 지금 소유 기관·지금 StudyAccess로 귀속을 다시 정하지 않는다.
   * 호출자의 기관은 "누가 읽는가"를 정할 뿐이다. 기존 검사 범위 `GET /api/audit`은 바꾸지 않는다.
   *
   * 거르기는 쪽을 자르기 전이다. SQL은 계약표에 있는 action이면서 이 기관 문자열의 JSON 표기가 detail에 있거나(target이
   * 기관인 action이면 target이 이 기관인) 행만 후보로 넘기고 — 보이는 행을 빠뜨리지 않는 넓은 조건이다 — 정확한 판정은
   * readAuditPage가 한다. detail 검색은 strpos(글자 그대로의 부분 문자열)다: Prisma `contains`(LIKE 패턴)는 JSON
   * 표기의 역슬래시를 이스케이프로 먹어 `\`·`"`가 든 기관의 행을 판정 전에 놓친다(admin-audit.ts auditCandidateRow가
   * 같은 조건의 순수 쌍둥이다). 첫 쪽이 읽은 가장 큰 id를 다음 쪽 값에 봉인해 이어받는 동안의 기준으로 삼는다.
   *
   * 검사 접근이 제한된 관리자는 거절한다: 검사 행에는 오더 매칭 overlay 같은 검사 내용이 실리므로, 허용 범위 밖
   * 검사의 기록을 보이는 창이 된다(운영 지표의 ADMIN_METRICS_RESTRICTED와 같은 이유). 이것은 읽는 사람의 관문이며
   * 행의 귀속에 쓰지 않는다.
   */
  async auditEvents(query: unknown, c: Caller) {
    if (!c.roles?.includes('admin')) throw new ForbiddenException('감사 기록 조회는 admin 권한이 필요합니다');
    if (c.kind !== 'member' || !c.institution) throw new ForbiddenException('소속 기관이 없는 계정입니다');
    const me = c.institution;
    const page = auditPageQuery(query);
    if (!page) throw new BadRequestException({ code: 'ADMIN_AUDIT_QUERY_INVALID', message: '감사 기록 조회 요청 형식이 잘못되었습니다' });
    const access = await this.studyAccess.snapshot(c);
    if (access.policy.restricted)
      throw new ForbiddenException({ code: 'ADMIN_AUDIT_RESTRICTED', message: '검사 접근 범위가 제한된 계정은 감사 기록을 볼 수 없습니다' });
    const owner = [me, c.sub];
    let cursor: AuditCursor | null = null;
    if (page.after !== null) {
      cursor = openAuditCursor(AUDIT_CURSOR_KEY, owner, page.after);
      if (!cursor) throw new ConflictException({ code: 'ADMIN_AUDIT_CURSOR_EXPIRED',
        message: '이어받기 유효기간이 지났거나 서버가 다시 시작되었습니다. 처음부터 다시 조회하세요.' });
    }
    let read: { top: number; observedAt: string; rows: any[]; ids: number[]; total: number; last: number | null };
    try {
      const top = cursor ? cursor.top
        : (await this.prisma.auditLog.findFirst({ orderBy: { id: 'desc' }, select: { id: true } }))?.id ?? 0;
      const mention = auditMention(me);
      const candidates = Prisma.join([...AUDIT_CANDIDATE_ACTIONS]), targets = Prisma.join([...AUDIT_TARGET_ACTIONS]);
      const source: AuditSource = (below, take) => {
        const older = below === null ? Prisma.empty : Prisma.sql`AND "id" < ${below}::int`;
        return this.prisma.$queryRaw<AuditLogRow[]>`SELECT "id", "at", "actor", "action", "target", "detail" FROM "AuditLog"
          WHERE "id" <= ${top}::int ${older} AND "action" IN (${candidates})
            AND (strpos("detail", ${mention}) > 0 OR ("action" IN (${targets}) AND "target" = ${me}))
          ORDER BY "id" DESC LIMIT ${take}`;
      };
      const observedAt = new Date().toISOString();
      read = { top, observedAt, ...await readAuditPage(source, me, { after: cursor?.after ?? null, limit: page.limit }, c.sub) };
    } catch (e: any) {
      // 읽기 실패는 0건이 아니다. 원인 문구(주소·SQL이 섞일 수 있다)는 싣지 않고 코드만 남긴다.
      console.warn(`[KIN API] 감사 기록 읽기 실패: ${e?.code ?? e?.name ?? 'unknown'}`);
      throw new ServiceUnavailableException({ code: 'ADMIN_AUDIT_UNAVAILABLE', message: '감사 기록을 읽지 못했습니다. 잠시 후 다시 조회하세요.' });
    }
    await this.studyAccess.unchanged(c, access);
    return adminAuditRead({
      institutionId: me, observedAt: read.observedAt, total: read.total, rows: read.rows,
      next: read.last === null ? null : sealAuditCursor(AUDIT_CURSOR_KEY, owner, { top: read.top, after: read.last }),
    }, read.ids);
  }
}
