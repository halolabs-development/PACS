import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { PrismaService } from './prisma.service';
import { StudyAccessService } from './study-access.service';
import { GatewayStatusService } from './gateway-status.service';
import { Caller, inst, need, needExact } from './pacs/access';
import { dump } from './pacs/values';
import { API_PROCESS_STARTED_AT } from './api-process';
import { gatewayDisplayName, GATEWAY_NO_CONTACT_AFTER_SECONDS } from './gateway-heartbeat';
import { compareVersions, decideSupportResult, GATEWAY_SUPPORT_BUSY, GATEWAY_SUPPORT_CONFLICT, GATEWAY_SUPPORT_INVALID,
  GATEWAY_SUPPORT_NOT_FOUND, GATEWAY_SUPPORT_RESTRICTED, GATEWAY_SUPPORT_UNKNOWN_LINE, GATEWAY_SUPPORT_UNKNOWN_VERSION,
  GATEWAY_UPDATE_MAX_BYTES, GATEWAY_UPDATES_SHOWN, GatewaySupportInputError, OPEN_STATES, parseSupportRequest,
  parseSupportResult, SupportRequestRow, supportRequestView, validVersion } from './gateway-support';

/** Reports kept in memory across all requests; past it the oldest reports are let go (their request stays done). */
const DIAGNOSTICS_TOTAL_BYTES = 32 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Gateway remote support (rules in `gateway-support.ts`). Requests live in this API process's memory beside the heartbeat
 * rows they are bound to — one, the newest, per Gateway line (credential sub + queue epoch). The administrator's request
 * is audited (`gateway.support.request`) before it is published; a Gateway only ever sees and answers requests bound to
 * its own credential, institution and queue. An API restart forgets requests and reports (the audit rows stay); the
 * console says so with the server's start time.
 */
@Injectable()
export class GatewaySupportService {
  private readonly requests = new Map<string, SupportRequestRow>();
  /** line key (sub \n epoch) → id of its newest request */
  private readonly lines = new Map<string, string>();
  protected clock = () => Date.now();
  protected updateDir = () => String(process.env.GATEWAY_UPDATE_DIR ?? '').trim();

  constructor(private readonly prisma: PrismaService, private readonly studyAccess: StudyAccessService,
    private readonly status: GatewayStatusService) {}

  private async admin(c: Caller, what: string) {
    need(c.roles, 'admin', what);
    const access = await this.studyAccess.snapshot(c);
    if (access.policy.restricted)
      throw new ForbiddenException({ code: GATEWAY_SUPPORT_RESTRICTED,
        message: '검사 접근 범위가 제한된 계정은 Gateway 원격 지원을 쓸 수 없습니다' });
    return access;
  }

  /** The versions this server holds (`GATEWAY_UPDATE_DIR/<version>.json`), newest first. No signature is judged here. */
  async updates(): Promise<string[]> {
    const dir = this.updateDir();
    if (!dir) return [];
    let names: string[];
    try { names = await fs.readdir(dir); } catch { return []; }
    const versions: string[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const version = name.slice(0, -5);
      if (!validVersion(version)) continue;
      try {
        const stat = await fs.stat(path.join(dir, name));
        if (stat.isFile() && stat.size > 0 && stat.size <= GATEWAY_UPDATE_MAX_BYTES) versions.push(version);
      } catch { /* gone between the listing and the look */ }
    }
    return versions.sort((a, b) => compareVersions(b, a) || a.localeCompare(b)).slice(0, GATEWAY_UPDATES_SHOWN);
  }

