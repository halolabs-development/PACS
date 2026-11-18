import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import {
  AUDIT_CANDIDATE_ACTIONS, AUDIT_TARGET_ACTIONS, AuditCursor, AuditLogRow, AuditSource, auditMention, auditPageQuery,
  openAuditCursor, readAuditPage, sealAuditCursor,
} from './admin-audit';
import { lockMemberRights, rightsAllow, rosterOverlap, rightsAccessEvent, RightsRequestFacts } from './member-rights';
import { AuthService, lockWaitExceeded } from './auth.service';
// 역할 목록은 clinician-policy 한 곳에서 온다. 여기서 별도 literal을 두면 guard와 어긋난다.
import { APP_ROLES } from './clinician-policy';
import { KeycloakService, KeycloakUser, RosterWriteFailure, within } from './keycloak.service';
import {
  adminInstitution, inScope, memberInstitution, memberNotFound, requireInScope, requireOwnAssignment,
} from './member-scope';
import { Caller } from './pacs.service';
import { PrismaService } from './prisma.service';
import { StudyAccessService } from './study-access.service';
import { sessionEndEvent } from './emr-runtime/auth-events';
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

/** The ledger event of an operator command, as for the realm import's service job (member-rights-import.ts). */
const OPERATOR_EVENT = {
  cause: 'service-job', executor: 'service',
  context: { basis: 'service-job', studyId: null, relatedStudyId: null, reason: null },
  trustedProxyIp: { status: 'not-applicable', reason: 'in-process-service' },
} as const;
const OPERATOR_NAME = /^[A-Za-z0-9._@-]{1,64}$/;
const activeAdmins = (db: any, institution: string) => db.memberRights.count({
  where: { institution, approved: true, suspended: false, roles: { has: 'admin' } } });
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
      users.push({ ...this.row(rights), rosterUnconfirmed: await this.rosterUnconfirmed(user.id) });
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
        // The first-administrator condition is decided under the institution lock, before the member lock.
        if (operator) await this.firstAdminGate(tx, id, operator.institution);
        await lockMemberRights(tx, id);
        const current = await tx.memberRights.findUnique({ where: { sub: id } });
        // Scope on the locked row first: a member another institution took meanwhile is unknown here, not a conflict.
        if (current) requireInScope(admin, memberInstitution(current));
        if (existing ? current?.version !== observed.version : !!current)
          throw new ConflictException({ code: 'MEMBER_VERSION_CONFLICT', message: '회원 상태가 바뀌었습니다. 새로고침하세요' });
        if (preReadError) throw preReadError;
        await facts.request.requireCurrent(tx);
        // The observed version precedes the remote pre-read. CAS rejects an older command after any
        // newer command commits, so its captured identity cannot rewind that newer identity. No I/O holds this lock.
        const version = existing ? observed.version : 1;
        let result: { after: ReturnType<AdminService['row']>; change: any; rosterUnconfirmed: boolean };
        const event = rightsAccessEvent(facts, affected, version + 1, new Date().toISOString());
        if (operator) Object.assign(event, OPERATOR_EVENT);
        await record(event, async () => {
          if (!existing) await this.register(tx, identity!);
          const [{ boundary }] = await tx.$queryRaw<{ boundary: Date }[]>`SELECT now() AS boundary`;
          const { count } = await tx.memberRights.updateMany({ where: { sub: id, version }, data: {
            approved, suspended, institution, roles, ...(identity ? this.identity(identity) : {}),
            version: { increment: 1 }, newAuthAfter: boundary,
          } });
          if (count !== 1) throw new ConflictException({ code: 'MEMBER_VERSION_CONFLICT', message: '회원 상태가 바뀌었습니다. 새로고침하세요' });
          const sessions = await tx.authSession.findMany({ where: { sub: id } });
          for (const session of sessions) {
            const ending = sessionEndEvent({ status: 'known', value: affected }, {
              surface: facts.surface, roles: facts.roles, rightsVersion: facts.rightsVersion,
              institution: facts.institution, auditRef: session.auditRef, ip: facts.ip,
              occurredAt: event.occurredAt, endCause: 'isolation', trigger: null,
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
                actor: observed.email || observed.username, action: 'auth.logout', target: id,
                detail: JSON.stringify({ institution: session.institution, ip: facts.ip, dataSubject: null, cause: 'isolation' }) } });
              return { kind: 'AuditLog', id: String(audit.id), version: null };
            });
          }
          const after = this.row(await tx.memberRights.findUnique({ where: { sub: id } }));
          const audit = await tx.auditLog.create({ data: { at: new Date(event.occurredAt),
            actor: c.actor, action: `admin.user.${action}`, target: id,
            detail: JSON.stringify({ before, after, verificationOverride,
              ...(operator ? { operator: { by: operator.name, institution: operator.institution, reason: operator.reason } } : {}) }) } });
          const change = approvalMutation ? await tx.providerChange.create({ data: {
            kind: 'credentials', target: id, sub: id, generation: after.version, state: 'unknown', createdAt: new Date(),
          } }) : null;
          result = { after, change, rosterUnconfirmed: !!change || await this.rosterUnconfirmed(id, tx) };
          return { kind: 'AuditLog', id: String(audit.id), version: null };
        });
        return result!;
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
   * Operator command only (api/prisma/designate-first-admin.cjs; no controller calls it): make one person the first
   * administrator of institution X while X has no approved, active administrator. It is the ordinary approval command
   * (patchUser: rights, version, re-login boundary, session end, audit, roster intent) run for X, with the operator,
   * institution and reason in its audit row. Refused without any write: X unknown or already administered; a service
   * account; a person of another institution or of several; provider groups that disagree with X; a suspended or
   * isolated account. Roles are the person's current X roles plus admin — nothing else is chosen here, and passwords,
   * suspension and the administrator OTP are untouched. Concurrent or repeated runs: the institution lock and the
   * re-read under it let one succeed.
   */
  async designateFirstAdmin(sub: string, institutionValue: string, operator: { name: string; reason: string }, facts: AdminRequestFacts) {
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
    const roles = [...new Set([...(existing?.approved ? existing.roles : []), 'admin'])];
    const c: Caller = { sub: facts.actor.subject, actor: 'operator:' + operator.name, roles: ['admin'], institution, kind: 'member' };
    return this.patchUser(sub, { approvalState: 'APPROVED', institution, roles, verificationOverride: true,
      ...(existing ? { version: existing.version } : {}) }, c, facts, { institution, name: operator.name, reason });
  }

  /** Under the institution lock: X still has no active administrator and the person is not isolated. */
  private async firstAdminGate(tx: any, sub: string, institution: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${0x4b494e46}::int4, hashtext(${institution})::int4)`;
    if (await activeAdmins(tx, institution))
      throw new FirstAdminRefusal('FIRST_ADMIN_EXISTS', '이 기관에는 이미 활성 관리자가 있습니다');
    if (await tx.memberIsolation.findUnique({ where: { sub } }))
      throw new FirstAdminRefusal('FIRST_ADMIN_TARGET_ISOLATED', '격리된 계정은 지정할 수 없습니다');
  }

  async resetPassword(id: string, body: any, c: Caller) {
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
        return row ?? await this.register(tx, user);
      }, { maxWait: 4000, timeout: 8000 }));
    } catch (error) {
      if (lockWaitExceeded(error))
        throw new ConflictException({ code: 'MEMBER_BUSY', message: '다른 요청이 회원 상태를 변경하고 있습니다. 잠시 후 다시 시도하세요' });
      throw error;
    }
    if (mode === 'temp') {
      const temporaryPassword = randomBytes(18).toString('base64url') + 'aA1!';
      await this.keycloak.resetPassword(id, mode, temporaryPassword);
      const after = this.row(await this.member(id));
      await this.audit(c.actor, 'admin.user.reset-password', id, { before, after, mode });
      // The provider write runs outside the member lock. If another institution approved a waiting member meanwhile,
      // the new password is set but never shown here (that institution resets it again).
      requireInScope(admin, memberInstitution(after));
      return { ...after, temporaryPassword };
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
      read = { top, observedAt, ...await readAuditPage(source, me, { after: cursor?.after ?? null, limit: page.limit }) };
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
