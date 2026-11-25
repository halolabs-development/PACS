/* REQ-EMR-15/19 -> RISK-F-07 -> TEST-F-INCIDENT. Contract-owned response obligations and actual admission. */
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture, intake, notice, exemption, delay } = require('./incident_harness.cjs');
const { INCIDENT_LIMITS } = require('../../../api/src/emr-audit/service.ts');
const { consumerSource } = require('../../../api/src/emr-viewing/consumer-read.ts');
const { LocalReadResponse, localReadEvents, localReadFollowup } = require('../../../api/src/emr-viewing/local-read.ts');
const forms = ['possibility', 'confirmed', 'not-a-leak', 'report', 'medical', 'network'];
const known = value => ({ status: 'known', value });
// A ledger of `count` reads of five patients in the incident's period.
function ledger(f, count, patientId = i => `SYN-P${i % 5}`) {
  const first = f.events[0];
  f.events.splice(0, f.events.length, ...Array.from({ length: count }, (_, i) => ({ ...structuredClone(first), eventId: `SYN-READ-${i}`,
    requestId: `SYN-REQUEST-${i}`, targets: [{ ...structuredClone(first.targets[0]), versionId: known(`SYN-VERSION-${i}`),
      patientLinkSnapshot: known({ patientId: patientId(i), assigningAuthority: 'SYN-SITE', linkId: `SYN-LINK-${i % 5}` }) }] })));
}
test('a large range is kept once as a fixed copy and answers from it after the ledger rows have expired', async () => {
  const f = fixture(), input = intake('LARGE'); ledger(f, 1200);
  const registered = await f.controller.registerIncident({}, input);
  assert.equal(registered.scope.identified.length, 5);
  assert.equal(registered.scope.identified.reduce((n, p) => n + p.eventIds.length, 0), 1200);
  assert.equal(f.copies.size, 1);
  const saved = f.requests[0].body, copy = f.copies.get('incident-snapshot:LARGE');
  assert.equal('rows' in saved.snapshot, false, 'the evidence rows are not in the incident history');
  assert.deepEqual({ rows: saved.snapshot.copy.rows, sha256: saved.snapshot.copy.sha256 }, { rows: 1200, sha256: copy.sha256 });
  assert.ok(JSON.stringify(saved).length < 20000);
  assert.equal(saved.listing.verdict, registered.plan.verdict);
  // Every returned target is recorded, as for a range kept in the body.
  assert.equal(f.records.flatMap(r => r.targets).length, registered.scope.auditEvent.targets.length + 1);
  f.events.splice(0);   // the viewing rows reach their retention end
  assert.deepEqual((await f.controller.readIncident({}, 'LARGE')).scope, registered.scope);
  await f.controller.registerIncident({}, input);   // the same request again after a lost answer
  assert.equal(f.requests.length, 1); assert.equal(f.copies.size, 1);
  const found = await f.controller.incidentFinding({}, 'LARGE', { operationId: 'more', facts: { ...input.facts, evidenceId: 'SYN-FINDING-2' } });
  assert.deepEqual(found.scope, registered.scope);
  assert.equal(f.requests.length, 2); assert.equal(f.copies.size, 1);
  assert.ok(JSON.stringify(f.requests[1].body).length < 20000, 'a later step does not store the rows again');
  for (const form of forms) assert.deepEqual((await f.controller.incidentDraft({}, 'LARGE', form)).scope, registered.scope);
  const reads = f.copyReads, list = await f.controller.listIncidents({});
  assert.equal(f.copyReads, reads, 'the list does not read the copy');
  assert.deepEqual([list.incidents[0].verdict, list.incidents[0].awarenessAt], [found.plan.verdict, found.plan.awarenessAt]);
});
test('a registration retried before the first one committed answers and records the saved incident, not its own read', async () => {
  for (const count of [20, 1200]) {
    const f = fixture(), input = intake('RACE'); ledger(f, count, () => 'SYN-A');
    const first = await f.controller.registerIncident({}, input);
    // Patient B is read after the first request read the ledger; the retry read the ledger before the first one was saved.
    f.events.unshift({ ...structuredClone(f.events[0]), eventId: 'SYN-READ-B', targets: [{ ...structuredClone(f.events[0].targets[0]),
      patientLinkSnapshot: known({ patientId: 'SYN-B', assigningAuthority: 'SYN-SITE', linkId: 'SYN-LINK-B' }) }] });
    f.unsavedReads = 1;
    const records = f.records.length, retried = await f.controller.registerIncident({}, input);
    assert.deepEqual(retried.scope, first.scope, `${count} rows`);
    assert.deepEqual(retried.scope.identified.map(p => p.patient.patientId), ['SYN-A']);
    assert.ok(f.records.slice(records).flatMap(r => r.targets).every(t => t.patientLinkSnapshot?.value?.patientId !== 'SYN-B'));
    assert.equal(f.requests.length, 1);
  }
});
test('a small range stays in the incident body as before', async () => {
  const f = fixture(), input = intake('SMALL'); ledger(f, 20);
  await f.controller.registerIncident({}, input);
  assert.equal(f.copies.size, 0);
  assert.equal(f.requests[0].body.snapshot.rows.length, 20);
  assert.deepEqual(Object.keys(f.requests[0].body.snapshot), ['top', 'rows', 'failure']);
  assert.equal('listing' in f.requests[0].body, false);
});
test('a damaged copy reads as unidentified, never as nobody affected, and takes no new decision', async () => {
  const f = fixture(), input = intake('DAMAGED'); ledger(f, 1200);
  await f.controller.registerIncident({}, input);
  const copy = f.copies.get('incident-snapshot:DAMAGED'); copy.body[copy.body.length - 1] ^= 1;
  const read = await f.controller.readIncident({}, 'DAMAGED');
  assert.equal(read.scope.subjectsIdentifiable, false);
  assert.deepEqual(read.scope.identified, []);
  assert.ok(read.scope.reasons.some(r => r.kind === 'ledger-unreadable'));
  await assert.rejects(f.controller.incidentFinding({}, 'DAMAGED', { operationId: 'more', facts: { ...input.facts, evidenceId: 'SYN-FINDING-2' } }),
    { code: 'IncidentSnapshotUnreadable' });
  assert.equal(f.requests.length, 1);
});
// The same registration sent until its evidence is preserved, as the page sends it: how many requests it took.
async function registered(f, input) {
  for (let requests = 1; ; requests++) {
    const answer = await f.controller.registerIncident({}, input);
    if (answer.status !== 'Registering') return Object.assign(answer, { requests });
    assert.deepEqual(Object.keys(answer), ['incidentId', 'status', 'collected']);
  }
}
const incidents = f => f.requests.filter(r => r.body.kind === 'incident');
const recent = (input, days = 2) => { input.query = { from: new Date(Date.now() - days * 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() }; return input; };
// The fixture's ledger as rows of the last hour, and a registration of the last days days over them.
function current(f, input, days) { const at = new Date(Date.now() - 3600_000).toISOString(); for (const event of f.events) event.occurredAt = at; return recent(input, days); }
function limits(t, patch) { const before = { ...INCIDENT_LIMITS }; Object.assign(INCIDENT_LIMITS, patch); t.after(() => Object.assign(INCIDENT_LIMITS, before)); }
// What one response recorded: the records written by a call, which the ledger must be able to hold unfinished at once.
async function recording(f, call) { const from = f.records.length, answer = await call(); return { answer, records: f.records.slice(from) }; }
/* The ledger rows a reader leaves at an institution whose list holds `list` studies, as measured on a running stack: the
 * viewer reads the whole list three times for each study opened, and each listed study leaves a prepared and an ended
 * row. Built by the product's own list-read recorder; the rows are made as they are read, newest first. */
function openings(f, list, count) {
  const reader = { id: 'synthetic-reader', issuer: 'synthetic', subject: 'reader' };
  const facts = { issuer: reader.issuer, subject: reader.subject, actor: reader, roles: ['radiologist'], rightsVersion: 3, institution: 'SYN-SITE',
    binding: { method: 'session', sessionRef: 'authref:00000000-0000-4000-8000-000000000000' }, requestId: 'SYN-LIST-REQUEST',
    ingress: known({ address: '192.0.2.12', source: 'trusted-proxy' }), surface: 'GET studies' };
  const body = Array.from({ length: list }, (_, i) => ({ uid: `1.2.826.0.1.3680043.8.498.${10 ** 15 + i}.${10 ** 15 + 7 * i}` }));
  const prepared = localReadEvents(facts, new LocalReadResponse(body, body.map((row, i) => consumerSource('study-metadata', row.uid, 'SYN-SITE', row.uid, null, [i],
    { sourcePatientId: `SYN-PID-${i}`, sourceInstitution: 'SYN-HOSPITAL' }))));
  const ended = prepared.map(event => localReadFollowup(event, 'ended')), total = count * 3 * list * 2, start = Date.now() - 6 * 3600_000;
  const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  f.events = new Proxy({ length: total }, { get: (_, key) => {
    if (key === 'length') return total;
    const n = total - 1 - Number(key), row = n % (2 * list), event = row < list ? prepared[row] : ended[row - list];
    return { ...event, eventId: id(n), occurredAt: new Date(start + n).toISOString(), relatedEventId: row < list ? null : id(n - list) };
  } });
  return total;
}
for (const [name, list, count] of [['the period of an alert (50 studies opened in ten minutes)', 209, 50], ['a reader\'s day of 200 studies', 209, 200]])
  test(`${name} at a 209-study list registers as one incident, reopens, and is decided, notified and closed whole`, { timeout: 600_000 }, async () => {
    const f = fixture(), input = recent(intake('ORDINARY')), rows = openings(f, list, count);
    const registering = registered(f, input); let finished = false; registering.then(() => { finished = true; }, () => { finished = true; });
    await f.controller.listIncidents({});
    assert.equal(finished, false, 'another request is answered while the evidence is being preserved');
    const first = await registering, saved = incidents(f);
    assert.deepEqual([first.status, saved.length, saved[0].body.snapshot.copy.rows], ['Open', 1, rows]);
    assert.deepEqual(first.scope.subjects, { identified: 0, identifiedLocally: list, events: rows, all: null });
    assert.equal('identified' in first.scope || 'identifiedLocally' in first.scope, false, 'no list stands in for the paged subjects');
    assert.equal(first.scope.subjectsIdentifiable, false);
    // Every request answered and recorded the incident alone: no response held more than one of the ledger's records.
    const answers = f.records.filter(r => r.surface === 'POST emr-audit/incidents');
    assert.ok(answers.length >= first.requests && answers.every(r => r.targets.length === 1 && r.targets[0].recordId.value === 'ORDINARY'));
    assert.deepEqual((await f.controller.listIncidents({})).incidents.map(i => [i.incidentId, i.status]), [['ORDINARY', 'Open']]);
    f.events = [];   // the viewing rows reach their retention end
    const reads = f.copyReads, opened = await recording(f, () => f.controller.readIncident({}, 'ORDINARY'));
    assert.deepEqual(opened.answer.scope, first.scope);
    assert.deepEqual([f.copyReads - reads, opened.records.length], [0, 1], 'reopening reads no part and records the incident');
    await f.controller.registerIncident({}, input);   // the same request again after a lost answer
    assert.equal(incidents(f).length, 1);
    // Its subjects, a page at a time: each page records the subjects it shows.
    const subjects = [];
    for (let from = '0.0'; from !== null;) {
      const page = await recording(f, () => f.controller.readIncident({}, 'ORDINARY', from));
      assert.equal(page.records.flatMap(r => r.targets).length, 1 + page.answer.subjects.identifiedLocally.length);
      assert.ok(page.records.length <= INCIDENT_LIMITS.wholeRecords);
      subjects.push(...page.answer.subjects.identifiedLocally); from = page.answer.subjects.next;
    }
    assert.deepEqual([subjects.length, new Set(subjects.map(s => s.source.sourcePatientId.value)).size], [list, list]);
    assert.ok(subjects.every(s => s.events === 6 * count && s.studyIds.length === 1));
    // Decision, notice and closure are taken on the whole range.
    let r = await f.controller.incidentNotice({}, 'ORDINARY', notice(first.plan.obligations[0]));
    assert.equal(r.plan.obligations[0].status, 'met');
    r = await f.controller.incidentFinding({}, 'ORDINARY', { operationId: 'no-leak', facts: { ...input.facts, status: 'not-a-leak', possibleGround: null,
      determinationAt: '2026-11-01T02:30:00.000Z', evidenceId: 'SYN-NO-LEAK' } });
    assert.deepEqual(r.scope, first.scope);
    await assert.rejects(f.controller.closeIncident({}, 'ORDINARY', { evidenceId: 'close' }), { code: 'IncidentDutiesOpen' });
    const followUp = notice(r.plan.obligations.find(o => o.kind === 'not-a-leak'), 'no-leak-notice'); followUp.notice.sentAt = '2026-11-01T02:45:00.000Z';
    await f.controller.incidentNotice({}, 'ORDINARY', followUp);
    r = await f.controller.closeIncident({}, 'ORDINARY', { evidenceId: 'close' });
    assert.deepEqual([r.status, r.scope.subjects.events, incidents(f).length], ['Closed', rows, 1 + r.history.length]);
  });
test('a range whose record does not fit one response is one incident, kept in parts and read a page at a time', async () => {
  const f = fixture(), input = intake('WIDE'); ledger(f, 3400, i => `SYN-${String(i % 5).repeat(2000)}`); current(f, input);
  const first = await recording(f, () => registered(f, input)), r = first.answer, copy = incidents(f)[0].body.snapshot.copy;
  assert.deepEqual([r.status, incidents(f).length, copy.format, copy.rows], ['Open', 1, 'gzip-json-ledger-rows-v2', 3400]);
  // Five patients fit one response: they are in the answer, and in its record with the incident.
  assert.deepEqual(r.scope.subjects.all.identified.map(p => [p.patient.patientId.length, p.events]), Array(5).fill([2004, 680]));
  assert.equal(first.records.at(-1).action, 'write');
  assert.deepEqual(first.records.at(-1).targets.map(t => t.patientLinkSnapshot.value?.patientId ?? t.recordId.value).sort(),
    ['WIDE', ...r.scope.subjects.all.identified.map(p => p.patient.patientId)].sort());
  for (const form of forms) {
    const draft = await recording(f, () => f.controller.incidentDraft({}, 'WIDE', form));
    assert.deepEqual(draft.answer.scope, r.scope);
    assert.deepEqual([draft.records.length, draft.records[0].action, draft.records[0].targets.length], [1, 'download', 6]);
  }
  // The events themselves are read from the preserved rows, as many as one response can record.
  f.events = [];
  const events = new Set(), pages = [];
  for (let from = '0.0'; from !== null;) {
    const page = await recording(f, () => f.controller.readIncident({}, 'WIDE', undefined, from));
    assert.ok(page.records.length <= INCIDENT_LIMITS.wholeRecords);
    const shown = page.answer.events.identified.flatMap(p => p.eventIds);
    assert.equal(page.records.flatMap(r => r.targets).length, 1 + shown.length, 'each shown event of each patient is recorded');
    for (const id of shown) events.add(id);
    pages.push(shown.length); from = page.answer.events.next;
  }
  assert.deepEqual([events.size, pages.every(n => n > 0 && n <= INCIDENT_LIMITS.pageEvents)], [3400, true]);
  for (const place of ['9.0', '0.999999', 'x', '0']) await assert.rejects(f.controller.readIncident({}, 'WIDE', undefined, place), { code: 'AuditRequestInvalid' });
  await assert.rejects(f.controller.readIncident({}, 'WIDE', '0.0', '0.0'), { code: 'AuditRequestInvalid' });
});
test('a paged registration is continued by its own request, belongs to its auditor and input, and is no incident until complete', async t => {
  limits(t, { wholeRows: 200, partRows: 500, requestMs: 0 });
  const f = fixture(), input = intake('STEPS'); ledger(f, 2600); current(f, input);
  const one = await recording(f, () => f.controller.registerIncident({}, input));
  assert.deepEqual(one.answer, { incidentId: 'STEPS', status: 'Registering', collected: { rows: 500 } });
  assert.deepEqual(one.records.map(r => r.targets), [[{ kind: 'access-audit', patientLinkSnapshot: { status: 'not-applicable', reason: 'non-record-target' },
    studyId: { status: 'not-applicable', reason: 'non-record-target' }, recordId: known('STEPS'), versionId: { status: 'not-applicable', reason: 'non-record-target' } }]]);
  // Nothing is registered yet: it is not listed, opened, decided on, closed, or the replacement of another incident.
  assert.deepEqual((await f.controller.listIncidents({})).incidents, []);
  await f.controller.registerIncident({}, recent(intake('OTHER'), 3)).then(a => assert.equal(a.status, 'Registering'));
  for (const call of [() => f.controller.readIncident({}, 'STEPS'), () => f.controller.incidentFinding({}, 'STEPS', { operationId: 'x', facts: input.facts }),
      () => f.controller.closeIncident({}, 'STEPS', { evidenceId: 'x' }), () => f.controller.incidentDraft({}, 'STEPS', 'possibility'),
      () => f.controller.readIncident({}, 'STEPS', '0.0')]) await assert.rejects(call(), { code: 'IncidentNotFound' });
  // Another input, or another auditor, is not this registration.
  const before = JSON.stringify([f.requests, [...f.copies.keys()]]);
  await assert.rejects(f.controller.registerIncident({}, { ...input, incidentType: 'other' }), { code: 'IncidentConflict' });
  await assert.rejects(f.controller.registerIncident({}, { ...input, facts: { ...input.facts, evidenceId: 'SYN-OTHER' } }), { code: 'IncidentConflict' });
  const other = fixture(undefined, undefined, { id: 'second-auditor', issuer: 'synthetic', subject: 'second' });
  other.requests.push(...f.requests); other.events = f.events;
  await assert.rejects(other.controller.registerIncident({}, input), { code: 'IncidentConflict' });
  assert.equal(JSON.stringify([f.requests, [...f.copies.keys()]]), before);
  // Rows read after the ceiling was taken, and the event that was unfinished then, are not this incident's evidence.
  f.events.unshift({ ...structuredClone(f.events[0]), eventId: 'SYN-LATER' });
  const r = await registered(f, input), state = incidents(f).find(i => i.body.incidentId === 'STEPS').body;
  assert.deepEqual([r.status, r.requests, state.snapshot.copy.parts, state.snapshot.copy.rows, r.scope.subjects.events], ['Open', 5, 6, 2600, 2600]);
  assert.deepEqual(r.scope.subjects.all.identified.map(p => p.events), Array(5).fill(520));
  assert.deepEqual((await f.controller.listIncidents({})).incidents.map(i => i.incidentId), ['STEPS']);
  const again = JSON.stringify(f.requests);
  assert.deepEqual((await f.controller.registerIncident({}, input)).scope, r.scope);
  assert.equal(JSON.stringify(f.requests), again);
  await assert.rejects(f.controller.registerIncident({}, { ...input, incidentType: 'other' }), { code: 'IncidentConflict' });
});
test('the evidence of a paged registration is the ledger at the moment its ceiling was taken', async t => {
  limits(t, { wholeRows: 200, partRows: 500, requestMs: 0 });
  const f = fixture(), input = intake('MOMENT'); ledger(f, 1300, () => 'SYN-A'); current(f, input);
  // Unfinished when the ceiling was taken: whether it commits afterwards or not, it was not in the ledger then.
  f.pending = ['SYN-READ-700'];
  const r = await registered(f, input);
  assert.deepEqual([r.scope.subjects.events, r.scope.subjects.all.identified[0].events], [1299, 1299]);
  const shown = new Set();
  for (let from = '0.0'; from !== null;) {
    const page = await f.controller.readIncident({}, 'MOMENT', undefined, from);
    for (const id of page.events.identified.flatMap(p => p.eventIds)) shown.add(id);
    from = page.events.next;
  }
  assert.deepEqual([shown.size, shown.has('SYN-READ-700'), shown.has('SYN-READ-699')], [1299, false, true]);
});
test('a range past the protective bound is refused in the same words, and the same ID then takes a narrower range', async t => {
  limits(t, { wholeRows: 200, partRows: 500, requestMs: 0, maxRows: 1200 });
  const f = fixture(), input = intake('BOUND'); ledger(f, 2600); current(f, input);
  await assert.rejects(registered(f, input), { code: 'IncidentRangeTooLarge' });
  const refused = JSON.stringify([f.requests, [...f.copies.keys()]]);
  await assert.rejects(f.controller.registerIncident({}, input), { code: 'IncidentRangeTooLarge' });
  assert.equal(JSON.stringify([f.requests, [...f.copies.keys()]]), refused, 'the same request is answered from the refusal');
  assert.deepEqual([incidents(f).length, (await f.controller.listIncidents({})).incidents.length], [0, 0]);
  f.events.splice(0, 1500);
  const r = await registered(f, recent(intake('BOUND'), 1));
  assert.deepEqual([r.status, r.scope.subjects.events, incidents(f).length], ['Open', 1100, 1]);
});
test('more subjects than one response shows are read a page at a time, a long study list continuing on the next', async t => {
  limits(t, { wholeRows: 200, pageBytes: 40_000 });
  const f = fixture(), input = intake('MANY'); input.determinations = [];
  ledger(f, 900, i => `SYN-P${String(i % 450).padStart(3, '0')}`);
  // One local subject seen in 300 studies beside them.
  const local = structuredClone(f.events[0]); local.surface = 'POST emr-audit/investigations';
  f.events.push(...Array.from({ length: 300 }, (_, i) => ({ ...local, eventId: `SYN-LOCAL-${i}`, targets: [{ kind: 'access-audit',
    studyId: known(`1.2.826.0.1.3680043.8.498.${'9'.repeat(20)}.${i}`), recordId: known(`SYN-RECORD-${i}`), versionId: known(`SYN-VERSION-${i}`),
    sourcePatientId: known('LOCAL-PATIENT'), sourceInstitution: known('SYN-SITE') }] })));
  current(f, input);
  const first = await recording(f, () => registered(f, input));
  assert.deepEqual(first.answer.scope.subjects, { identified: 450, identifiedLocally: 1, events: 1200, all: null });
  assert.deepEqual(first.records.at(-1).targets.length, 1, 'a summary discloses no subject');
  const patients = [], studies = []; let continued = 0;
  for (let from = '0.0'; from !== null;) {
    const page = await recording(f, () => f.controller.readIncident({}, 'MANY', from)), s = page.answer.subjects;
    assert.ok(s.identified.length <= INCIDENT_LIMITS.pageSubjects && page.records.length <= INCIDENT_LIMITS.wholeRecords);
    const targets = page.records.flatMap(r => r.targets);
    assert.equal(targets.length, 1 + s.identified.length + s.identifiedLocally.reduce((n, p) => n + p.studyIds.length, 0));
    assert.deepEqual(targets.filter(t => t.patientLinkSnapshot?.status === 'known').map(t => [t.patientLinkSnapshot.value.patientId, t.recordId.value, t.versionId.value]),
      s.identified.map(p => [p.patient.patientId, 'MANY', 'MANY']));
    assert.ok(s.identified.every(p => !('link' in p) && p.events === 2));
    patients.push(...s.identified.map(p => p.patient.patientId)); studies.push(...s.identifiedLocally.flatMap(p => p.studyIds));
    continued += s.identifiedLocally.length; from = s.next;
  }
  assert.deepEqual([patients.length, new Set(patients).size, studies.length, new Set(studies).size], [450, 450, 300, 300]);
  assert.ok(continued > 1, 'the local subject\'s studies continue on a next page');
  for (const place of ['451.0', '3.1', '450.300', '-1.0']) await assert.rejects(f.controller.readIncident({}, 'MANY', place), { code: 'AuditRequestInvalid' });
  // A range answered whole has no pages: its subjects are in its answer.
  const small = fixture(); await small.controller.registerIncident({}, intake());
  await assert.rejects(small.controller.readIncident({}, 'SYN-INCIDENT', '0.0'), { code: 'AuditRequestInvalid' });
});
test('a damaged part of a paged incident reads as unidentified, never as nobody affected, and takes no new decision', async t => {
  limits(t, { wholeRows: 200, partRows: 500 });
  const f = fixture(), input = intake('DAMAGED-PART'); ledger(f, 1300); current(f, input);
  const r = await registered(f, input), copy = incidents(f)[0].body.snapshot.copy, part = f.copies.get(`${copy.key}:1`);
  assert.equal(r.scope.subjects.identified, 5);
  part.body[part.body.length - 1] ^= 1;
  const read = await f.controller.readIncident({}, 'DAMAGED-PART');
  assert.deepEqual([read.scope.subjectsIdentifiable, read.scope.subjects.identified, read.scope.subjects.all], [false, 0, null]);
  assert.ok(read.scope.reasons.some(reason => reason.kind === 'ledger-unreadable'));
  const before = f.requests.length;
  await assert.rejects(f.controller.incidentFinding({}, 'DAMAGED-PART', { operationId: 'more', facts: { ...input.facts, evidenceId: 'SYN-FINDING-2' } }),
    { code: 'IncidentSnapshotUnreadable' });
  for (const page of [['0.0'], [undefined, '0.0']]) await assert.rejects(f.controller.readIncident({}, 'DAMAGED-PART', ...page), { code: 'IncidentSnapshotUnreadable' });
  assert.equal(f.requests.length, before);
  // A missing part is the same: a count that still matches does not vouch for the rows.
  part.body[part.body.length - 1] ^= 1; f.copies.delete(`${copy.key}:2`);
  assert.equal((await f.controller.readIncident({}, 'DAMAGED-PART')).scope.subjectsIdentifiable, false);
});
test('a paged range that began before the retention end of its rows cannot say its copy is complete', async t => {
  limits(t, { wholeRows: 200, partRows: 500 });
  const f = fixture(), input = intake('OLD-RANGE'); ledger(f, 900); current(f, input, 729);
  const r = await registered(f, input);
  assert.deepEqual([r.status, r.scope.subjectsIdentifiable, r.scope.subjects.identified, incidents(f)[0].body.snapshot.copy.rows], ['Open', false, 0, 900]);
  assert.deepEqual(r.scope.reasons.find(reason => reason.kind === 'ledger-unreadable'), { kind: 'ledger-unreadable', code: 'LedgerRetentionElapsed' });
});
test('the pages of events show every preserved row, also one that names no subject', async t => {
  limits(t, { wholeRows: 200, partRows: 500 });
  // An auditor's own read of the incident list, in the period: an event that names no patient.
  const seed = fixture(); await seed.controller.registerIncident({}, intake()); await seed.controller.listIncidents({});
  const listRead = seed.records.at(-1);
  assert.ok(listRead.targets.length && listRead.targets.every(target => target.patientLinkSnapshot.status !== 'known'));
  const f = fixture(), input = intake('EVERY-ROW'); ledger(f, 900);
  f.events.splice(450, 0, { ...structuredClone(listRead), eventId: 'SYN-LIST-READ' });
  current(f, input);
  const r = await registered(f, input);
  assert.equal(r.scope.subjects.events, 901);
  const named = new Set(), others = [];
  for (let from = '0.0'; from !== null;) {
    const page = await recording(f, () => f.controller.readIncident({}, 'EVERY-ROW', undefined, from)), events = page.answer.events;
    const shown = events.identified.flatMap(p => p.eventIds);
    assert.equal(page.records.flatMap(record => record.targets).length, 1 + shown.length, 'a row that names nobody adds no target to the record');
    for (const id of shown) named.add(id);
    others.push(...events.others); from = events.next;
  }
  assert.deepEqual([named.size, others], [900, ['SYN-LIST-READ']], 'the rows on the pages are the rows the summary counts');
});
test('a paged answer repeats the patient its range was asked for only with the record of that patient', async t => {
  limits(t, { wholeRows: 200, partRows: 500 });
  const patient = { patientId: 'SYN-ONLY-PATIENT', assigningAuthority: 'SYN-SITE' };
  // Readable: the one patient is a subject in the answer and in its record, and the condition is repeated.
  const f = fixture(), input = intake('ONE-PATIENT'); ledger(f, 900, () => patient.patientId); current(f, input); input.query.patient = patient;
  await registered(f, input);
  const read = await recording(f, () => f.controller.readIncident({}, 'ONE-PATIENT'));
  assert.deepEqual([read.answer.scope.filters.patient, 'withheld' in read.answer.scope.subjects], [patient, false]);
  assert.deepEqual(read.records.flatMap(record => record.targets).map(target => target.patientLinkSnapshot.value?.patientId ?? target.recordId.value),
    ['ONE-PATIENT', patient.patientId]);
  // Unreadable (the range began before the retention end of its rows): the answer names nobody, in its conditions either.
  const g = fixture(), old = intake('ONE-PATIENT-OLD'); ledger(g, 900, () => patient.patientId); current(g, old, 729); old.query.patient = patient;
  await registered(g, old);
  for (const call of [() => g.controller.readIncident({}, 'ONE-PATIENT-OLD'), () => g.controller.incidentDraft({}, 'ONE-PATIENT-OLD', 'possibility'),
      () => g.controller.registerIncident({}, old)]) {
    const shown = await recording(g, call), scope = shown.answer.scope;
    assert.deepEqual([scope.filters.patient, scope.subjects.withheld, scope.filters.from], [null, ['patient'], old.query.from]);
    assert.equal(JSON.stringify(shown.answer).includes(patient.patientId), false, 'no patient is shown');
    assert.deepEqual(shown.records.flatMap(record => record.targets).map(target => target.recordId.value), ['ONE-PATIENT-OLD'], 'and the record is the incident alone');
  }
});
test('a later auditor never becomes the author of the registration scope finding', async () => {
  const first = fixture(), input = intake();
  await first.controller.registerIncident({}, input);
  const reader = { id: 'second-auditor', issuer: 'synthetic', subject: 'second' };
  const second = fixture(undefined, undefined, reader); second.requests.push(...structuredClone(first.requests));
  const old = await second.controller.readIncident({}, input.incidentId);
  assert.equal(old.scope.reasons.find(r => r.kind === 'access-outside-ledger').by.id, 'synthetic-auditor');
  const result = await second.controller.incidentNotice({}, input.incidentId, notice(old.plan.obligations[0]));
  assert.equal(result.history.at(-1).by.id, 'second-auditor');
  assert.equal(result.scope.reasons.find(r => r.kind === 'access-outside-ledger').by.id, 'synthetic-auditor');
  assert.equal(result.plan.ledger.findings[0].by.id, 'synthetic-auditor');
});
test('register, full scope, six draft downloads, deadline, replay and exact disclosed targets', async () => {
  const f = fixture(), input = intake();
  let r = await f.controller.registerIncident({}, input);
  assert.equal(r.incidentType, 'cvr-misdelivery'); assert.equal(r.scope.subjectsIdentifiable, false);
  assert.equal(r.scope.identified[0].patient.patientId, 'SYN-PATIENT');
  assert.equal(r.plan.obligations[0].dueAt, '2026-11-04T00:00:00.000Z');
  const first = JSON.stringify(f.requests);
  await f.controller.registerIncident({}, input); assert.equal(JSON.stringify(f.requests), first);
  for (const form of forms) {
    const draft = await f.controller.incidentDraft({}, input.incidentId, form);
    assert.equal(draft.status, 'Draft'); assert.match(draft.wording, /P5/); assert.equal(draft.cloud, '조건부 (#69)');
    if (draft.obligations.length) assert.deepEqual(draft.basis, [...new Set(draft.obligations.flatMap(o => o.basis))]);
    else { assert.deepEqual(draft.basis, []); assert.equal(draft.applicabilityNote, '현재 계약 결과에 이 서식의 의무가 없습니다(조회 사실만 포함)'); }
    assert.equal(f.records.at(-1).action, 'download');
    assert.ok(f.records.at(-1).targets.some(t => t.patientLinkSnapshot?.value?.patientId === 'SYN-PATIENT'));
  }
  const list = await f.controller.listIncidents({}); assert.equal(list.incidents.length, 1);
  assert.ok(f.records.at(-1).targets.every(t => t.patientLinkSnapshot.status === 'not-applicable'));
  assert.equal((await f.controller.readIncident({}, input.incidentId)).scope.identified.length, 1);
});

test('report exemption is an evidenced human decision, survives reload and permits honest closure', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T03:00:00Z') });
  const f = fixture(), input = intake('EXEMPT', 'confirmed'); input.facts.reportTriggers = ['sensitive-or-unique'];
  let r = await f.controller.registerIncident({}, input);
  const decision = exemption(r.plan.obligations.find(o => o.family === 'report'));
  decision.decision.by = { id: 'forged', issuer: 'forged', subject: 'forged' };
  decision.decision.decider = { ...decision.decision.decider, by: decision.decision.by, ownerId: 'FOREIGN', status: 'representative', evidenceId: 'FORGED' };
  for (const patch of [{ basis: 'invented' }, { category: 'invented' }, { stillOwed: true },
    { obligationKey: r.plan.obligations.find(o => o.family === 'confirmed').obligationKey }, { at: '2099-01-01T00:00:00.000Z' }]) {
    await assert.rejects(f.controller.incidentFinding({}, input.incidentId, { ...decision, decision: { ...decision.decision, ...patch } }), { code: 'IncidentResponseRefused' });
  }
  const prior = JSON.stringify(f.requests), grantor = f.grantor; f.grantor = null;
  await assert.rejects(f.controller.incidentFinding({}, input.incidentId, decision), { code: 'AuditorDesignationAuthorityRequired' });
  assert.equal(JSON.stringify(f.requests), prior); f.grantor = grantor;
  r = await f.controller.incidentFinding({}, input.incidentId, decision);
  const d = r.plan.ledger.decisions[0];
  assert.equal(d.by.id, 'synthetic-auditor'); assert.equal(d.decider.by.id, d.by.id);
  assert.equal(d.decider.ownerId, 'SYN-SITE'); assert.equal(d.decider.status, 'verified-privacy-officer');
  assert.equal(d.decider.evidenceId, 'SYN-DESIGNATION');
  assert.equal(r.plan.obligations.find(o => o.family === 'report').status, 'exempt');
  await assert.rejects(f.controller.closeIncident({}, input.incidentId, { evidenceId: 'close' }), { code: 'IncidentDutiesOpen' });
  for (const o of r.plan.obligations.filter(o => o.stillOwed)) await f.controller.incidentNotice({}, input.incidentId, notice(o, o.kind));
  r = await f.controller.closeIncident({}, input.incidentId, { evidenceId: 'close' }); assert.equal(r.status, 'Closed');
  const saved = JSON.stringify(f.requests);
  await f.controller.incidentFinding({}, input.incidentId, decision); assert.equal(JSON.stringify(f.requests), saved);
  const reopened = await f.controller.readIncident({}, input.incidentId);
  assert.equal(reopened.plan.obligations.find(o => o.family === 'report').closureGround, 'report-exemption');
  assert.deepEqual(reopened.history[1].decisions, [d]);
});

