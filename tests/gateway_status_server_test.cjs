'use strict';
/* Gateway operational status on the API (api/src/gateway-heartbeat.ts rules, api/src/gateway-status.service.ts): the
 * Gateway's heartbeat is a closed body; identity and institution come only from the verified caller; a late beat never
 * overwrites a newer one (same run by uptime, another run by its derived start); another institution's row is never
 * moved; the memory table is bounded (an existing row still updates, a new one is refused); the admin read gives this
 * institution's rows only, with No Contact after 180 s of server time, and refuses restricted accounts like the metrics.
 * No DB, credentials or network.
 */
require('./service_test_loader.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('/app/dist/gateway-heartbeat');
const { GatewayStatusService } = require('/app/dist/gateway-status.service');

const EPOCH = '0f4b2c1a-1111-4222-8333-944455556666', EPOCH2 = '1f4b2c1a-1111-4222-8333-944455556666';
const BOOT = 4, BOOT2 = 5;
const GW = { sub: 'sub-gw-a', actor: 'service-account-gw-inst-a', roles: ['gateway'], institution: 'inst-a', kind: 'gateway' };
const GW_B = { sub: 'sub-gw-b', actor: 'service-account-gw-inst-b', roles: ['gateway'], institution: 'inst-b', kind: 'gateway' };
const ADMIN = { sub: 'sub-admin', actor: 'SYN-admin', roles: ['admin'], institution: 'inst-a', kind: 'member' };
const TECH = { sub: 'sub-tech', actor: 'SYN-tech', roles: ['technician'], institution: 'inst-a', kind: 'member' };
const beat = (extra = {}) => ({ epoch: EPOCH, bootSeq: BOOT, version: '2026.11.1', uptimeSeconds: 600,
  queue: { waiting: 3, retry: 1, failed: 0 }, lastStowAgeSeconds: 12, localOrthanc: { answered: true, ageSeconds: 1 }, ...extra });

function harness({ restricted = false, changed = false } = {}) {
  const calls = [];
  const studyAccess = {
    snapshot: async c => { calls.push(['snapshot', c.sub]); return { policy: { restricted } }; },
    unchanged: async (c, snap) => { calls.push(['unchanged', c.sub]); if (changed) { const e = new Error('changed'); e.status = 409; throw e; } },
  };
  const service = new GatewayStatusService(studyAccess);
  let now = Date.parse('2026-11-16T12:00:00.000Z');
  service.clock = () => now;
  return { service, calls, at: iso => { now = Date.parse(iso); }, tick: ms => { now += ms; } };
}
const status = error => error?.getStatus?.() ?? error?.status;
const code = error => error?.getResponse?.()?.code;

test('the body is closed: every key, type and bound; ages never exceed the uptime', () => {
  assert.deepEqual(H.parseGatewayHeartbeat(beat()), beat());
  assert.deepEqual(H.parseGatewayHeartbeat(beat({ queue: null, lastStowAgeSeconds: null, localOrthanc: null })).queue, null);
  const bad = [undefined, null, [], 'x', {}, { ...beat(), extra: 1 }, (() => { const b = beat(); delete b.version; return b; })(),
    beat({ epoch: EPOCH.toUpperCase() }), beat({ epoch: 'not-a-uuid' }), beat({ bootSeq: 0 }), beat({ bootSeq: 1.5 }), beat({ bootSeq: '4' }), beat({ bootSeq: -1 }),
    beat({ bootSeq: 2 ** 31 }), beat({ bootSeq: null }), beat({ version: '' }),
    beat({ version: 'v 1' }), beat({ version: 'x'.repeat(33) }), beat({ version: 7 }), beat({ uptimeSeconds: -1 }),
    beat({ uptimeSeconds: 1.5 }), beat({ uptimeSeconds: '600' }), beat({ uptimeSeconds: 10 * 366 * 24 * 3600 + 1 }),
    beat({ queue: { waiting: 1, retry: 0 } }), beat({ queue: { waiting: 1, retry: 0, failed: 0, complete: 4 } }),
    beat({ queue: { waiting: -1, retry: 0, failed: 0 } }), beat({ queue: { waiting: '1', retry: 0, failed: 0 } }),
    beat({ queue: [] }), beat({ lastStowAgeSeconds: 601 }), beat({ lastStowAgeSeconds: -1 }),
    beat({ localOrthanc: { answered: 'yes', ageSeconds: 1 } }), beat({ localOrthanc: { answered: true } }),
    beat({ localOrthanc: { answered: true, ageSeconds: 601 } }), beat({ localOrthanc: { answered: true, ageSeconds: 1, at: 'x' } })];
  for (const body of bad) assert.throws(() => H.parseGatewayHeartbeat(body), H.GatewayHeartbeatInputError, JSON.stringify(body));
});

test('times come from the server reception: start = R - uptime, last STOW = R - age, local answer = R - age', () => {
  const R = Date.parse('2026-11-16T12:00:00.000Z');
  const row = H.gatewayHeartbeatRow(H.parseGatewayHeartbeat(beat()), 'sub', 'label', 'inst-a', R);
  assert.equal(row.startedAt, R - 600000);
  assert.equal(row.lastStowAt, R - 12000);
  assert.deepEqual(row.localOrthanc, { answered: true, observedAt: R - 1000 });
  assert.equal(row.receivedAt, R);
});

test('late writes: same run only forward by uptime, another run only if it started later; another institution conflicts', () => {
  const R = 1_000_000_000;
  const row = (extra, at = R) => H.gatewayHeartbeatRow(H.parseGatewayHeartbeat(beat(extra)), 'sub', 'l', 'inst-a', at);
  const stored = row({});
  assert.equal(H.decideGatewayHeartbeat(undefined, stored), 'stored');
  assert.equal(H.decideGatewayHeartbeat(stored, row({ uptimeSeconds: 630 }, R + 30000)), 'stored');
  assert.equal(H.decideGatewayHeartbeat(stored, row({ uptimeSeconds: 600 }, R + 1000)), 'stored', 'equal uptime is not older');
  assert.equal(H.decideGatewayHeartbeat(stored, row({ uptimeSeconds: 570, lastStowAgeSeconds: 0 }, R + 5000)), 'stale');
  // A restart: the next run number wins whatever its uptime.
  assert.equal(H.decideGatewayHeartbeat(stored, row({ bootSeq: BOOT2, uptimeSeconds: 2, lastStowAgeSeconds: null }, R + 60000)), 'stored');
  // A beat of the earlier run arriving after the restart's first beat.
  const restarted = row({ bootSeq: BOOT2, uptimeSeconds: 2, lastStowAgeSeconds: null }, R + 60000);
  assert.equal(H.decideGatewayHeartbeat(restarted, row({ uptimeSeconds: 640 }, R + 61000)), 'stale');
  const moved = { ...row({ uptimeSeconds: 640 }, R + 40000), institutionId: 'inst-b' };
  assert.equal(H.decideGatewayHeartbeat(stored, moved), 'conflict');
});

test('run order is the run number, never the derived start: a delayed beat of an earlier run, a clock set back', async () => {
  const h = harness();
  const at = ms => { h.at('2026-11-16T12:00:00.000Z'); h.tick(ms); };
  const shown = async () => (await h.service.status(ADMIN)).gateways.map(g => [g.contact, g.startedAt, g.lastContactAt]);
  // Run A has run 2 s at 0 s. Run B (the next run) starts and is heard at 5 s. A's beat sent at 2 s of its uptime,
  // delayed in transit, arrives at 8 s: its derived start (6 s) is later than B's (5 s), and still it is refused.
  at(0); assert.deepEqual(h.service.heartbeat(beat({ bootSeq: 1, uptimeSeconds: 2, lastStowAgeSeconds: null }), GW), { result: 'stored' });
  at(5000); assert.deepEqual(h.service.heartbeat(beat({ bootSeq: 2, uptimeSeconds: 0, lastStowAgeSeconds: null,
    localOrthanc: null }), GW), { result: 'stored' });
  at(8000); assert.deepEqual(h.service.heartbeat(beat({ bootSeq: 1, uptimeSeconds: 2, lastStowAgeSeconds: null }), GW), { result: 'stale' });
  // B's own beats go on being stored.
  at(35000); assert.deepEqual(h.service.heartbeat(beat({ bootSeq: 2, uptimeSeconds: 30, lastStowAgeSeconds: null,
    localOrthanc: null }), GW), { result: 'stored' });
  assert.deepEqual(await shown(), [['recent', '2026-11-16T12:00:05.000Z', '2026-11-16T12:00:35.000Z']]);
  // The server clock is set back an hour, then the Gateway restarts (run 3): it is stored though every derived time is
  // earlier than the stored ones, and the old run's late beat after it is still refused.
  at(-3600000); assert.deepEqual(h.service.heartbeat(beat({ bootSeq: 3, uptimeSeconds: 1, lastStowAgeSeconds: null,
    localOrthanc: null }), GW), { result: 'stored' });
  at(-3590000); assert.deepEqual(h.service.heartbeat(beat({ bootSeq: 2, uptimeSeconds: 40, lastStowAgeSeconds: null,
    localOrthanc: null }), GW), { result: 'stale' });
  at(-3570000); assert.deepEqual(h.service.heartbeat(beat({ bootSeq: 3, uptimeSeconds: 31, lastStowAgeSeconds: null,
    localOrthanc: null }), GW), { result: 'stored' });
});

test('a lower run number is taken only after the stored run has been silent past the contact rule (a restored queue file)', () => {
  const h = harness();
  assert.deepEqual(h.service.heartbeat(beat({ bootSeq: 9 }), GW), { result: 'stored' });
  h.tick(180000);
  assert.deepEqual(h.service.heartbeat(beat({ bootSeq: 3, uptimeSeconds: 5, lastStowAgeSeconds: null }), GW), { result: 'stale' },
    'exactly 180 s of silence is not yet past the rule');
  h.tick(1);
  assert.deepEqual(h.service.heartbeat(beat({ bootSeq: 3, uptimeSeconds: 5, lastStowAgeSeconds: null }), GW), { result: 'stored' });
  h.tick(30000);
  assert.deepEqual(h.service.heartbeat(beat({ bootSeq: 9, uptimeSeconds: 700 }), GW), { result: 'stored' },
    'the higher number still wins when it speaks again');
});

test('heartbeat: gateway credentials only; identity and institution from the caller; answers stored or stale', () => {
  const h = harness();
  for (const caller of [ADMIN, TECH, { ...GW, kind: 'member' }, { ...GW, roles: ['admin'] }])
    assert.throws(() => h.service.heartbeat(beat(), caller), e => status(e) === 403, JSON.stringify(caller));
  assert.throws(() => h.service.heartbeat(beat(), { ...GW, institution: null }), e => status(e) === 403);
  assert.throws(() => h.service.heartbeat({ ...beat(), institutionId: 'inst-b' }, GW),
    e => status(e) === 400 && code(e) === H.GATEWAY_HEARTBEAT_INVALID);
  assert.deepEqual(h.service.heartbeat(beat(), GW), { result: 'stored' });
  h.tick(1000);
  assert.deepEqual(h.service.heartbeat(beat({ uptimeSeconds: 500 }), GW), { result: 'stale' });
});

test('admin read: this institution only, newest contact first, No Contact after 180 s, answer is the explicit projection', async () => {
  const h = harness();
  h.service.heartbeat(beat(), GW);
  h.service.heartbeat(beat({ epoch: EPOCH2 }), GW_B);
  h.tick(10000);
  h.service.heartbeat(beat({ epoch: EPOCH2, bootSeq: BOOT2, uptimeSeconds: 20, queue: null, lastStowAgeSeconds: null,
    localOrthanc: { answered: false, ageSeconds: 4 } }), GW);
  const first = await h.service.status(ADMIN);
  assert.equal(first.institutionId, 'inst-a');
  assert.equal(first.generatedAt, '2026-11-16T12:00:10.000Z');
  assert.equal(first.noContactAfterSeconds, 180);
  assert.match(first.serverStartedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(first.gateways, [
    { gateway: 'gw-inst-a', queueInstance: EPOCH2, contact: 'recent', lastContactAt: '2026-11-16T12:00:10.000Z',
      startedAt: '2026-11-16T11:59:50.000Z', version: '2026.11.1', queue: null, lastStowAt: null,
      localOrthanc: { answered: false, observedAt: '2026-11-16T12:00:06.000Z' } },
    { gateway: 'gw-inst-a', queueInstance: EPOCH, contact: 'recent', lastContactAt: '2026-11-16T12:00:00.000Z',
      startedAt: '2026-11-16T11:50:00.000Z', version: '2026.11.1', queue: { waiting: 3, retry: 1, failed: 0 },
      lastStowAt: '2026-11-16T11:59:48.000Z', localOrthanc: { answered: true, observedAt: '2026-11-16T11:59:59.000Z' } }]);
  assert.equal(JSON.stringify(first).includes('inst-b'), false, 'nothing of another institution');
  assert.equal(JSON.stringify(first).includes('sub-gw'), false, 'no account id');
  h.at('2026-11-16T12:03:00.000Z');   // exactly 180 s after the first row's contact: still recent
  assert.deepEqual((await h.service.status(ADMIN)).gateways.map(g => g.contact), ['recent', 'recent']);
  h.at('2026-11-16T12:03:00.001Z');
  assert.deepEqual((await h.service.status(ADMIN)).gateways.map(g => g.contact), ['recent', 'no_contact']);
  h.at('2026-11-16T13:00:00.000Z');
  const later = await h.service.status(ADMIN);
  assert.deepEqual(later.gateways.map(g => [g.queueInstance, g.contact]), [[EPOCH2, 'no_contact'], [EPOCH, 'no_contact']],
    'old rows stay as No Contact; nothing is evicted');
  const other = await h.service.status({ ...ADMIN, institution: 'inst-b', sub: 'sub-admin-b' });
  assert.deepEqual(other.gateways.map(g => g.gateway), ['gw-inst-b']);
});

test('admin read: admin only, restricted accounts refused like the metrics, an access change while reading is not answered', async () => {
  const h = harness();
  for (const caller of [TECH, GW, { ...ADMIN, roles: ['radiologist'] }])
    await assert.rejects(h.service.status(caller), e => status(e) === 403, JSON.stringify(caller));
  await assert.rejects(h.service.status({ ...ADMIN, institution: null }), e => status(e) === 403);
  const restricted = harness({ restricted: true });
  await assert.rejects(restricted.service.status(ADMIN), e => status(e) === 403 && code(e) === H.GATEWAY_STATUS_RESTRICTED);
  const changed = harness({ changed: true });
  await assert.rejects(changed.service.status(ADMIN), e => status(e) === 409);
  assert.deepEqual(changed.calls, [['snapshot', 'sub-admin'], ['unchanged', 'sub-admin']]);
});

test('another institution cannot take over a row; a moved credential is refused, not silently re-homed', () => {
  const h = harness();
  h.service.heartbeat(beat(), GW);
  h.tick(30000);
  assert.throws(() => h.service.heartbeat(beat({ uptimeSeconds: 630 }), { ...GW, institution: 'inst-b' }),
    e => status(e) === 409 && code(e) === H.GATEWAY_HEARTBEAT_INSTITUTION_CONFLICT);
});

test('the memory table is bounded: at the bound an existing row still updates and a new row is refused', async () => {
  const h = harness();
  const epoch = n => `${n.toString(16).padStart(8, '0')}-1111-4222-8333-944455556666`;
  for (let n = 0; n < H.GATEWAY_HEARTBEAT_ROWS_PER_INSTITUTION; n++)
    assert.deepEqual(h.service.heartbeat(beat({ epoch: epoch(n) }), GW), { result: 'stored' });
  assert.throws(() => h.service.heartbeat(beat({ epoch: epoch(999) }), GW),
    e => status(e) === 429 && code(e) === H.GATEWAY_HEARTBEAT_LIMIT);
  h.tick(30000);
  assert.deepEqual(h.service.heartbeat(beat({ epoch: epoch(0), uptimeSeconds: 630 }), GW), { result: 'stored' });
  assert.deepEqual(h.service.heartbeat(beat({ epoch: epoch(0) }), GW_B), { result: 'stored' }, 'another institution has its own bound');
  assert.equal((await h.service.status(ADMIN)).gateways.length, H.GATEWAY_HEARTBEAT_ROWS_PER_INSTITUTION);
});

test('a service-account label shows as the client name; any other label is shown as is, bounded', () => {
  assert.equal(H.gatewayDisplayName('service-account-gw-hallym'), 'gw-hallym');
  assert.equal(H.gatewayDisplayName('gw-x'), 'gw-x');
  assert.equal(H.gatewayDisplayName('y'.repeat(300)).length, 128);
});
