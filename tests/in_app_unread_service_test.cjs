'use strict';
/* In-app unread on the API (clinician-question.service.ts and image-request.service.ts unread() and seen()) over a store
 * that records every statement: the view and the seen body are checked before anything is read; a session without the
 * view's role is answered `available: false` without reading a row; the unread rows are chosen by the list's own
 * visibility filter (the same fragment the pool and own lists use) plus the rule's kinds and the caller's own seen mark;
 * the list's own statements keep their filter. The rule itself on PostgreSQL is tests/e2e/test_in_app_unread.py's.
 * No DB, credentials or network.
 */
require('./service_test_loader.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ClinicianQuestionService } = require('/app/dist/clinician-question.service');
const { ImageRequestService } = require('/app/dist/image-request.service');

const INST = 'SYN-INST';
const member = (sub, roles) => ({ kind: 'member', institution: INST, sub, actor: sub + '@syn', roles, name: 'SYN ' + sub });
const CLIN = member('syn-clin', ['clinician']), RAD = member('syn-rad', ['radiologist']), ADMIN = member('syn-admin', ['admin']);
const TECH = member('syn-tech', ['technician']);
const owner = c => [c.institution, c.sub];

/** A store that answers the statements of these reads with no row and records each one's text and values. */
function world(restricted = false) {
  const statements = [];
  const sql = (strings, values) => {
    // Prisma.sql fragments arrive as values: flatten them into the text the statement runs.
    const parts = [], params = [];
    const walk = (s, v) => s.forEach((piece, i) => {
      parts.push(piece);
      if (i >= v.length) return;
      const value = v[i];
      if (value && typeof value === 'object' && Array.isArray(value.strings) && Array.isArray(value.values)) walk(value.strings, value.values);
      else if (value && typeof value === 'object' && typeof value.sql === 'string' && Array.isArray(value.values)) { parts.push(value.sql); params.push(...value.values); }
      else { parts.push('?'); params.push(value); }
    });
    walk(strings, values);
    return { text: parts.join(''), params };
  };
  const prisma = {
    $queryRaw: async (strings, ...values) => {
      const statement = sql([...strings], values);
      statements.push(statement);
      return statement.text.includes('count(*)') ? [{ n: 0 }] : [];
    },
    studyState: { findMany: async () => [{ uid: '2.25.1' }] },
  };
  const access = { snapshot: async () => ({ policy: { restricted }, revision: 7 }), allowed: async (_c, uids) => new Set(uids),
    prepare: async () => {} };
  return { statements, questions: new ClinicianQuestionService(prisma, access), requests: new ImageRequestService(prisma, access) };
}
const code = (status, value) => e => typeof e?.getStatus === 'function' && e.getStatus() === status && e.getResponse()?.code === value;

test('a view is one of three names with an optional cursor; anything else is refused before a statement', async () => {
  const w = world();
  for (const q of [{}, { view: 'inbox' }, { view: 'question-mine', state: 'open' }, { view: ['question-mine'] }])
    await assert.rejects(w.questions.unread(CLIN, q), code(400, 'QUESTION_INPUT_INVALID'), JSON.stringify(q));
  for (const q of [{ view: 'question-mine' }, { view: 'image-request-mine', kind: 'x' }])
    await assert.rejects(w.requests.unread(CLIN, q), code(400, 'IMAGE_REQUEST_INPUT_INVALID'), JSON.stringify(q));
  await assert.rejects(w.questions.unread(CLIN, { view: 'question-mine', cursor: '!!' }), code(400, 'QUESTION_INPUT_INVALID'));
  assert.equal(w.statements.filter(s => s.text.includes('StudyQuestionEntry')).length, 0);
});

test('a session without the view role is answered available false and reads no row', async () => {
  const w = world();
  for (const [svc, c, view] of [['questions', CLIN, 'question-inbox'], ['questions', ADMIN, 'question-inbox'], ['questions', RAD, 'question-mine'],
    ['requests', RAD, 'image-request-mine'], ['requests', TECH, 'image-request-mine'], ['requests', ADMIN, 'image-request-mine']]) {
    const answer = await w[svc].unread(c, { view });
    assert.deepEqual(answer, { owner: owner(c), view, available: false, count: 0, items: [], nextCursor: null }, `${c.sub} ${view}`);
  }
  assert.deepEqual(w.statements, []);
});

test('the unread rows are chosen by the list filter, the view kinds, someone else and the caller seen mark', async () => {
  for (const restricted of [false, true]) {
    const w = world(restricted);
    await w.questions.unread(CLIN, { view: 'question-mine' });
    await w.questions.unread(RAD, { view: 'question-inbox' });
    await w.questions.list(CLIN, { view: 'mine' });
    await w.questions.list(RAD, { view: 'inbox' });
    await w.requests.unread(CLIN, { view: 'image-request-mine' });
    await w.requests.list(CLIN, { view: 'mine' });
    const [mineCount, mineRows, inboxCount, inboxRows, listMine, listInbox, reqCount, reqRows, reqList] = w.statements;
    const filter = 'q."institutionId"=? AND (NOT ? OR q."studyUid"=ANY(?::text[]))\n        AND (NOT ? OR q."authorSub"=?)';
    for (const s of [mineCount, mineRows, inboxCount, inboxRows, listMine, listInbox]) {
      assert.ok(s.text.includes(filter), s.text);
      assert.ok(s.text.includes('JOIN "StudyState" s ON s.uid=q."studyUid" AND s."institutionId"=q."institutionId"'), s.text);
      assert.equal(s.params[0], INST);
      assert.equal(s.params[1], restricted);
    }
    for (const s of [mineCount, mineRows]) {
      assert.deepEqual(s.params.slice(3, 5), [true, CLIN.sub]);
      assert.ok(s.text.includes('e."authorSub"<>?') && s.text.includes('"StudyQuestionSeen" v') && s.text.includes('e.seq >'), s.text);
      assert.ok(s.params.some(p => Array.isArray(p) && p.join() === 'answer,close'), JSON.stringify(s.params));
      assert.ok(s.params.filter(p => p === CLIN.sub).length >= 3, 'own threads, someone else, own seen mark');
    }
    for (const s of [inboxCount, inboxRows]) {
      assert.deepEqual(s.params.slice(3, 5), [false, RAD.sub]);
      assert.ok(s.text.includes("q.state::text='Open'"), s.text);
      assert.ok(s.params.some(p => Array.isArray(p) && p.join() === 'question,followup'), JSON.stringify(s.params));
    }
    const rfilter = 'r."institutionId"=? AND (NOT ? OR r."studyUid"=ANY(?::text[]))\n        AND (NOT ? OR r."requesterSub"=?)';
    for (const s of [reqCount, reqRows, reqList]) assert.ok(s.text.includes(rfilter), s.text);
    for (const s of [reqCount, reqRows]) {
      assert.ok(s.text.includes('x."subjectSub"<>?') && s.text.includes('"StudyImageRequestSeen" v'), s.text);
      assert.ok(s.params.some(p => Array.isArray(p) && p.join() === 'accept,close,decline,cancel'), JSON.stringify(s.params));
    }
    assert.ok(mineRows.params.includes(101) && reqRows.params.includes(101), 'a page of 100 and one more to tell a next page');
  }
});

test('a seen mark takes exactly the account and a positive revision, checked before any read', async () => {
  const w = world();
  const id = '00000000-0000-4000-8000-000000000001';
  for (const [svc, missing] of [['questions', 'QUESTION_INPUT_INVALID'], ['requests', 'IMAGE_REQUEST_INPUT_INVALID']]) {
    for (const body of [{}, { expectedOwner: owner(CLIN) }, { expectedOwner: owner(CLIN), revision: 0 }, { expectedOwner: owner(CLIN), revision: 1.5 },
      { expectedOwner: owner(CLIN), revision: 1, requestId: id }])
      await assert.rejects(w[svc].seen(id, CLIN, body), code(400, missing), JSON.stringify(body));
    await assert.rejects(w[svc].seen(id, CLIN, { expectedOwner: [INST, 'someone-else'], revision: 1 }), code(409, 'OWNER_CHANGED'));
  }
  await assert.rejects(w.questions.seen('not-a-uuid', CLIN, { expectedOwner: owner(CLIN), revision: 1 }), code(404, 'QUESTION_NOT_FOUND'));
  await assert.rejects(w.requests.seen('not-a-uuid', CLIN, { expectedOwner: owner(CLIN), revision: 1 }), code(404, 'IMAGE_REQUEST_NOT_FOUND'));
  await assert.rejects(w.questions.seen(id, TECH, { expectedOwner: owner(TECH), revision: 1 }), code(403, 'QUESTION_ROLE_REQUIRED'));
  assert.deepEqual(w.statements, []);
});

/* ── openUid: the row each item opens on, decided by the server (exam-merge.service.ts examOpenUids) ──
 * Over an in-memory exam store and the real resolveExamScope: a never-grouped study is itself, a split part its own
 * logical UID, a merged original its exam's base, an original of an undone merge itself again; a study whose exam the
 * caller may not read now (access, another institution, a retired split part) names no row. */
const { NotFoundException } = require('/app/node_modules/@nestjs/common');
const { examOpenUids } = require('/app/dist/exam-merge.service');
const A = '2.25.801', B = '2.25.802', X = '2.25.803', P = '2.25.804', O = '2.25.805';
const G_MERGE = '00000000-0000-4000-8000-00000000b001', G_SPLIT = '00000000-0000-4000-8000-00000000b002';
function match(row, where) {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return v.some(x => match(row, x));
    if (v && typeof v === 'object' && !Array.isArray(v) && 'in' in v) return v.in.includes(row[k]);
    return (row[k] ?? null) === v;
  });
}
const pick = (row, select) => select ? Object.fromEntries(Object.keys(select).map(k => [k, row[k]])) : { ...row };
function exams({ groups = [], members = [], denied = [], states = {} } = {}) {
  const state = uid => ({ uid, institutionId: INST, teleInstitutionId: null, rs: 'W', draftEpoch: null, ...(states[uid] || {}) });
  const rows = new Map([A, B, X, P, O].map(uid => [uid, state(uid)]));
  const db = {
    studyState: { findUnique: async ({ where }) => rows.get(where.uid) ?? null,
      findMany: async ({ where, select }) => [...rows.values()].filter(s => match(s, where)).map(s => pick(s, select)) },
    studyGroup: { findMany: async ({ where, select }) => groups.filter(g => match(g, where)).map(g => pick(g, select)) },
    studyGroupMember: { findMany: async ({ where, select }) => members.filter(m => match(m, where)).map(m => pick(m, select)) },
  };
  const prepared = [];
  const access = { prepare: async (_c, uids = []) => { prepared.push(...uids); }, prepareSourceIdentity: async () => {},
    require: async (_c, uids) => { if (uids.some(uid => denied.includes(uid))) throw new NotFoundException('SYN not found'); },
    allowed: async (_c, uids) => new Set(uids.filter(uid => !denied.includes(uid))),
    assertUnsplitSource: () => ({ sourcePatientId: 'SYN-P1', sourceInstitution: INST }),
    assertIdentifiedSource: () => ({ sourcePatientId: 'SYN-P1', sourceInstitution: INST }) };
  return { db, access, prepared, open: uids => examOpenUids(db, db, access, RAD, uids) };
}
const merge = (dissolvedAt = null) => ({
  groups: [{ id: G_MERGE, institutionId: INST, kind: 'merge', baseUid: A, dissolvedAt }],
  members: [A, B].map((uid, part) => ({ groupId: G_MERGE, logicalUid: uid, studyUid: uid, part, seriesUids: [] })) });
