'use strict';
// Patient Consent (api/src/patient-consent.service.ts) with a synthetic database and archive: the patient is the caller's
// institution plus the exact original Patient ID on an owned, single-resource, Study-Access-allowed study; every route
// asks that one rule; another institution's patient and an unknown ID answer the same 404. A record and its withdrawal
// each write one audit row; a retried request returns the same row. A patient row is never transfer evidence, and the
// Connect basis answers keep their old fields. Patient-level permission is the existing Study Access Original Patient ID
// rule (api/src/study-access.service.ts), shown with two accounts of one institution.
const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs');
const root = path.resolve(__dirname, '..'), ts = require(path.join(root, 'api/node_modules/typescript'));
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, experimentalDecorators: true,
    emitDecoratorMetadata: true, esModuleInterop: true }, fileName: filename,
}).outputText, filename);
const { Prisma } = require(path.join(root, 'api/node_modules/@prisma/client'));
const { PatientConsentService } = require('../api/src/patient-consent.service.ts');
const { ConnectService } = require('../api/src/connect.service.ts');
const { StudyAccessService } = require('../api/src/study-access.service.ts');

const A = 'synthetic-hospital-a', B = 'synthetic-hospital-b';
const adminA = { sub: 'admin-a', actor: 'admin-a@example.test', roles: ['admin'], institution: A, kind: 'member' };
const adminA2 = { sub: 'admin-a2', actor: 'admin-a2@example.test', roles: ['admin'], institution: A, kind: 'member' };
const adminB = { sub: 'admin-b', actor: 'admin-b@example.test', roles: ['admin'], institution: B, kind: 'member' };
const past = (days = 1) => new Date(Date.now() - days * 86400000).toISOString();
const future = (days = 1) => new Date(Date.now() + days * 86400000).toISOString();
const rid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

// The archive: one row per original Study resource (a UID two patients share has two rows).
function archive() {
  const resources = [
    { uid: '1.2.1', pid: 'P1', name: 'SYN^ONE' }, { uid: '1.2.2', pid: 'P1', name: 'SYN^ONE' },
    { uid: '1.2.3', pid: 'P1', name: 'SYN^ONE' },                                  // excluded by the admin's Study Access
    { uid: '1.2.4', pid: 'P8', name: 'SYN^SHARED' }, { uid: '1.2.4', pid: 'P9', name: 'SYN^OTHER' }, // shared UID
    { uid: '1.2.5', pid: 'P2', name: 'SYN^FOREIGN' },                              // owned by B
    { uid: '1.2.6', pid: 'P3', name: 'SYN^TELE' },                                 // owned by B, read by A as telerad
    { uid: '1.2.7', pid: 'P4', name: 'SYN^UNOWNED' },                              // no owner yet
    { uid: '1.2.8', pid: 'P5', name: 'SYN^EXCLUDED' },                             // A's, all excluded
    { uid: '1.2.9', pid: 'P1 ', name: 'SYN^PADDED' },                              // a different ID (trailing space)
  ];
  const states = [['1.2.1', A], ['1.2.2', A], ['1.2.3', A], ['1.2.4', A], ['1.2.5', B], ['1.2.6', B, A], ['1.2.7', null], ['1.2.8', A], ['1.2.9', A]]
    .map(([uid, institutionId, teleInstitutionId = null]) => ({ uid, institutionId, teleInstitutionId }));
  let fail = false;
  const qido = r => ({ '0020000D': { Value: [r.uid] }, '00100020': { Value: [r.pid] }, '00100010': { Value: [{ Alphabetic: r.name }] } });
  const orthanc = {
    reads: 0,
    set fail(v) { fail = v; },
    patientStudyUids: async pid => { orthanc.reads++; if (fail) throw new (require(path.join(root, 'api/node_modules/@nestjs/common')).ServiceUnavailableException)('archive down');
      return [...new Set(resources.filter(r => r.pid === pid).map(r => r.uid))]; },
    studiesByUid: async uids => { if (fail) throw new Error('down'); return uids.flatMap(uid => resources.filter(r => r.uid === uid).map(qido)); },
    connectStudyIdentity: async uid => ({ patientId: resources.find(r => r.uid === uid).pid }),
  };
  return { resources, states, orthanc };
}