  /** `GET /api/admin/gateway-support`: this institution's Gateway lines, each with its newest request, and held versions. */
  async adminList(c: Caller) {
    const access = await this.admin(c, 'Gateway 원격 지원 조회');
    const me = inst(c);
    const now = this.clock();
    const updates = await this.updates();
    const gateways = this.status.rowsOf(me).map(row => {
      const id = this.lines.get(row.gateway + '\n' + row.epoch);
      const request = id ? this.requests.get(id) : undefined;
      return { gateway: gatewayDisplayName(row.label), queueInstance: row.epoch, version: row.version,
        contact: now - row.receivedAt > GATEWAY_NO_CONTACT_AFTER_SECONDS * 1000 ? 'no_contact' : 'recent',
        lastContactAt: new Date(row.receivedAt).toISOString(),
        request: request && request.state !== 'claiming' ? supportRequestView(request) : null };
    });
    const answer = { institutionId: me, generatedAt: new Date(now).toISOString(),
      serverStartedAt: new Date(API_PROCESS_STARTED_AT).toISOString(), updates, gateways };
    await this.studyAccess.unchanged(c, access);
    return answer;
  }

  /** `POST /api/admin/gateway-support` with `{ queueInstance, action, version }`. */
  async adminRequest(body: unknown, c: Caller) {
    const access = await this.admin(c, 'Gateway 원격 지원 요청');
    const me = inst(c);
    let input;
    try { input = parseSupportRequest(body); }
    catch (error) {
      if (error instanceof GatewaySupportInputError)
        throw new BadRequestException({ code: GATEWAY_SUPPORT_INVALID, field: error.message });
      throw error;
    }
    if (input.action === 'update' && !(await this.updates()).includes(input.version as string))
      throw new BadRequestException({ code: GATEWAY_SUPPORT_UNKNOWN_VERSION });
    const line = this.status.rowsOf(me).filter(row => row.epoch === input.queueInstance);
    if (line.length !== 1) throw new NotFoundException({ code: GATEWAY_SUPPORT_UNKNOWN_LINE });
    const { gateway, epoch, label } = line[0];
    const key = gateway + '\n' + epoch;
    const previousId = this.lines.get(key);
    const previous = previousId ? this.requests.get(previousId) : undefined;
    if (previous && (previous.state === 'claiming' || (OPEN_STATES as readonly string[]).includes(previous.state)))
      throw new ConflictException({ code: GATEWAY_SUPPORT_BUSY, message: '이 Gateway에 아직 끝나지 않은 요청이 있습니다' });
    // Claim the line first (no await before this), audit, then publish; a failure releases the claim and nothing is sent.
    const now = this.clock();
    const row: SupportRequestRow = { id: randomUUID(), institutionId: me, gateway, epoch, label, action: input.action,
      version: input.version, state: 'claiming', code: null, requestedBy: String(c.actor || 'unknown').slice(0, 128),
      requestedAt: now, updatedAt: now, acceptedBootId: null, resultVersion: null, diagnostics: null, diagnosticsBytes: 0 };
    this.requests.set(row.id, row);
    this.lines.set(key, row.id);
    try {
      await this.studyAccess.unchanged(c, access);
      await this.prisma.auditLog.create({ data: { actor: c.actor || 'unknown', action: 'gateway.support.request',
        target: row.id, detail: dump({ institution: me, request: row.id, gateway: gatewayDisplayName(label),
          queueInstance: epoch, action: row.action, version: row.version, at: new Date(now).toISOString() }) } });
    } catch (error) {
      this.requests.delete(row.id);
      if (previousId) this.lines.set(key, previousId); else this.lines.delete(key);
      throw error;
    }
    // The line's older request (final) and its report are let go: one request per line is kept.
    if (previousId) this.requests.delete(previousId);
    row.state = 'requested';
    return { request: supportRequestView(row) };
  }

  /** `GET /api/admin/gateway-support/:id/diagnostics`: the report, for an admin of the request's institution. */
  async adminDiagnostics(id: string, c: Caller) {
    const access = await this.admin(c, 'Gateway 진단 받기');
    const me = inst(c);
    const row = UUID.test(String(id)) ? this.requests.get(String(id)) : undefined;
    if (!row || row.institutionId !== me || row.diagnostics === null)
      throw new NotFoundException({ code: GATEWAY_SUPPORT_NOT_FOUND });
    const answer = { request: supportRequestView(row), gateway: gatewayDisplayName(row.label), queueInstance: row.epoch,
      receivedAt: new Date(row.updatedAt).toISOString(), report: row.diagnostics };
    await this.studyAccess.unchanged(c, access);
    return answer;
  }