const split = (dissolvedAt = null) => ({
  groups: [{ id: G_SPLIT, institutionId: INST, kind: 'split', baseUid: A, dissolvedAt }],
  members: [{ groupId: G_SPLIT, logicalUid: A, studyUid: A, part: 0, seriesUids: [] },
    { groupId: G_SPLIT, logicalUid: X, studyUid: A, part: 1, seriesUids: ['2.25.803.1'] }] });
const asObject = map => Object.fromEntries([...map].sort());

test('openUid: a never-grouped study is itself, read without an exam lookup per study', async () => {
  const e = exams();
  assert.deepEqual(asObject(await e.open([P, O, P])), { [O]: O, [P]: P });
  assert.deepEqual(e.prepared, [], 'no source observation for a study that was never grouped');
});

test('openUid: a split exam - a question on part one opens part one (A), one on part two its own row', async () => {
  const e = exams(split());
  assert.deepEqual(asObject(await e.open([A, X])), { [A]: A, [X]: X });
});

test('openUid: merged then undone - the original answers itself again, the base itself', async () => {
  const e = exams(merge('2026-11-01T00:00:00.000Z'));
  assert.deepEqual(asObject(await e.open([A, B])), { [A]: A, [B]: B });
});

test('openUid: merged - an original left on B opens the exam on its base A (the merged answer of B)', async () => {
  const e = exams(merge());
  assert.deepEqual(asObject(await e.open([B])), { [B]: A });
  assert.deepEqual(asObject(await e.open([A, B])), { [A]: A, [B]: A });
});

