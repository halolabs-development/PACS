'use strict';
/* Reading request on the API (api/src/pacs/reading-request.ts) over a store that records every statement: who may ask and
 * the body are checked before anything is read; the study row is locked first; an open request answers a second press as
 * it is; an approved or destroyed report row refuses a new one; a request writes the five StudyState fields and exactly one
 * audit row (who, when, the study and the row it opens on); the approval's close reaches the originals that row answers for
 * (a merged exam's every study, a split exam's first part only); the worklist and clinician views of a request. The rule
 * on PostgreSQL (two connections, the real approval, a merged exam) is tests/e2e/test_reading_request.py's.
 * No DB, credentials or network.
 */
require('./service_test_loader.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('/app/dist/pacs/reading-request');

const INST = 'SYN-INST', OTHER = 'SYN-OTHER';
const UID = '2.25.7701', UID_B = '2.25.7702';
const member = (sub, roles, extra = {}) => ({ kind: 'member', institution: INST, sub, actor: sub + '@syn', roles, name: 'SYN ' + sub, ...extra });
const CLIN = member('syn-clin', ['clinician']);
const owner = c => [c.institution, c.sub];
const code = (status, value) => e => typeof e?.getStatus === 'function' && e.getStatus() === status && e.getResponse()?.code === value;

/** Does a Prisma `where` of the exam-group reads (OR of uid columns, groupId or id `in`) match this row? */
const matches = (row, where = {}) => Object.entries(where).every(([key, want]) => key === 'OR'
  ? want.some(part => matches(row, part))
  : want && typeof want === 'object' && Array.isArray(want.in) ? want.in.includes(row[key]) : row[key] === want);

/**
 * A store with one StudyState row per uid; every raw statement is recorded with its values. `sources` is how many patient
 * resources Orthanc answered per uid (one unless named). `merged` is an exam group that only the transaction's own reads
 * see: committed by a merge while the request waited for the study row's lock (the reads before the lock saw none).
 */
function world(rows = {}, { sources = {}, merged = null } = {}) {
  const statements = [], audits = [], identities = [];
  const text = (strings, values) => ({ text: [...strings].join('?'), params: values });
  const tx = {
    $executeRaw: async (strings, ...values) => { statements.push(text(strings, values)); return 1; },
    $queryRaw: async (strings, ...values) => {
      const s = text(strings, values);
      statements.push(s);
      if (s.text.includes('FOR UPDATE')) return rows[values[0]] ? [{ ...rows[values[0]] }] : [];
      if (s.text.includes('SELECT rs FROM')) return rows[values[0]] ? [{ rs: rows[values[0]].rs }] : [];
      return [];
    },
    studyGroupMember: { findMany: async () => [] },
    studyGroup: { findMany: async () => [] },
    studyState: { updateMany: async args => { statements.push({ text: 'updateMany', params: [args] }); return { count: 0 }; },
      findUnique: async ({ where }) => rows[where.uid] ?? null,
      findMany: async ({ where }) => (where.uid.in ?? []).filter(uid => rows[uid]).map(uid => ({ ...rows[uid] })) },
    auditLog: { create: async ({ data }) => { audits.push(data); statements.push({ text: 'AUDIT', params: [] }); return data; } },
  };
  const prisma = { ...tx, $transaction: async fn => fn(merged ? { ...tx,
    studyGroupMember: { findMany: async ({ where }) => merged.members.filter(m => matches(m, where)) },
    studyGroup: { findMany: async ({ where }) => [merged.group].filter(g => matches(g, where)) } } : tx) };
  const access = { prepare: async () => {}, snapshot: async () => ({ policy: { restricted: false }, revision: 1 }),
    require: async () => {}, prepareSourceIdentity: async () => { identities.push('prepared'); },
    assertUnsplitSource: (_c, uid) => { identities.push(uid); return { sourcePatientId: 'SYN-P' }; },
    observedSourceCount: (_c, uid) => sources[uid] ?? 1 };
  return { prisma, access, statements, audits, rows, identities };
}
/** A merge of UID into UID_B's exam (UID_B the base row), as the merge commits it. */
const mergeIntoB = () => ({ group: { id: 'syn-group-1', kind: 'merge', baseUid: UID_B, institutionId: INST, dissolvedAt: null },
  members: [UID_B, UID].map((uid, part) => ({ groupId: 'syn-group-1', logicalUid: uid, studyUid: uid, part, seriesUids: [] })) });
const state = (extra = {}) => ({ uid: UID, institutionId: INST, rs: 'W', readingRequestAt: null, readingRequestBySub: null,
  readingRequestBy: null, readingRequestByName: null, readingRequestClosedAt: null, ...extra });
const create = (w, c = CLIN, body = { expectedOwner: owner(c) }, uid = UID) => R.createReadingRequest(w.prisma, w.access, c, uid, body);

test('who may ask and the body are checked before any statement', async () => {
  const w = world({ [UID]: state() });
  for (const c of [member('syn-rad', ['radiologist']), member('syn-tech', ['technician']), member('syn-admin', ['admin']),
    { ...CLIN, kind: 'service' }, { ...CLIN, sub: '' }])
    await assert.rejects(create(w, c, { expectedOwner: owner(c) }), code(403, 'READING_REQUEST_ROLE_REQUIRED'), c.sub);
  for (const body of [null, [], {}, { expectedOwner: owner(CLIN), reason: 'x' }, { expectedOwner: owner(CLIN), urgent: true }])
    await assert.rejects(create(w, CLIN, body), code(400, 'READING_REQUEST_INPUT_INVALID'), JSON.stringify(body));
  await assert.rejects(create(w, CLIN, { expectedOwner: owner(CLIN) }, 'not-a-uid'), code(400, 'READING_REQUEST_INPUT_INVALID'));
  await assert.rejects(create(w, CLIN, { expectedOwner: [INST, 'someone-else'] }), code(409, 'OWNER_CHANGED'));
  assert.deepEqual(w.statements, []);
  assert.deepEqual(w.audits, []);
});

test('a new request locks the study row first, writes the five fields and one audit row, and changes nothing else', async () => {
  const w = world({ [UID]: state() });
  const answer = await create(w);
  assert.equal(answer.created, true);
  assert.deepEqual(answer.owner, owner(CLIN));
  assert.deepEqual(Object.keys(answer.readingRequest).sort(), ['at', 'by', 'closedAt', 'open']);
  assert.equal(answer.readingRequest.by, 'SYN syn-clin');
  assert.equal(answer.readingRequest.open, true);
  assert.equal(answer.readingRequest.closedAt, null);
  const writes = w.statements.filter(s => /UPDATE|AUDIT|FOR UPDATE/.test(s.text));
  assert.match(writes[0].text, /FOR UPDATE/, 'the study row is locked before anything is written');
  assert.equal(writes.length, 3, writes.map(s => s.text).join('\n---\n'));
  const update = writes[1];
  assert.match(update.text, /UPDATE "StudyState" SET "readingRequestAt"=\?, "readingRequestBySub"=\?/);
  assert.match(update.text, /"readingRequestClosedAt"=NULL/);
  // Only the request fields and updatedAt: no rs, report, holder, assignment or image column.
  assert.doesNotMatch(update.text, /\brs\b|holder|repDoc|confirm|preDoc|teleInstitutionId|"approvedAt"/);
  assert.deepEqual(update.params.slice(1, 4), [CLIN.sub, CLIN.actor, 'SYN syn-clin']);
  assert.equal(update.params[update.params.length - 1], UID);
  assert.equal(w.audits.length, 1);
  const audit = w.audits[0];
  assert.deepEqual([audit.actor, audit.action, audit.target], [CLIN.actor, 'study.reading-request', UID]);
  const detail = JSON.parse(audit.detail);
  assert.deepEqual(Object.keys(detail).sort(), ['at', 'institution', 'openUid', 'role', 'sub']);
  assert.deepEqual([detail.institution, detail.sub, detail.openUid, detail.role], [INST, CLIN.sub, UID, 'clinician']);
  assert.equal(detail.at, answer.readingRequest.at);
  // The study is one identified source (prepared before the lock, asserted inside it).
  assert.deepEqual(w.identities, ['prepared', UID]);
});

test('a token without a name is named by its login; a mixed-role member who holds clinician may ask', async () => {
  const w = world({ [UID]: state() });
  const answer = await create(w, member('syn-mix', ['clinician', 'radiologist'], { name: '  ' }));
  assert.equal(answer.readingRequest.by, 'syn-mix@syn');
});

test('an open request answers a second press as it is: no second request, no audit row', async () => {
  const w = world({ [UID]: state({ readingRequestAt: new Date('2026-11-21T05:03:00Z'), readingRequestBy: 'first@syn',
    readingRequestByName: 'SYN First' }) });
  const answer = await create(w, member('syn-clin2', ['clinician']));
  assert.deepEqual(answer, { owner: [INST, 'syn-clin2'], created: false,
    readingRequest: { at: '2026-11-21T05:03:00.000Z', by: 'SYN First', open: true, closedAt: null } });
  assert.equal(w.statements.filter(s => s.text.startsWith('UPDATE')).length, 0);
  assert.deepEqual(w.audits, []);
});

test('a request closed by an approval and a report back before approval: a new request clears the closing time', async () => {
  const w = world({ [UID]: state({ readingRequestAt: new Date('2026-11-20T05:00:00Z'), readingRequestBy: 'old@syn',
    readingRequestClosedAt: new Date('2026-11-20T06:00:00Z') }) });
  const answer = await create(w);
  assert.equal(answer.created, true);
  assert.equal(w.audits.length, 1);
});

test('an approved or destroyed report row refuses a new request; another institution or no row is not found', async () => {
  for (const [rs, value] of [['A', 'READING_REQUEST_REPORTED'], ['D', 'READING_REQUEST_DESTROYED']]) {
    const w = world({ [UID]: state({ rs }) });
    await assert.rejects(create(w), code(409, value), rs);
    assert.equal(w.statements.filter(s => s.text.startsWith('UPDATE')).length, 0);
    assert.deepEqual(w.audits, []);
  }
  for (const rows of [{ [UID]: state({ institutionId: OTHER }) }, {}]) {
    const w = world(rows);
    await assert.rejects(create(w), code(404, 'STUDY_NOT_FOUND'));
    assert.deepEqual(w.audits, []);
  }
  // Waiting, saved, on hold or preliminary: not approved yet, so a request is made.
  for (const rs of ['W', 'T', 'H', 'P']) assert.equal((await create(world({ [UID]: state({ rs }) }))).created, true, rs);
});

test('a study whose original this request observed none of is not found: no request, no audit row', async () => {
  // Orthanc answered no patient resource for the study (its StudyState row of the caller's institution is still there).
  const w = world({ [UID]: state() }, { sources: { [UID]: 0 } });
  await assert.rejects(create(w), code(404, 'STUDY_NOT_FOUND'));
  assert.equal(w.statements.filter(s => s.text.startsWith('UPDATE')).length, 0);
  assert.deepEqual(w.audits, []);
  // Checked inside the lock, right after the source check.
  assert.match(w.statements.find(s => /FOR UPDATE/.test(s.text)).text, /FOR UPDATE/);
});

test('a merge committed while the request waited for the lock: not saved, the busy answer to press again', async () => {
  // Before the lock the study opened on itself; inside it the study is now in the merged exam whose base is UID_B.
  const w = world({ [UID]: state(), [UID_B]: state({ uid: UID_B }) }, { merged: mergeIntoB() });
  await assert.rejects(create(w), code(503, 'READING_REQUEST_BUSY'));
  assert.equal(w.statements.filter(s => s.text.startsWith('UPDATE')).length, 0);
  assert.deepEqual(w.audits, []);
});

test('the approval closes the open requests of the originals its row answers for, with its own time', async () => {
  const at = new Date('2026-11-21T07:00:00Z');
  // The approved row's own request: closed by the approval's own StudyState write, judged on that locked row.
  assert.deepEqual(R.ownReadingRequestClose(state({ readingRequestAt: new Date(), readingRequestBy: 'a@syn' }), at), { readingRequestClosedAt: at });
  assert.deepEqual(R.ownReadingRequestClose(state(), at), {});
  assert.deepEqual(R.ownReadingRequestClose(state({ readingRequestAt: new Date(), readingRequestClosedAt: new Date() }), at), {},
    'a closed request keeps its first closing time');
  // The other studies of a merged exam on its base row; nothing else is written (a single study, either part of a split).
  const runs = [
    [UID, { kind: 'merge', studies: [UID, UID_B] }, [UID_B]],
    [UID, { kind: null, studies: [UID] }, null],
    [UID, { kind: 'split', studies: [UID] }, null],
    ['2.25.7701.9', { kind: 'split', studies: [UID] }, null],
  ];
  for (const [uid, scope, expected] of runs) {
    const w = world();
    await R.closeMergedReadingRequests(w.prisma, uid, scope, at);
    if (expected === null) { assert.deepEqual(w.statements, [], uid + ' ' + scope.kind); continue; }
    assert.deepEqual(w.statements, [{ text: 'updateMany', params: [{
      where: { uid: { in: expected }, readingRequestAt: { not: null }, readingRequestClosedAt: null },
      data: { readingRequestClosedAt: at } }] }]);
  }
});

test('the views: open or closed with the closing time, and who may ask now', async () => {
  assert.equal(R.readingRequestView(state()), null);
  assert.deepEqual(R.readingRequestView(state({ readingRequestAt: new Date('2026-11-21T05:03:00Z'), readingRequestBy: 'a@syn' })),
    { at: '2026-11-21T05:03:00.000Z', by: 'a@syn', open: true, closedAt: null });
  assert.deepEqual(R.readingRequestView(state({ readingRequestAt: new Date('2026-11-21T05:03:00Z'), readingRequestBy: 'a@syn',
    readingRequestByName: 'SYN A', readingRequestClosedAt: new Date('2026-11-21T06:00:00Z') })),
    { at: '2026-11-21T05:03:00.000Z', by: 'SYN A', open: false, closedAt: '2026-11-21T06:00:00.000Z' });
  const rows = [state({ uid: '2.25.1' }), state({ uid: '2.25.2', rs: 'A' }), state({ uid: '2.25.3', rs: 'D' }),
    state({ uid: '2.25.4', readingRequestAt: new Date(), readingRequestBy: 'a@syn' }), state({ uid: '2.25.5', institutionId: OTHER }),
    state({ uid: '2.25.6', rs: 'T', readingRequestAt: new Date(), readingRequestBy: 'a@syn', readingRequestClosedAt: new Date() })];
  const w = world(Object.fromEntries(rows.map(row => [row.uid, row])));
  const out = await R.clinicianReadingRequests(w.prisma, w.access, CLIN, rows.map(row => row.uid));
  assert.deepEqual(rows.map(row => out.get(row.uid).readingRequestable), [true, false, false, false, false, true]);
  // Why not, as the POST would refuse it: approved, destroyed, open (shown as the request), another institution's.
  assert.deepEqual(rows.map(row => out.get(row.uid).readingRequestRefusal), [null, 'reported', 'destroyed', null, 'unavailable', null]);
  // A session without the clinician role (an administrator on the Physician screen) is never offered the press.
  const admin = await R.clinicianReadingRequests(w.prisma, w.access, member('syn-admin', ['admin']), ['2.25.1']);
  assert.deepEqual([admin.get('2.25.1').readingRequestable, admin.get('2.25.1').readingRequestRefusal], [false, 'role']);
  // The one rule, in its order.
  assert.equal(R.readingRequestRefusal(CLIN, state(), undefined), 'unavailable', 'no row it opens on');
  assert.equal(R.readingRequestRefusal(CLIN, state({ readingRequestAt: new Date() }), 'A'), 'open', 'an open request is answered as it is first');
  assert.equal(R.readingRequestRefusal(CLIN, state(), 'P'), null);
  // Another institution's study (a tele receiver's row) shows no request of the owner's.
  assert.equal(out.get('2.25.5').readingRequest, null);
  assert.equal(out.get('2.25.6').readingRequest.open, false);
});

test('the worklist rows: the open requests of the caller\'s own institution on the row they open on, nothing else', async () => {
  const rows = {
    '2.25.11': state({ uid: '2.25.11', readingRequestAt: new Date('2026-11-21T05:00:00Z'), readingRequestBy: 'a@syn', readingRequestByName: 'SYN A' }),
    '2.25.12': state({ uid: '2.25.12' }),
    '2.25.13': state({ uid: '2.25.13', readingRequestAt: new Date(), readingRequestBy: 'b@syn', readingRequestClosedAt: new Date() }),
    '2.25.14': state({ uid: '2.25.14', institutionId: OTHER, readingRequestAt: new Date(), readingRequestBy: 'c@syn' }),
  };
  const w = world();
  const out = await R.worklistReadingRequests(w.prisma, w.access, CLIN,
    Object.keys(rows).map(uid => ({ uid, studies: [uid] })), uid => rows[uid]);
  // Open, of the caller's institution: shown on its own row. Closed, none, or another institution's: nothing.
  assert.deepEqual([...out], [['2.25.11', { at: '2026-11-21T05:00:00.000Z', by: 'SYN A' }]]);
  // Judged on the rows the list read: no statement of its own.
  assert.deepEqual(w.statements, []);
  // A caller without an institution, or rows without an open request: nothing.
  assert.equal((await R.worklistReadingRequests(w.prisma, w.access, { ...CLIN, institution: null }, [{ uid: '2.25.11', studies: ['2.25.11'] }], uid => rows[uid])).size, 0);
  assert.equal((await R.worklistReadingRequests(w.prisma, w.access, CLIN, [{ uid: '2.25.12', studies: ['2.25.12'] }], uid => rows[uid])).size, 0);
});