  private gatewayCaller(c: Caller, what: string) {
    needExact(c, 'gateway', what);
    const sub = String(c.sub ?? '');
    if (!sub) throw new ForbiddenException('Gateway 신원이 없습니다');
    return { me: inst(c), sub };
  }

  /** `GET /api/gateway/support?epoch=`: the open request of the caller's own line, if any (marks it delivered). */
  gatewayPoll(query: any, c: Caller) {
    const { me, sub } = this.gatewayCaller(c, 'Gateway 원격 지원 조회');
    const epoch = query?.epoch;
    if (!query || Object.keys(query).length !== 1 || typeof epoch !== 'string' || !UUID.test(epoch))
      throw new BadRequestException({ code: GATEWAY_SUPPORT_INVALID, field: 'epoch' });
    const id = this.lines.get(sub + '\n' + epoch);
    const row = id ? this.requests.get(id) : undefined;
    if (!row || row.institutionId !== me || (row.state !== 'requested' && row.state !== 'delivered'))
      return { request: null };
    if (row.state === 'requested') { row.state = 'delivered'; row.updatedAt = this.clock(); }
    return { request: { id: row.id, action: row.action, version: row.version } };
  }

  /** `POST /api/gateway/support/:id`: the caller's result for a request bound to its own credential, institution, queue. */
  gatewayResult(id: string, body: unknown, c: Caller) {
    const { me, sub } = this.gatewayCaller(c, 'Gateway 원격 지원 결과');
    let input;
    try { input = parseSupportResult(body); }
    catch (error) {
      if (error instanceof GatewaySupportInputError)
        throw new BadRequestException({ code: GATEWAY_SUPPORT_INVALID, field: error.message });
      throw error;
    }
    const row = UUID.test(String(id)) ? this.requests.get(String(id)) : undefined;
    if (!row || row.institutionId !== me || row.gateway !== sub || row.epoch !== input.epoch)
      throw new NotFoundException({ code: GATEWAY_SUPPORT_NOT_FOUND });
    const decision = decideSupportResult(row, input);
    if (decision.kind === 'invalid') throw new BadRequestException({ code: GATEWAY_SUPPORT_INVALID, field: decision.field });
    if (decision.kind === 'conflict') throw new ConflictException({ code: GATEWAY_SUPPORT_CONFLICT });
    if (decision.kind === 'same') return { result: 'same', state: row.state };
    row.state = decision.state;
    row.code = input.code;
    row.updatedAt = this.clock();
    if (input.result === 'accepted') row.acceptedBootId = input.bootId;
    if (input.version !== null) row.resultVersion = input.version;
    if (input.diagnostics !== null) this.keepDiagnostics(row, input.diagnostics);
    return { result: 'stored', state: row.state };
  }

  private keepDiagnostics(row: SupportRequestRow, report: Record<string, unknown>) {
    row.diagnostics = report;
    row.diagnosticsBytes = JSON.stringify(report).length;
    let total = 0;
    const held = [...this.requests.values()].filter(r => r.diagnostics !== null).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const r of held) total += r.diagnosticsBytes;
    for (const r of held) {
      if (total <= DIAGNOSTICS_TOTAL_BYTES || r === row) break;
      total -= r.diagnosticsBytes;
      r.diagnostics = null;
      r.diagnosticsBytes = 0;
    }
  }

  /** `GET /api/gateway/update/:version`: the bundle file of a held version, for a Gateway credential. */
  async gatewayBundle(version: string, c: Caller): Promise<Buffer> {
    this.gatewayCaller(c, 'Gateway 갱신 파일 받기');
    if (!validVersion(version) || !(await this.updates()).includes(version))
      throw new NotFoundException({ code: GATEWAY_SUPPORT_UNKNOWN_VERSION });
    const bytes = await fs.readFile(path.join(this.updateDir(), version + '.json'));
    if (bytes.length > GATEWAY_UPDATE_MAX_BYTES) throw new NotFoundException({ code: GATEWAY_SUPPORT_UNKNOWN_VERSION });
    return bytes;
  }
}
