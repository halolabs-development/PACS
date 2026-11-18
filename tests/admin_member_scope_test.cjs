'use strict';
// A hospital administrator manages only the members of their own institution (plus the shared waiting room of
// self sign-ups without an institution). Every member route asks the same server-side rule; a member of another
// institution answers like an unknown id. Also: the reset-mail failure says why, Revoke Approval keeps the member
// in their institution, and an administrator can correct a member's email and name.
const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs');
const root = path.resolve(__dirname, '..'), ts = require(path.join(root, 'api/node_modules/typescript'));
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, experimentalDecorators: true,
    emitDecoratorMetadata: true, esModuleInterop: true }, fileName: filename,
}).outputText, filename);
const { AdminService } = require('../api/src/admin.service.ts');
const { AdminController } = require('../api/src/admin.controller.ts');
const { SigningKeyAdminController } = require('../api/src/signing-key-admin.controller.ts');
const { KeycloakService, RosterWriteFailure } = require('../api/src/keycloak.service.ts');
const { createRequestContext } = require('../api/src/emr-runtime/request-context.ts');
const { createRequestIngress } = require('../api/src/emr-runtime/request-ingress.ts');
const { IncomingMessage, ServerResponse } = require('node:http');
const { Socket } = require('node:net');

process.env.KC_ISSUER = 'https://synthetic-identity.example.test/auth/realms/kin';
const A = 'synthetic-hospital-a', B = 'synthetic-hospital-b', C = 'synthetic-hospital-c';