const pick = (row, select) => select ? Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]])) : { ...row };
function matches(row, where) {
  return Object.entries(where).every(([k, v]) => v !== null && typeof v === 'object' && !(v instanceof Date)
    ? ('in' in v ? v.in.includes(row[k]) : 'gt' in v ? (v.gt === undefined || row[k] > v.gt) : true)
    : v === undefined ? true : row[k] === v);
}

function database(world) {
  let bases = [], audits = [], transfers = [];
  const db = {
    studyState: {
      findMany: async ({ where, select }) => world.states.filter(s => matches(s, where)).map(s => pick(s, select)),
      findUnique: async ({ where }) => world.states.find(s => s.uid === where.uid) ?? null,
    },
    transferBasis: {
      findMany: async ({ where, orderBy, take, select }) => {
        let rows = bases.filter(b => matches(b, where));
        if (Array.isArray(orderBy)) rows.sort((x, y) => y.recordedAt - x.recordedAt || (y.id < x.id ? -1 : 1));
        else rows.sort((x, y) => x.id < y.id ? -1 : 1);
        return rows.slice(0, take ?? rows.length).map(r => pick(r, select));
      },
      findUnique: async ({ where }) => {
        const key = where.institutionId_recordedBySub_requestId;
        const row = key ? bases.find(b => b.institutionId === key.institutionId && b.recordedBySub === key.recordedBySub && b.requestId === key.requestId)
          : bases.find(b => b.id === where.id);
        return row ? { ...row } : null;
      },
      findFirst: async ({ where, select }) => { const row = bases.find(b => matches(b, where)); return row ? pick(row, select) : null; },
      create: async ({ data, select }) => {
        if (data.requestId && bases.some(b => b.institutionId === data.institutionId && b.recordedBySub === data.recordedBySub && b.requestId === data.requestId))
          throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'synthetic' });
        // The migration's subject check, as the database would answer.
        const patient = data.studyUid == null;
        if (patient ? !(data.kind === 'PATIENT_CONSENT' && data.patientId?.trim() && data.purpose?.trim() && data.requestId && data.recordedBySub)
          : (data.patientId != null || data.purpose != null || data.requestId != null || data.recordedBySub != null)) throw new Error('TransferBasis_subject_check');
        const row = { patientId: null, purpose: null, requestId: null, recordedBySub: null, expiresAt: null, revokedAt: null, revokedBy: null,
          revokeReason: null, ...data };
        bases.push(row); return pick(row, select);
      },
      update: async ({ where, data, select }) => { const row = bases.find(b => b.id === where.id); Object.assign(row, data); return pick(row, select); },
      updateMany: async ({ where, data }) => { const rows = bases.filter(b => matches(b, where)); rows.forEach(r => Object.assign(r, data)); return { count: rows.length }; },
    },
    processingAgreement: { findFirst: async () => ({ id: rid(900) }) },
    institution: { findUnique: async ({ where }) => [A, B].includes(where.id) ? { id: where.id } : null },
    transfer: { findFirst: async () => null, create: async ({ data }) => { transfers.push(data); return data; } },
    auditLog: { create: async ({ data }) => { audits.push(data); return { id: audits.length }; } },
    $executeRaw: async () => 0,
    $queryRaw: async (strings, ...values) => {
      const sql = strings.join('?');
      if (sql.includes('FROM "StudyState"')) return world.states.filter(s => s.uid === values[0]);
      if (sql.includes('FROM "StudyAccessPolicy"')) return world.policies?.(values[0]) ?? [];
      return [{ locked: 1 }];
    },
  };
  // A transaction that throws leaves nothing behind.
  db.$transaction = async work => {
    const saved = [bases.map(b => ({ ...b })), audits.slice(), transfers.slice()];
    try { return await work(db); } catch (e) { [bases, audits, transfers] = saved; throw e; }
  };
  return { db, get bases() { return bases; }, get audits() { return audits; }, get transfers() { return transfers; } };
}

// The admin's own Study Access excludes 1.2.3 and 1.2.8.
const access = { allowed: async (c, uids) => new Set(uids.filter(uid => !['1.2.3', '1.2.8'].includes(uid))), prepare: async () => {}, snapshot: async () => ({ policy: { restricted: false } }), require: async () => {} };

const status = code => e => e?.getStatus?.() === code;
const notFound = e => status(404)(e) && e.getResponse().code === 'CONSENT_PATIENT_NOT_FOUND';

