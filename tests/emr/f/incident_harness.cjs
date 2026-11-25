/* Actual F controller, contract and surface parser; only storage is synthetic. */
'use strict';
const { fixture: base, actor, EmrAuditController } = require('./inspection_harness.cjs');
const { INCIDENT_LIMITS } = require('../../../api/src/emr-audit/service.ts');
const { randomUUID, createHash } = require('node:crypto');
const known = value => ({ status: 'known', value });
function fixture(scopes = ['investigate', 'export'], institution = 'SYN-SITE', requestActor = actor) {
  const f = base(scopes, institution, [], requestActor), requests = [], copies = new Map(), query = f.tx.$queryRaw;
  f.copyReads = 0;
  f.events.splice(0, f.events.length, { formatVersion: 1, surface: 'GET studies/:uid/report/versions', eventId: 'SYN-READ',
    userId: known(actor), rolesAtTime: known(['radiologist']), actingInstitution: known('SYN-SITE'), managingInstitution: known('SYN-SITE'),
    occurredAt: '2026-10-02T00:00:00.000Z', trustedProxyIp: known({ address: '127.0.0.1', source: 'trusted-proxy' }),
    cause: 'user-view', executor: 'member', context: { basis: 'worklist', studyId: null, relatedStudyId: null, reason: null },
    targets: [{ kind: 'report-version', patientLinkSnapshot: known({ patientId: 'SYN-PATIENT', assigningAuthority: 'SYN-SITE', linkId: 'SYN-LINK' }),
      studyId: known('SYN-STUDY'), recordId: known('SYN-RECORD'), versionId: known('SYN-VERSION') }],
    action: 'provide-prepared', result: 'prepared', requestId: 'SYN-READ-REQUEST', auditLinkId: `audit:${randomUUID()}`, relatedEventId: null });
  f.tx.$queryRaw = async (parts, ...values) => {
    const sql = parts.join('?');
    if (sql.includes('FROM emr_audit.grantor')) return f.grantor ? [structuredClone(f.grantor)] : [];
    if (sql.includes('FROM emr_audit.roster_event') && values[0] === actor.id && requestActor.id !== actor.id) {
      const rows = await query(parts, ...values);
      return rows.map(r => ({ body: { ...r.body, grantId: 'SYN-ORIGINAL-GRANT', subject: actor } }));
    }
    if (sql.includes('FROM emr_audit.fixed_copy')) {
      // copyReads counts the copies whose bytes leave the store; a hash taken where they are is not a read.
      if (!Array.isArray(values[0])) { f.copyReads++; return copies.has(values[0]) ? [{ ...copies.get(values[0]) }] : []; }
      if (sql.includes('body,sha256')) f.copyReads += values[0].length;
      return values[0].filter(key => copies.has(key)).map(key => ({ issuance_id: key, ...copies.get(key),
        actual: createHash('sha256').update(copies.get(key).body).digest('hex') }));
    }
    // Events of operations unfinished when a registration takes its ceiling (set by a test).
    if (sql.includes('pending_operations')) return (f.pending || []).map(event_id => ({ event_id }));
    // The ledger rows of the period below a ceiling: sequences are stable while a test adds newer events in front.
    if (sql.includes('investigation_entries')) {
      f.reads.push(values);
      const top = values[4], below = values[5], take = values[6], total = f.events.length;
      const rows = [];
      for (let i = Math.max(0, top === null ? 0 : total - Number(top), below === null ? 0 : total - Number(below) + 1); i < total && rows.length < take; i++)
        rows.push({ sequence: BigInt(total - i), payload: JSON.stringify(f.events[i]), recorded_at: new Date(f.events[i].occurredAt), snapshot_top: BigInt(total) });
      return rows;
    }
    if (sql.includes('FROM emr_audit.request_event')) {
      if (sql.includes('AS copied')) return requests.filter(r => r.body.incidentId === values[0]).slice(-1).map(r => ({ copied: !!r.body.snapshot?.copy }));
      if (sql.includes('DISTINCT ON')) return structuredClone([...new Map(requests.filter(r => r.institution_id === values[0] && r.body.kind === 'incident').map(r => [r.body.incidentId, r])).values()]);
      // A read made before another request's registration committed (set by a test): it sees no incident yet.
      if (f.unsavedReads > 0 && !sql.includes('pg_advisory')) { f.unsavedReads--; return []; }
      return structuredClone(requests.filter(r => r.body.incidentId === values[0]).slice(-1));
    }
    return query(parts, ...values);
  };
  f.tx.$executeRaw = async (parts, ...values) => {
    const sql = parts.join('?');
    if (sql.includes('INSERT INTO emr_audit.fixed_copy')) {
      if (copies.has(values[0])) throw Error('Duplicate fixed copy');
      copies.set(values[0], { body: Buffer.from(values[1]), sha256: values[2] }); return 1;
    }
    if (!sql.includes('INSERT INTO emr_audit.request_event')) throw Error('Unexpected write');
    requests.push({ institution_id: values[1], body: JSON.parse(values[2]) }); return 1;
  };
  f.grantor = { capacity: 'privacy-officer', basis_document_id: 'SYN-DESIGNATION' };
  return Object.assign(f, { requests, copies });
}
function intake(id = 'SYN-INCIDENT', status = 'possible') {
  return { incidentId: id, incidentType: 'cvr-misdelivery', query: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-03T00:00:00.000Z' },
    determinations: [{ kind: 'access-outside-ledger', note: '합성 CVR 오발송: 원장 밖 수신자 확인 중 <img>' }],
    facts: { incidentId: id, awarenessAt: '2026-11-01T00:00:00.000Z', determinationAt: '2026-11-01T00:00:00.000Z', status,
      possibleGround: status === 'possible' ? 'illegal-access-unidentifiable' : null,
      evidenceId: 'SYN-FINDING-1', detailsComplete: true, newlyConfirmedAt: null, reportTriggers: [], medicalIncident: null } };
}
function notice(obligation, id = 'SYN-NOTICE') {
  return { operationId: id, notice: { kind: obligation.kind, triggeredAt: obligation.triggeredAt, noticeId: id,
    sentAt: '2026-11-01T02:00:00.000Z', triggerEventId: obligation.triggerEventId, recipientScopeRef: obligation.recipientScopeRef,
    coversAll: true, evidenceId: id + '-EVIDENCE', coveredFields: obligation.requiredFields,
    channel: obligation.recipient === 'PIPC-or-KISA' ? 'PIPC' : obligation.recipient === 'MOHW' ? 'MOHW-official' : obligation.recipient === 'MSIT-or-KISA' ? 'KISA' : 'affected-users' } };
}
function decider(at = '2026-11-01T00:00:00.000Z') {
  return { verifiedAt: at, designation: { categoryBasis: 'privacy-decree:32.2.1', categoryEvidenceId: 'SYN-CATEGORY',
    qualificationRequired: false, qualificationAssessmentEvidenceId: 'SYN-QUALIFICATION' } };
}
function exemption(obligation, id = 'SYN-EXEMPT') {
  return { operationId: id, decision: { decisionId: id, obligationKey: obligation.obligationKey,
    at: '2026-11-01T01:00:00.000Z', authorityEvidenceId: 'SYN-DESIGNATION', evidenceId: id + '-EVIDENCE',
    reason: '합성 면제 결정 근거', basis: 'privacy-decree:40.1:last-sentence', effect: 'report-exemption', stillOwed: false,
    category: 'risk-substantially-reduced', decider: decider() } };
}
function delay(obligation, id = 'SYN-DELAY') {
  return { operationId: id, delay: { delayId: id, obligationKey: obligation.obligationKey,
    clause: { possibility: 'privacy-decree:39-3.1', confirmed: 'privacy-decree:39.1', report: 'privacy-decree:40.1' }[obligation.family],
    version: '2026-09-11', reason: '합성 불가항력 지연', evidenceId: id + '-EVIDENCE',
    startedAt: '2026-11-01T00:30:00.000Z', clearedAt: null, accepted: true, decisionId: id + '-DECISION', supersedes: null,
    category: 'force-majeure', decider: decider(), causalReview: { evidenceId: 'SYN-CAUSE',
      reviewedAt: '2026-11-01T01:00:00.000Z', relatesToTime: '2026-11-01T00:30:00.000Z',
      createdAt: '2026-11-01T00:30:00.000Z', receivedAt: '2026-11-01T00:45:00.000Z', reason: '합성 인과 검토' } } };
}
module.exports = { fixture, intake, notice, exemption, delay, decider };
if (require.main === module) {
  let f = fixture();
  const Filter = Reflect.getMetadata('__exceptionFilters__', EmrAuditController)[0];
  require('node:readline').createInterface({ input: process.stdin }).on('line', async line => {
    try {
      const q = JSON.parse(line);
      if (q.reset) { f = fixture(q.scopes, q.institution); process.stdout.write(JSON.stringify({ status: 200, body: {} }) + '\n'); return; }
      if (q.inspect) { process.stdout.write(JSON.stringify({ status: 200, body: { records: f.records, requests: f.requests } }) + '\n'); return; }
      // A page test's ledger of `count` recent reads of `patients` patients, and the sizes at which this run pages a range.
      if (q.ledger) {
        const first = f.events[0], at = new Date(Date.now() - 3600_000).toISOString();
        f.events.splice(0, f.events.length, ...Array.from({ length: q.ledger.count }, (_, i) => ({ ...structuredClone(first), eventId: `SYN-READ-${i}`, occurredAt: at,
          targets: [{ ...structuredClone(first.targets[0]), versionId: known(`SYN-VERSION-${i}`), patientLinkSnapshot: known({
            patientId: `SYN-P${String(i % q.ledger.patients).padStart(3, '0')}`, assigningAuthority: 'SYN-SITE', linkId: `SYN-LINK-${i % q.ledger.patients}` }) }] })));
        Object.assign(INCIDENT_LIMITS, q.limits);
        process.stdout.write(JSON.stringify({ status: 200, body: {} }) + '\n'); return;
      }
      const body = await f.controller[q.method]({}, ...(q.id ? [q.id] : []), ...(q.form ? [q.form] : []), ...(q.body ? [q.body] : []),
        ...(q.query ? [q.query.subjects, q.query.events] : []));
      process.stdout.write(JSON.stringify({ status: 200, body }) + '\n');
    } catch (error) {
      let status = 500, body = { code: error.code || error.message };
      new Filter().catch(error, { switchToHttp: () => ({ getResponse: () => ({ status: s => { status = s; return { json: b => { body = b; } }; } }) }) });
      process.stdout.write(JSON.stringify({ status, body }) + '\n');
    }
  });
}