function world() {
  const rows = new Map();
  const put = (sub, institution, extra = {}) => rows.set(sub, { sub, username: sub, email: sub + '@example.test',
    name: 'Synthetic ' + sub, emailVerified: true, approved: institution !== null, suspended: false, institution,
    roles: institution === null ? [] : ['radiologist'], version: 1, ...extra });
  put('admin-a', A, { roles: ['admin'] });
  put('reader-a', A);
  put('reader-b', B);
  put('waiting', null);
  put('waiting-2', null);
  put('revoked', null, { suspended: true });
  put('isolated', null);
  const kcOnly = { 'kc-pending': [], 'kc-b': [B], 'kc-two': [A, B], 'kc-c-group': [C], 'kc-service': [] };
  const isolations = new Set(['isolated']), changes = [];
  const audits = [], kcCalls = [];
  let writes = 0;
  const db = {
    memberRights: {
      findUnique: async ({ where }) => rows.get(where.sub) ? { ...rows.get(where.sub) } : null,
      findMany: async ({ where }) => [...rows.values()].filter(r => !where?.sub?.in || where.sub.in.includes(r.sub)).map(r => ({ ...r })),
      create: async ({ data }) => { writes++; rows.set(data.sub, { version: 1, ...data }); return { ...rows.get(data.sub) }; },
      count: async ({ where }) => [...rows.values()].filter(r => r.institution === where.institution && r.approved === where.approved
        && r.suspended === where.suspended && r.roles.includes(where.roles.has)).length,
      updateMany: async ({ where, data }) => {
        const row = rows.get(where.sub);
        if (!row || (where.version !== undefined && row.version !== where.version)) return { count: 0 };
        writes++;
        const { version, newAuthAfter, ...fields } = data;
        Object.assign(row, fields, { version: row.version + 1 });
        return { count: 1 };
      },
    },
    authSession: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    memberIsolation: { findUnique: async ({ where }) => isolations.has(where.sub) ? { sub: where.sub } : null },
    auditLog: { create: async ({ data }) => { audits.push(data); return { id: audits.length }; }, findFirst: async () => null,
      findMany: async ({ where }) => audits.filter(a => a.target === where.target && where.action.in.includes(a.action)).reverse() },
    providerChange: { create: async ({ data }) => { writes++; changes.push({ id: changes.length + 1, ...data }); return changes.at(-1); },
      findMany: async () => [], findFirst: async () => null,
      updateMany: async ({ where, data }) => { const row = changes.find(c => c.id === where.id); if (row) Object.assign(row, data); return { count: row ? 1 : 0 }; } },
    $executeRaw: async () => 0,
    $queryRaw: async () => [{ boundary: new Date(), id: null }],
  };
  db.$transaction = async work => work(db);
  const identity = sub => {
    const row = rows.get(sub);
    const groups = row ? (row.institution ? [row.institution] : []) : kcOnly[sub];
    if (!groups) return null;
    return { id: sub, username: sub, email: row ? row.email : sub + '@example.test', emailVerified: true,
      firstName: 'Synthetic', lastName: sub, enabled: true, serviceAccountClientId: sub === 'kc-service' ? 'synthetic-client' : null, groups, roles: [] };
  };
  // As KeycloakService.listUsers: service accounts never reach the member list.
  const all = () => [...new Set([...rows.keys(), ...Object.keys(kcOnly)])].map(identity).filter(u => !u.serviceAccountClientId);
  const kc = {
    institutions: async () => [A, B, C],
    getUser: async id => identity(id),
    listUsers: async page => {
      const users = all();
      return { page, pageSize: 25, total: users.length, pendingCount: users.filter(u => !u.groups.length).length,
        users: users.slice((page - 1) * 25, page * 25), realmUsers: users };
    },
    createUser: async user => { kcCalls.push(['create', user]); return identity(user.username) ?? { id: user.username, ...user, emailVerified: false, groups: [], roles: [] }; },
    setGroups: async (...a) => { kcCalls.push(['groups', ...a]); },
    setRoles: async (...a) => { kcCalls.push(['roles', ...a]); },
    setEnabled: async (...a) => { kcCalls.push(['enabled', ...a]); },
    resetPassword: async (...a) => { kcCalls.push(['reset', ...a]); },
    mailSettings: async () => ({ configured: true }),
    updateIdentity: async (...a) => { kcCalls.push(['identity', ...a]); return { state: 'done', outcome: 'http_204' }; },
  };
  const ledger = { begin: () => ({
    resolveRequestIdentity: async () => '00000000-0000-4000-8000-000000000001',
    transactionWithRecords: async work => work(db, async (event, mutation) => mutation()),
    end() {},
  }) };
  const service = new AdminService(db, kc, null, { publishCredentials() {} });
  const requests = createRequestContext(createRequestIngress({ proxyPeers: [] }), ledger);
  const controller = new AdminController(service, null, requests.source);
  const keys = new SigningKeyAdminController(db, requests.source, { manage: async () => { kcCalls.push(['key']); } });
  const adminA = { sub: 'admin-a', actor: 'admin-a@example.test', roles: ['admin'], institution: A, kind: 'member' };
  const call = async (route, method, run, who = adminA) => {
    const req = Object.assign(new IncomingMessage(new Socket()), who), res = new ServerResponse(req);
    await requests.capture.capture(req, res, { issuer: process.env.KC_ISSUER, subject: who.sub, roles: who.roles,
      rightsVersion: 1, institution: who.institution, binding: { method: 'bearer', sessionRef: null } },
      { method, route, purpose: 'clinical' }, async () => {});
    try { return await run(req); } finally { res.emit('finish'); }
  };
  const operatorFacts = institution => { const work = ledger.begin(); return { surface: 'operator:first-admin',
    actor: { issuer: 'urn:kin:pacs:operator', subject: 'ops', id: '00000000-0000-4000-8000-000000000009' }, roles: ['admin'],
    rightsVersion: 0, institution, ip: null, sessionRef: null, requestId: '00000000-0000-4000-8000-00000000000a',
    request: { work, requireCurrent: async () => {} } }; };
  const designate = (sub, institution) => service.designateFirstAdmin(sub, institution,
    { name: 'ops', reason: 'synthetic hospital request confirmed by phone' }, operatorFacts(institution));
  return { rows, audits, kcCalls, kc, db, service, controller, keys, adminA, call, writes: () => writes, designate, changes };
}

