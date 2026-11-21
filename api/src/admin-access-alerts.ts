import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { StudyAccessService } from './study-access.service';
import { Caller } from './pacs.service';
import { inst, need } from './pacs/access';
import { randomUUID } from 'node:crypto';
import type { RequestWorkContext } from './emr-runtime/request-context';
import type { AccessEventV1 } from './emr-contract/access-event';
import { ALERT_ROW_CAP, accessAlerts, alertThreshold } from './access-alerts';

type Row = { entry_id: string; sequence: bigint; event_id: string; occurred_at: Date; account: string; study_id: string };

function period(query: any) {
  const invalid = () => new BadRequestException('조회 기간을 확인하세요.');
  if (!query || Object.keys(query).some(k => !['report', 'from', 'until'].includes(k)) || query.report !== 'access-alerts') throw invalid();
  const timestamp = (value: unknown) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw invalid();
    return value;
  };
  const from = timestamp(query.from), until = timestamp(query.until);
  if (from >= until) throw invalid();
  return { from, until };
}

function account(text: string) {
  const [id, issuer, subject] = JSON.parse(text);
  return { status: 'known' as const, value: { id, issuer, subject } };
}

/**
 * Access Alerts over the access ledger: the same administrator, institution and restricted-account checks as Access
 * Review, the institution recorded as managing at the time, and the same recorded read of what was shown. Which
 * entries count is emr_access.alert_entries; the time rule is access-alerts.ts.
 */
@Injectable()
export class AdminAccessAlerts {
  constructor(private readonly db: PrismaService, private readonly access: StudyAccessService) {}

  async read(query: unknown, caller: Caller, request: RequestWorkContext) {
    need(caller.roles, 'admin', '이상 접근 경보');
    const institution = inst(caller);
    if (caller.kind !== 'member') throw new ForbiddenException('관리자 회원 계정이 필요합니다.');
    const { from, until } = period(query);
    const threshold = alertThreshold(process.env.KIN_ACCESS_ALERT_THRESHOLD);
    if (!threshold) throw new ServiceUnavailableException('경보 기준 설정값이 올바르지 않습니다. 운영자에게 알리세요.');
    await request.requireCurrent();
    const access = await this.access.snapshot(caller);
    if (access.policy.restricted) throw new ForbiddenException('검사 접근 범위가 제한된 계정은 접속기록을 조회할 수 없습니다.');
    let rows: Row[];
    try {
      // The same 30 s limit as Access Review, local to this transaction.
      [, rows] = await this.db.$transaction([
        this.db.$queryRaw`SELECT set_config('statement_timeout',
          CASE WHEN setting::bigint BETWEEN 1 AND 30000 THEN setting ELSE '30000' END, true) AS limit_ms
          FROM pg_settings WHERE name = 'statement_timeout'`,
        this.db.$queryRaw<Row[]>`
        SELECT * FROM emr_access.alert_entries(${institution}::text, ${from}::timestamptz, ${until}::timestamptz,
          ${ALERT_ROW_CAP}::integer)`]);
    } catch {
      throw new ServiceUnavailableException('접속기록을 조회하지 못했습니다. 다시 조회하세요.');
    }
    // Never judge part of the period: an alert missing from a cut-off read would read as no alert.
    if (rows.length > ALERT_ROW_CAP)
      throw new ServiceUnavailableException('기간 안의 열람 기록이 너무 많아 경보를 판정하지 못했습니다. 기간을 줄여 다시 조회하세요.');
    const alerts = accessAlerts(rows.map(row => ({ entryId: row.entry_id, sequence: row.sequence, eventId: row.event_id,
      occurredAt: row.occurred_at, account: row.account, studyId: row.study_id })), threshold);
    await this.access.unchanged(caller, access);
    await request.requireCurrent();
    const known = <T>(value: T) => ({ status: 'known' as const, value });
    const na = { status: 'not-applicable' as const, reason: 'non-record-target' as const };
    // What the administrator was shown is each alert's evidence entry, not every entry that was only counted.
    const event: AccessEventV1 = {
      formatVersion: 1, eventId: randomUUID(), surface: request.facts.surface,
      userId: known(request.facts.actor), rolesAtTime: known([...request.facts.roles]),
      actingInstitution: known(request.facts.institution), managingInstitution: known(institution),
      occurredAt: new Date().toISOString(), trustedProxyIp: request.facts.ingress,
      executor: 'member', cause: 'user-view',
      context: { basis: 'out-of-context', studyId: null, relatedStudyId: null, reason: null },
      targets: alerts.map(alert => ({ kind: 'access-audit', patientLinkSnapshot: na, studyId: na,
        recordId: known(alert.evidenceEntryId), versionId: na })),
      action: 'provide-prepared', result: 'prepared', requestId: request.facts.requestId,
      auditLinkId: `audit:${randomUUID()}`, relatedEventId: null,
    };
    try { await request.work.append(event); }
    catch { throw new ServiceUnavailableException('접속기록 열람을 기록하지 못했습니다. 다시 조회하세요.'); }
    await this.access.unchanged(caller, access);
    await request.requireCurrent();
    return { institutionId: institution, from, until, observedAt: new Date().toISOString(), threshold: { ...threshold },
      alerts: alerts.map(alert => ({ userId: account(alert.account), firstAt: alert.firstAt, lastAt: alert.lastAt,
        studies: alert.studies, events: alert.events, evidenceEntryId: alert.evidenceEntryId })) };
  }
}
