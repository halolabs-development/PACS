'use strict';
/* Modality Worklist: what a device is answered (api/src/modality-worklist.ts) and the API's side of the helper
 * (api/src/modality-worklist.service.ts), against an in-memory order table, the real device rule (PacsInstitutions
 * .resolveDevice) and, for the process side, a stand-in helper (stdlib Python) in place of api/mwl/mwl_scp.py. The real
 * helper is covered by tests/modality_worklist_helper_test.py, the whole path by tests/e2e/test_modality_worklist.py.
 * No DB, credentials or network.
 */
require('./service_test_loader.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { answerQuery, prepareQuery, MWL_STATUS, MWL_MAX_MATCHES, scheduledAt } = require('/app/dist/modality-worklist');
const { ModalityWorklistService, mwlConfig, MWL_PAGE } = require('/app/dist/modality-worklist.service');
const { PacsInstitutions } = require('/app/dist/pacs/institutions');

const PN = (v, group = 'Alphabetic') => ({ vr: 'PN', Value: [{ [group]: v }] });
const S = (vr, v) => v === undefined ? { vr } : { vr, Value: [v] };
const SQ = (...items) => ({ vr: 'SQ', Value: items });
const value = (el) => el?.Value?.[0]?.Alphabetic ?? el?.Value?.[0] ?? '';

let n = 0;
function order(over = {}) {
  n += 1;
  return { oid: `SYN-ORDER-${String(n).padStart(6, '0')}`, institutionId: 'inst-a', patientId: 'SYN-P1', name: 'SYNTHETIC^ONE', sex: 'F',
    birth: '1980-02-03', sched: '2026-11-20 09:10', modality: 'CT', descr: 'SYN CT HEAD', ward: 'SYNWARD', reqDoc: 'SYN DOC',
    accession: 'SYNACC1', mwlProcedureId: `SYNPROC${String(n).padStart(9, '0')}`, mwlStudyUid: `2.25.${1000 + n}`,
    scheduledStationAet: 'SYNCT1', removedAt: null, matched: 'U', studyUid: null, risStatus: null, ...over };
}

function harness(rows, { auditFails = false } = {}) {
  const audits = [], reads = [];
  const institutions = new PacsInstitutions(null, null, null, null, null);
  institutions.institutions = [
    { id: 'inst-a', name: 'A', dicomNames: '', dicomAets: 'SYNCT1,SYNCT2' },
    { id: 'inst-b', name: 'B', dicomNames: '', dicomAets: 'SYNCTB' },
    { id: 'inst-c', name: 'C', dicomNames: '', dicomAets: 'SYNSHARED' },
    { id: 'inst-d', name: 'D', dicomNames: '', dicomAets: 'SYNSHARED' },
  ];
  const sorted = list => [...list].sort((x, y) => x.sched < y.sched ? -1 : x.sched > y.sched ? 1 : x.oid < y.oid ? -1 : x.oid > y.oid ? 1 : 0);
  const prisma = {
    order: {
      findMany: async (q) => {
        reads.push(q);
        // The population is the institution's listed orders; the only other condition is the page cursor.
        assert.deepEqual(Object.keys(q.where).filter(k => k !== 'OR').sort(), ['institutionId', 'removedAt']);
        assert.equal(q.where.removedAt, null);
        assert.deepEqual(q.orderBy, [{ sched: 'asc' }, { oid: 'asc' }]);
        assert.ok(q.take > 0 && q.take <= 1000);
        const after = q.where.OR ? { sched: q.where.OR[0].sched.gt, oid: q.where.OR[1].oid.gt } : null;
        if (after) assert.equal(q.where.OR[1].sched, after.sched);
        return sorted(rows.filter(o => o.institutionId === q.where.institutionId && o.removedAt === null))
          .filter(o => !after || o.sched > after.sched || (o.sched === after.sched && o.oid > after.oid))
          .slice(0, q.take)
          .map(o => Object.fromEntries(Object.keys(q.select).map(k => [k, o[k]])));
      },
      update: () => assert.fail('a query never writes an order'), updateMany: () => assert.fail('a query never writes an order'),
    },
    auditLog: { create: async ({ data }) => { if (auditFails) throw new Error('audit down'); audits.push({ ...data, detail: JSON.parse(data.detail) }); return data; } },
  };
  const service = new ModalityWorklistService(prisma, { resolveDevice: aet => institutions.resolveDevice(aet) });
  const logged = [];
  service.log = { log: () => undefined, warn: m => logged.push(['warn', m]), error: m => logged.push(['error', m]) };
  return { service, audits, reads, logged };
}

const dayQuery = (date, extra = {}) => ({ '00100010': S('PN'), '00100020': S('LO'), '00080050': S('SH'),
  '00400100': SQ({ '00400002': S('DA', date), '00080060': S('CS'), '00400001': S('AE') }), ...extra });
const ids = async (orders, q) => {
  const r = await answerQuery(orders, { '00100020': S('LO'), ...q });
  assert.equal(r.status, 0, JSON.stringify(r));
  return r.items.map(i => value(i['00100020']));
};

test('a registered device gets its own institution listed orders only; another device gets its own', async () => {
  const a = order({ patientId: 'SYN-SAME', accession: 'SYNACC-SAME' });
  const b = order({ institutionId: 'inst-b', patientId: 'SYN-SAME', accession: 'SYNACC-SAME', scheduledStationAet: 'SYNCTB' });
  const { service, audits } = harness([a, b]);
  const q = dayQuery('20261120', { '00100020': S('LO', 'SYN-SAME'), '00080050': S('SH', 'SYNACC-SAME') });
  const fromA = await service.answer('SYNCT1', q);
  assert.equal(fromA.status, 0);
  assert.deepEqual(fromA.items.map(i => value(i['00400100'].Value[0]['00400001'])), ['SYNCT1']);
  const fromB = await service.answer('SYNCTB', q);
  assert.deepEqual(fromB.items.map(i => value(i['00400100'].Value[0]['00400001'])), ['SYNCTB']);
  // The second registered device of A gets A's, with the station key telling A's devices apart.
  const second = await service.answer('SYNCT2', dayQuery('20261120', { '00400100': SQ({ '00400001': S('AE', 'SYNCT2') }) }));
  assert.equal(second.items.length, 0);
  assert.deepEqual(audits.map(r => [r.action, r.detail.institution, r.detail.aet, r.detail.outcome, r.detail.matches, r.detail.excluded]),
    [['modality-worklist.query', 'inst-a', 'SYNCT1', 'answered', 1, 0], ['modality-worklist.query', 'inst-b', 'SYNCTB', 'answered', 1, 0],
     ['modality-worklist.query', 'inst-a', 'SYNCT2', 'answered', 0, 0]]);
  for (const r of audits) assert.ok(!JSON.stringify(r).includes('SYN-SAME') && !JSON.stringify(r).includes('SYNTHETIC'), 'no patient or search value');
});

test('an unregistered, shared or empty calling AE is refused without reading any order; a lost audit row is logged', async () => {
  const { service, audits, reads } = harness([order()]);
  for (const aet of ['SYNUNKNOWN', 'SYNSHARED', '', '  ', 'synct1', null]) {
    const got = await service.answer(aet, dayQuery('20261120'));
    assert.deepEqual(got, { status: MWL_STATUS.refused, warning: false, items: [] }, String(aet));
  }
  assert.equal(reads.length, 0);
  assert.ok(audits.every(r => r.detail.institution === null && r.detail.outcome === 'refused' && r.target === '-'));
  const down = harness([order()], { auditFails: true });
  assert.equal((await down.service.answer('SYNUNKNOWN', dayQuery('20261120'))).status, MWL_STATUS.refused);
  assert.deepEqual(down.logged.map(([level]) => level), ['error']);
  assert.match(down.logged[0][1], /audit row not written \(refused query of device SYNUNKNOWN\)/);
});

test('Delete Order takes it out of the next query and Undo brings it back; repeated queries change no order', async () => {
  const kept = order(), removed = order({ patientId: 'SYN-P2', matched: 'M', studyUid: '2.25.77', risStatus: 'acquired' });
  const rows = [kept, removed];
  const { service } = harness(rows);
  const snapshot = JSON.stringify(rows);
  const oids = async () => (await service.answer('SYNCT1', { '00402016': S('LO') })).items.map(i => value(i['00402016']));
  // A matched, RIS-acquired order is still listed: neither is a step the worklist reads.
  assert.deepEqual(await oids(), [kept.oid, removed.oid]);
  removed.removedAt = new Date();
  assert.deepEqual(await oids(), [kept.oid]);
  removed.removedAt = null;
  const back = await service.answer('SYNCT1', { '00402016': S('LO'), '00401001': S('SH'), '0020000D': S('UI') });
  assert.deepEqual(back.items.map(i => [value(i['00402016']), value(i['00401001']), value(i['0020000D'])]),
    [[kept.oid, kept.mwlProcedureId, kept.mwlStudyUid], [removed.oid, removed.mwlProcedureId, removed.mwlStudyUid]]);
  for (let i = 0; i < 3; i++) await oids();
  assert.equal(JSON.stringify(rows), snapshot, 'Match, receipt and RIS state are untouched by queries');
  // The matched study's own UID is never handed out: the worklist UID is the order's.
  assert.notEqual(value(back.items[1]['0020000D']), removed.studyUid);
});

test('a large list is read in pages, in order, and every match is answered', async () => {
  const rows = Array.from({ length: MWL_PAGE * 2 + 7 }, (_, i) => order({ sched: '2026-11-20 09:10', patientId: `SYN-PAGE-${i}` }));
  const { service, reads } = harness(rows);
  const got = await service.answer('SYNCT1', { '00402016': S('LO') });
  assert.equal(got.items.length, rows.length);
  assert.deepEqual(got.items.map(i => value(i['00402016'])), rows.map(o => o.oid).sort());
  assert.equal(reads.length, 3);
  assert.ok(reads.every(q => q.take === MWL_PAGE));
});

test('only the keys asked for come back, with the character set and the hospital offset', async () => {
  const o = order({ name: '홍길동^SYNTHETIC' });
  const got = await answerQuery([o], { '00100020': S('LO') });
  assert.deepEqual(Object.keys(got.items[0]).sort(), ['00080005', '00080201', '00100020']);
  assert.deepEqual(got.items[0]['00080005'], { vr: 'CS', Value: ['ISO_IR 192'] });
  assert.deepEqual(got.items[0]['00080201'], { vr: 'SH', Value: ['+0900'] });
  assert.equal(value((await answerQuery([o], { '00100010': PN('홍*') })).items[0]['00100010']), '홍길동^SYNTHETIC');
  // A whole SPS (empty sequence or one empty item) is every SPS key; a partial item only its keys.
  for (const sps of [{ vr: 'SQ' }, SQ(), SQ({})]) {
    const whole = (await answerQuery([o], { '00400100': sps })).items[0]['00400100'].Value[0];
    assert.deepEqual(Object.keys(whole).sort(), ['00080060', '00321070', '00400001', '00400002', '00400003', '00400004', '00400005',
      '00400006', '00400007', '00400008', '00400009', '00400010', '00400011', '00400012', '00400020']);
    assert.equal(value(whole['00400003']), '091000');
    assert.deepEqual(whole['00400006'], { vr: 'PN' }, 'performing physician unknown: empty');
    assert.deepEqual(whole['00400008'], { vr: 'SQ', Value: [] });
  }
  const part = await answerQuery([o], { '00400100': SQ({ '00080060': S('CS') }) });
  assert.deepEqual(Object.keys(part.items[0]['00400100'].Value[0]), ['00080060']);
});

test('return values come from the order, fit their VR and are never made up; an order that cannot be carried is not answered', async () => {
  const o = order({ accession: null, reqDoc: 'SYN REQ', birth: '1980-02-03', sex: 'X' });
  const got = (await answerQuery([o], { '00080050': S('SH'), '00321032': S('PN'), '00080090': S('PN'), '00100030': S('DA'), '00100040': S('CS'),
    '00401001': S('SH'), '00402016': S('LO'), '0020000D': S('UI'), '00380300': S('LO'), '00321060': S('LO') })).items[0];
  assert.deepEqual(got['00080050'], { vr: 'SH' });
  assert.equal(value(got['00321032']), 'SYN REQ');
  assert.deepEqual(got['00080090'], { vr: 'PN' });
  assert.equal(value(got['00100030']), '19800203');
  assert.deepEqual(got['00100040'], { vr: 'CS' });
  assert.equal(value(got['00401001']), o.mwlProcedureId);
  assert.equal(value(got['00402016']), o.oid);
  assert.equal(value(got['00380300']), 'SYNWARD');
  // Two orders whose oids share their first 16 characters keep their own procedure IDs.
  const one = order({ oid: 'SYNTHETIC-techord-aaaa' }), two = order({ oid: 'SYNTHETIC-techord-bbbb' });
  const pairs = (await answerQuery([one, two], { '00401001': S('SH'), '00400100': SQ({ '00400009': S('SH') }) })).items
    .map(i => [value(i['00401001']), value(i['00400100'].Value[0]['00400009'])]);
  assert.deepEqual(pairs, [[one.mwlProcedureId, one.mwlProcedureId], [two.mwlProcedureId, two.mwlProcedureId]]);
  // A specific accession does not match an order without one.
  assert.equal((await answerQuery([o], { '00080050': S('SH', 'SYNACC1') })).items.length, 0);
  // A Type 1 value the order cannot give, or a value its VR cannot carry: the order is not answered in those keys. When it
  // is the only match, the query ends Unable to process with no identifier.
  const fails = [
    [order({ name: '', patientId: '' }), { '00100010': S('PN'), '00100020': S('LO') }],
    [order({ name: '^^^^' }), { '00100010': S('PN') }],
    [order({ name: ' ^ = ^ ' }), { '00100010': S('PN') }],
    [order({ descr: '' }), { '00321060': S('LO') }],
    [order({ descr: '' }), { '00400100': SQ() }],
    [order({ oid: 'SYN-' + 'X'.repeat(61) }), { '00402016': S('LO') }],
    [order({ ward: 'W'.repeat(65) }), { '00380300': S('LO') }],
    [order({ name: 'SYN=ALT=THIRD=FOURTH' }), { '00100010': S('PN') }],
    [order({ modality: 'ct' }), { '00400100': SQ({ '00080060': S('CS') }) }],
    [order({ scheduledStationAet: '한글장비' }), { '00400100': SQ({ '00400001': S('AE') }) }],
    [order({ scheduledStationAet: '한글장비' }), { '00400100': SQ() }],
    [order({ scheduledStationAet: 'SYN\\CT' }), { '00400100': SQ({ '00400001': S('AE') }) }],
  ];
  for (const [row, q] of fails) {
    const r = await answerQuery([row], q);
    assert.deepEqual([r.status, r.items, r.matches, r.excluded], [MWL_STATUS.missingValue, [], 1, 1], JSON.stringify(q));
  }
  // A Type 2 person name of delimiters only is no name: it comes back empty.
  assert.deepEqual((await answerQuery([order({ reqDoc: '^^' })], { '00321032': S('PN') })).items[0]['00321032'], { vr: 'PN' });
  // A standard Type 2 key the order does not hold comes back empty, without a warning.
  const weight = await answerQuery([order()], { '00100020': S('LO'), '00101030': S('DS'), '00081110': S('SQ') });
  assert.equal(weight.warning, false);
  assert.deepEqual(weight.items[0]['00101030'], { vr: 'DS' });
  assert.deepEqual(weight.items[0]['00081110'], { vr: 'SQ', Value: [] });
});

test('matching: exact single values, name wildcards in any one representation, performing physician and UID lists', async () => {
  const a = order({ name: 'KIM^SYNTHETIC', patientId: 'SYN-A', modality: 'CT', scheduledStationAet: 'SYN_CT1' });
  const b = order({ name: 'LEE^SYNTHETIC', patientId: 'SYN-B', modality: 'MR', scheduledStationAet: 'SYN_CT2' });
  const c = order({ name: '홍길동', patientId: 'SYN-C', modality: 'CT', scheduledStationAet: null });
  const rows = [a, b, c];
  assert.deepEqual(await ids(rows, { '00100010': PN('K*') }), ['SYN-A']);
  assert.deepEqual(await ids(rows, { '00100010': PN('K?M^*') }), ['SYN-A']);
  assert.deepEqual(await ids(rows, { '00100010': PN('KIM') }), []);
  // A name searched in its Ideographic or Phonetic representation only is compared, not dropped.
  assert.deepEqual(await ids(rows, { '00100010': PN('홍*', 'Ideographic') }), ['SYN-C']);
  assert.deepEqual(await ids(rows, { '00100010': PN('KIM*', 'Phonetic') }), ['SYN-A']);
  const several = await answerQuery(rows, { '00100020': S('LO'), '00100010': { vr: 'PN', Value: [{ Alphabetic: 'KIM*', Ideographic: '金*' }] } });
  assert.deepEqual([several.status, several.items], [MWL_STATUS.nameGroups, []]);
  // Single values match exactly: wildcard characters are characters there.
  assert.deepEqual(await ids(rows, { '00100020': S('LO', 'SYN-B') }), ['SYN-B']);
  assert.deepEqual(await ids(rows, { '00100020': S('LO', 'SYN-*') }), []);
  assert.deepEqual(await ids(rows, { '00400100': SQ({ '00400001': S('AE', 'SYN_CT?') }) }), []);
  assert.deepEqual(await ids(rows, { '00400100': SQ({ '00080060': S('CS', 'C?') }) }), []);
  assert.deepEqual(await ids(rows, { '00400100': SQ({ '00080060': S('CS', 'CT') }) }), ['SYN-A', 'SYN-C']);
  // A station query never finds an order not scheduled on a device; the calling device is not copied into it.
  assert.deepEqual(await ids(rows, { '00400100': SQ({ '00400001': S('AE', 'SYN_CT1') }) }), ['SYN-A']);
  assert.deepEqual(await ids(rows, { '00400100': SQ({ '00400006': S('PN', 'SYN DOCTOR') }) }), []);
  assert.deepEqual(await ids(rows, { '00400100': SQ({ '00400006': S('PN', '*') }) }), ['SYN-A', 'SYN-B', 'SYN-C']);
  assert.deepEqual(await ids(rows, { '0020000D': { vr: 'UI', Value: [a.mwlStudyUid, b.mwlStudyUid] } }), ['SYN-A', 'SYN-B']);
  // Asking for the station back while an order without one matches: that order alone is left out, and counted.
  const partly = await answerQuery([a, c], { '00100020': S('LO'), '00400100': SQ({ '00400001': S('AE'), '00080060': S('CS', 'CT') }) });
  assert.deepEqual([partly.status, partly.items.map(i => value(i['00100020'])), partly.matches, partly.excluded], [0, ['SYN-A'], 2, 1]);
});

const HAN = '\u{20000}';   // one character outside the Basic Multilingual Plane (two UTF-16 units)

test('an order the keys asked for cannot carry is left out alone: the others are answered, all left out is Unable to process, no match is success', async () => {
  const good = order({ patientId: 'SYN-GOOD' });
  const unnamed = order({ patientId: 'SYN-UNNAMED', name: '^^^^' });
  const station = order({ patientId: 'SYN-STATION', scheduledStationAet: '한글장비' });
  const rows = [good, unnamed, station];
  const named = { '00100010': S('PN'), '00100020': S('LO') };
  const got = async q => { const r = await answerQuery(rows, q); return [r.status, r.items.map(i => value(i['00100020'])), r.matches, r.excluded]; };
  // Mixed: every order that can be carried is answered; the one that cannot is counted, not sent.
  assert.deepEqual(await got(named), [0, ['SYN-GOOD', 'SYN-STATION'], 3, 1]);
  assert.deepEqual(await got({ '00100020': S('LO'), '00400100': SQ() }), [0, ['SYN-GOOD', 'SYN-UNNAMED'], 3, 1]);
  assert.deepEqual(await got({ ...named, '00400100': SQ({ '00400001': S('AE') }) }), [0, ['SYN-GOOD'], 3, 2]);
  // A flaw in a field nobody asked for leaves the order in.
  assert.deepEqual(await got({ '00100020': S('LO') }), [0, ['SYN-GOOD', 'SYN-UNNAMED', 'SYN-STATION'], 3, 0]);
  // Every matching order left out: Unable to process, no identifier - the device can tell it from an empty list.
  assert.deepEqual(await got({ ...named, '00100020': S('LO', 'SYN-UNNAMED') }), [MWL_STATUS.missingValue, [], 1, 1]);
  // No order matches the keys: success, no identifier.
  assert.deepEqual(await got({ ...named, '00100020': S('LO', 'SYN-NOBODY') }), [0, [], 0, 0]);
  // The audit row counts the matches and the orders left out apart, with no value.
  const { service, audits } = harness(rows);
  assert.deepEqual((await service.answer('SYNCT1', named)).items.map(i => value(i['00100020'])), ['SYN-GOOD', 'SYN-STATION']);
  assert.deepEqual(await service.answer('SYNCT1', { ...named, '00100020': S('LO', 'SYN-UNNAMED') }), { status: MWL_STATUS.missingValue, warning: false, items: [] });
  assert.deepEqual(audits.map(r => [r.detail.outcome, r.detail.matches, r.detail.excluded]), [['answered', 3, 1], ['failed', 1, 1]]);
  for (const r of audits) assert.ok(!/SYN-|SYNTHETIC|한글/.test(JSON.stringify(r)), 'no patient or search value');
  // The limit is on the orders that can be answered: 5,000 left out and one that can go is one answer.
  const many = Array.from({ length: MWL_MAX_MATCHES }, () => order({ name: '^^^^' }));
  const one = await answerQuery([...many, order({ patientId: 'SYN-ONE' })], named);
  assert.deepEqual([one.status, one.items.map(i => value(i['00100020'])), one.matches, one.excluded], [0, ['SYN-ONE'], MWL_MAX_MATCHES + 1, MWL_MAX_MATCHES]);
});

test('lengths count characters, not UTF-16 units; a person name is measured and returned by representation', async () => {
  const id33 = HAN.repeat(33), proc16 = HAN.repeat(16);
  const o = order({ patientId: id33, mwlProcedureId: proc16, name: HAN.repeat(60) + '^SYN', accession: HAN.repeat(16), ward: HAN.repeat(64) });
  const got = await answerQuery([o], { '00100020': S('LO', id33), '00100010': S('PN'), '00401001': S('SH', proc16), '00080050': S('SH'), '00380300': S('LO') });
  assert.equal(got.status, 0, JSON.stringify(got));
  assert.deepEqual([value(got.items[0]['00100020']), value(got.items[0]['00401001']), value(got.items[0]['00100010']), value(got.items[0]['00080050']),
    value(got.items[0]['00380300'])], [id33, proc16, HAN.repeat(60) + '^SYN', HAN.repeat(16), HAN.repeat(64)]);
  // One character more than the VR carries: the order is not answered in that key.
  for (const [row, q] of [[order({ patientId: HAN.repeat(65) }), { '00100020': S('LO') }], [order({ accession: HAN.repeat(17) }), { '00080050': S('SH') }],
    [order({ name: HAN.repeat(65) }), { '00100010': S('PN') }], [order({ name: 'SYN=' + 'S'.repeat(65) }), { '00100010': S('PN') }],
    [order({ scheduledStationAet: 'S'.repeat(17) }), { '00400100': SQ({ '00400001': S('AE') }) }]])
    assert.equal((await answerQuery([row], q)).status, MWL_STATUS.missingValue, JSON.stringify(q));
  // A stored name in two or three representations is found by its patient ID and comes back with each of them.
  const two = order({ patientId: 'SYN-TWO', name: 'KIM^A=金' }), three = order({ patientId: 'SYN-THREE', name: 'LEE^B=李=イ' });
  const long = order({ patientId: 'SYN-LONG', name: 'S'.repeat(64) + '=' + HAN.repeat(64) });
  const ideographic = order({ patientId: 'SYN-IDEO', name: '=朴' });
  const names = await answerQuery([two, three, long, ideographic], { '00100020': S('LO'), '00100010': S('PN') });
  assert.equal(names.status, 0, JSON.stringify(names));
  assert.deepEqual(names.items.map(i => i['00100010']), [
    { vr: 'PN', Value: [{ Alphabetic: 'KIM^A', Ideographic: '金' }] },
    { vr: 'PN', Value: [{ Alphabetic: 'LEE^B', Ideographic: '李', Phonetic: 'イ' }] },
    { vr: 'PN', Value: [{ Alphabetic: 'S'.repeat(64), Ideographic: HAN.repeat(64) }] },
    { vr: 'PN', Value: [{ Ideographic: '朴' }] },
  ]);
  const exact = await answerQuery([two, three], { '00100020': S('LO', 'SYN-TWO'), '00100010': S('PN') });
  assert.deepEqual([exact.status, exact.items.length, exact.excluded], [0, 1, 0]);
  // Either representation of the stored name answers a name searched in one.
  const rows = [two, three, ideographic];
  assert.deepEqual(await ids(rows, { '00100010': PN('KIM^A') }), ['SYN-TWO']);
  assert.deepEqual(await ids(rows, { '00100010': PN('金', 'Ideographic') }), ['SYN-TWO']);
  assert.deepEqual(await ids(rows, { '00100010': PN('李*') }), ['SYN-THREE']);
  assert.deepEqual(await ids(rows, { '00100010': PN('イ', 'Phonetic') }), ['SYN-THREE']);
  assert.deepEqual(await ids(rows, { '00100010': PN('朴') }), ['SYN-IDEO']);
  assert.deepEqual(await ids(rows, { '00100010': PN('KIM') }), []);
});

test('wildcards and padding work by character: `?` is one character outside the BMP too; only the DICOM padding space is taken off', async () => {
  const han = order({ patientId: 'SYN-HAN', name: 'SYN^' + HAN }), two = order({ patientId: 'SYN-HAN2', name: 'SYN^' + HAN + HAN });
  const rows = [han, two];
  assert.deepEqual(await ids(rows, { '00100010': PN('SYN^?') }), ['SYN-HAN']);
  assert.deepEqual(await ids(rows, { '00100010': PN('SYN^??') }), ['SYN-HAN2']);
  assert.deepEqual(await ids(rows, { '00100010': PN('SYN^*') }), ['SYN-HAN', 'SYN-HAN2']);
  assert.deepEqual(await ids(rows, { '00100010': PN('SYN^' + HAN) }), ['SYN-HAN']);
  // Delimiters that end a name are not part of it; a name of delimiters only asks for no name.
  const tail = order({ patientId: 'SYN-TAIL', name: 'PARK^C^^^' });
  assert.deepEqual(await ids([tail, han], { '00100010': PN('PARK^C') }), ['SYN-TAIL']);
  assert.deepEqual(await ids([tail, han], { '00100010': PN('PARK^C^^') }), ['SYN-TAIL']);
  assert.deepEqual(await ids([tail, han], { '00100010': PN('^^^^') }), ['SYN-TAIL', 'SYN-HAN']);
  // An identifier that begins with an ideographic space is another identifier; SPACE padding is not part of one.
  const wide = order({ patientId: '　A' }), plain = order({ patientId: 'A' }), padded = order({ patientId: ' B ' });
  const list = [wide, plain, padded];
  assert.deepEqual(await ids(list, { '00100020': S('LO', 'A') }), ['A']);
  assert.deepEqual(await ids(list, { '00100020': S('LO', ' A ') }), ['A']);
  assert.deepEqual(await ids(list, { '00100020': S('LO', '　A') }), ['　A']);
  assert.deepEqual(await ids(list, { '00100020': S('LO', 'B') }), ['B']);
  assert.deepEqual(await ids(list, {}), ['　A', 'A', 'B']);
});

test('a patient key given a value is compared (birth date, sex); a patient attribute the order cannot be compared on never matches', async () => {
  const a = order({ patientId: 'SYN-A', birth: '1980-02-03', sex: 'F' });
  const b = order({ patientId: 'SYN-B', birth: '1975-07-09', sex: 'M' });
  const c = order({ patientId: 'SYN-C', birth: '', sex: '' });
  const rows = [a, b, c];
  const got = async q => { const r = await answerQuery(rows, { '00100020': S('LO'), ...q }); return [r.status, r.warning, r.items.map(i => value(i['00100020']))]; };
  // Both given: only the patient both are true of - never the others under a warning.
  assert.deepEqual(await got({ '00100030': S('DA', '19800203'), '00100040': S('CS', 'F') }), [0, false, ['SYN-A']]);
  assert.deepEqual(await got({ '00100030': S('DA', '19800203'), '00100040': S('CS', 'M') }), [0, false, []]);
  assert.deepEqual(await got({ '00100030': S('DA', '19750709') }), [0, false, ['SYN-B']]);
  assert.deepEqual(await got({ '00100030': S('DA', '19700101-19791231') }), [0, false, ['SYN-B']]);
  assert.deepEqual(await got({ '00100030': S('DA', '19760101-') }), [0, false, ['SYN-A']]);
  assert.deepEqual(await got({ '00100040': S('CS', 'M') }), [0, false, ['SYN-B']]);
  assert.deepEqual(await got({ '00100040': S('CS', 'O') }), [0, false, []]);
  // Asked back only (zero length): every order, each with its own value or empty.
  const back = await answerQuery(rows, { '00100020': S('LO'), '00100030': S('DA'), '00100040': S('CS') });
  assert.deepEqual(back.items.map(i => [value(i['00100030']), value(i['00100040'])]), [['19800203', 'F'], ['19750709', 'M'], ['', '']]);
  assert.equal((await answerQuery(rows, { '00100030': S('DA', '1980-02-03') })).status, MWL_STATUS.identifier);
  // A value for a patient attribute the order has nothing to compare with (issuer of the patient ID, other patient IDs,
  // a referenced patient, weight) is never taken as matched.
  assert.deepEqual(await got({ '00100021': S('LO', 'SYN-ISSUER') }), [0, true, []]);
  assert.deepEqual(await got({ '00101000': S('LO', 'SYN-A') }), [0, true, []]);
  assert.deepEqual(await got({ '00101002': SQ({ '00100020': S('LO', 'SYN-A') }) }), [0, true, []]);
  assert.deepEqual(await got({ '00081120': SQ({ '00081150': S('UI'), '00081155': S('UI', '2.25.5') }) }), [0, true, []]);
  assert.deepEqual(await got({ '00101030': S('DS', '70') }), [0, true, []]);
  // The same attributes asked back only (no value, or a sequence item of empty keys) narrow nothing.
  assert.deepEqual((await got({ '00100021': S('LO') }))[2], ['SYN-A', 'SYN-B', 'SYN-C']);
  assert.deepEqual((await got({ '00081120': SQ({ '00081150': S('UI'), '00081155': S('UI') }), '00101002': SQ({ '00100020': S('LO') }) }))[2], ['SYN-A', 'SYN-B', 'SYN-C']);
  // A value for an attribute that is not the patient's and the answer does not match: a warning, as before.
  assert.deepEqual(await got({ '00380300': S('LO', 'SYNWARD') }), [0, true, ['SYN-A', 'SYN-B', 'SYN-C']]);
});

test('scheduled date and time: single, ranges, one span only when both are ranges, date-only and unreadable orders', async () => {
  const at = sched => order({ sched, patientId: sched });
  const rows = [at('2026-11-20 21:00'), at('2026-11-20 23:00'), at('2026-11-21 01:00'), at('2026-11-21 03:00'), at('20261120'), at('soon'),
    at('2026-11-21 10:00'), at('2026-11-21 14:00'), at('2026-11-22 10:00:00')];
  const pick = (date, time) => answerQuery(rows, { '00100020': S('LO'),
    '00400100': SQ({ ...(date !== undefined ? { '00400002': S('DA', date) } : {}), ...(time !== undefined ? { '00400003': S('TM', time) } : {}) }) });
  const when = async (...a) => { const r = await pick(...a); assert.equal(r.status, 0, JSON.stringify(r)); return r.items.map(i => value(i['00100020'])); };
  assert.deepEqual(await when('20261120'), ['2026-11-20 21:00', '2026-11-20 23:00', '20261120']);
  assert.deepEqual(await when('20261122-'), ['2026-11-22 10:00:00']);
  assert.deepEqual(await when('-20261120'), ['2026-11-20 21:00', '2026-11-20 23:00', '20261120']);
  // Both ranges: one span from the first date's start time to the last date's end time.
  assert.deepEqual(await when('20261120-20261121', '2200-0200'), ['2026-11-20 23:00', '2026-11-21 01:00']);
  // A date range with a single time: that time on each of the dates, not a span.
  assert.deepEqual(await when('20261120-20261122', '100000'), ['2026-11-21 10:00', '2026-11-22 10:00:00']);
  assert.deepEqual(await when('20261120', '2100'), ['2026-11-20 21:00']);
  assert.deepEqual(await when(undefined, '0000-0200'), ['2026-11-21 01:00']);
  // A date-only order has no midnight: a time key does not match it, and asked for its time it is the one left out.
  assert.ok(!(await when('20261120', '0000-2359')).includes('20261120'));
  const timeAsked = await answerQuery(rows, { '00100020': S('LO'), '00400100': SQ({ '00400002': S('DA', '20261120'), '00400003': S('TM') }) });
  assert.deepEqual([timeAsked.status, timeAsked.items.map(i => value(i['00100020'])), timeAsked.matches, timeAsked.excluded],
    [0, ['2026-11-20 21:00', '2026-11-20 23:00'], 3, 1]);
  assert.equal((await answerQuery([at('20261120')], { '00400100': SQ({ '00400002': S('DA', '20261120'), '00400003': S('TM') }) })).status, MWL_STATUS.missingValue);
  // Two times out of order are one span only across two dates.
  assert.equal((await pick('20261120', '2200-0200')).status, MWL_STATUS.identifier);
  assert.equal((await pick(undefined, '2200-0200')).status, MWL_STATUS.identifier);
  // An unreadable scheduled date is out of every date query, and asking for its date with no date key fails.
  assert.ok(!(await when('19000101-29991231')).includes('soon'));
  assert.equal((await answerQuery([at('soon')], { '00400100': SQ({ '00400002': S('DA') }) })).status, MWL_STATUS.missingValue);
  assert.equal(scheduledAt('20261131'), null);
});

test('a query in another UTC offset is read in that offset, open ends included', async () => {
  const eight = order({ sched: '2026-11-20 08:00', patientId: 'SYN-0800' }), ten = order({ sched: '2026-11-20 10:00', patientId: 'SYN-1000' });
  const nine = order({ sched: '2026-11-20 09:10', patientId: 'SYN-0910' }), day = order({ sched: '20261120', patientId: 'SYN-DAY' });
  const rows = [eight, nine, ten, day];
  const q = (offset, date, time) => ({ '00080201': S('SH', offset), '00100020': S('LO'),
    '00400100': SQ({ ...(date ? { '00400002': S('DA', date) } : {}), ...(time ? { '00400003': S('TM', time) } : {}) }) });
  const got = async (...a) => (await answerQuery(rows, q(...a))).items.map(i => value(i['00100020']));
  assert.deepEqual(await got('+0000', '20261120', '0000-0059'), ['SYN-0910']);   // 00:10 UTC = 09:10 KST
  assert.deepEqual(await got('+0000', '20261120', '0100-0200'), ['SYN-1000']);
  assert.deepEqual(await got('+0900', '20261120', '0900-1000'), ['SYN-0910', 'SYN-1000']);
  assert.deepEqual(await got('-0500', '20261119', '1900-1959'), ['SYN-0910']);   // 19:10 the day before at -0500
  // Time only, an open start: from the query's own midnight (UTC 00:00 = 09:00 here), not the hospital's.
  assert.deepEqual(await got('+0000', undefined, '-0200'), ['SYN-0910', 'SYN-1000']);
  // A date-only order with a date key in another offset: either end of its day.
  assert.ok((await got('+0000', '20261119')).includes('SYN-DAY'));
  assert.equal((await answerQuery(rows, { '00080201': S('SH', '+9999'), '00100020': S('LO') })).status, MWL_STATUS.identifier);
});

test('identifiers the SOP Class does not allow, an empty identifier, unsupported keys and too many matches', async () => {
  const o = order();
  const status = async q => (await answerQuery([o], q)).status;
  assert.equal(await status({ '00400100': SQ({}, {}) }), MWL_STATUS.identifier);
  assert.equal(await status({ '00400100': SQ({ '00400002': S('DA', '2026-11-20') }) }), MWL_STATUS.identifier);
  assert.equal(await status({ '00400100': SQ({ '00400002': S('DA', '20261121-20261120') }) }), MWL_STATUS.identifier);
  assert.equal(await status({ '00400100': SQ({ '00400003': S('TM', '2500') }) }), MWL_STATUS.identifier);
  assert.equal(await status({ '00100020': { vr: 'LO', Value: ['A', 'B'] } }), MWL_STATUS.identifier);
  assert.equal(await status({ '00100020': SQ() }), MWL_STATUS.identifier);
  // A key given with another VR than its own.
  assert.equal(await status({ '00100020': S('CS', 'SYN-P1') }), MWL_STATUS.identifier);
  assert.equal(await status({ '00400100': SQ({ '00400001': S('SH', 'SYNCT1') }) }), MWL_STATUS.identifier);
  assert.throws(() => prepareQuery([]));
  // Nothing asked: no match. Only the character set: still nothing asked.
  assert.deepEqual(await answerQuery([o], {}), { status: 0, items: [], warning: false, matches: 0, excluded: 0 });
  assert.equal((await answerQuery([o], { '00080005': S('CS', 'ISO_IR 192') })).items.length, 0);
  // A key outside the worklist keys: a warning, returned empty; a value given to a returned-only key: a warning.
  const unknown = await answerQuery([o], { '00100020': S('LO'), '00181030': S('LO'), '00400100': SQ({ '00400099': S('LO') }) });
  assert.equal(unknown.warning, true);
  assert.deepEqual(unknown.items[0]['00181030'], { vr: 'LO' });
  assert.deepEqual(unknown.items[0]['00400100'].Value[0]['00400099'], { vr: 'LO' });
  assert.equal((await answerQuery([o], { '00380300': S('LO', 'SYNWARD') })).warning, true);
  assert.equal((await answerQuery([o], { '00100020': S('LO') })).warning, false);
  const many = Array.from({ length: MWL_MAX_MATCHES + 1 }, () => order());
  const over = await answerQuery(many, { '00100020': S('LO') });
  assert.deepEqual([over.status, over.items], [MWL_STATUS.resources, []]);
});

test('the audit row is written before any identifier, and its failure answers none', async () => {
  const { service, logged } = harness([order()], { auditFails: true });
  assert.deepEqual(await service.answer('SYNCT1', { '00100020': S('LO') }), { status: MWL_STATUS.audit, warning: false, items: [] });
  assert.deepEqual(logged.map(([level]) => level), ['error']);
  const ok = harness([order()]);
  await ok.service.answer('SYNCT1', { '00400100': SQ({}, {}) });
  assert.deepEqual(ok.audits.map(r => r.detail.outcome), ['invalid']);
});

test('off unless KIN_MWL_PORT is set; a bad setting refuses to start', () => {
  assert.equal(mwlConfig({}), null);
  assert.equal(mwlConfig({ KIN_MWL_PORT: '' }), null);
  assert.deepEqual(Object.entries(mwlConfig({ KIN_MWL_PORT: '4243' })).filter(([k]) => ['port', 'aet', 'answerSeconds'].includes(k)),
    [['port', 4243], ['aet', 'KINMWL'], ['answerSeconds', 10]]);
  for (const env of [{ KIN_MWL_PORT: 'x' }, { KIN_MWL_PORT: '70000' }, { KIN_MWL_PORT: '4243', KIN_MWL_AET: 'A'.repeat(17) },
    { KIN_MWL_PORT: '4243', KIN_MWL_ANSWER_SECONDS: '0' }])
    assert.throws(() => mwlConfig(env), JSON.stringify(env));
  const saved = process.env.KIN_MWL_PORT;
  delete process.env.KIN_MWL_PORT;
  const { service } = harness([]);
  service.onApplicationBootstrap();
  assert.equal(service.child, null);
  service.onApplicationShutdown();
  if (saved !== undefined) process.env.KIN_MWL_PORT = saved;
});

function withEnv(t, env) {
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
}

test('the helper process: asked, answered on its own stdin, started again after it stops, stopped with the API; its other output is not logged', async (t) => {
  const python = process.env.KIN_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mwl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stand = path.join(dir, 'stand.py');
  fs.writeFileSync(stand, [
    'import json, os, sys',
    'log = os.path.join(os.path.dirname(os.path.abspath(__file__)), "log.jsonl")',
    'open(log, "a").write(json.dumps({"start": sys.argv[1:]}) + "\\n")',
    'sys.stderr.write("KIN-MWL query not readable ValueError\\n")',
    'sys.stderr.write("UserWarning: The value SYN-SECRET-VALUE is invalid\\n")',
    'sys.stderr.flush()',
    'print(json.dumps({"type": "listening", "port": 1}), flush=True)',
    'print(json.dumps({"type": "find", "id": "syn:1", "calling": "SYNCT1", "called": "KINMWL", "identifier": {"00100020": {"vr": "LO"}}}), flush=True)',
    'line = sys.stdin.readline()',
    'open(log, "a").write(line)',
    'sys.exit(0)',
  ].join('\n'));
  withEnv(t, { KIN_MWL_PORT: '4999', KIN_MWL_AET: 'SYNMWL', KIN_MWL_PYTHON: python, KIN_MWL_HELPER: stand });
  const { service, audits, logged } = harness([order({ patientId: 'SYN-PROC' })]);
  service.onApplicationBootstrap();
  const log = path.join(dir, 'log.jsonl');
  const lines = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const deadline = Date.now() + 15000;
  while (lines().filter(l => l.start).length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  service.onApplicationShutdown();
  const seen = lines();
  assert.ok(seen.filter(l => l.start).length >= 2, 'started again after it stopped');
  assert.deepEqual(seen[0].start, ['--port', '4999', '--aet', 'SYNMWL', '--answer-seconds', '10']);
  const answer = seen.find(l => l.id === 'syn:1');
  assert.equal(answer.status, 0);
  assert.deepEqual(answer.items.map(i => i['00100020'].Value[0]), ['SYN-PROC']);
  assert.ok(audits.length >= 1);
  const text = JSON.stringify(logged);
  assert.ok(text.includes('KIN-MWL query not readable ValueError'));
  assert.ok(!text.includes('SYN-SECRET-VALUE'), 'a line that may hold a value is not logged');
  // Once stopped with the API, no new start.
  const count = lines().filter(l => l.start).length;
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(lines().filter(l => l.start).length, count);
});

test('a helper that cannot even start is tried again', async (t) => {
  withEnv(t, { KIN_MWL_PORT: '4999', KIN_MWL_PYTHON: path.join(os.tmpdir(), 'kin-no-such-python-' + process.pid), KIN_MWL_HELPER: 'none.py' });
  const { service, logged } = harness([]);
  let starts = 0;
  const start = service.start.bind(service);
  service.start = () => { starts += 1; return start(); };
  service.onApplicationBootstrap();
  const deadline = Date.now() + 8000;
  while (starts < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  service.onApplicationShutdown();
  assert.ok(starts >= 2, `started ${starts} times`);
  assert.ok(logged.some(([, m]) => /could not run/.test(m)));
});

test('the main and production compose files never turn it on; only the synthetic overlay does', () => {
  const root = path.resolve(__dirname, '..');
  for (const file of ['docker-compose.yml', 'docker-compose.prod.yml']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(!/KIN_MWL_/.test(text), `${file} sets no Modality Worklist value`);
    assert.ok(!/4243/.test(text), `${file} publishes no worklist port`);
  }
  const overlay = fs.readFileSync(path.join(root, 'docker-compose.mwl.yml'), 'utf8');
  assert.match(overlay, /KIN_MWL_PORT: "4243"/);
  assert.match(overlay, /"127\.0\.0\.1:\$\{KIN_MWL_HOST_PORT:-4243\}:4243"/);
});
