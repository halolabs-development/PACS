/*
 * QC Flag: a technician's image quality mark on one worklist row, with its reason, removed when the problem is resolved.
 *
 * The one rule: the mark is what the row's StudyState stores - flagged while `qcReason` is not NULL - and it changes only
 * through `PATCH studies/:uid {qc}` (PacsStudyState.patchState), by a technician of the owning institution, in the write's
 * row lock, with one `state.patch` audit row holding the revision it stored. `qcRevision` rises by one on every mark,
 * reason change and clear and never goes down, so a screen can drop an answer older than what it has shown. The mark is
 * its own fact: it never changes SS, RS, the order match or the missing-images check, and they never change it.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Caller } from './access';
import { markerShown } from '../account-identity';

export const QC_REASON_MAX = 500;
// One line of text: no control character at all (tab and line breaks included), judged before trimming.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const EPOCH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The body keys of a QC command; it is sent alone, never mixed with another study change. */
const QC_KEYS = ['qc', 'qcRevision', 'epoch'];

export interface QcCommand { reason: string | null; revision: number; epoch: string }

/** Is this PATCH body a QC command (it names `qc`)? */
export function isQcCommand(body: any): boolean {
  return !!body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'qc');
}

/**
 * The QC command of a PATCH body: `{qc: {reason}, qcRevision, epoch}` marks (or changes the reason), `{qc: null, ...}`
 * clears. `qcRevision` is the revision the screen showed and `epoch` the row's draftEpoch it showed (a row deleted and
 * made again has a new one). The reason is one line: no control character anywhere (tab and line breaks included), then
 * trimmed to 1..500 characters.
 */
export function qcCommand(body: any): QcCommand {
  if (Object.keys(body).some(k => !QC_KEYS.includes(k)))
    throw new BadRequestException('QC 표시는 다른 검사 변경과 함께 보낼 수 없습니다');
  const { qc, qcRevision, epoch } = body;
  if (!Number.isSafeInteger(qcRevision) || qcRevision < 0 || typeof epoch !== 'string' || !EPOCH.test(epoch))
    throw new BadRequestException('QC 표시의 기준(qcRevision, epoch)이 필요합니다');
  if (qc === null) return { reason: null, revision: qcRevision, epoch };
  if (!qc || typeof qc !== 'object' || Array.isArray(qc) || Object.keys(qc).join() !== 'reason' || typeof qc.reason !== 'string')
    throw new BadRequestException('QC 표시는 {reason} 또는 null이어야 합니다');
  if (CONTROL.test(qc.reason)) throw new BadRequestException(`QC 사유는 1~${QC_REASON_MAX}자의 글이어야 합니다`);
  const reason = qc.reason.trim();
  if (!reason || reason.length > QC_REASON_MAX)
    throw new BadRequestException(`QC 사유는 1~${QC_REASON_MAX}자의 글이어야 합니다`);
  return { reason, revision: qcRevision, epoch };
}

export function qcFlagged(state: { qcReason?: unknown } | null | undefined): boolean {
  return typeof state?.qcReason === 'string';
}

/**
 * What the stored row becomes for this command, or `null` when nothing is written: clearing a row that is not flagged
 * answers the row as it is (same revision, no audit). A command based on another row generation or revision is refused.
 */
export function qcChange(state: any, command: QcCommand, c: Caller, at: Date) {
  if (state.draftEpoch !== command.epoch)
    throw new ConflictException({ code: 'QC_STUDY_CHANGED', message: '검사가 바뀌었습니다. 목록을 새로고침한 뒤 다시 확인하세요' });
  if (command.reason === null && !qcFlagged(state)) return null;
  if ((state.qcRevision ?? 0) !== command.revision)
    throw new ConflictException({ code: 'QC_REVISION_CHANGED', message: '다른 사람이 이 검사의 QC 표시를 바꿨습니다. 지금 상태를 확인한 뒤 다시 하세요' });
  return command.reason === null
    ? { qcReason: null, qcBy: null, qcAt: null, qcRevision: (state.qcRevision ?? 0) + 1 }
    : { qcReason: command.reason, qcBy: c.actor || 'unknown', qcAt: at, qcRevision: (state.qcRevision ?? 0) + 1 };
}

/**
 * The row's mark as every answer carries it: `{reason, by, byName, at, revision}`, all but the revision null when not
 * flagged. `by` is the marking login and `byName` the person a screen shows for it (account-identity.ts markerShown - the
 * screen never looks it up again), both sent only to the owning institution (a tele-reading receiver sees the mark and
 * reason, not who).
 */
export function qcView(state: any, caller: Caller) {
  const flagged = qcFlagged(state);
  const at = flagged && state.qcAt instanceof Date && Number.isFinite(state.qcAt.getTime()) ? state.qcAt.toISOString() : null;
  const by = flagged && state.institutionId != null && state.institutionId === caller?.institution ? state.qcBy ?? null : null;
  return {
    reason: flagged ? state.qcReason : null,
    by, byName: by ? markerShown(by, caller) : null,
    at, revision: Number.isSafeInteger(state?.qcRevision) ? state.qcRevision : 0,
  };
}

/** A grouping change that would hide an unresolved mark from the list (or end the row that carries it) is refused. */
export function qcGroupRefusal(row: any, merging: boolean) {
  return qcFlagged(row) ? { uid: row.uid, rule: 'qc-flagged', message: merging
    ? '이 검사에 해결되지 않은 QC 표시가 있습니다. 합치면 목록에서 사라지므로 먼저 QC 표시를 지우세요.'
    : '나눈 둘째 검사에 해결되지 않은 QC 표시가 있습니다. 먼저 QC 표시를 지우세요.' } : null;
}