const status = code => error => { assert.equal(error?.getStatus?.(), code, String(error?.message)); return true; };
const sameAsUnknown = error => { assert.equal(error?.getStatus?.(), 404); assert.equal(error.message, '사용자를 찾을 수 없습니다'); return true; };

(async () => {
  // 1. The list holds the administrator's own institution and the waiting room only; counts follow.
  {
    const w = world();
    const list = await w.controller.list('1', w.adminA);
    const ids = list.users.map(u => u.id).sort();
    assert.deepEqual(ids, ['admin-a', 'isolated', 'kc-pending', 'reader-a', 'revoked', 'waiting', 'waiting-2'], 'no other institution in the list');
    assert.equal(list.total, 7);
    assert.equal(list.pendingCount, 5, 'the pending badge counts what this administrator can act on');
    assert.ok(!ids.includes('kc-c-group'), 'a member of a group without an administrator is not the waiting room');
    assert.ok(!JSON.stringify(list).includes('reader-b'), 'nothing of another institution in the answer');
    assert.ok(!JSON.stringify(list).includes('kc-two'), 'a member of two groups is nobody\'s to manage');
    const noInstitution = { ...w.adminA, institution: null };
    await assert.rejects(w.controller.list('1', noInstitution), status(403), 'an administrator without an institution manages nobody');
  }

  // 2. Writes to another institution's member answer like an unknown id and change nothing.
  {
    const w = world();
    const attempts = [
      ['suspend', id => w.call('admin/users/:id', 'PATCH', req => w.controller.patch(id, { enabled: false, version: 1 }, req))],
      ['revoke', id => w.call('admin/users/:id', 'PATCH', req => w.controller.patch(id, { approvalState: 'PENDING', version: 1 }, req))],
      ['roles', id => w.call('admin/users/:id', 'PATCH', req => w.controller.patch(id, { roles: ['clinician'], version: 1 }, req))],
      ['temp', id => w.controller.resetPassword(id, { mode: 'temp' }, w.adminA)],
      ['email', id => w.controller.resetPassword(id, { mode: 'email' }, w.adminA)],
    ];
    for (const [name, run] of attempts) {
      for (const id of ['reader-b', 'kc-b', 'kc-two', 'no-such-member']) {
        const before = w.writes();
        await assert.rejects(run(id), sameAsUnknown, `${name} on ${id}`);
        assert.equal(w.writes(), before, `${name} on ${id} writes nothing`);
      }
    }
    assert.deepEqual(w.kcCalls, [], 'no provider call for an out-of-scope member');
    assert.equal(w.rows.get('reader-b').suspended, false);
  }

  // 3. Assigning an institution: only the administrator's own (create, approve, move).
  {
    const w = world();
    await assert.rejects(w.call('admin/users', 'POST', req => w.controller.create({ username: 'new-member', email: 'new@example.test',
      firstName: 'New', lastName: 'Member', institution: B, roles: ['radiologist'] }, req)), status(400));
    assert.deepEqual(w.kcCalls, [], 'refused before any provider account is created');
    await assert.rejects(w.call('admin/users/:id', 'PATCH', req => w.controller.patch('waiting', {
      approvalState: 'APPROVED', institution: B, roles: ['radiologist'], version: 1 }, req)), status(400));
    await assert.rejects(w.call('admin/users/:id', 'PATCH', req => w.controller.patch('reader-a', {
      institution: B, version: 1 }, req)), status(400), 'a member is not sent to another institution');
    const approved = await w.call('admin/users/:id', 'PATCH', req => w.controller.patch('waiting', {
      approvalState: 'APPROVED', institution: A, roles: ['radiologist'], version: 1 }, req));
    assert.equal(approved.institution, A);
    assert.equal(approved.approvalState, 'APPROVED');
    const fromProvider = await w.call('admin/users/:id', 'PATCH', req => w.controller.patch('kc-pending', {
      approvalState: 'APPROVED', institution: A, roles: ['technician'] }, req));
    assert.equal(fromProvider.institution, A, 'a waiting sign-up without a rights row is approved into the own institution');
  }

  // 4. Revoke Approval does what its button says: PENDING, suspended, institution and roles cleared (the waiting room).
  {
    const w = world();
    const revoked = await w.call('admin/users/:id', 'PATCH', req => w.controller.patch('reader-a', { approvalState: 'PENDING', version: 1 }, req));
    assert.deepEqual([revoked.approvalState, revoked.enabled, revoked.institution, revoked.roles], ['PENDING', false, null, []]);
    const adminB = { ...w.adminA, sub: 'admin-b', actor: 'admin-b@example.test', institution: B };
    assert.ok((await w.controller.list('1', adminB)).users.some(u => u.id === 'reader-a'), 'a released member is in the waiting room');
    const taken = await w.call('admin/users/:id', 'PATCH', req => w.controller.patch('reader-a', {
      approvalState: 'APPROVED', institution: B, roles: ['radiologist'], version: revoked.version }, req), adminB);
    assert.equal(taken.institution, B);
    assert.equal(taken.enabled, false, 'still suspended after re-approval: Activate is a separate step, as the button says');
    await assert.rejects(w.call('admin/users/:id', 'PATCH', req => w.controller.patch('reader-a', { enabled: true, version: taken.version }, req)),
      sameAsUnknown, 'once another institution has the member, the first one cannot touch them');
  }

  // 4b. Races: a member another institution takes meanwhile is unknown here, never a conflict and never a password.
  {
    const w = world();
    const adminB = { ...w.adminA, sub: 'admin-b', actor: 'admin-b@example.test', institution: B };
    const claim = () => Object.assign(w.rows.get('waiting'), { institution: B, approved: true, roles: ['radiologist'], version: 2 });
    const realFind = w.db.memberRights.findUnique;
    let reads = 0;
    w.db.memberRights.findUnique = async args => { if (args.where.sub === 'waiting' && ++reads === 2) claim(); return realFind(args); };
    await assert.rejects(w.call('admin/users/:id', 'PATCH', req => w.controller.patch('waiting', {
      approvalState: 'APPROVED', institution: A, roles: ['radiologist'], version: 1 }, req)), sameAsUnknown,
      'B approved the waiting member between the pre-read and the locked read');
    w.db.memberRights.findUnique = realFind;
    Object.assign(w.rows.get('waiting'), { institution: null, approved: false, roles: [], version: 1 });
    w.kc.resetPassword = async (id, mode) => { if (mode === 'temp') claim(); };
    await assert.rejects(w.controller.resetPassword('waiting', { mode: 'temp' }, w.adminA), sameAsUnknown,
      'the temporary password of a member B took during the provider write is not shown to A');
    Object.assign(w.rows.get('waiting'), { institution: null, approved: false, roles: [], version: 1 });
    w.kc.resetPassword = async (id, mode) => { if (mode === 'email') claim(); };
    await assert.rejects(w.controller.resetPassword('waiting', { mode: 'email' }, w.adminA), sameAsUnknown,
      'a member B took during the send is not shown to A');
    w.kc.getUser = async () => { throw new RosterWriteFailure({ state: 'unknown', outcome: 'http_500' }); };
    await assert.rejects(w.controller.resetPassword('reader-a', { mode: 'email' }, w.adminA), error => {
      assert.equal(error.getResponse().code, 'MEMBER_DIRECTORY_UNAVAILABLE');
      assert.doesNotMatch(error.getResponse().message, /Keycloak|roster|http_/i);
      return true;
    });
    assert.ok(adminB);
  }

  // 5. Own members are still managed as before.
  {
    const w = world();
    const suspended = await w.call('admin/users/:id', 'PATCH', req => w.controller.patch('reader-a', { enabled: false, version: 1 }, req));
    assert.equal(suspended.enabled, false);
    const temp = await w.controller.resetPassword('reader-a', { mode: 'temp' }, w.adminA);
    assert.ok(temp.temporaryPassword);
    const mail = await w.controller.resetPassword('waiting', { mode: 'email' }, w.adminA);
    assert.equal(mail.id, 'waiting', 'the waiting room can receive a reset mail');
  }

  // 6. Signing keys: the administrator's own members and the waiting room (a revoked doctor's keys here stay
  //    revocable); another institution's member answers like an unknown id.
  {
    const w = world();
    assert.equal((await w.call('admin/users/:id/signing-key', 'GET', req => w.keys.read('waiting', req))).subject, 'waiting');
    for (const id of ['reader-b', 'no-such-member']) {
      await assert.rejects(w.call('admin/users/:id/signing-key', 'GET', req => w.keys.read(id, req)), status(404), id);
      await assert.rejects(w.call('admin/users/:id/signing-key', 'POST', req => w.keys.change(id,
        { action: 'provision', expectedKid: null, reason: 'synthetic' }, req)), status(404), id);
    }
    assert.ok(!w.kcCalls.some(c => c[0] === 'key'), 'no key change reaches another institution');
    const own = await w.call('admin/users/:id/signing-key', 'GET', req => w.keys.read('reader-a', req));
    assert.equal(own.subject, 'reader-a');
  }

  // 7. The reset mail failure says why, without the provider's internal words.
  {
    const w = world();
    w.kc.resetPassword = async (id, mode) => { if (mode === 'email') throw new RosterWriteFailure({ state: 'unknown', outcome: 'http_500' }); };
    w.kc.mailSettings = async () => ({ configured: false });
    await assert.rejects(w.controller.resetPassword('reader-a', { mode: 'email' }, w.adminA), error => {
      assert.equal(error.getStatus(), 503);
      const body = error.getResponse();
      assert.equal(body.code, 'RESET_MAIL_NOT_CONFIGURED');
      assert.doesNotMatch(body.message, /Keycloak|roster|http_/i);
      assert.match(body.message, /Temp Password/);
      return true;
    });
    w.kc.mailSettings = async () => ({ configured: true });
    await assert.rejects(w.controller.resetPassword('reader-a', { mode: 'email' }, w.adminA), error => {
      assert.equal(error.getResponse().code, 'RESET_MAIL_FAILED');
      assert.doesNotMatch(error.getResponse().message, /Keycloak|roster|http_/i);
      return true;
    });
    w.kc.mailSettings = async () => { throw new Error('synthetic read failure'); };
    await assert.rejects(w.controller.resetPassword('reader-a', { mode: 'email' }, w.adminA), error => {
      assert.equal(error.getResponse().code, 'RESET_MAIL_FAILED', 'an unknown cause is never reported as missing settings');
      return true;
    });
    w.kc.resetPassword = async () => { throw new TypeError('fetch failed'); };
    w.kc.mailSettings = async () => ({ configured: true });
    await assert.rejects(w.controller.resetPassword('reader-a', { mode: 'email' }, w.adminA), error => {
      assert.equal(error.getResponse().code, 'RESET_MAIL_FAILED', 'a transport failure also gets the page message');
      return true;
    });
    w.rows.get('reader-a').email = '';
    await assert.rejects(w.controller.resetPassword('reader-a', { mode: 'email' }, w.adminA), error => {
      assert.equal(error.getStatus(), 400);
      assert.equal(error.getResponse().code, 'RESET_MAIL_NO_ADDRESS');
      return true;
    });
    assert.ok(w.audits.some(a => a.action === 'admin.user.reset-password.failed'), 'a failed reset mail is recorded');
    // The provider client itself reads the realm's mail settings without exposing them.
    const provider = new KeycloakService();
    provider.adm = async route => { assert.equal(route, ''); return { smtpServer: { host: 'smtp.example.test', from: '' } }; };
    assert.deepEqual(await provider.mailSettings(), { configured: false });
    provider.adm = async () => ({ smtpServer: { host: 'smtp.example.test', from: 'no-reply@example.test', password: '**********' } });
    assert.deepEqual(await provider.mailSettings(), { configured: true });
    for (const unreadable of [null, '', 'not json', []]) {
      provider.adm = async () => unreadable;
      await assert.rejects(provider.mailSettings(), status(503), 'an unreadable realm is unknown, not "not configured"');
    }
  }

  // 8. The first administrator of an institution without one: an operator command, never an HTTP route.
  {
    const { sendRecordedRoster } = require('../api/src/member-rights-import.ts');
    assert.equal(typeof AdminController.prototype.designateFirstAdmin, 'undefined', 'no controller route designates');
    const w = world();
    const refused = async (sub, institution, code, label) => {
      const before = w.writes(), audits = w.audits.length;
      await assert.rejects(w.designate(sub, institution), error => { assert.equal(error.getResponse().code ?? null, code, label); return true; }, label);
      assert.equal(w.writes(), before, label + ': nothing written');
      assert.equal(w.audits.length, audits, label + ': no audit row');
    };
    await refused('waiting', A, 'FIRST_ADMIN_EXISTS', 'an institution with an active administrator');
    await refused('reader-b', C, 'FIRST_ADMIN_TARGET_CONFLICT', 'another institution\'s member');
    await refused('kc-two', C, 'FIRST_ADMIN_TARGET_CONFLICT', 'a member of several groups');
    await refused('kc-b', C, 'FIRST_ADMIN_TARGET_CONFLICT', 'provider groups naming another institution');
    await refused('revoked', C, 'FIRST_ADMIN_TARGET_SUSPENDED', 'a suspended account');
    await refused('isolated', C, 'FIRST_ADMIN_TARGET_ISOLATED', 'an isolated account');
    await assert.rejects(w.designate('kc-service', C), status(403), 'a service account');
    await assert.rejects(w.designate('waiting', 'not-an-institution'), status(400), 'an unknown institution');
    assert.equal(w.writes(), 0);
    const first = await w.designate('waiting', C);
    assert.deepEqual([first.institution, first.roles, first.approvalState, first.enabled], [C, ['admin'], 'APPROVED', true]);
    const row = w.audits.filter(a => a.action === 'admin.user.approve');
    assert.equal(row.length, 1);
    assert.equal(row[0].actor, 'operator:ops');
    assert.deepEqual(JSON.parse(row[0].detail).operator, { by: 'ops', institution: C, reason: 'synthetic hospital request confirmed by phone' });
    assert.equal(w.changes.length, 1, 'one roster intent');
    // Repeated or concurrent: the condition is read again under the institution lock; one administrator only.
    await refused('waiting', C, 'FIRST_ADMIN_EXISTS', 'the same command again');
    const realCount = w.db.memberRights.count;
    let calls = 0;
    w.db.memberRights.count = async args => (++calls === 1 ? 0 : realCount(args));
    await refused('waiting-2', C, 'FIRST_ADMIN_EXISTS', 'a second operator who read before the first committed');
    w.db.memberRights.count = realCount;
    assert.equal(w.audits.filter(a => a.action.startsWith('admin.user.')).length, 1, 'one success audit, no failure audit');
    // The roster is sent from the recorded audit of that generation, as --retry-roster recovers it.
    const sent = [], provider = { setGroups: async (...a) => sent.push(['groups', ...a]), setRoles: async (...a) => sent.push(['roles', ...a]) };
    assert.equal(await sendRecordedRoster(w.db, provider, w.changes[0]), 'done');
    assert.deepEqual(sent, [['groups', 'waiting', [C]], ['roles', 'waiting', ['admin']]]);
    // An approved member of the institution keeps their roles and gains admin; a KC-only member of that one group may be named.
    const w2 = world();
    w2.rows.set('reader-c', { ...w2.rows.get('reader-a'), sub: 'reader-c', institution: C });
    const promoted = await w2.designate('reader-c', C);
    assert.deepEqual(promoted.roles.sort(), ['admin', 'radiologist']);
    const w3 = world();
    assert.equal((await w3.designate('kc-c-group', C)).institution, C);
  }

  process.stdout.write('Member institution scope contracts passed\n');
})().catch(e => { console.error(e); process.exitCode = 1; });
