import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { StudyAccessService } from './study-access.service';
import type { Caller } from './pacs.service';

/**
 * Patient Consent: a hospital administrator records a patient's consent for a stated purpose and reads that patient's
 * records again. The record is kept in TransferBasis as a patient row (studyUid null). It opens nothing: no access or
 * transfer decision reads a patient row (a transfer needs a basis of its own study).
 *
 * The patient is (the caller's institution, the exact original Patient ID). It exists for this administrator only when
 * at least one study of the archive names exactly that ID on its one original resource, is owned by the caller's
 * institution (StudyState, the server's value) and is allowed by the caller's own Study Access. Every route asks
 * patientOf() first; another institution's patient and an unknown ID answer the same 404.
 */
const bad = (message = '입력 값을 확인하세요') => { throw new BadRequestException({ code: 'CONSENT_INPUT_INVALID', message }); };
const missing = () => { throw new NotFoundException({ code: 'CONSENT_PATIENT_NOT_FOUND', message: '이 기관에서 이 환자 번호의 검사를 찾지 못했습니다' }); };
const CONTROL = /[\x00-\x1f\x7f]/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function text(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value)) bad(`${what}을(를) 확인하세요`);
  return (value as string).trim();
}
function instant(value: unknown, what: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) bad(`${what}을(를) 확인하세요`);
  const d = new Date(value as string), expected = (value as string).length === 20 ? (value as string).replace('Z', '.000Z') : value;
  if (!Number.isFinite(d.getTime()) || d.toISOString() !== expected) bad(`${what}을(를) 확인하세요`);
  return d;
}
function patientIdOf(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 64 || CONTROL.test(value) || /[*?\\]/.test(value))
    bad('환자 번호를 확인하세요');
  return value as string;
}
function fields(body: unknown, allowed: string[], required: string[]) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k))
    || required.some(k => !Object.prototype.hasOwnProperty.call(body, k))) bad();
  return body as Record<string, any>;
}
function patientName(row: any): string {
  const value = row?.['00100010']?.Value?.[0];
  return typeof value === 'string' ? value : typeof value?.Alphabetic === 'string' ? value.Alphabetic : '';
}
type Row = { id: string; purpose: string | null; reference: string; obtainedAt: Date; expiresAt: Date | null; recordedBy: string;
  recordedAt: Date; revokedBy: string | null; revokedAt: Date | null; revokeReason: string | null };
const SELECT = { id: true, purpose: true, reference: true, obtainedAt: true, expiresAt: true, recordedBy: true, recordedAt: true,
  revokedBy: true, revokedAt: true, revokeReason: true } as const;
const iso = (d: Date | null) => d ? d.toISOString() : null;
function view(row: Row, now = new Date()) {
  const state = row.revokedAt ? 'withdrawn' : row.expiresAt && row.expiresAt <= now ? 'expired' : 'active';
  return { id: row.id, purpose: row.purpose, reference: row.reference, obtainedAt: iso(row.obtainedAt), expiresAt: iso(row.expiresAt),
    recordedBy: row.recordedBy, recordedAt: iso(row.recordedAt), withdrawnBy: row.revokedBy, withdrawnAt: iso(row.revokedAt),
    withdrawReason: row.revokeReason, state };
}

@Injectable()
export class PatientConsentService {
  constructor(private prisma: PrismaService, private orthanc: OrthancService, private studyAccess: StudyAccessService) {}

  private admin(c: Caller): [string, string] {
    if (c.kind !== 'member' || !c.sub || !c.actor || !c.institution || !c.roles?.includes('admin'))
      throw new ForbiddenException({ code: 'CONSENT_ADMIN_REQUIRED', message: '환자 동의 기록은 이 기관의 관리자만 다룹니다' });
    return [c.institution, c.sub];
  }

  /**
   * The one rule of every route: the caller's own-institution, Study-Access-allowed studies of exactly this patient.
   * Archive reads happen here, before any transaction; a failed read is 503, never an empty history or a 404.
   */
  async patientOf(c: Caller, value: unknown) {
    const [institution] = this.admin(c), patientId = patientIdOf(value);
    const candidates = await this.orthanc.patientStudyUids(patientId);
    const owned = candidates.length ? (await this.prisma.studyState.findMany({
      where: { uid: { in: candidates }, institutionId: institution }, select: { uid: true } })).map(s => s.uid) : [];
    const single: string[] = [], names = new Set<string>(), rows = new Map<string, any[]>();
    for (let i = 0; i < owned.length; i += 100) {
      for (const row of await this.orthanc.studiesByUid(owned.slice(i, i + 100))) {
        const uid = OrthancService.tag(row, '0020000D');
        rows.set(uid, [...rows.get(uid) ?? [], row]);
      }
    }
    // A UID two patient resources share is no patient's evidence; another of this patient's studies still is.
    for (const [uid, list] of rows) if (list.length === 1 && OrthancService.tag(list[0], '00100020') === patientId) single.push(uid);
    const allowed = single.length ? await this.studyAccess.allowed(c, single) : new Set<string>();
    const studies = single.filter(uid => allowed.has(uid));
    if (!studies.length) missing();
    for (const uid of studies) { const name = patientName(rows.get(uid)![0]); if (name) names.add(name); }
    return { institution, patientId, studies, names: [...names].sort() };
  }

