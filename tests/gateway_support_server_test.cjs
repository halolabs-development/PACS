'use strict';
/* Gateway remote support on the API (api/src/gateway-support.ts rules, api/src/gateway-support.service.ts): only an admin
 * of the Gateway's own institution (restricted study scope refused) asks for diagnostics, a restart or an update to a held
 * version on one Gateway line (the full queueInstance of the own institution's heartbeat row); the request is audited
 * before the Gateway can see it, one open request per line; a Gateway sees and answers only requests bound to its own
 * credential, institution and queue; results follow one state rule (a late accepted never covers a final, a restart is
 * done only from another run); the diagnostics report is a closed shape within 256 KiB. No DB, credentials or network.
 */
require('./service_test_loader.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('/app/dist/gateway-support');
const { GatewayStatusService } = require('/app/dist/gateway-status.service');
const { GatewaySupportService } = require('/app/dist/gateway-support.service');
const { GATEWAY_SUPPORT_RESULT_ROUTE, gatewaySupportParser } = require('/app/dist/gateway-support-parser');

const EPOCH = '0f4b2c1a-1111-4222-8333-944455556666', EPOCH2 = '1f4b2c1a-1111-4222-8333-944455556666';
const BOOT = 'aa4b2c1a-1111-4222-8333-944455556666', BOOT2 = 'bb4b2c1a-1111-4222-8333-944455556666';
const GW = { sub: 'sub-gw-a', actor: 'service-account-gw-inst-a', roles: ['gateway'], institution: 'inst-a', kind: 'gateway' };
const GW_SAME_INST = { ...GW, sub: 'sub-gw-a2', actor: 'service-account-gw-inst-a2' };
const GW_B = { sub: 'sub-gw-b', actor: 'service-account-gw-inst-b', roles: ['gateway'], institution: 'inst-b', kind: 'gateway' };
const ADMIN = { sub: 'sub-admin', actor: 'SYN-admin', roles: ['admin'], institution: 'inst-a', kind: 'member' };
const ADMIN2 = { ...ADMIN, sub: 'sub-admin-2', actor: 'SYN-admin-2' };
const ADMIN_B = { sub: 'sub-admin-b', actor: 'SYN-admin-b', roles: ['admin'], institution: 'inst-b', kind: 'member' };
const TECH = { sub: 'sub-tech', actor: 'SYN-tech', roles: ['technician'], institution: 'inst-a', kind: 'member' };
const beat = (extra = {}) => ({ epoch: EPOCH, bootId: BOOT, seq: 1, version: '2026.11.2', uptimeSeconds: 600,
  queue: { waiting: 0, retry: 0, failed: 0 }, lastStowAgeSeconds: null, localOrthanc: null, ...extra });
const status = error => error?.getStatus?.() ?? error?.status;
const code = error => error?.getResponse?.()?.code;
const result = (extra = {}) => ({ epoch: EPOCH, bootId: BOOT, result: 'accepted', code: null, version: null,
  diagnostics: null, ...extra });

function report(rows = 1, logs = 1, forwards = 0) {
  return {
    format: 1, version: '2026.11.2', uptimeSeconds: 61,
    launcher: { current: 'builtin', previous: null, running: 'builtin', installing: false, last: null },
    config: { kinBaseUrl: 'https://kin.invalid', clientId: 'gw-syn', tlsVerify: true, byteBudget: 25165824, pollSeconds: 2,
      httpTimeoutSeconds: 30, stowTimeoutSeconds: 300, backoffBaseSeconds: 5, backoffMaxSeconds: 300, remoteSupport: true },
    settings: { known: true, revision: 3, routes: 1, compression: 'lossless' },
    localOrthanc: { answered: true, ageSeconds: 2 }, lastStowAgeSeconds: 40, dataFreeBytes: 1e9,
    queue: { counts: { complete: rows, not_routed: 1 }, total: rows + 1, omitted: 1,
      rows: Array.from({ length: rows }, (_, i) => ({ uid: `1.2.840.10008.99.${i}`, phase: 'complete', attempt: 0,
        errorCode: null, destinations: ['kin', '33333333-3333-4333-8333-333333333333'],
        forwards: Array.from({ length: forwards }, () => ({ destination: '33333333-3333-4333-8333-333333333333',
          phase: 'retry', attempt: 4, errorCode: 'other' })) })) },
    log: Array.from({ length: logs }, () => ({ at: '2026-11-20T00:00:00Z', event: 'study.retry', attempt: 2, error: 'announce_http' })),
  };
}

function harness({ restricted = false, auditFails = false, dir = null } = {}) {
  const audits = [];
  let gate = null;
  const studyAccess = {
    snapshot: async () => ({ policy: { restricted } }),
    unchanged: async () => { if (gate) await gate; },
  };
  const prisma = { auditLog: { create: async ({ data }) => { if (auditFails) throw new Error('audit down'); audits.push(data); } } };
  const heartbeats = new GatewayStatusService(studyAccess);
  const support = new GatewaySupportService(prisma, studyAccess, heartbeats);
  let now = Date.parse('2026-11-20T12:00:00.000Z');
  heartbeats.clock = () => now;
  support.clock = () => now;
  support.updateDir = () => dir ?? '';
  return { heartbeats, support, audits, setGate: g => { gate = g; }, tick: ms => { now += ms; } };
}

function updatesDir(versions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-updates-'));
  for (const v of versions) fs.writeFileSync(path.join(dir, `${v}.json`), JSON.stringify({ version: v }));
  fs.writeFileSync(path.join(dir, 'not-a-version.json'), '{}');
  fs.writeFileSync(path.join(dir, '2026.12.9.txt'), '{}');
  fs.writeFileSync(path.join(dir, '2026.12.8.json'), '');
  return dir;
}

test('the administrator body is closed: one of three actions, a version only (and always) for update', () => {
  assert.deepEqual(S.parseSupportRequest({ queueInstance: EPOCH, action: 'restart', version: null }),
    { queueInstance: EPOCH, action: 'restart', version: null });
  assert.equal(S.parseSupportRequest({ queueInstance: EPOCH, action: 'update', version: '2026.12.1' }).version, '2026.12.1');
  for (const body of [null, {}, { queueInstance: EPOCH, action: 'restart' }, { queueInstance: EPOCH, action: 'shell', version: null },
    { queueInstance: EPOCH.slice(0, 8), action: 'restart', version: null }, { queueInstance: EPOCH, action: 'update', version: null },
    { queueInstance: EPOCH, action: 'restart', version: '1' }, { queueInstance: EPOCH, action: 'update', version: '1.0; x' },
    { queueInstance: EPOCH, action: 'diagnostics', version: null, extra: 1 }])
    assert.throws(() => S.parseSupportRequest(body), S.GatewaySupportInputError, JSON.stringify(body));
});

test('an admin of the own institution asks once per line; the request is audited before a Gateway can see it', async () => {
  const h = harness();
  h.heartbeats.heartbeat(beat(), GW);
  const asked = await h.support.adminRequest({ queueInstance: EPOCH, action: 'diagnostics', version: null }, ADMIN);
  assert.equal(asked.request.state, 'requested');
  assert.equal(h.audits.length, 1);
  assert.equal(h.audits[0].action, 'gateway.support.request');
  assert.deepEqual(JSON.parse(h.audits[0].detail), { institution: 'inst-a', request: asked.request.id, gateway: 'gw-inst-a',
    queueInstance: EPOCH, action: 'diagnostics', version: null, at: '2026-11-20T12:00:00.000Z' });
  await assert.rejects(h.support.adminRequest({ queueInstance: EPOCH, action: 'restart', version: null }, ADMIN2),
    e => status(e) === 409 && code(e) === S.GATEWAY_SUPPORT_BUSY);
  const listed = await h.support.adminList(ADMIN);
  assert.deepEqual(listed.gateways.map(g => [g.gateway, g.queueInstance, g.version, g.contact, g.request.state]),
    [['gw-inst-a', EPOCH, '2026.11.2', 'recent', 'requested']]);
  assert.deepEqual(listed.updates, []);
  // The Gateway of another institution, and another queue of this Gateway, see nothing.
  assert.deepEqual(h.support.gatewayPoll({ epoch: EPOCH }, GW_B), { request: null });
  assert.deepEqual(h.support.gatewayPoll({ epoch: EPOCH2 }, GW), { request: null });
  assert.deepEqual(h.support.gatewayPoll({ epoch: EPOCH }, GW), { request: { id: asked.request.id, action: 'diagnostics', version: null } });
  // Delivered again until a result comes (an answer can be lost).
  assert.deepEqual(h.support.gatewayPoll({ epoch: EPOCH }, GW).request.id, asked.request.id);
  assert.equal((await h.support.adminList(ADMIN)).gateways[0].request.state, 'delivered');
});

test('who and which line: technicians, restricted admins, other institutions and unknown or shared lines are refused', async () => {
  const h = harness();
  h.heartbeats.heartbeat(beat(), GW);
  h.heartbeats.heartbeat(beat({ epoch: EPOCH2 }), GW_B);
  await assert.rejects(h.support.adminRequest({ queueInstance: EPOCH, action: 'restart', version: null }, TECH), e => status(e) === 403);
  await assert.rejects(h.support.adminList(TECH), e => status(e) === 403);
  await assert.rejects(harness({ restricted: true }).support.adminList(ADMIN), e => status(e) === 403 && code(e) === S.GATEWAY_SUPPORT_RESTRICTED);
  await assert.rejects(h.support.adminRequest({ queueInstance: EPOCH2, action: 'restart', version: null }, ADMIN),
    e => status(e) === 404 && code(e) === S.GATEWAY_SUPPORT_UNKNOWN_LINE);
  assert.deepEqual((await h.support.adminList(ADMIN_B)).gateways.map(g => g.queueInstance), [EPOCH2]);
  assert.throws(() => h.support.gatewayPoll({ epoch: EPOCH }, ADMIN), e => status(e) === 403);
  await assert.rejects(Promise.resolve().then(() => h.support.gatewayPoll({ epoch: EPOCH, other: 1 }, GW)), e => status(e) === 400);
  // Two credentials of the same institution sending one queue copy: the line is not one Gateway, so nothing is asked.
  h.heartbeats.heartbeat(beat({ bootId: BOOT2 }), GW_SAME_INST);
  await assert.rejects(h.support.adminRequest({ queueInstance: EPOCH, action: 'restart', version: null }, ADMIN),
    e => status(e) === 404);
  assert.equal(h.audits.length, 0);
});

test('two admins pressing at once make one request and one audit row; a failed audit sends nothing', async () => {
  const h = harness();
  h.heartbeats.heartbeat(beat(), GW);
  let open;
  h.setGate(new Promise(resolve => { open = resolve; }));
  const both = Promise.allSettled([h.support.adminRequest({ queueInstance: EPOCH, action: 'restart', version: null }, ADMIN),
    h.support.adminRequest({ queueInstance: EPOCH, action: 'diagnostics', version: null }, ADMIN2)]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.support.gatewayPoll({ epoch: EPOCH }, GW), { request: null }, 'nothing visible before the audit');
  open();
  const settled = await both;
  assert.deepEqual(settled.map(s => s.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(status(settled.find(s => s.status === 'rejected').reason), 409);
  assert.equal(h.audits.length, 1);
  const failing = harness({ auditFails: true });
  failing.heartbeats.heartbeat(beat(), GW);
  await assert.rejects(failing.support.adminRequest({ queueInstance: EPOCH, action: 'restart', version: null }, ADMIN));
  assert.deepEqual(failing.support.gatewayPoll({ epoch: EPOCH }, GW), { request: null });
  assert.equal((await failing.support.adminList(ADMIN)).gateways[0].request, null);
});

test('diagnostics: a closed report, kept for the admins of that institution; reports over 100 KiB fit', async () => {
  const h = harness();
  h.heartbeats.heartbeat(beat(), GW);
  const { request } = await h.support.adminRequest({ queueInstance: EPOCH, action: 'diagnostics', version: null }, ADMIN);
  h.support.gatewayPoll({ epoch: EPOCH }, GW);
  const big = report(200, 200, 5);
  const size = JSON.stringify(big).length;
  assert.ok(size > 100 * 1024 && size <= S.GATEWAY_DIAGNOSTICS_MAX_BYTES, String(size));
  // The result is bound to the caller's own credential and queue.
  assert.throws(() => h.support.gatewayResult(request.id, result({ result: 'done', diagnostics: big }), GW_B), e => status(e) === 404);
  assert.throws(() => h.support.gatewayResult(request.id, result({ result: 'done', diagnostics: big, epoch: EPOCH2 }), GW), e => status(e) === 404);
  assert.throws(() => h.support.gatewayResult(request.id, result({ result: 'done', diagnostics: big }), GW_SAME_INST), e => status(e) === 404);
  assert.throws(() => h.support.gatewayResult(request.id, result({ result: 'done' }), GW), e => status(e) === 400);
  assert.deepEqual(h.support.gatewayResult(request.id, result({ result: 'done', diagnostics: big }), GW), { result: 'stored', state: 'done' });
  assert.deepEqual(h.support.gatewayResult(request.id, result({ result: 'done', diagnostics: big }), GW), { result: 'same', state: 'done' });
  const got = await h.support.adminDiagnostics(request.id, ADMIN2);
  assert.deepEqual(got.report, big);
  assert.equal(got.gateway, 'gw-inst-a');
  await assert.rejects(h.support.adminDiagnostics(request.id, ADMIN_B), e => status(e) === 404);
  await assert.rejects(h.support.adminDiagnostics(request.id, TECH), e => status(e) === 403);
  assert.equal((await h.support.adminList(ADMIN)).gateways[0].request.diagnostics, true);
  // A new request on the line lets the old report go (one request per line is kept).
  const next = await h.support.adminRequest({ queueInstance: EPOCH, action: 'restart', version: null }, ADMIN);
  await assert.rejects(h.support.adminDiagnostics(request.id, ADMIN), e => status(e) === 404);
  assert.equal(next.request.state, 'requested');
});

test('the diagnostics shape is closed and bounded', () => {
  assert.doesNotThrow(() => S.parseDiagnostics(report()));
  const bad = [];
  const edit = fn => { const r = report(); fn(r); bad.push(r); };
  edit(r => { r.extra = 1; });
  edit(r => { delete r.log; });
  edit(r => { r.config.clientSecret = 'x'; });
  edit(r => { r.queue.rows[0].patientName = 'X'; });
  edit(r => { r.queue.rows[0].uid = 'PATIENT^NAME'; });
  edit(r => { r.queue.rows[0].errorCode = 'announce HTTP 500'; });
  edit(r => { r.log[0].uid = '1.2.3'; });
  edit(r => { r.log[0].note = 'free text'; });
  edit(r => { r.log[0].error = 'Patient Name'; });
  edit(r => { r.launcher.current = '../x'; });
  edit(r => { r.queue.rows = Array.from({ length: 201 }, () => r.queue.rows[0]); });
  edit(r => { r.log = Array.from({ length: 201 }, () => r.log[0]); });
  edit(r => { r.config.kinBaseUrl = 'javascript:alert(1)'; });
  for (const r of bad) assert.throws(() => S.parseDiagnostics(r), S.GatewaySupportInputError, JSON.stringify(r).slice(0, 120));
  const tooBig = report(200, 200, 9);
  for (const row of tooBig.queue.rows) {
    row.uid = '1.' + '9'.repeat(62);
    row.destinations = Array.from({ length: 10 }, () => '33333333-3333-4333-8333-333333333333');
  }
  assert.ok(JSON.stringify(tooBig).length > S.GATEWAY_DIAGNOSTICS_MAX_BYTES);
  assert.throws(() => S.parseDiagnostics(tooBig), S.GatewaySupportInputError);
});

test('a restart: accepted by one run, done only from another; a late accepted never covers the final', async () => {
  const h = harness();
  h.heartbeats.heartbeat(beat(), GW);
  const { request } = await h.support.adminRequest({ queueInstance: EPOCH, action: 'restart', version: null }, ADMIN);
  h.support.gatewayPoll({ epoch: EPOCH }, GW);
  assert.equal(h.support.gatewayResult(request.id, result(), GW).state, 'accepted');
  assert.deepEqual(h.support.gatewayPoll({ epoch: EPOCH }, GW), { request: null }, 'accepted is not delivered again');
  await assert.rejects(h.support.adminRequest({ queueInstance: EPOCH, action: 'diagnostics', version: null }, ADMIN), e => status(e) === 409);
  assert.throws(() => h.support.gatewayResult(request.id, result({ result: 'done' }), GW), e => status(e) === 400 && e.getResponse().field === 'bootId');
  assert.equal(h.support.gatewayResult(request.id, result({ result: 'done', bootId: BOOT2 }), GW).state, 'done');
  assert.deepEqual(h.support.gatewayResult(request.id, result({ bootId: BOOT }), GW), { result: 'same', state: 'done' });
  assert.deepEqual(h.support.gatewayResult(request.id, result({ result: 'done', bootId: BOOT2 }), GW), { result: 'same', state: 'done' });
  assert.throws(() => h.support.gatewayResult(request.id, result({ result: 'refused', code: 'remote_support_off' }), GW), e => status(e) === 409);
  assert.throws(() => h.support.gatewayResult(request.id, result({ result: 'installed' }), GW), e => status(e) === 400);
  assert.equal((await h.support.adminList(ADMIN)).gateways[0].request.state, 'done');
});

test('an update: only a held version, the Gateway gets the file, the final result is the launcher\'s', async () => {
  const dir = updatesDir(['2026.12.1', '2026.12.10', '2026.12.2']);
  const h = harness({ dir });
  h.heartbeats.heartbeat(beat(), GW);
  assert.deepEqual((await h.support.adminList(ADMIN)).updates, ['2026.12.10', '2026.12.2', '2026.12.1']);
  for (const version of ['2026.12.3', '2026.12.8', '2026.12.9'])
    await assert.rejects(h.support.adminRequest({ queueInstance: EPOCH, action: 'update', version }, ADMIN),
      e => status(e) === 400 && code(e) === S.GATEWAY_SUPPORT_UNKNOWN_VERSION);
  const { request } = await h.support.adminRequest({ queueInstance: EPOCH, action: 'update', version: '2026.12.2' }, ADMIN);
  assert.deepEqual(h.support.gatewayPoll({ epoch: EPOCH }, GW).request, { id: request.id, action: 'update', version: '2026.12.2' });
  assert.deepEqual(JSON.parse((await h.support.gatewayBundle('2026.12.2', GW)).toString()), { version: '2026.12.2' });
  await assert.rejects(h.support.gatewayBundle('2026.12.3', GW), e => status(e) === 404);
  await assert.rejects(h.support.gatewayBundle('../2026.12.2', GW), e => status(e) === 404);
  await assert.rejects(h.support.gatewayBundle('2026.12.2', ADMIN), e => status(e) === 403);
  assert.equal(h.support.gatewayResult(request.id, result({ version: '2026.12.2' }), GW).state, 'accepted');
  assert.throws(() => h.support.gatewayResult(request.id, result({ result: 'installed', version: '2026.12.1' }), GW), e => status(e) === 400);
  assert.throws(() => h.support.gatewayResult(request.id, result({ result: 'rolled_back', version: '2026.12.2' }), GW), e => status(e) === 400);
  assert.equal(h.support.gatewayResult(request.id, result({ result: 'rolled_back', code: 'not_ready', version: '2026.12.2', bootId: BOOT2 }), GW).state, 'rolled_back');
  const row = (await h.support.adminList(ADMIN)).gateways[0].request;
  assert.deepEqual([row.state, row.code, row.version], ['rolled_back', 'not_ready', '2026.12.2']);
  // The line is free again; a refused update (wrong signature on the host) ends with its code.
  const again = await h.support.adminRequest({ queueInstance: EPOCH, action: 'update', version: '2026.12.10' }, ADMIN);
  assert.equal(h.support.gatewayResult(again.request.id, result({ result: 'refused', code: 'bad_signature', version: '2026.12.10' }), GW).state, 'refused');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('memory only: another API process knows no request (the audit row stays); the result route parser has room', async () => {
  const h = harness();
  h.heartbeats.heartbeat(beat(), GW);
  const { request } = await h.support.adminRequest({ queueInstance: EPOCH, action: 'restart', version: null }, ADMIN);
  const fresh = harness();
  fresh.heartbeats.heartbeat(beat({ seq: 2 }), GW);
  assert.equal((await fresh.support.adminList(ADMIN)).gateways[0].request, null);
  assert.throws(() => fresh.support.gatewayResult(request.id, result(), GW), e => status(e) === 404);
  assert.ok(GATEWAY_SUPPORT_RESULT_ROUTE.test(`/api/gateway/support/${request.id}`));
  for (const other of ['/api/gateway/support', '/api/admin/gateway-support', '/api/gateway/support/x/y'])
    assert.ok(!GATEWAY_SUPPORT_RESULT_ROUTE.test(other), other);
  assert.ok(S.GATEWAY_SUPPORT_BODY_LIMIT > S.GATEWAY_DIAGNOSTICS_MAX_BYTES * 1.5);
  let passed = false;
  gatewaySupportParser()({ method: 'GET', originalUrl: `/api/gateway/support/${request.id}` }, {}, () => { passed = true; });
  assert.ok(passed, 'other methods are left to the default parser');
});
