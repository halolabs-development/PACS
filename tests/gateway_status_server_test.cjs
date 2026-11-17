'use strict';
/* Gateway operational status on the API (api/src/gateway-heartbeat.ts rules, api/src/gateway-status.service.ts): the
 * Gateway's heartbeat is a closed body; identity and institution come only from the verified caller; the write rule is
 * one function: the same run as the stored row is stored only for a strictly higher seq, another run is always stored
 * (the server does not order different runs, and no clock decides); another institution's row is never moved; the
 * memory table is bounded (an existing row still updates, a new one is refused); the admin read gives this institution's
 * rows only, with No Contact after 180 s of server time, and refuses restricted accounts like the metrics.
 * No DB, credentials or network.
 */
require('./service_test_loader.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('/app/dist/gateway-heartbeat');
const { GatewayStatusService } = require('/app/dist/gateway-status.service');

const EPOCH = '0f4b2c1a-1111-4222-8333-944455556666', EPOCH2 = '1f4b2c1a-1111-4222-8333-944455556666';
const BOOT = 'aa4b2c1a-1111-4222-8333-944455556666', BOOT2 = 'bb4b2c1a-1111-4222-8333-944455556666';
const GW = { sub: 'sub-gw-a', actor: 'service-account-gw-inst-a', roles: ['gateway'], institution: 'inst-a', kind: 'gateway' };
const GW_B = { sub: 'sub-gw-b', actor: 'service-account-gw-inst-b', roles: ['gateway'], institution: 'inst-b', kind: 'gateway' };
const ADMIN = { sub: 'sub-admin', actor: 'SYN-admin', roles: ['admin'], institution: 'inst-a', kind: 'member' };
const TECH = { sub: 'sub-tech', actor: 'SYN-tech', roles: ['technician'], institution: 'inst-a', kind: 'member' };
const beat = (extra = {}) => ({ epoch: EPOCH, bootId: BOOT, seq: 1, version: '2026.11.1', uptimeSeconds: 600,
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
// The one row of (GW, EPOCH) as the admin read projects it.
const rowOf = async h => (await h.service.status(ADMIN)).gateways.find(g => g.queueInstance === EPOCH);

test('the body is closed: every key, type and bound; ages never exceed the uptime', () => {
  assert.deepEqual(H.parseGatewayHeartbeat(beat()), beat());
  assert.deepEqual(H.parseGatewayHeartbeat(beat({ seq: Number.MAX_SAFE_INTEGER })).seq, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(H.parseGatewayHeartbeat(beat({ queue: null, lastStowAgeSeconds: null, localOrthanc: null })).queue, null);
  const bad = [undefined, null, [], 'x', {}, { ...beat(), extra: 1 }, (() => { const b = beat(); delete b.version; return b; })(),
    (() => { const b = beat(); delete b.seq; return b; })(), { ...beat(), bootSeq: 1 },
    beat({ epoch: EPOCH.toUpperCase() }), beat({ epoch: 'not-a-uuid' }), beat({ bootId: '' }), beat({ bootId: 'SYN' }),
    beat({ bootId: BOOT.toUpperCase() }), beat({ bootId: 7 }), beat({ bootId: null }),
    beat({ seq: 0 }), beat({ seq: -1 }), beat({ seq: 1.5 }), beat({ seq: '1' }), beat({ seq: null }),
    beat({ seq: Number.MAX_SAFE_INTEGER + 1 }), beat({ version: '' }),
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

test('the write rule: same run as the stored row only for a strictly higher seq, another run always; another institution conflicts', () => {
  const R = 1_000_000_000;
  const row = (extra, at = R) => H.gatewayHeartbeatRow(H.parseGatewayHeartbeat(beat(extra)), 'sub', 'l', 'inst-a', at);
  const stored = row({ seq: 10 });
  assert.equal(H.decideGatewayHeartbeat(undefined, stored), 'stored');
  assert.equal(H.decideGatewayHeartbeat(stored, row({ seq: 11 }, R + 30000)), 'stored');
  assert.equal(H.decideGatewayHeartbeat(stored, row({ seq: 10, uptimeSeconds: 900 }, R + 30000)), 'stale', 'the same seq again');
  assert.equal(H.decideGatewayHeartbeat(stored, row({ seq: 9, uptimeSeconds: 900 }, R + 30000)), 'stale', 'an older body of the run');
  // Another run: stored whatever its seq, uptime or derived times.
  for (const extra of [{ seq: 1 }, { seq: 10 }, { seq: 3, uptimeSeconds: 9000 }, { seq: 1, uptimeSeconds: 0, lastStowAgeSeconds: null, localOrthanc: null }])
    assert.equal(H.decideGatewayHeartbeat(stored, row({ bootId: BOOT2, ...extra }, R - 3600000)), 'stored', JSON.stringify(extra));
  const moved = { ...row({ seq: 11 }, R + 40000), institutionId: 'inst-b' };
  assert.equal(H.decideGatewayHeartbeat(stored, moved), 'conflict');
  assert.equal(H.decideGatewayHeartbeat(stored, { ...row({ bootId: BOOT2 }), institutionId: 'inst-b' }), 'conflict');
});

test('a refused body leaves the whole row as it was, its contact time too', async () => {
  const h = harness();
  assert.deepEqual(h.service.heartbeat(beat({ seq: 5, queue: { waiting: 1, retry: 0, failed: 0 } }), GW), { result: 'stored' });
  const before = await rowOf(h);
  h.tick(60000);
  for (const seq of [5, 4, 1])
    assert.deepEqual(h.service.heartbeat(beat({ seq, uptimeSeconds: 700, queue: { waiting: 9, retry: 9, failed: 9 } }), GW),
      { result: 'stale' }, `seq ${seq}`);
  assert.deepEqual(await rowOf(h), before, 'queue counts, start, last STOW and Last Contact are the stored ones');
});

test('another run is stored as it comes, and the stored run is then forgotten: A:10 -> B:1 -> A:9 stores all three', () => {
  const h = harness();
  const A = BOOT, B = BOOT2;
  assert.deepEqual(h.service.heartbeat(beat({ bootId: A, seq: 10 }), GW), { result: 'stored' });
  h.tick(1000);
  assert.deepEqual(h.service.heartbeat(beat({ bootId: B, seq: 1, uptimeSeconds: 1, lastStowAgeSeconds: null }), GW), { result: 'stored' });
  h.tick(1000);
  assert.deepEqual(h.service.heartbeat(beat({ bootId: A, seq: 9 }), GW), { result: 'stored' },
    'B in between: the row no longer remembers A:10, so A:9 is another run to it');
});

test('convergence: several late bodies of an ended run interleaved with the live run, then the live run shows', async () => {
  const h = harness();
  const OLD = BOOT, LIVE = BOOT2;
  const live = seq => beat({ bootId: LIVE, seq, uptimeSeconds: 10 * seq, lastStowAgeSeconds: null, queue: { waiting: seq, retry: 0, failed: 0 } });
  const old = seq => beat({ bootId: OLD, seq, uptimeSeconds: 5000 + seq, queue: { waiting: 100 + seq, retry: 0, failed: 0 } });
  for (const body of [old(7), live(1), old(5), old(8), live(2), old(6), live(3), old(9)]) { h.tick(500); h.service.heartbeat(body, GW); }
  assert.deepEqual((await rowOf(h)).queue, { waiting: 109, retry: 0, failed: 0 }, 'the last arrival of the ended run shows for now');
  h.tick(30000);
  assert.deepEqual(h.service.heartbeat(live(4), GW), { result: 'stored' });
  const shown = await rowOf(h);
  assert.deepEqual([shown.queue, shown.contact, shown.lastContactAt], [{ waiting: 4, retry: 0, failed: 0 }, 'recent', '2026-11-16T12:00:34.000Z']);
  h.tick(30000);
  assert.deepEqual(h.service.heartbeat(live(5), GW), { result: 'stored' });
  assert.deepEqual((await rowOf(h)).queue, { waiting: 5, retry: 0, failed: 0 });
});

test('the server clock never decides: the same arrivals are stored or refused alike with the clock forward, back or still', () => {
  const arrivals = [[BOOT, 3], [BOOT, 2], [BOOT, 4], [BOOT2, 1], [BOOT, 9], [BOOT, 9], [BOOT, 8], [BOOT2, 2], [BOOT2, 1]];
  const results = [];
  for (const step of [30000, -3600000, 0, 7]) {
    const h = harness();
    results.push(arrivals.map(([bootId, seq]) => { h.tick(step); return h.service.heartbeat(beat({ bootId, seq }), GW).result; }));
  }
  assert.deepEqual(results[0], ['stored', 'stale', 'stored', 'stored', 'stored', 'stale', 'stale', 'stored', 'stale']);
  for (const other of results.slice(1)) assert.deepEqual(other, results[0]);
});

test('a restored queue or a restarted API never blocks: a new run is stored at once with seq 1', () => {
  const h = harness();
  assert.deepEqual(h.service.heartbeat(beat({ seq: 2880, uptimeSeconds: 86400 }), GW), { result: 'stored' });
  // The queue file comes back from a backup (same epoch); the agent restarts with a new run id and counts from 1.
  h.tick(1000);
  assert.deepEqual(h.service.heartbeat(beat({ bootId: BOOT2, seq: 1, uptimeSeconds: 0, lastStowAgeSeconds: null, localOrthanc: null }), GW), { result: 'stored' });
  // The API restarts: its memory is empty, and the first valid beat of a run that has gone on for long is stored.
  const fresh = harness();
  assert.deepEqual(fresh.service.heartbeat(beat({ seq: 2881, uptimeSeconds: 86430 }), GW), { result: 'stored' });
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
  assert.deepEqual(h.service.heartbeat(beat(), GW), { result: 'stale' });
});

test('admin read: this institution only, newest contact first, No Contact after 180 s, answer is the explicit projection', async () => {
  const h = harness();
  h.service.heartbeat(beat(), GW);
  h.service.heartbeat(beat({ epoch: EPOCH2 }), GW_B);
  h.tick(10000);
  h.service.heartbeat(beat({ epoch: EPOCH2, bootId: BOOT2, uptimeSeconds: 20, queue: null, lastStowAgeSeconds: null,
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
  assert.throws(() => h.service.heartbeat(beat({ seq: 2, uptimeSeconds: 630 }), { ...GW, institution: 'inst-b' }),
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
  assert.deepEqual(h.service.heartbeat(beat({ epoch: epoch(0), seq: 2, uptimeSeconds: 630 }), GW), { result: 'stored' });
  assert.deepEqual(h.service.heartbeat(beat({ epoch: epoch(1), bootId: BOOT2 }), GW), { result: 'stored' }, 'a new run of a held key adds no row');
  assert.deepEqual(h.service.heartbeat(beat({ epoch: epoch(0) }), GW_B), { result: 'stored' }, 'another institution has its own bound');
  assert.equal((await h.service.status(ADMIN)).gateways.length, H.GATEWAY_HEARTBEAT_ROWS_PER_INSTITUTION);
});

test('a service-account label shows as the client name; any other label is shown as is, bounded', () => {
  assert.equal(H.gatewayDisplayName('service-account-gw-hallym'), 'gw-hallym');
  assert.equal(H.gatewayDisplayName('gw-x'), 'gw-x');
  assert.equal(H.gatewayDisplayName('y'.repeat(300)).length, 128);
});