(async () => {
  // ── 1. The patient: one rule for every route.
  {
    const w = archive(), d = database(w), s = new PatientConsentService(d.db, w.orthanc, access);
    const first = await s.lookup(adminA, { patientId: 'P1' });
    assert.deepEqual(first, { owner: [A, 'admin-a'], patient: { patientId: 'P1', names: ['SYN^ONE'] }, records: [] });
    assert.deepEqual((await s.patientOf(adminA, 'P1')).studies, ['1.2.1', '1.2.2'], 'excluded study is not evidence');
    for (const id of ['P2', 'P3', 'P4', 'P5', 'P8', 'P404', 'SYN-OVERLAY']) {
      await assert.rejects(s.lookup(adminA, { patientId: id }), notFound, id);
      await assert.rejects(s.record(adminA, { patientId: id, purpose: 'x', reference: 'y', obtainedAt: past(), requestId: rid(1) }), notFound, id);
      await assert.rejects(s.withdraw(adminA, rid(2), { patientId: id, reason: 'r' }), notFound, id);
    }
    // P9 shares 1.2.4 with P8 and has no other study; P1 with a trailing space is another ID.
    await assert.rejects(s.lookup(adminA, { patientId: 'P9' }), notFound);
    // The same ID at two institutions: each reads only its own studies. A shared UID beside a normal study: the normal one counts.
    w.resources.push({ uid: '1.2.12', pid: 'P1', name: 'SYN^B-ONE' }); w.states.push({ uid: '1.2.12', institutionId: B, teleInstitutionId: null });
    w.resources.push({ uid: '1.2.13', pid: 'P9', name: 'SYN^OTHER' }); w.states.push({ uid: '1.2.13', institutionId: A, teleInstitutionId: null });
    assert.deepEqual(await s.patientOf(adminA, 'P1'), { institution: A, patientId: 'P1', studies: ['1.2.1', '1.2.2'], names: ['SYN^ONE'] });
    assert.deepEqual(await s.patientOf(adminB, 'P1'), { institution: B, patientId: 'P1', studies: ['1.2.12'], names: ['SYN^B-ONE'] });
    assert.deepEqual((await s.patientOf(adminA, 'P9')).studies, ['1.2.13']);
    assert.deepEqual((await s.lookup(adminB, { patientId: 'P2' })).patient.names, ['SYN^FOREIGN'], 'the owner institution sees its own patient');
    for (const bad of [{ patientId: 'P*' }, { patientId: 'P?' }, { patientId: 'P\\1' }, { patientId: ' P1' }, { patientId: '' },
      { patientId: 'x'.repeat(65) }, { patientId: 'P\u00011' }, {}, { patientId: 'P1', extra: 1 }, { patientId: 7 }])
      await assert.rejects(s.lookup(adminA, bad), status(400), JSON.stringify(bad));
    w.orthanc.fail = true;
    await assert.rejects(s.lookup(adminA, { patientId: 'P1' }), status(503), 'a failed archive read is not an empty history or a 404');
    w.orthanc.fail = false;
    for (const who of [{ ...adminA, roles: ['radiologist'] }, { ...adminA, roles: ['clinician'] }, { ...adminA, roles: ['technician'] },
      { ...adminA, kind: 'gateway' }, { ...adminA, institution: null }]) {
      const reads = w.orthanc.reads;
      await assert.rejects(s.lookup(who, { patientId: 'P1' }), status(403));
      await assert.rejects(s.record(who, { patientId: 'P1', purpose: 'x', reference: 'y', obtainedAt: past(), requestId: rid(1) }), status(403));
      await assert.rejects(s.withdraw(who, rid(2), { patientId: 'P1', reason: 'r' }), status(403));
      assert.equal(w.orthanc.reads, reads, 'a refused caller reads nothing');
    }
    assert.equal(d.bases.length, 0); assert.equal(d.audits.length, 0);
  }

  // ── 2. Record, read again, retry, input refusals.
  {
    const w = archive(), d = database(w), s = new PatientConsentService(d.db, w.orthanc, access);
    const body = { patientId: 'P1', purpose: 'SYN research registry', reference: 'SYN-FORM-0001 (paper file, records office)',
      obtainedAt: past(2), expiresAt: future(300), requestId: rid(10) };
    const made = await s.record(adminA, body);
    assert.equal(made.replayed, false); assert.equal(made.state, 'active'); assert.equal(made.purpose, body.purpose);
    assert.equal(made.reference, body.reference); assert.equal(made.obtainedAt, body.obtainedAt); assert.equal(made.expiresAt, body.expiresAt);
    assert.equal(made.recordedBy, 'admin-a@example.test');
    const stored = d.bases[0];
    assert.equal(stored.studyUid, null); assert.equal(stored.patientId, 'P1'); assert.equal(stored.kind, 'PATIENT_CONSENT');
    assert.equal(stored.institutionId, A); assert.equal(stored.recordedBySub, 'admin-a'); assert.equal(stored.requestId, rid(10));
    assert.deepEqual(d.audits.map(a => [a.action, a.target, JSON.parse(a.detail)]),
      [['patient.consent.record', made.id, { institution: A, consentId: made.id, before: null, after: 'active' }]]);
    // Another administrator of the same institution reads it again; another institution does not.
    const again = await s.lookup(adminA2, { patientId: 'P1' });
    assert.deepEqual(again.records.map(r => [r.id, r.purpose, r.reference, r.obtainedAt, r.expiresAt, r.recordedBy, r.state]),
      [[made.id, body.purpose, body.reference, body.obtainedAt, body.expiresAt, 'admin-a@example.test', 'active']]);
    await assert.rejects(s.lookup(adminB, { patientId: 'P1' }), notFound);
    // The same request after a lost answer: the same row, no second audit. The same key with other content: 409.
    const replay = await s.record(adminA, body);
    assert.equal(replay.id, made.id); assert.equal(replay.replayed, true); assert.equal(d.audits.length, 1); assert.equal(d.bases.length, 1);
    await assert.rejects(s.record(adminA, { ...body, purpose: 'SYN another purpose' }), e => status(409)(e) && e.getResponse().code === 'CONSENT_REQUEST_REUSED');
    // The same request id from another administrator is another request.
    const other = await s.record(adminA2, { ...body, purpose: 'SYN second', expiresAt: undefined });
    assert.notEqual(other.id, made.id); assert.equal(other.expiresAt, null);
    const list = (await s.lookup(adminA, { patientId: 'P1' })).records;
    assert.equal(list.length, 2);
    // A concurrent attempt of the same request committed first: answer with that row.
    const race = { ...body, requestId: rid(11) };
    const original = d.db.transferBasis.findUnique;
    let calls = 0;
    d.db.transferBasis.findUnique = async q => (calls++ === 0 ? null : original(q));
    const created = await s.record(adminA, race);
    d.db.transferBasis.findUnique = original;
    calls = 0;
    d.db.transferBasis.findUnique = async q => (calls++ === 0 ? null : original(q));
    const raced = await s.record(adminA, race);
    d.db.transferBasis.findUnique = original;
    assert.equal(raced.id, created.id); assert.equal(raced.replayed, true);
    const audits = d.audits.length, rows = d.bases.length;
    for (const bad of [{ obtainedAt: future() }, { obtainedAt: '2026-11-01' }, { obtainedAt: '2026-02-30T00:00:00Z' }, { expiresAt: past(3) },
      { expiresAt: body.obtainedAt }, { purpose: '' }, { purpose: '   ' }, { purpose: 'x'.repeat(501) }, { reference: '' }, { reference: 'a\u0007b' },
      { requestId: 'not-a-uuid' }, { requestId: undefined }, { purpose: undefined }, { kind: 'LEGAL_BASIS' }, { studyUid: '1.2.1' }])
      await assert.rejects(s.record(adminA, { ...body, requestId: rid(50), ...bad }), status(400), JSON.stringify(bad));
    assert.equal(d.audits.length, audits); assert.equal(d.bases.length, rows);
    // A record entered after its expiry: the answer and the audit row both say Expired.
    const late = await s.record(adminA, { ...body, requestId: rid(51), obtainedAt: past(30), expiresAt: past(1) });
    assert.equal(late.state, 'expired');
    assert.deepEqual(JSON.parse(d.audits.at(-1).detail), { institution: A, consentId: late.id, before: null, after: 'expired' });
  }

  // ── 3. Withdraw: once, with its reason; every other selection is 404 and keeps the row.
  {
    const w = archive(), d = database(w), s = new PatientConsentService(d.db, w.orthanc, access);
    const one = await s.record(adminA, { patientId: 'P1', purpose: 'SYN purpose', reference: 'SYN ref', obtainedAt: past(), requestId: rid(20) });
    const foreign = await s.record(adminB, { patientId: 'P2', purpose: 'SYN B', reference: 'SYN B ref', obtainedAt: past(), requestId: rid(21) });
    d.bases.push({ id: rid(22), studyUid: '1.2.1', institutionId: A, kind: 'PATIENT_CONSENT', reference: 'SYN study basis', obtainedAt: new Date(past()),
      expiresAt: null, recordedBy: 'x', recordedAt: new Date(), revokedAt: null, revokedBy: null, revokeReason: null, patientId: null, purpose: null, requestId: null, recordedBySub: null });
    w.resources.push({ uid: '1.2.10', pid: 'P6', name: 'SYN^SIX' }); w.states.push({ uid: '1.2.10', institutionId: A, teleInstitutionId: null });
    const sixth = await s.record(adminA, { patientId: 'P6', purpose: 'SYN six', reference: 'SYN six ref', obtainedAt: past(), requestId: rid(23) });
    const before = JSON.stringify(d.bases);
    for (const [id, patientId] of [[foreign.id, 'P1'], [rid(22), 'P1'], [sixth.id, 'P1'], [rid(99), 'P1'], [one.id, 'P6']])
      await assert.rejects(s.withdraw(adminA, id, { patientId, reason: 'SYN wrong selection' }), notFound, id + ' ' + patientId);
    await assert.rejects(s.withdraw(adminB, one.id, { patientId: 'P1', reason: 'r' }), notFound);
    await assert.rejects(s.withdraw(adminA, 'nope', { patientId: 'P1', reason: 'r' }), status(400));
    await assert.rejects(s.withdraw(adminA, one.id, { patientId: 'P1', reason: '' }), status(400));
    assert.equal(JSON.stringify(d.bases), before);
    const audits = d.audits.length;
    const done = await s.withdraw(adminA2, one.id.toUpperCase(), { patientId: 'P1', reason: 'SYN patient withdrew by phone' });
    assert.equal(done.state, 'withdrawn'); assert.equal(done.withdrawnBy, 'admin-a2@example.test'); assert.equal(done.withdrawReason, 'SYN patient withdrew by phone');
    assert.equal(done.purpose, 'SYN purpose', 'the original record stays');
    assert.deepEqual(d.audits.slice(audits).map(a => [a.action, a.target, JSON.parse(a.detail)]),
      [['patient.consent.revoke', one.id, { institution: A, consentId: one.id, before: 'active', after: 'withdrawn' }]]);
    await assert.rejects(s.withdraw(adminA, one.id, { patientId: 'P1', reason: 'SYN again' }), e => status(409)(e) && e.getResponse().code === 'CONSENT_ALREADY_WITHDRAWN');
    assert.equal(d.audits.length, audits + 1);
    assert.equal((await s.lookup(adminA, { patientId: 'P1' })).records[0].state, 'withdrawn');
    // An expired record reads as Expired and can still be withdrawn.
    d.bases.find(b => b.id === sixth.id).expiresAt = new Date(Date.now() - 1000);
    assert.equal((await s.lookup(adminA, { patientId: 'P6' })).records[0].state, 'expired');
  }

  // ── 4. A patient row is never transfer evidence; the Connect basis answers keep their fields.
  {
    const w = archive(), d = database(w), s = new PatientConsentService(d.db, w.orthanc, access);
    const consent = await s.record(adminA, { patientId: 'P1', purpose: 'SYN purpose', reference: 'SYN ref', obtainedAt: past(), requestId: rid(30) });
    const connect = new ConnectService(d.db, w.orthanc, access);
    const tech = { sub: 'tech-a', actor: 'tech-a@example.test', roles: ['technician'], institution: A, kind: 'member' };
    await assert.rejects(connect.openTransfer('1.2.1', { to: B, basisId: consent.id }, tech), e => status(403)(e) && e.getResponse().code === 'BASIS_MISSING');
    assert.equal(d.transfers.length, 0);
    const basis = await connect.recordBasis('1.2.1', { kind: 'PATIENT_CONSENT', reference: 'SYN study basis', obtainedAt: past() }, adminA);
    const fieldsOf = row => Object.keys(row).sort();
    const OLD = ['expiresAt', 'id', 'institutionId', 'kind', 'obtainedAt', 'recordedAt', 'recordedBy', 'reference', 'revokeReason', 'revokedAt', 'revokedBy', 'studyUid'];
    assert.deepEqual(fieldsOf(basis), OLD);
    const listed = await connect.listBasis('1.2.1', {}, adminA);
    assert.deepEqual(listed.items.map(r => r.id), [basis.id], 'the patient row is not a basis of the study');
    assert.deepEqual(fieldsOf(listed.items[0]), OLD);
    const revoked = await connect.revokeBasis('1.2.1', basis.id, { reason: 'SYN revoke' }, adminA);
    assert.deepEqual(fieldsOf(revoked), OLD);
    await assert.rejects(connect.revokeBasis('1.2.1', consent.id, { reason: 'SYN revoke' }, adminA), status(404));
    assert.ok(!d.audits.some(a => a.action.startsWith('basis.') && JSON.parse(a.detail).basisId === consent.id));
  }

  // ── 5. Patient Permission: the existing Study Access rule with the Original Patient ID alone, two accounts of one institution.
  {
    const w = archive();
    w.resources.push({ uid: '1.2.11', pid: 'P7', name: 'SYN^SEVEN' }); w.states.push({ uid: '1.2.11', institutionId: A, teleInstitutionId: null });
    const policies = new Map();
    w.policies = subject => policies.has(subject) ? [{ institution: A, revision: 1, policy: policies.get(subject), reason: 'SYN', updatedBy: 'admin-a', updatedAt: new Date('2026-11-01T00:00:00Z') }] : [];
    const d = database(w);
    const orthanc = {
      studyIdentityResources: async uid => w.resources.filter(r => r.uid === uid).map(r => ({ '0020000D': { Value: [r.uid] }, '00100020': { Value: [r.pid] }, '00080020': { Value: ['20261101'] }, '00080061': { Value: ['CT'] } })),
      studyIdentities: async () => w.resources.map(r => ({ '0020000D': { Value: [r.uid] }, '00100020': { Value: [r.pid] }, '00080020': { Value: ['20261101'] }, '00080061': { Value: ['CT'] } })),
    };
    const studyAccess = new StudyAccessService(d.db, orthanc, null);
    const patientOnly = pid => ({ version: 1, restricted: true, startsAt: null, endsAt: null, rules: [{ patientId: pid, modalities: [], dateFrom: null, dateTo: null, studyUids: [] }] });
    const denyAll = { version: 1, restricted: true, startsAt: null, endsAt: null, rules: [] };
    const readerA = { sub: 'reader-a', actor: 'reader-a@example.test', roles: ['radiologist'], institution: A, kind: 'member' };
    const readerB = { sub: 'reader-b', actor: 'reader-b@example.test', roles: ['radiologist'], institution: A, kind: 'member' };
    const wanted = ['1.2.1', '1.2.2', '1.2.11'];
    policies.set('reader-a', patientOnly('P1')); policies.set('reader-b', denyAll);
    assert.deepEqual([...await studyAccess.allowed({ ...readerA }, wanted)].sort(), ['1.2.1', '1.2.2'], 'A opens both of X and not Y');
    assert.deepEqual([...await studyAccess.allowed({ ...readerB }, wanted)], [], 'B opens none of X');
    await assert.rejects(studyAccess.require({ ...readerB }, ['1.2.1']), status(404));
    policies.set('reader-a', denyAll);
    assert.deepEqual([...await studyAccess.allowed({ ...readerA }, wanted)], [], 'withdrawn: A opens none of X');
    await assert.rejects(studyAccess.require({ ...readerA }, ['1.2.2']), status(404));
    // A consent record does not change either answer.
    const consent = new PatientConsentService(d.db, { patientStudyUids: async pid => w.resources.filter(r => r.pid === pid).map(r => r.uid),
      studiesByUid: async uids => uids.flatMap(uid => w.resources.filter(r => r.uid === uid).map(r => ({ '0020000D': { Value: [r.uid] }, '00100020': { Value: [r.pid] } }))) },
      { allowed: async (c, uids) => new Set(uids) });
    await consent.record(adminA, { patientId: 'P1', purpose: 'SYN', reference: 'SYN', obtainedAt: past(), requestId: rid(40) });
    assert.deepEqual([...await studyAccess.allowed({ ...readerB }, wanted)], [], 'a consent opens nothing');
    policies.set('reader-a', patientOnly('P1'));
    assert.deepEqual([...await studyAccess.allowed({ ...readerA }, wanted)].sort(), ['1.2.1', '1.2.2']);
  }

  process.stdout.write('Patient consent contracts passed\n');
  finished = true;
})().catch(e => { console.error(e); process.exitCode = 1; });
let finished = false;
process.on('exit', code => { if (!finished && code === 0) { console.error('Patient consent contracts did not finish'); process.exitCode = 1; } });
