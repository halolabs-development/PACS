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
  const isolations = new Set(['isolated']), changes = [], sessions = [], events = [];
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
    authSession: { findMany: async ({ where }) => sessions.filter(s => s.sub === where.sub),
      count: async ({ where }) => sessions.filter(s => s.sub === where.sub).length,
      deleteMany: async ({ where }) => { const before = sessions.length; sessions.splice(0, sessions.length, ...sessions.filter(s => s.sid !== where.sid)); return { count: before - sessions.length }; } },
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
  let identityHook = null;
  const identity = sub => {
    if (identityHook) { const forced = identityHook(sub); if (forced !== undefined) return forced; }
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
    transactionWithRecords: async work => work(db, async (event, mutation) => { events.push(event); return mutation(); }),
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
  let factsMade = 0;
  const operatorFacts = institution => { const work = ledger.begin(); return {
    actor: { issuer: 'urn:kin:pacs:operator', subject: 'ops', id: '00000000-0000-4000-8000-000000000009' }, roles: ['admin'],
    rightsVersion: 0, institution, ip: null, sessionRef: null, requestId: '00000000-0000-4000-8000-00000000000a',
    surface: 'service:first-admin-designation',
    request: { work, requireCurrent: async () => {} } }; };
  const designate = (sub, institution) => service.designateFirstAdmin(sub, institution,
    { name: 'ops', reason: 'synthetic hospital request confirmed by phone' }, async () => { factsMade++; return operatorFacts(institution); });
  return { rows, audits, kcCalls, kc, db, service, controller, keys, adminA, call, writes: () => writes, designate, changes, sessions, events, factsMade: () => factsMade, kcOnly, identityOverride: f => { identityHook = f; } };
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
    assert.equal(w.factsMade(), 0, 'no refusal resolves (writes) the operator ledger identity');
    // A signed-in person is refused (the command never ends a member session as a service job); signed out, it proceeds.
    w.sessions.push({ sid: 'synthetic-sid', sub: 'waiting', auditRef: 'authref:00000000-0000-4000-8000-00000000000b', institution: null });
    await refused('waiting', C, 'FIRST_ADMIN_TARGET_SIGNED_IN', 'a signed-in account');
    w.sessions.length = 0;
    const first = await w.designate('waiting', C);
    assert.deepEqual([first.institution, first.roles, first.approvalState, first.enabled], [C, ['admin'], 'APPROVED', true]);
    const row = w.audits.filter(a => a.action === 'admin.user.approve');
    assert.equal(row.length, 1);
    assert.equal(row[0].actor, 'operator:ops');
    assert.deepEqual(JSON.parse(row[0].detail).operator, { by: 'ops', institution: C, reason: 'synthetic hospital request confirmed by phone' });
    assert.equal(w.changes.length, 1, 'one roster intent');
    // Every ledger event the command recorded is valid under the access-event contract (closed internal surface).
    const { parseAccessEvent } = require('../api/src/emr-contract/access-event.ts');
    assert.equal(w.events.length, 1);
    for (const event of w.events) parseAccessEvent(JSON.parse(JSON.stringify(event)));
    // Repeated or concurrent: the condition is read again under the institution lock; one administrator only.
    await refused('waiting', C, 'FIRST_ADMIN_EXISTS', 'the same command again');
    const realCount = w.db.memberRights.count;
    let calls = 0;
    w.db.memberRights.count = async args => (++calls === 1 ? 0 : realCount(args));
    await refused('waiting-2', C, 'FIRST_ADMIN_EXISTS', 'a second operator who read before the first committed');
    w.db.memberRights.count = realCount;
    // A sign-in that commits after the pre-check is seen under the member lock (session admission holds it): refused.
    const w4 = world();
    const realSessions = w4.db.authSession.count;
    let sessionReads = 0;
    w4.db.authSession.count = async args => (++sessionReads === 1 ? 0 : 1);
    await assert.rejects(w4.designate('waiting', C), e => e.getResponse().code === 'FIRST_ADMIN_TARGET_SIGNED_IN');
    assert.equal(w4.writes(), 0);
    assert.equal(w4.audits.length, 0, 'no failure audit');
    w4.db.authSession.count = realSessions;
    // The command's own (second) provider read of an existing member is checked for its groups too.
    const w5 = world();
    w5.rows.set('reader-c', { ...w5.rows.get('reader-a'), sub: 'reader-c', institution: C });
    let reads = 0;
    w5.identityOverride(sub => sub === 'reader-c' && ++reads > 1 ? { id: sub, username: sub, email: sub + '@example.test', emailVerified: true,
      firstName: 'S', lastName: sub, enabled: true, serviceAccountClientId: null, groups: [C, B], roles: [] } : undefined);
    await assert.rejects(w5.designate('reader-c', C), e => e.getResponse().code === 'FIRST_ADMIN_TARGET_CONFLICT');
    assert.equal(w5.writes(), 0);
    assert.equal(w5.audits.length, 0);
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

  // 9. The operator command itself (api/prisma/designate-first-admin.cjs, run as a process over synthetic stand-ins of
  // what it loads — tests/first_admin_command_fakes.cjs): its exit code and printed `designated` follow whether this
  // run's transaction committed. 1 = not designated; 0 = designated, roster confirmed; 2 = designated, roster
  // unconfirmed (--retry-roster); 3 = unknown. A failed cleanup is one line of its own and never changes the code.
  {
    const { spawnSync } = require('node:child_process'), os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-admin-command-'));
    const run = scenario => {
      const logFile = path.join(dir, (scenario || 'plain').replace(/,/g, '+') + '.jsonl');
      fs.writeFileSync(logFile, '');
      const env = { ...process.env, KIN_TEST_FIRST_ADMIN_SCENARIO: scenario, KIN_TEST_FIRST_ADMIN_LOG: logFile,
        DATABASE_URL: 'postgresql://synthetic.invalid/kin', KC_ADMIN_URL: 'https://synthetic-identity.example.test/admin',
        KC_REALM: 'kin', KC_ISSUER: process.env.KC_ISSUER, KC_CLIENT_ID: 'synthetic', KC_CLIENT_SECRET: 'synthetic',
        KIN_EMR_STATE_DIR: dir };
      const result = spawnSync(process.execPath, ['-r', path.join(root, 'tests/first_admin_command_fakes.cjs'),
        path.join(root, 'api/prisma/designate-first-admin.cjs'), '--institution', 'synthetic-hospital-c',
        '--subject', 'synthetic-first-admin', '--operator', 'ops', '--reason', 'synthetic hospital request'],
        { cwd: root, env, encoding: 'utf8', timeout: 60000 });
      const json = text => text.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
      return { code: result.status, out: json(result.stdout), errJson: json(result.stderr), stderr: result.stderr,
        steps: fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) };
    };
    const expect = (scenario, code, designated, label, more = () => {}) => {
      const r = run(scenario);
      const shown = [...r.out, ...r.errJson].map(o => o.designated);
      assert.equal(r.code, code, `${label}: exit ${r.code}\n${r.stderr}`);
      assert.deepEqual(shown, [designated], `${label}: designated ${JSON.stringify(shown)}\n${r.stderr}`);
      assert.ok(r.steps.includes('stop') && r.steps.includes('disconnect') || scenario.includes('start-fails'), label + ': cleanup ran');
      more(r);
      return r;
    };
    const retry = r => assert.match(r.stderr, /--retry-roster/);
    const noRetry = r => assert.doesNotMatch(r.stderr, /--retry-roster/);
    const untouched = (...steps) => r => { for (const step of steps) assert.ok(!r.steps.includes(step), step); noRetry(r); };
    // Not committed — 1, and nothing after it is attempted; no re-read decides it.
    expect('refused', 1, false, 'a refusal', r => {
      assert.equal(r.errJson[0].code, 'FIRST_ADMIN_EXISTS');
      untouched('operator-identity', 'transaction', 'reread-audit', 'lookup-change', 'send-roster')(r);
    });
    expect('start-fails', 1, false, 'the ledger did not start', r => assert.ok(!r.steps.includes('designate')));
    expect('fails-before-commit', 1, false, 'a failure before the transaction', untouched('transaction', 'reread-audit'));
    expect('callback-refused', 1, false, 'a refusal inside the transaction (rolled back)', r => {
      assert.equal(r.errJson[0].code, 'FIRST_ADMIN_EXISTS'); untouched('reread-audit', 'lookup-change')(r); });
    expect('not-committed', 1, false, 'COMMIT asked and known not committed', untouched('reread-audit', 'lookup-change'));
    // Committed: designated, whatever fails after (the code is 2 unless the roster is confirmed).
    expect('', 0, true, 'designated and roster confirmed', r => { assert.equal(r.out[0].roster, 'done'); noRetry(r); });
    expect('lookup-throws', 2, true, 'the roster-intent lookup threw after the commit', r => {
      assert.equal(r.out[0].version, 2); assert.equal(r.out[0].roster, 'unknown'); retry(r); });
    expect('roster-throws', 2, true, 'the roster send threw after the commit', retry);
    expect('roster-unknown', 2, true, 'the roster answer was lost', retry);
    // Settled after a failure (not seen returning): designated, and the roster is left to --retry-roster, which sends
    // each member's latest generation — this run's own generation is never re-sent over a later change.
    const settled = r => { assert.equal(r.out[0].version, 2); assert.equal(r.out[0].roster, 'unknown');
      assert.ok(!r.steps.includes('lookup-change') && !r.steps.includes('send-roster'), 'no roster sent'); retry(r); };
    expect('work-end-fails', 2, true, 'closing the request work threw after the commit', settled);
    expect('http-after-commit', 2, true, 'an HTTP-shaped error after the commit is not a refusal', settled);
    expect('http-after-commit,reread-fails', 2, true, 'after the commit, its audit row unreadable: still designated', r => {
      assert.equal(r.out[0].version, null); retry(r); });
    // The commit answer was lost: only this run's own audit row (by id) says it committed.
    expect('commit-lost', 2, true, 'a lost commit answer; this run\'s audit row is there', settled);
    expect('commit-lost-not-committed', 3, null, 'a lost commit answer and no audit row of this run (it may still commit)', retry);
    expect('commit-lost-not-committed,other-run-committed', 3, null, 'another run\'s approval of the person is not this run\'s', retry);
    expect('commit-lost,reread-fails', 3, null, 'a lost commit answer and an unreadable record', retry);
    // An approved member promoted to administrator: the change's audit row is admin.user.update, still this run's.
    expect('commit-lost,promoted', 2, true, 'a lost commit answer for a promotion; its update row is there', settled);
    expect('work-end-fails,promoted', 2, true, 'a promotion committed, then a later step threw', settled);
    // Writing the outcome throws at once: the exit code still says what was saved.
    for (const [scenario, code] of [['write-throws', 0], ['write-throws,commit-lost', 2], ['write-throws,roster-unknown', 2]]) {
      const r = run(scenario);
      assert.equal(r.code, code, `${scenario}: exit ${r.code}\n${r.stderr}`);
      assert.ok(r.steps.includes('stop') && r.steps.includes('disconnect'), scenario + ': cleanup ran');
    }
    // A failed cleanup is its own line and keeps the outcome.
    for (const [scenario, code, designated] of [['stop-fails', 0, true], ['stop-fails,roster-unknown', 2, true],
      ['stop-fails,refused', 1, false], ['disconnect-fails', 0, true], ['stop-fails,disconnect-fails,lookup-throws', 2, true]]) {
      expect(scenario, code, designated, 'cleanup failure: ' + scenario, r => assert.match(r.stderr, /cleanup failed|disconnect failed/i));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  process.stdout.write('Member institution scope contracts passed\n');
})().catch(e => { console.error(e); process.exitCode = 1; });