test('accepted and pending delay preserve the original deadline and causal evidence across replay', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T03:00:00Z') });
  const f = fixture(); let r = await f.controller.registerIncident({}, intake());
  const o = r.plan.obligations[0], accepted = delay(o), pending = structuredClone(accepted);
  pending.operationId = pending.delay.delayId = 'PENDING'; pending.delay.accepted = false; pending.delay.decisionId = null;
  delete pending.delay.decider; delete pending.delay.causalReview;
  r = await f.controller.incidentFinding({}, r.incidentId, pending);
  assert.equal(r.plan.obligations[0].dueAt, o.dueAt); assert.equal(r.plan.obligations[0].status, 'overdue');
  for (const patch of [{ clause: 'wrong' }, { category: 'urgent-containment' }, { causalReview: undefined }])
    await assert.rejects(f.controller.incidentFinding({}, r.incidentId, { ...accepted, delay: { ...accepted.delay, ...patch } }), { code: 'IncidentResponseRefused' });
  r = await f.controller.incidentFinding({}, r.incidentId, accepted);
  assert.equal(r.plan.obligations[0].originalDueAt, o.originalDueAt);
  assert.equal(r.plan.obligations[0].timing, 'deferred-until-cause-cleared'); assert.equal(r.plan.obligations[0].dueAt, null);
  assert.equal(r.plan.ledger.delays.find(d => d.delayId === accepted.delay.delayId).by.id, 'synthetic-auditor');
  const saved = JSON.stringify(f.requests); await f.controller.incidentFinding({}, r.incidentId, accepted);
  assert.equal(JSON.stringify(f.requests), saved);
  assert.deepEqual((await f.controller.readIncident({}, r.incidentId)).plan.ledger.delays, r.plan.ledger.delays);
});

