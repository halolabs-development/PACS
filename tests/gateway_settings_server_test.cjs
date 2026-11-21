'use strict';
/* Gateway settings on the API (api/src/gateway-settings.ts rule, api/src/gateway-settings.service.ts): the administrator's
 * form is a closed shape (routes with a Modality and/or sending AE and one to nine destinations, each this server or one of
 * the institution's store peers; overlapping routes allowed; compression
 * none or lossless); a save names the revision it started from and another save in between is 409; the same settings
 * again write nothing; every change writes one audit row with counts and choices only; restricted accounts and other
 * roles are refused; the Gateway reads its own institution's settings with every store peer (never a printer), and an
 * institution with none set answers the empty settings. No DB, credentials or network.
 */
require('./service_test_loader.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('/app/dist/gateway-settings');
const { GatewaySettingsService } = require('/app/dist/gateway-settings.service');

const P1 = '11111111-1111-4111-8111-111111111111', P2 = '22222222-2222-4222-8222-222222222222';
const PRINTER = '33333333-3333-4333-8333-333333333333', OTHER = '44444444-4444-4444-8444-444444444444';
const ADMIN = { sub: 'sub-admin', actor: 'SYN-admin', roles: ['admin'], institution: 'inst-a', kind: 'member' };
const ADMIN_B = { ...ADMIN, sub: 'sub-admin-b', institution: 'inst-b' };
const TECH = { sub: 'sub-tech', actor: 'SYN-tech', roles: ['technician'], institution: 'inst-a', kind: 'member' };
const GW = { sub: 'sub-gw', actor: 'service-account-gw-inst-a', roles: ['gateway'], institution: 'inst-a', kind: 'gateway' };
const route = (modality, sourceAe, ...destinations) => ({ modality, sourceAe, destinations });
const form = (extra = {}) => ({ revision: 0, routes: [route('CT', null, 'kin', P1)], compression: 'lossless', ...extra });

function harness({ restricted = false, changed = false } = {}) {
  const institutions = new Map([['inst-a', { gatewaySettings: null }], ['inst-b', { gatewaySettings: null }]]);
  const peers = [
    { id: P1, institutionId: 'inst-a', name: 'SYN PACS A', aet: 'SYNPACSA', host: 'pacs-a.synthetic.test', port: 104, kind: 'store' },
    { id: P2, institutionId: 'inst-a', name: 'SYN PACS B', aet: 'SYNPACSB', host: '10.0.0.9', port: 11112, kind: 'store' },
    { id: PRINTER, institutionId: 'inst-a', name: 'SYN film', aet: 'SYNFILM', host: '10.0.0.8', port: 104, kind: 'printer' },
    { id: OTHER, institutionId: 'inst-b', name: 'SYN PACS other', aet: 'SYNPACSO', host: '10.0.0.7', port: 104, kind: 'store' },
  ];
  const audits = [], calls = [], locks = [];
  const prisma = {
    institution: {
      findUnique: async ({ where }) => institutions.has(where.id) ? { ...institutions.get(where.id) } : null,
      update: async ({ where, data }) => { calls.push(['update', where.id]); Object.assign(institutions.get(where.id), data); },
    },
    dicomPeer: { findMany: async ({ where }) => peers.filter(p => p.institutionId === where.institutionId && p.kind === where.kind)
      .sort((x, y) => x.name.localeCompare(y.name)) },
    auditLog: { create: async ({ data }) => { audits.push(data); return data; } },
    $queryRaw: async (strings, me) => { locks.push(me); return institutions.has(me) ? [{ ...institutions.get(me) }] : []; },
    $transaction: async work => work(tx),
  };
  const tx = { ...prisma };
  const studyAccess = {
    snapshot: async c => { calls.push(['snapshot', c.sub]); return { policy: { restricted } }; },
    unchanged: async (c, access, db) => { calls.push(['unchanged', c.sub, db === tx]); if (changed) { const e = new Error('changed'); e.status = 409; throw e; } },
  };
  return { service: new GatewaySettingsService(prisma, studyAccess), institutions, audits, calls, locks };
}
const status = error => error?.getStatus?.() ?? error?.status;
const code = error => error?.getResponse?.()?.code;
const field = error => error?.getResponse?.()?.field;

test('the form is closed: conditions, destinations, overlap and compression', () => {
  const peers = new Set([P1, P2]);
  const ok = S.parseGatewaySettingsInput(form({ routes: [route(' ct ', ' SYN_CT ', 'kin', P1), route('MG', null, P2)] }), peers);
  assert.deepEqual(ok, { expectedRevision: 0, settings: { routes: [route('CT', 'SYN_CT', 'kin', P1), route('MG', null, P2)],
    compression: 'lossless', retentionDays: null } });
  assert.deepEqual(S.parseGatewaySettingsInput(form({ routes: [route('', '', 'kin')], compression: 'none' }), peers)
    .settings.routes, [route(null, null, 'kin')], 'empty conditions are no condition');
  const bad = [
    [form({ extra: 1 }), 'body'], [null, 'body'], [[], 'body'], [form({ revision: -1 }), 'revision'], [form({ revision: '0' }), 'revision'],
    [form({ routes: {} }), 'routes'], [form({ routes: Array.from({ length: 33 }, (_, i) => route('M' + i, null, 'kin')) }), 'routes'],
    [form({ routes: [route('C T', null, 'kin')] }), 'routes[0].modality'], [form({ routes: [route(7, null, 'kin')] }), 'routes[0].modality'],
    [form({ routes: [route('CT', 'A\\B', 'kin')] }), 'routes[0].sourceAe'], [form({ routes: [route('CT', 'X'.repeat(17), 'kin')] }), 'routes[0].sourceAe'],
    [form({ routes: [route('CT', null)] }), 'routes[0].destinations'], [form({ routes: [route('CT', null, 'kin', 'kin')] }), 'routes[0].destinations'],
    [form({ routes: [route('CT', null, PRINTER)] }), 'routes[0].destinations'], [form({ routes: [route('CT', null, OTHER)] }), 'routes[0].destinations'],
    [form({ routes: [{ ...route('CT', null, 'kin'), order: 1 }] }), 'routes[0]'],
    [form({ retentionDays: 0 }), 'retentionDays'], [form({ retentionDays: 3651 }), 'retentionDays'],
    [form({ retentionDays: 1.5 }), 'retentionDays'], [form({ retentionDays: '7' }), 'retentionDays'],
    [form({ retentionDays: true }), 'retentionDays'], [form({ retentionDays: -1 }), 'retentionDays'],
    [form({ compression: 'jpeg' }), 'compression'], [form({ compression: undefined }), 'compression'],
  ];
  for (const [body, name] of bad)
    assert.throws(() => S.parseGatewaySettingsInput(body, peers), error => error instanceof S.GatewaySettingsInputError
      && error.field === name && error.code === S.GATEWAY_SETTINGS_INVALID, JSON.stringify(body));
  // Routes are not ranked: one study can match several (a CT and an SR series), and it goes to all their destinations
  // (the Gateway's rule), so routes that could meet one study are kept as they are.
  for (const [a, b] of [[route('CT', null, 'kin'), route('CT', 'SYN_CT', P1)], [route(null, null, 'kin'), route('MG', null, P1)],
    [route('CT', null, 'kin'), route('SR', null, P1)]])
    assert.deepEqual(S.parseGatewaySettingsInput(form({ routes: [a, b] }), peers).settings.routes, [a, b]);
});

test('nothing stored is the empty settings, for the administrator and for the Gateway', async () => {
  const h = harness();
  const read = await h.service.adminRead(ADMIN);
  assert.deepEqual(read.settings, { revision: 0, routes: [], compression: 'none', retentionDays: null });
  assert.deepEqual(read.peers.map(p => p.id), [P1, P2], 'store peers of the own institution only, never a printer');
  const answer = await h.service.gatewayRead(GW);
  assert.deepEqual(answer, { revision: 0, routes: [], compression: 'none', destinations: [
    { id: P1, name: 'SYN PACS A', aet: 'SYNPACSA', host: 'pacs-a.synthetic.test', port: 104 },
    { id: P2, name: 'SYN PACS B', aet: 'SYNPACSB', host: '10.0.0.9', port: 11112 }] });
  assert.deepEqual(Object.keys(answer).sort(), ['compression', 'destinations', 'revision', 'routes']);
});

test('a save: revision check, one audit row with no address, the same settings write nothing, the Gateway sees it', async () => {
  const h = harness();
  const first = await h.service.adminSave(form(), ADMIN);
  assert.equal(first.changed, true);
  assert.deepEqual(first.settings, { revision: 1, routes: [route('CT', null, 'kin', P1)], compression: 'lossless',
    retentionDays: null });
  assert.deepEqual(h.locks, ['inst-a'], 'the institution row is locked first');
  assert.deepEqual(h.audits.map(a => [a.action, a.target, JSON.parse(a.detail)]), [['institution.gateway-settings.save', 'inst-a',
    { institution: 'inst-a', revision: 1, routes: 1, destinations: [P1, 'kin'], compression: 'lossless', retentionDays: null }]]);
  assert.doesNotMatch(h.audits[0].detail, /synthetic\.test|10\.0\.0/);
  const again = await h.service.adminSave(form({ revision: 1 }), ADMIN);
  assert.deepEqual([again.changed, again.settings.revision, h.audits.length], [false, 1, 1]);
  // Another administrator saved meanwhile: the old form is refused, nothing is overwritten.
  await assert.rejects(h.service.adminSave(form({ revision: 0, compression: 'none' }), ADMIN),
    error => status(error) === 409 && code(error) === S.GATEWAY_SETTINGS_STALE && error.getResponse().revision === 1);
  assert.equal(h.institutions.get('inst-a').gatewaySettings.compression, 'lossless');
  const answer = await h.service.gatewayRead(GW);
  assert.deepEqual([answer.revision, answer.routes, answer.compression],
    [1, [route('CT', null, 'kin', P1)], 'lossless']);
  assert.deepEqual((await h.service.gatewayRead({ ...GW, institution: 'inst-b' })).routes, [], 'another institution is untouched');
});

test('a refused form writes nothing and names its field', async () => {
  const h = harness();
  for (const [body, name, kind] of [[form({ routes: [route('CT', null, OTHER)] }), 'routes[0].destinations', S.GATEWAY_SETTINGS_INVALID],
    [form({ routes: [route('CT', null, 'kin'), route('MG', null)] }), 'routes[1].destinations', S.GATEWAY_SETTINGS_INVALID]])
    await assert.rejects(h.service.adminSave(body, ADMIN), error => status(error) === 400 && field(error) === name && code(error) === kind);
  assert.deepEqual([h.audits.length, h.institutions.get('inst-a').gatewaySettings], [0, null]);
});

test('roles: the administrator only, not with a restricted study scope; the Gateway read is the Gateway credential only', async () => {
  const h = harness();
  for (const who of [TECH, GW]) {
    await assert.rejects(h.service.adminRead(who), error => status(error) === 403);
    await assert.rejects(h.service.adminSave(form(), who), error => status(error) === 403);
  }
  for (const who of [ADMIN, TECH, { ...ADMIN, roles: ['admin', 'gateway'] }])
    await assert.rejects(h.service.gatewayRead(who), error => status(error) === 403);
  const restricted = harness({ restricted: true });
  await assert.rejects(restricted.service.adminRead(ADMIN), error => status(error) === 403 && code(error) === S.GATEWAY_SETTINGS_RESTRICTED);
  await assert.rejects(restricted.service.adminSave(form(), ADMIN), error => status(error) === 403);
  assert.equal(restricted.audits.length, 0);
  assert.deepEqual((await h.service.adminSave(form(), ADMIN_B).catch(error => error)).getResponse?.().field, 'routes[0].destinations',
    'a peer of another institution is not a destination');
});

test('a scope that changed between the admission and the write refuses the save, and nothing is written', async () => {
  const h = harness({ changed: true });
  await assert.rejects(h.service.adminSave(form(), ADMIN), error => status(error) === 409);
  assert.deepEqual([h.audits.length, h.institutions.get('inst-a').gatewaySettings], [0, null]);
  assert.deepEqual(h.calls.filter(call => call[0] === 'update'), []);
  assert.deepEqual(h.calls.filter(call => call[0] === 'unchanged'), [['unchanged', ADMIN.sub, true]]);
});

test('stored values are read defensively and the routed peers are the ones the routes name', () => {
  for (const odd of [null, 'x', [], { revision: 'x', routes: [] }, { revision: 1 }])
    assert.deepEqual(S.storedGatewaySettings(odd), S.NO_GATEWAY_SETTINGS);
  const stored = { revision: 3, routes: [route('CT', null, 'kin', P1), route('MG', null, P2)], compression: 'lossless',
    retentionDays: 30 };
  assert.deepEqual(S.storedGatewaySettings(stored), stored);
  assert.deepEqual([...S.routedPeers(stored)].sort(), [P1, P2]);
  for (const odd of [0, 3651, 1.5, '30', undefined])
    assert.equal(S.storedGatewaySettings({ ...stored, retentionDays: odd }).retentionDays, null, 'an unreadable period is never delete');
});

test('the retention period: set, kept by a form without it, cleared, audited, and given only to a Gateway that asks', async () => {
  const h = harness();
  const peers = new Set([P1, P2]);
  for (const days of [1, 3650, null])
    assert.equal(S.parseGatewaySettingsInput(form({ retentionDays: days }), peers).settings.retentionDays, days);
  assert.equal(S.parseGatewaySettingsInput(form(), peers, 14).settings.retentionDays, 14, 'a form without the key keeps it');
  const set = await h.service.adminSave(form({ retentionDays: 30 }), ADMIN);
  assert.deepEqual([set.changed, set.settings.revision, set.settings.retentionDays], [true, 1, 30]);
  assert.equal(JSON.parse(h.audits[0].detail).retentionDays, 30);
  // Only the period changes: one more revision and one more audit row; the same again writes nothing.
  const longer = await h.service.adminSave(form({ revision: 1, retentionDays: 60 }), ADMIN);
  assert.deepEqual([longer.changed, longer.settings.revision, h.audits.length], [true, 2, 2]);
  const same = await h.service.adminSave(form({ revision: 2, retentionDays: 60 }), ADMIN);
  assert.deepEqual([same.changed, same.settings.revision, h.audits.length], [false, 2, 2]);
  const older = await h.service.adminSave(form({ revision: 2 }), ADMIN);
  assert.deepEqual([older.changed, older.settings.retentionDays], [false, 60], 'an older page keeps the period');
  await assert.rejects(h.service.adminSave(form({ revision: 2, retentionDays: 0 }), ADMIN),
    error => status(error) === 400 && field(error) === 'retentionDays');
  // An older Gateway asks without it and gets the closed shape it reads; a Gateway that asks gets the period.
  const plain = await h.service.gatewayRead(GW);
  assert.deepEqual(Object.keys(plain).sort(), ['compression', 'destinations', 'revision', 'routes']);
  assert.equal((await h.service.gatewayRead(GW, true)).retentionDays, 60);
  const cleared = await h.service.adminSave(form({ revision: 2, retentionDays: null }), ADMIN);
  assert.deepEqual([cleared.changed, cleared.settings.retentionDays, h.audits.length], [true, null, 3]);
  const asked = await h.service.gatewayRead(GW, true);
  assert.deepEqual([Object.keys(asked).includes('retentionDays'), asked.retentionDays], [true, null]);
});