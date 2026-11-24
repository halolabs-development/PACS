import * as F from './contract';
import type { ImmutableIdentity } from '../emr-contract/access-event';

export interface IncidentStep {
  operationId: string; input: unknown; facts: F.IncidentResponseFacts;
  notices: F.IncidentNoticeEvidence[]; by: ImmutableIdentity; roles: readonly string[]; at: string;
  decisions?: F.IncidentDecision[]; delays?: F.IncidentDelay[];
}
/** The evidence rows of a large registration, kept once outside the incident's history. The hash is of the stored bytes. */
export interface IncidentSnapshotCopy { format: 'gzip-json-ledger-rows-v1'; key: string; sha256: string; rows: number }
/** Exactly one of `rows` (in the body) and `copy` (a fixed copy) holds the evidence; a body with neither is not an empty range. */
export interface IncidentSnapshot { top: number; rows?: F.LedgerRow[]; failure: string | null; copy?: IncidentSnapshotCopy }
export interface IncidentState {
  kind: 'incident'; institutionId: string; incidentId: string; incidentType: 'other' | 'cvr-misdelivery';
  intake: unknown; query: unknown; determinations: F.IncidentDetermination[];
  snapshot: IncidentSnapshot;
  steps: IncidentStep[]; closed: { evidenceId: string; by: ImmutableIdentity; at: string; supersededBy?: string } | null;
  /** With a copy: the contract's effective verdict when this row was saved, so the list does not read the copy. */
  listing?: { verdict: F.IncidentResponsePlan['verdict']; awarenessAt: string };
}
export const INCIDENT_FORMS = {
  possibility: { title: 'Possible Leak Notice', kinds: ['possible-leak'] },
  confirmed: { title: 'Confirmed / Priority / Additional Notice', kinds: ['confirmed-leak', 'confirmed-priority', 'confirmed-additional'] },
  'not-a-leak': { title: 'No Leak Notice', kinds: ['not-a-leak'] },
  report: { title: 'PIPC / KISA Report', kinds: ['pipc-kisa-report', 'pipc-kisa-priority', 'pipc-kisa-additional'] },
  medical: { title: 'MOHW Notice Materials', kinds: ['mohw-notice'] },
  network: { title: 'Network Incident Report Materials', kinds: ['isp-incident-report', 'isp-incident-report-supplement', 'isp-user-notice', 'isp-user-additional'] },
} as const;

export function incidentDraft(form: keyof typeof INCIDENT_FORMS, state: IncidentState, scope: F.IncidentScope, plan: F.IncidentResponsePlan) {
  const definition = INCIDENT_FORMS[form];
  const obligations = plan.obligations.filter(o => (definition.kinds as readonly string[]).includes(o.kind));
  return { form, title: definition.title, status: 'Draft', wording: '문안 확정 전 (P5). 근거 조문과 확인된 사실만 포함한 초안이며 발송하지 않습니다.',
    applicabilityNote: obligations.length ? null : '현재 계약 결과에 이 서식의 의무가 없습니다(조회 사실만 포함)',
    basis: [...new Set(obligations.flatMap(o => o.basis))],
    incidentId: state.incidentId, incidentType: state.incidentType,
    verdict: plan.verdict, determinationAt: plan.determinationAt, awarenessAt: plan.awarenessAt, asOf: plan.asOf,
    facts: state.steps.at(-1).facts, scope, obligations,
    evidence: plan.ledger.notices, cloud: '조건부 (#69)' };
}