test('superseded closure keeps old verdict, scope and drafts; targets must be existing same-site open incidents', async () => {
  const f = fixture(), old = await f.controller.registerIncident({}, intake('OLD'));
  await f.controller.registerIncident({}, intake('NEW'));
  const foreign = fixture(undefined, 'FOREIGN'); await foreign.controller.registerIncident({}, intake('FOREIGN'));
  f.requests.push(...foreign.requests);
  await f.controller.registerIncident({}, intake('CLOSED', 'not-a-leak'));
  await f.controller.closeIncident({}, 'CLOSED', { evidenceId: 'closed' });
  for (const [target, code] of [['OLD', 'IncidentConflict'], ['MISSING', 'IncidentNotFound'], ['FOREIGN', 'IncidentNotFound'], ['CLOSED', 'IncidentClosed']]) {
    const saved = JSON.stringify(f.requests);
    await assert.rejects(f.controller.closeIncident({}, 'OLD', { evidenceId: 'mistake', supersededBy: target }), { code });
    assert.equal(JSON.stringify(f.requests), saved);
  }
  const closure = { evidenceId: 'mistake', supersededBy: 'NEW' };
  let r = await f.controller.closeIncident({}, 'OLD', closure);
  assert.equal(r.status, 'Closed'); assert.equal(r.closed.supersededBy, 'NEW'); assert.equal(r.plan.verdict, 'possible');
  assert.deepEqual(r.scope, old.scope); assert.equal(r.history.length, 1);
  await assert.rejects(f.controller.closeIncident({}, 'NEW', { evidenceId: 'cycle', supersededBy: 'OLD' }), { code: 'IncidentClosed' });
  for (const changed of [{ evidenceId: 'mistake' }, { ...closure, evidenceId: 'changed' }, { ...closure, supersededBy: 'MISSING' }])
    await assert.rejects(f.controller.closeIncident({}, 'OLD', changed), { code: 'IncidentConflict' });
  await f.controller.registerIncident({}, intake('NEXT'));
  await f.controller.closeIncident({}, 'NEW', { evidenceId: 'next', supersededBy: 'NEXT' });
  await assert.rejects(f.controller.closeIncident({}, 'NEXT', { evidenceId: 'long-cycle', supersededBy: 'OLD' }), { code: 'IncidentClosed' });
  const saved = JSON.stringify(f.requests); await f.controller.closeIncident({}, 'OLD', closure);
  assert.equal(JSON.stringify(f.requests), saved);
  assert.equal((await f.controller.listIncidents({})).incidents.find(i => i.incidentId === 'OLD').supersededBy, 'NEW');
  r = await f.controller.readIncident({}, 'OLD'); assert.deepEqual(r.scope, old.scope);
  for (const form of forms) { const d = await f.controller.incidentDraft({}, 'OLD', form); assert.deepEqual(d.scope, old.scope); assert.equal(d.verdict, 'possible'); }
});
test('possible notice then confirmed preserves actual evidence and closes only after every owed notice', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T01:00:00Z') });
  const f = fixture(), input = intake(); let r = await f.controller.registerIncident({}, input);
  t.mock.timers.setTime(Date.parse('2026-11-01T03:00:00Z'));
  const sent = notice(r.plan.obligations[0]); r = await f.controller.incidentNotice({}, input.incidentId, sent);
  assert.equal(r.plan.obligations[0].status, 'met');
  const finding = { operationId: 'confirm', facts: { ...input.facts, status: 'confirmed', possibleGround: null,
    determinationAt: '2026-11-01T02:00:00.000Z', evidenceId: 'SYN-CONFIRMED', verdictId: 'confirmed-1' } };
  r = await f.controller.incidentFinding({}, input.incidentId, finding);
  assert.equal(r.plan.verdict, 'confirmed'); assert.equal(r.history.length, 3);
  await assert.rejects(f.controller.closeIncident({}, input.incidentId, { evidenceId: 'close' }), { code: 'IncidentDutiesOpen' });
  for (const o of r.plan.obligations.filter(o => o.stillOwed)) await f.controller.incidentNotice({}, input.incidentId, notice(o, o.kind));
  r = await f.controller.closeIncident({}, input.incidentId, { evidenceId: 'close' }); assert.equal(r.status, 'Closed');
  const stored = JSON.stringify(f.requests);
  await f.controller.closeIncident({}, input.incidentId, { evidenceId: 'close' });
  await f.controller.incidentFinding({}, input.incidentId, finding);
  await f.controller.incidentNotice({}, input.incidentId, sent);
  assert.equal(JSON.stringify(f.requests), stored);
  await assert.rejects(f.controller.incidentFinding({}, input.incidentId, { ...finding, operationId: 'new' }), { code: 'IncidentClosed' });
  await assert.rejects(f.controller.closeIncident({}, input.incidentId, { evidenceId: 'other' }), { code: 'IncidentConflict' });
  assert.equal(f.requests[0].body.steps.length, 1);
});
test('no-leak closure retains prior notice and requires the contract no-leak followup', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T03:00:00Z') });
  for (const notified of [false, true]) {
    const f = fixture(), input = intake(); let r = await f.controller.registerIncident({}, input);
    if (notified) r = await f.controller.incidentNotice({}, input.incidentId, notice(r.plan.obligations[0]));
    r = await f.controller.incidentFinding({}, input.incidentId, { operationId: 'no-leak', facts: { ...input.facts,
      status: 'not-a-leak', possibleGround: null, determinationAt: '2026-11-01T02:30:00.000Z', evidenceId: 'SYN-NO-LEAK' } });
    if (notified) {
      await assert.rejects(f.controller.closeIncident({}, input.incidentId, { evidenceId: 'close' }), { code: 'IncidentDutiesOpen' });
      const o = r.plan.obligations.find(o => o.kind === 'not-a-leak');
      const n = notice(o, 'no-leak-notice'); n.notice.sentAt = '2026-11-01T02:45:00.000Z';
      r = await f.controller.incidentNotice({}, input.incidentId, n);
      assert.equal(r.plan.ledger.notices.length, 2);
    }
    r = await f.controller.closeIncident({}, input.incidentId, { evidenceId: 'close' }); assert.equal(r.status, 'Closed');
    assert.equal(r.plan.verdict, 'not-a-leak');
  }
});
test('unreadable and locally identified sources stay explicitly unidentifiable, not zero affected', async () => {
  const broken = fixture(); broken.events[0].surface = 'invalid';
  const r = await broken.controller.registerIncident({}, intake());
  assert.equal(r.scope.subjectsIdentifiable, false); assert.ok(r.scope.reasons.some(r => r.kind === 'ledger-unreadable'));
  assert.equal((await broken.controller.readIncident({}, 'SYN-INCIDENT')).scope.subjectsIdentifiable, false);
  const local = fixture(), event = local.events[0], target = event.targets[0];
  event.surface = 'POST emr-audit/investigations';
  event.targets = [{ kind: 'access-audit', studyId: target.studyId, recordId: target.recordId, versionId: target.versionId,
    sourcePatientId: { status: 'known', value: 'LOCAL-PATIENT' }, sourceInstitution: { status: 'known', value: 'SYN-SITE' } }];
  const input = intake(); input.determinations = [];
  const result = await local.controller.registerIncident({}, input);
  assert.equal(result.scope.subjectsIdentifiable, false); assert.equal(result.scope.identifiedLocally.length, 1);
  assert.ok(local.records.at(-1).targets.some(t => t.sourcePatientId?.value === 'LOCAL-PATIENT'));
  for (const form of forms) await local.controller.incidentDraft({}, input.incidentId, form);
});
test('numeric overdue, immediate MOHW, ISP provisional and confirmed clocks come from F', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-10T00:00:00Z') });
  const f = fixture(), input = intake('CLOCKS', 'confirmed');
  input.facts.reportTriggers = ['sensitive-or-unique'];
  input.facts.medicalIncident = { occurredAt: '2026-10-31T00:00:00.000Z', discoveredAt: input.facts.awarenessAt, electronicIntrusion: true, type: 'theft-leak' };
  input.facts.ispIncident = { eventId: 'attack', attackCaused: true, status: 'unknown',
    occurrence: { occurredAt: '2026-10-31T00:00:00.000Z', endedAt: null, evidenceId: 'occurrence' } };
  let r = await f.controller.registerIncident({}, input);
  assert.equal(r.plan.obligations.find(o => o.kind === 'confirmed-leak').status, 'overdue');
  assert.equal(r.plan.obligations.find(o => o.kind === 'mohw-notice').dueAt, null);
  assert.equal(r.plan.ispAssessments[0].initialReport.provisionalResponseDueAt, '2026-11-02T00:00:00.000Z');
  const fact = { ...input.facts, evidenceId: 'verified', determinationAt: '2026-11-01T01:00:00.000Z',
    ispIncident: { ...input.facts.ispIncident, status: true, verification: { by: { id: 'spoof', issuer: 'spoof', subject: 'spoof' },
      at: '2026-11-01T01:00:00.000Z', evidenceId: 'types', types: { telecomBusiness: true, forProfitTelecomInformation: false } } } };
  r = await f.controller.incidentFinding({}, input.incidentId, { operationId: 'verify', facts: fact });
  assert.equal(r.history.at(-1).facts.ispIncident.verification.by.id, 'synthetic-auditor');
  assert.equal(r.plan.obligations.find(o => o.kind === 'isp-incident-report').dueAt, '2026-11-02T00:00:00.000Z');
  const o = r.plan.obligations.find(o => o.kind === 'confirmed-leak'), sent = notice(o);
  sent.notice.sentAt = '2026-11-09T00:00:00.000Z';
  r = await f.controller.incidentNotice({}, input.incidentId, sent);
  assert.equal(r.plan.obligations.find(o => o.kind === 'confirmed-leak').status, 'met');
  assert.ok(r.plan.obligations.find(o => o.kind === 'confirmed-leak').lateByMs > 0);
});
test('all routes require both scopes and tenant ownership; malformed, conflict and future inputs refuse', async () => {
  const methods = [['registerIncident',[intake()]], ['listIncidents',[]], ['readIncident',['x']], ['incidentFinding',['x',{}]],
    ['incidentNotice',['x',{}]], ['closeIncident',['x',{}]], ['incidentDraft',['x','possibility']]];
  for (const scopes of [[], ['investigate'], ['export'], ['inspection']]) {
    const f = fixture(scopes);
    for (const [method, args] of methods) await assert.rejects(f.controller[method]({}, ...args), { code: scopes.length ? 'AuditScopeNotGranted' : 'AuditorNotDesignated' });
    assert.equal(f.records.length, 0); assert.equal(f.requests.length, 0);
  }
  const f = fixture(); await f.controller.registerIncident({}, intake());
  const foreign = fixture(undefined, 'OTHER'); foreign.requests.push(...f.requests);
  assert.deepEqual((await foreign.controller.listIncidents({})).incidents, []);
  await assert.rejects(foreign.controller.readIncident({}, 'SYN-INCIDENT'), { code: 'IncidentNotFound' });
  await assert.rejects(f.controller.registerIncident({}, { ...intake(), incidentType: 'other' }), { code: 'IncidentConflict' });
  await assert.rejects(f.controller.incidentDraft({}, 'SYN-INCIDENT', 'invented'), { code: 'AuditRequestInvalid' });
  const future = intake('FUTURE'); future.facts.determinationAt = '2099-01-01T00:00:00.000Z';
  await assert.rejects(f.controller.registerIncident({}, future), { code: 'IncidentResponseRefused' });
});
test('incident parser exceptions do not waive clinical targets, unresolved patients or other surfaces', async () => {
  const { parseAccessEvent } = require('../../../api/src/emr-contract/access-event.ts');
  const f = fixture(); await f.controller.registerIncident({}, intake());
  const event = structuredClone(f.records[0]);
  assert.throws(() => parseAccessEvent({ ...event, surface: 'GET studies/:uid/report/versions' }));
  const noId = structuredClone(event); noId.targets[0].recordId = { status: 'unresolved', reason: 'not-resolved' };
  assert.throws(() => parseAccessEvent(noId));
  const noPatient = structuredClone(event); noPatient.targets[1].patientLinkSnapshot = { status: 'unresolved', reason: 'not-resolved' };
  assert.throws(() => parseAccessEvent(noPatient));
  const wrongKind = structuredClone(event); wrongKind.targets[0].kind = 'report-version';
  assert.throws(() => parseAccessEvent(wrongKind));
  const v2 = { ...event, formatVersion: 2, branch: 'local-read' };
  assert.throws(() => parseAccessEvent(v2));
});