test('openUid: no row the caller may not read - access to the exam, another institution, a retired split part', async () => {
  assert.deepEqual(asObject(await exams({ ...merge(), denied: [A] }).open([B, P])), { [P]: P }, 'the merged exam is not readable whole');
  assert.deepEqual(asObject(await exams({ ...merge(), states: { [A]: { institutionId: 'SYN-OTHER' } } }).open([B])), {}, 'base owned elsewhere');
  assert.deepEqual(asObject(await exams({ ...split(), denied: [A] }).open([A, X])), {}, 'the split original is not readable');
  assert.deepEqual(asObject(await exams(split('2026-11-01T00:00:00.000Z')).open([X])), {}, 'a retired split part answers no row');
});

test('openUid rides on GET unread (both records) and on the Inbox list, by the same rule', async () => {
  const e = exams(merge());
  const qid = '00000000-0000-4000-8000-000000000011', rid = '00000000-0000-4000-8000-000000000012';
  const at = new Date('2026-11-01T00:00:00.000Z');
  const thread = { id: qid, studyUid: B, state: 'Open', revision: 1, authorActor: 'syn', authorName: 'SYN', entryCount: 1,
    createdAt: at, updatedAt: at, lastEntryAt: at };
  e.db.$queryRaw = async strings => {
    const text = strings.join('?');
    if (text.includes('count(*)')) return [{ n: 1 }];
    if (text.includes('FROM "StudyImageRequest" r')) return [{ id: rid, studyUid: B, revision: 3, createdAt: at }];
    return [thread];
  };
  e.access.snapshot = async () => ({ policy: { restricted: false }, revision: 7 });
  const questions = new ClinicianQuestionService(e.db, e.access), requests = new ImageRequestService(e.db, e.access);
  const inbox = await questions.unread(RAD, { view: 'question-inbox' });
  assert.deepEqual(inbox.items, [{ id: qid, studyUid: B, revision: 1, openUid: A }]);
  const listed = await questions.list(RAD, { view: 'inbox' });
  assert.deepEqual(listed.items.map(item => [item.id, item.studyUid, item.openUid]), [[qid, B, A]]);
  const mine = await requests.unread(CLIN, { view: 'image-request-mine' });
  assert.deepEqual(mine.items, [{ id: rid, studyUid: B, revision: 3, openUid: A }]);
  const denied = exams({ ...merge(), denied: [A] });
  denied.db.$queryRaw = e.db.$queryRaw;
  denied.access.snapshot = e.access.snapshot;
  const none = await new ClinicianQuestionService(denied.db, denied.access).unread(RAD, { view: 'question-inbox' });
  assert.deepEqual(none.items, [{ id: qid, studyUid: B, revision: 1, openUid: null }], 'no row the reader may not open');
});