  /** Inside a write: the owner rows and the caller's access policy again, on the transaction's connection. */
  private async recheck(tx: Prisma.TransactionClient, c: Caller, patient: { institution: string; studies: string[] }) {
    const owned = (await tx.studyState.findMany({ where: { uid: { in: patient.studies }, institutionId: patient.institution }, select: { uid: true } }))
      .map(s => s.uid);
    if (!owned.length || !(await this.studyAccess.allowed(c, owned, tx)).size) missing();
  }

  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(async tx => { await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`; return work(tx); },
        { maxWait: 4000, timeout: 8000 });
    } catch (e: any) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === 'P2028' || e.code === 'P2034'
        || (e.code === 'P2010' && ['55P03', '57014', '40P01'].includes(String((e.meta as any)?.code)))))
        throw new ServiceUnavailableException({ code: 'CONSENT_BUSY', message: '저장이 지연되었습니다. 같은 요청으로 다시 시도하세요' });
      throw e;
    }
  }

  private records(institution: string, patientId: string) {
    return this.prisma.transferBasis.findMany({ where: { institutionId: institution, patientId, studyUid: null },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], select: SELECT });
  }

  async lookup(c: Caller, body: unknown) {
    const b = fields(body, ['patientId'], ['patientId']);
    const patient = await this.patientOf(c, b.patientId), now = new Date();
    return { owner: [patient.institution, c.sub], patient: { patientId: patient.patientId, names: patient.names },
      records: (await this.records(patient.institution, patient.patientId)).map(row => view(row, now)) };
  }

  async record(c: Caller, body: unknown) {
    this.admin(c);
    const b = fields(body, ['patientId', 'purpose', 'reference', 'obtainedAt', 'expiresAt', 'requestId'], ['patientId', 'purpose', 'reference', 'obtainedAt', 'requestId']);
    const patientId = patientIdOf(b.patientId), purpose = text(b.purpose, 500, 'Purpose'), reference = text(b.reference, 1000, 'Reference');
    const obtainedAt = instant(b.obtainedAt, 'Obtained At'), expiresAt = b.expiresAt == null ? null : instant(b.expiresAt, 'Expires At');
    if (obtainedAt.getTime() > Date.now()) bad('Obtained At은 지금보다 뒤일 수 없습니다');
    if (expiresAt && expiresAt <= obtainedAt) bad('Expires At은 Obtained At보다 뒤여야 합니다');
    if (typeof b.requestId !== 'string' || !UUID.test(b.requestId)) bad();
    const requestId = b.requestId.toLowerCase();
    const patient = await this.patientOf(c, patientId);
    const same = (row: any) => row.patientId === patientId && row.studyUid === null && row.purpose === purpose && row.reference === reference
      && row.obtainedAt.getTime() === obtainedAt.getTime() && (row.expiresAt?.getTime() ?? null) === (expiresAt?.getTime() ?? null);
    const replay = async () => {
      const row = await this.prisma.transferBasis.findUnique({ where: { institutionId_recordedBySub_requestId: {
        institutionId: patient.institution, recordedBySub: c.sub, requestId } } });
      if (!row) return null;
      if (!same(row)) throw new ConflictException({ code: 'CONSENT_REQUEST_REUSED', message: '다른 기록에 쓰인 요청입니다. 기록을 다시 불러와 확인하세요' });
      return { ...view(row), replayed: true };
    };
    const earlier = await replay(); if (earlier) return earlier;
    try {
      return await this.transaction(async tx => {
        await this.recheck(tx, c, patient);
        const at = new Date();
        const row = await tx.transferBasis.create({ data: { id: randomUUID(), studyUid: null, patientId, purpose, institutionId: patient.institution,
          kind: 'PATIENT_CONSENT', reference, obtainedAt, expiresAt, recordedBy: c.actor, recordedAt: at, requestId, recordedBySub: c.sub }, select: SELECT });
        // The answer and the audit row tell the same state (a record entered after its expiry is Expired in both).
        const made = view(row, at);
        await tx.auditLog.create({ data: { actor: c.actor, action: 'patient.consent.record', target: row.id, at,
          detail: JSON.stringify({ institution: patient.institution, consentId: row.id, before: null, after: made.state }) } });
        return { ...made, replayed: false };
      });
    } catch (e) {
      // The same request committed by a concurrent attempt: answer with that row.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') { const row = await replay(); if (row) return row; }
      throw e;
    }
  }

  async withdraw(c: Caller, id: string, body: unknown) {
    this.admin(c);
    if (typeof id !== 'string' || !UUID.test(id)) bad();
    const b = fields(body, ['patientId', 'reason'], ['patientId', 'reason']);
    const patientId = patientIdOf(b.patientId), reason = text(b.reason, 1000, 'Reason'), consentId = id.toLowerCase();
    const patient = await this.patientOf(c, patientId);
    return this.transaction(async tx => {
      await this.recheck(tx, c, patient);
      const where = { id: consentId, institutionId: patient.institution, patientId, studyUid: null };
      const before = await tx.transferBasis.findFirst({ where, select: SELECT });
      if (!before) missing();
      const at = new Date();
      const changed = await tx.transferBasis.updateMany({ where: { ...where, revokedAt: null },
        data: { revokedAt: at, revokedBy: c.actor, revokeReason: reason } });
      if (changed.count !== 1) throw new ConflictException({ code: 'CONSENT_ALREADY_WITHDRAWN', message: '이미 철회된 기록입니다. 기록을 다시 불러오세요' });
      await tx.auditLog.create({ data: { actor: c.actor, action: 'patient.consent.revoke', target: consentId, at,
        detail: JSON.stringify({ institution: patient.institution, consentId, before: view(before!, at).state, after: 'withdrawn' }) } });
      return view((await tx.transferBasis.findFirst({ where, select: SELECT }))!, at);
    });
  }
}
