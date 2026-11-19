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
  const audits = [], kcCalls = [], raws = [];
  let identities = 0;
  let writes = 0;
  const db = {
    memberRights: {
      findUnique: async ({ where }) => rows.get(where.sub) ? { ...rows.get(where.sub) } : null,
      findMany: async ({ where }) => [...rows.values()].filter(r => (!where?.sub?.in || where.sub.in.includes(r.sub))
        && (where?.institution === undefined || (r.institution === where.institution && r.approved === where.approved
          && r.suspended === where.suspended && r.roles.includes(where.roles.has)))).map(r => ({ ...r })),
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
    $executeRaw: async (strings, ...values) => { raws.push([strings.join('?'), ...values]); return 0; },
    $queryRaw: async () => [{ boundary: new Date(), id: null }],
  };
  db.$transaction = async work => work(db);
  let identityHook = null, standingHook = null;
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
    // As KeycloakService.memberStanding: groups and effective realm roles (a composite's included), read strictly.
    memberStanding: async id => {
      if (standingHook) { const forced = await standingHook(id); if (forced !== undefined) return forced; }
      const user = identity(id);
      if (!user) throw new RosterWriteFailure({ state: 'void', outcome: 'http_404' });
      return { groups: user.groups, effectiveRoles: user.roles };
    },
  };
  const ledger = { begin: () => ({
    resolveRequestIdentity: async () => '00000000-0000-4000-8000-000000000001',
    resolveIdentity: async () => { identities++; return '00000000-0000-4000-8000-00000000000' + (identities % 10); },
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
  const replace = (from, to, institution, operator = { name: 'ops', reason: 'synthetic hospital request confirmed by phone' }) =>
    service.replaceSoleAdmin(from, to, institution, operator, ledger.begin());
  return { rows, audits, kcCalls, kc, db, service, controller, keys, adminA, call, writes: () => writes, designate, changes, sessions, events, factsMade: () => factsMade, kcOnly, identityOverride: f => { identityHook = f; },
    replace, raws, identities: () => identities, put, standingOverride: f => { standingHook = f; } };
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

  // 10. Replacing an institution's sole administrator (one who left while their rights are live): an operator command,
  // never an HTTP route. Decided on the rights rows read again under the institution lock; one transaction suspends the
  // predecessor (institution and roles kept, every session ended) and approves the successor (current roles plus admin,
  // every session ended), with the operator, institution, reason and pair in both audit rows and one roster intent.
  {
    const { parseAccessEvent } = require('../api/src/emr-contract/access-event.ts');
    assert.equal(typeof AdminController.prototype.replaceSoleAdmin, 'undefined', 'no controller route replaces');
    const D = 'synthetic-hospital-d';
    const setup = () => {
      const w = world();
      w.kc.institutions = async () => [A, B, C, D];
      w.put('admin-d', D, { roles: ['admin'] });
      w.put('reader-d', D);
      w.put('colleague-d', D);
      w.put('suspended-admin-d', D, { roles: ['admin'], suspended: true });
      w.kcOnly['kc-d-group'] = [D];
      return w;
    };
    const refused = async (w, from, to, code, label, institution = D, operator) => {
      const before = w.writes(), audits = w.audits.length, ids = w.identities(), sessions = w.sessions.length;
      const rows = JSON.stringify([...w.rows.values()]);
      await assert.rejects(w.replace(from, to, institution, operator), error => {
        if (typeof code === 'number') assert.equal(error.getStatus?.(), code, label + ': ' + error.message);
        else assert.equal(error.getResponse?.().code ?? null, code, label + ': ' + error.message);
        return true;
      }, label);
      assert.equal(w.writes(), before, label + ': nothing written');
      assert.equal(w.audits.length, audits, label + ': no audit row (success or failure)');
      assert.equal(w.identities(), ids, label + ': no ledger identity resolved');
      assert.equal(w.sessions.length, sessions, label + ': no session ended');
      assert.equal(JSON.stringify([...w.rows.values()]), rows, label + ': rights unchanged');
      assert.equal(w.changes.length, 0, label + ': no roster intent');
    };
    {
      const w = setup();
      w.sessions.push({ sid: 'sid-admin-d', sub: 'admin-d', auditRef: 'authref:00000000-0000-4000-8000-0000000000d1', institution: D });
      // The predecessor is X's approved, active administrator, and the only one.
      await refused(w, 'admin-a', 'reader-d', 'REPLACE_ADMIN_FROM_NOT_ADMIN', 'a predecessor of another institution');
      await refused(w, 'no-such-member', 'reader-d', 'REPLACE_ADMIN_FROM_NOT_ADMIN', 'a predecessor that does not exist');
      await refused(w, 'colleague-d', 'reader-d', 'REPLACE_ADMIN_FROM_NOT_ADMIN', 'a predecessor who is not an administrator');
      await refused(w, 'suspended-admin-d', 'reader-d', 'REPLACE_ADMIN_FROM_NOT_ADMIN', 'a suspended predecessor');
      await refused(w, 'waiting', 'reader-d', 'REPLACE_ADMIN_FROM_NOT_ADMIN', 'a waiting member as predecessor');
      // The successor: a person of X or the waiting room, usable, not suspended or isolated.
      await refused(w, 'admin-d', 'no-such-member', 404, 'a successor that does not exist');
      await refused(w, 'admin-d', 'reader-b', 'REPLACE_ADMIN_TO_CONFLICT', 'a successor of another institution');
      await refused(w, 'admin-d', 'kc-b', 'REPLACE_ADMIN_TO_CONFLICT', 'a successor whose provider group is another institution');
      await refused(w, 'admin-d', 'kc-two', 'REPLACE_ADMIN_TO_CONFLICT', 'a successor of several groups');
      await refused(w, 'admin-d', 'kc-service', 403, 'a service account');
      await refused(w, 'admin-d', 'revoked', 'REPLACE_ADMIN_TO_SUSPENDED', 'a suspended successor');
      await refused(w, 'admin-d', 'isolated', 'REPLACE_ADMIN_TO_ISOLATED', 'an isolated successor');
      w.identityOverride(sub => sub === 'reader-d' ? { id: sub, username: sub, email: sub + '@example.test', emailVerified: true,
        firstName: 'S', lastName: sub, enabled: false, serviceAccountClientId: null, groups: [D], roles: [] } : undefined);
      await refused(w, 'admin-d', 'reader-d', 'REPLACE_ADMIN_TO_UNUSABLE', 'a successor disabled in the provider');
      w.identityOverride(sub => sub === 'reader-d' ? { id: sub, username: sub, email: sub + '@example.test', emailVerified: true,
        firstName: 'S', lastName: sub, enabled: true, serviceAccountClientId: null, groups: [D], roles: ['gateway'] } : undefined);
      await refused(w, 'admin-d', 'reader-d', 'REPLACE_ADMIN_TO_UNUSABLE', 'a gateway identity');
      w.identityOverride(() => undefined);
      // A gateway role reached through a composite is in the effective roles the token will carry.
      w.standingOverride(sub => sub === 'reader-d' ? { groups: [D], effectiveRoles: ['radiologist', 'gateway'] } : undefined);
      await refused(w, 'admin-d', 'reader-d', 'REPLACE_ADMIN_TO_UNUSABLE', 'a gateway role through a composite');
      // An unreadable standing is a failed read, never "no groups".
      w.standingOverride(sub => { if (sub === 'kc-d-group') throw new RosterWriteFailure({ state: 'unknown', outcome: 'unreadable' }); });
      await assert.rejects(w.replace('admin-d', 'kc-d-group', D), RosterWriteFailure, 'an unreadable standing refuses');
      assert.deepEqual([w.writes(), w.changes.length, w.identities()], [0, 0, 0]);
      w.standingOverride(() => undefined);
      // A successor whose email or username is the predecessor's would act under the same key: the predecessor's
      // private drafts and history would answer to them.
      for (const [field, value] of [['email', 'admin-d@example.test'], ['email', 'ADMIN-D@example.test'], ['username', 'admin-d']]) {
        w.identityOverride(sub => sub === 'reader-d' ? { id: sub, username: 'reader-d', email: 'reader-d@example.test', emailVerified: true,
          firstName: 'S', lastName: sub, enabled: true, serviceAccountClientId: null, groups: [D], roles: [], [field]: value } : undefined);
        await refused(w, 'admin-d', 'reader-d', 'REPLACE_ADMIN_TO_SHARES_KEY', `a successor ${field} ${value}`);
      }
      w.identityOverride(() => undefined);
      // The input itself.
      await refused(w, 'admin-d', 'admin-d', 400, 'the predecessor as successor');
      await refused(w, 'admin-d', 'reader-d', 400, 'an unknown institution', 'not-an-institution');
      await refused(w, 'admin-d', 'reader-d', 400, 'a blank institution', ' ');
      for (const reason of [undefined, '', '   ', 'x'.repeat(501), 'request\nconfirmed', '\nrequest', 'request\n'])
        await refused(w, 'admin-d', 'reader-d', 400, 'reason ' + JSON.stringify(reason), D, { name: 'ops', reason });
      for (const name of [undefined, '', 'two words', 'x'.repeat(65)])
        await refused(w, 'admin-d', 'reader-d', 400, 'operator ' + JSON.stringify(name), D, { name, reason: 'synthetic request' });
      for (const [from, to] of [['', 'reader-d'], ['admin-d', ''], [' admin-d', 'reader-d'], [null, 'reader-d'], ['admin-d', 'r'.repeat(257)]])
        await refused(w, from, to, 400, `subjects ${JSON.stringify([from, to])}`);
      // Not the sole administrator: the other one manages the institution from the screen.
      w.put('second-admin-d', D, { roles: ['admin', 'radiologist'] });
      await refused(w, 'admin-d', 'reader-d', 'REPLACE_ADMIN_NOT_SOLE', 'another active administrator');
    }
    // Replaced: both members change in one transaction, every session of both ends, a third member's session lives.
    {
      const w = setup();
      w.sessions.push({ sid: 'sid-from-1', sub: 'admin-d', auditRef: 'authref:00000000-0000-4000-8000-0000000000d1', institution: D },
        { sid: 'sid-from-2', sub: 'admin-d', auditRef: 'authref:00000000-0000-4000-8000-0000000000d2', institution: D },
        { sid: 'sid-to', sub: 'reader-d', auditRef: 'authref:00000000-0000-4000-8000-0000000000d3', institution: D },
        { sid: 'sid-other', sub: 'colleague-d', auditRef: 'authref:00000000-0000-4000-8000-0000000000d4', institution: D });
      const result = await w.replace('admin-d', 'reader-d', D);
      assert.deepEqual([result.id, result.institution, result.approvalState, result.enabled, [...result.roles].sort()],
        ['reader-d', D, 'APPROVED', true, ['admin', 'radiologist']]);
      const from = w.rows.get('admin-d');
      assert.deepEqual([from.suspended, from.approved, from.institution, from.roles, from.version], [true, true, D, ['admin'], 2],
        'the predecessor is suspended as the screen\'s Suspend does: institution and roles kept');
      assert.deepEqual(w.sessions.map(s => s.sid), ['sid-other'], 'both members\' sessions end; another member\'s session lives');
      const memberRows = w.audits.filter(a => a.action.startsWith('admin.user.'));
      assert.deepEqual(memberRows.map(a => [a.action, a.target]), [['admin.user.suspend', 'admin-d'], ['admin.user.update', 'reader-d']]);
      for (const row of memberRows) {
        assert.equal(row.actor, 'operator:ops');
        assert.deepEqual(JSON.parse(row.detail).operator, { by: 'ops', institution: D, reason: 'synthetic hospital request confirmed by phone',
          replaced: { from: 'admin-d', to: 'reader-d' } });
      }
      assert.equal(w.audits.filter(a => a.action === 'auth.logout').length, 3);
      assert.deepEqual(w.changes.map(c => [c.target, c.generation]), [['reader-d', 2]], 'one roster intent: the successor\'s');
      assert.equal(w.identities(), 3, 'the operator and both members, resolved once inside the transaction');
      // Every ledger event is valid under the access-event contract: two rights changes, three service isolations.
      assert.equal(w.events.length, 5);
      for (const event of w.events) parseAccessEvent(JSON.parse(JSON.stringify(event)));
      const ends = w.events.filter(e => e.action === 'auth.logout');
      assert.deepEqual(ends.map(e => [e.surface, e.executor, e.auth.endCause, e.cause]),
        Array(3).fill(['service:sole-admin-replacement', 'service', 'isolation', 'service-job']));
      assert.deepEqual(ends.map(e => e.session.value), ['authref:00000000-0000-4000-8000-0000000000d1',
        'authref:00000000-0000-4000-8000-0000000000d2', 'authref:00000000-0000-4000-8000-0000000000d3']);
      // Locks: the institution, then both members in one fixed order; the boundary is read after them.
      const locks = w.raws.filter(r => /pg_advisory_xact_lock/.test(r[0]));
      assert.equal(locks[0][1], 0x4b494e46, 'the institution lock first');
      assert.equal(locks[0][2], D);
      assert.equal(locks.slice(1).filter(r => r[1] === 0x4b494e4d).length, 2, 'then both member locks');
      // Again: the predecessor is no longer X's administrator.
      w.changes.length = 0;
      await refused(w, 'admin-d', 'colleague-d', 'REPLACE_ADMIN_FROM_NOT_ADMIN', 'the same predecessor again');
      // The successor now administers X from the screen: another institution's member stays unknown to them.
      const adminD = { sub: 'reader-d', actor: 'reader-d@example.test', roles: ['admin', 'radiologist'], institution: D, kind: 'member' };
      await assert.rejects(w.call('admin/users/:id', 'PATCH', req => w.controller.patch('reader-b', { enabled: false, version: 1 }, req), adminD), sameAsUnknown);
      const list = await w.controller.list('1', adminD);
      assert.ok(list.users.some(u => u.id === 'admin-d' && u.enabled === false), 'the suspended predecessor is in the successor\'s list');
    }
    // A waiting successor gets admin only; a provider-only member of X's group is registered and approved.
    {
      const w = setup();
      const waiting = await w.replace('admin-d', 'waiting', D);
      assert.deepEqual([waiting.institution, waiting.roles, waiting.approvalState], [D, ['admin'], 'APPROVED']);
      assert.equal(w.audits.find(a => a.target === 'waiting').action, 'admin.user.approve');
      const w2 = setup();
      assert.equal((await w2.replace('admin-d', 'kc-d-group', D)).institution, D);
    }
    // Same predecessor, two different successors at once: the second read the rows before the first committed, and is
    // refused on the rows read again under the institution lock. Only one replacement is applied.
    {
      const w = setup();
      const stale = { ...w.rows.get('admin-d') };
      await w.replace('admin-d', 'reader-d', D);
      const writes = w.writes(), audits = w.audits.length, ids = w.identities(), colleague = JSON.stringify(w.rows.get('colleague-d'));
      const realFind = w.db.memberRights.findUnique, realMany = w.db.memberRights.findMany;
      let preRead = true;
      w.db.memberRights.findUnique = async args => (preRead && args.where.sub === 'admin-d' ? { ...stale } : realFind(args));
      w.db.memberRights.findMany = async args => (preRead && args.where?.institution === D ? [{ sub: 'admin-d' }] : realMany(args));
      const realLock = w.db.$executeRaw;
      w.db.$executeRaw = async (strings, ...values) => { if (/pg_advisory_xact_lock/.test(strings.join(''))) preRead = false; return realLock(strings, ...values); };
      await assert.rejects(w.replace('admin-d', 'colleague-d', D), e => e.getResponse().code === 'REPLACE_ADMIN_FROM_NOT_ADMIN');
      assert.equal(w.writes(), writes); assert.equal(w.audits.length, audits); assert.equal(w.identities(), ids);
      assert.equal(JSON.stringify(w.rows.get('colleague-d')), colleague, 'the losing successor is untouched');
      assert.deepEqual(w.changes.map(c => c.target), ['reader-d']);
    }
    // A successor row changed between the read and the locks: refused, nothing written (re-run reads it again).
    {
      const w = setup();
      const realLock = w.db.$executeRaw;
      w.db.$executeRaw = async (strings, ...values) => {
        if (/pg_advisory_xact_lock/.test(strings.join('')) && values[0] === 0x4b494e46) w.rows.get('reader-d').version = 7;
        return realLock(strings, ...values);
      };
      await assert.rejects(w.replace('admin-d', 'reader-d', D), e => e.getResponse().code === 'MEMBER_VERSION_CONFLICT',
        'a successor changed meanwhile');
      assert.deepEqual([w.writes(), w.audits.length, w.identities(), w.changes.length], [0, 0, 0, 0]);
      assert.equal(w.rows.get('admin-d').suspended, false, 'the predecessor is untouched too');
      const w2 = setup();
      const realLock2 = w2.db.$executeRaw;
      w2.db.$executeRaw = async (strings, ...values) => {
        if (/pg_advisory_xact_lock/.test(strings.join('')) && values[0] === 0x4b494e46 && !w2.rows.get('kc-d-group'))
          w2.put('kc-d-group', null);
        return realLock2(strings, ...values);
      };
      await assert.rejects(w2.replace('admin-d', 'kc-d-group', D), e => e.getResponse().code === 'MEMBER_VERSION_CONFLICT',
        'a row registered meanwhile for a successor observed without one');
      assert.equal(w2.changes.length, 0);
      assert.equal(w2.rows.get('admin-d').suspended, false);
    }
    // The screen's member changes take the same institution lock before the member lock.
    {
      const w = world();
      await w.call('admin/users/:id', 'PATCH', req => w.controller.patch('reader-a', { enabled: false, version: 1 }, req));
      const locks = w.raws.filter(r => /pg_advisory_xact_lock/.test(r[0]));
      assert.deepEqual(locks.map(r => r[1]), [0x4b494e46, 0x4b494e4d], 'the institution lock, then the member lock');
      assert.equal(locks[0][2], A);
    }
  }

  // 11. The replacement command itself (api/prisma/replace-sole-admin.cjs, over the same stand-ins): the exit codes and
  // their meaning are the first-administrator command's, printed as `replaced`; the run's own committed change is the
  // successor's approval — never the predecessor's suspension row of the same run.
  {
    const { spawnSync } = require('node:child_process'), os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replace-admin-command-'));
    const run = (scenario, args = ['--institution', 'synthetic-hospital-c', '--from', 'synthetic-departed-admin',
      '--to', 'synthetic-first-admin', '--operator', 'ops', '--reason', 'synthetic hospital request']) => {
      const logFile = path.join(dir, (scenario || 'plain').replace(/,/g, '+') + '.jsonl');
      fs.writeFileSync(logFile, '');
      const env = { ...process.env, KIN_TEST_FIRST_ADMIN_SCENARIO: scenario, KIN_TEST_FIRST_ADMIN_LOG: logFile,
        DATABASE_URL: 'postgresql://synthetic.invalid/kin', KC_ADMIN_URL: 'https://synthetic-identity.example.test/admin',
        KC_REALM: 'kin', KC_ISSUER: process.env.KC_ISSUER, KC_CLIENT_ID: 'synthetic', KC_CLIENT_SECRET: 'synthetic',
        KIN_EMR_STATE_DIR: dir };
      const result = spawnSync(process.execPath, ['-r', path.join(root, 'tests/first_admin_command_fakes.cjs'),
        path.join(root, 'api/prisma/replace-sole-admin.cjs'), ...args], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
      const json = text => text.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
      return { code: result.status, out: json(result.stdout), errJson: json(result.stderr), stderr: result.stderr,
        steps: fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) };
    };
    const expect = (scenario, code, replaced, label, more = () => {}) => {
      const r = run(scenario);
      const shown = [...r.out, ...r.errJson].map(o => o.replaced);
      assert.equal(r.code, code, `${label}: exit ${r.code}\n${r.stderr}`);
      assert.deepEqual(shown, [replaced], `${label}: replaced ${JSON.stringify(shown)}\n${r.stderr}`);
      assert.ok([...r.out, ...r.errJson].every(o => !('designated' in o)), label + ': printed as replaced');
      assert.ok(r.steps.includes('stop') && r.steps.includes('disconnect') || scenario.includes('start-fails'), label + ': cleanup ran');
      more(r);
    };
    const retry = r => assert.match(r.stderr, /--retry-roster/);
    const noRetry = r => assert.doesNotMatch(r.stderr, /--retry-roster/);
    // Usage: five flags, each once, all with values — anything else ends 1 before anything runs.
    for (const args of [[], ['--institution', 'x'], ['--institution', 'x', '--from', 'a', '--to', 'b', '--operator', 'ops', '--reason'],
      ['--institution', 'x', '--from', 'a', '--from', 'b', '--operator', 'ops', '--reason', 'r'],
      ['--institution', 'x', '--from', 'a', '--to', 'b', '--operator', 'ops', '--why', 'r'],
      ['--institution', 'x', '--from', 'a', '--to', 'b', '--subject', 'ops', '--reason', 'r'],
      // A name every object inherits is no flag.
      ['--institution', 'x', '--from', 'a', '--to', 'b', '--operator', 'ops', 'constructor', 'r'],
      ['--institution', 'x', '--from', 'a', '--to', 'b', '__proto__', 'ops', '--reason', 'r'],
      ['--institution', 'x', '--from', 'a', 'toString', 'b', '--operator', 'ops', '--reason', 'r']]) {
      const r = run('', args);
      assert.equal(r.code, 1, 'usage ' + JSON.stringify(args));
      assert.deepEqual(r.steps, [], 'nothing runs on a usage error');
    }
    expect('refused', 1, false, 'a refusal', r => {
      assert.equal(r.errJson[0].code, 'REPLACE_ADMIN_NOT_SOLE');
      for (const step of ['operator-identity', 'transaction', 'reread-audit', 'lookup-change', 'send-roster']) assert.ok(!r.steps.includes(step), step);
      noRetry(r);
    });
    expect('start-fails', 1, false, 'the ledger did not start', r => assert.ok(!r.steps.includes('replace')));
    expect('callback-refused', 1, false, 'a refusal under the locks (rolled back)', r => {
      assert.equal(r.errJson[0].code, 'REPLACE_ADMIN_FROM_NOT_ADMIN'); assert.ok(!r.steps.includes('operator-identity')); noRetry(r); });
    expect('not-committed', 1, false, 'COMMIT asked and known not committed', noRetry);
    expect('', 0, true, 'replaced and roster confirmed', r => {
      assert.equal(r.out[0].subject, 'synthetic-first-admin'); assert.equal(r.out[0].roster, 'done'); noRetry(r); });
    expect('roster-unknown', 2, true, 'the roster answer was lost', retry);
    expect('lookup-throws', 2, true, 'the roster-intent lookup threw after the commit', retry);
    // A lost commit answer: the successor's own approval row of this run decides; the predecessor's row never does.
    expect('commit-lost', 2, true, 'a lost commit answer; this run\'s successor row is there', r => {
      assert.equal(r.out[0].subject, 'synthetic-first-admin'); assert.equal(r.out[0].version, 2);
      assert.ok(!r.steps.includes('send-roster'), 'no roster sent'); retry(r); });
    expect('commit-lost-not-committed', 3, null, 'a lost commit answer and no row of this run', retry);
    expect('commit-lost,reread-fails', 3, null, 'a lost commit answer and an unreadable record', retry);
    expect('stop-fails', 0, true, 'a cleanup failure keeps the outcome', r => assert.match(r.stderr, /cleanup failed/i));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 12. An operator command beside the running API writes its failure spool in a directory of its own run, and imports
  // each finished run's spool exactly once (claimed by one rename); an unfinished run's spool is never touched.
  {
    const os = require('node:os');
    const { importFinishedSpools, closeRunSpool } = require('../api/src/emr-runtime/operator-runtime.ts');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-spool-'));
    const write = (dir, text) => { fs.mkdirSync(path.join(base, dir), { recursive: true }); fs.writeFileSync(path.join(base, dir, 'failure-spool.jsonl'), text); };
    fs.writeFileSync(path.join(base, 'failure-spool.jsonl'), 'legacy\n');
    write('run-finished', 'finished\n'); fs.writeFileSync(path.join(base, 'run-finished', 'closed'), '');
    write('run-unfinished', 'unfinished\n');
    write('run-own', '');
    const seen = [];
    // As the real replay: every record imported, then the spool file emptied.
    const importer = async directory => { const file = path.join(directory, 'failure-spool.jsonl');
      seen.push(fs.readFileSync(file, 'utf8')); fs.truncateSync(file, 0); return 1; };
    // Two commands start together: each finished spool is imported once.
    const counts = await Promise.all([importFinishedSpools(base, 'run-own', importer), importFinishedSpools(base, 'run-other', importer)]);
    assert.deepEqual(seen.sort(), ['finished\n', 'legacy\n']);
    assert.equal(counts[0] + counts[1], 2);
    assert.deepEqual(fs.readdirSync(base).sort(), ['run-own', 'run-unfinished'], 'imported spools removed; unfinished and own kept');
    // A failed import puts the claimed spool back as it was, and the start fails.
    write('run-later', 'later\n'); fs.writeFileSync(path.join(base, 'run-later', 'closed'), '');
    await assert.rejects(importFinishedSpools(base, 'run-own', async () => { throw new Error('synthetic database outage'); }), /outage/);
    assert.ok(fs.existsSync(path.join(base, 'run-later', 'closed')) && fs.readFileSync(path.join(base, 'run-later', 'failure-spool.jsonl'), 'utf8') === 'later\n');
    fs.writeFileSync(path.join(base, 'failure-spool.jsonl'), 'legacy again\n');
    await assert.rejects(importFinishedSpools(base, 'run-own', async () => { throw new Error('synthetic database outage'); }), /outage/);
    assert.equal(fs.readFileSync(path.join(base, 'failure-spool.jsonl'), 'utf8'), 'legacy again\n', 'the earlier layout\'s file is put back');
    assert.ok(!fs.readdirSync(base).some(name => name.startsWith('claim-')), 'no claim left behind');
    // Closing a run: empty — removed; with records — marked closed for the next run.
    closeRunSpool(path.join(base, 'run-own'));
    assert.ok(!fs.existsSync(path.join(base, 'run-own')));
    write('run-kept', 'kept\n'); closeRunSpool(path.join(base, 'run-kept'));
    assert.ok(fs.existsSync(path.join(base, 'run-kept', 'closed')));
    fs.rmSync(path.join(base, 'run-kept'), { recursive: true, force: true });
    fs.rmSync(path.join(base, 'run-later'), { recursive: true, force: true });
    fs.rmSync(path.join(base, 'failure-spool.jsonl'), { force: true });
    // The real spool replay: an incomplete last record is set aside as `.partial` — kept (never deleted with the spool).
    const { FailureSpool } = require('../api/src/emr-runtime/journal-file.ts');
    const record = JSON.stringify({ id: '00000000-0000-4000-8000-0000000000f1', operationId: null, eventId: null,
      at: new Date().toISOString(), cause: 'capacity' });
    write('run-torn', record + '\n{"id":"torn'); fs.writeFileSync(path.join(base, 'run-torn', 'closed'), '');
    const replayed = [];
    const real = async directory => new FailureSpool(directory).replay(async r => { replayed.push(r.id); });
    assert.equal(await importFinishedSpools(base, 'run-own', real), 1);
    assert.deepEqual(replayed, ['00000000-0000-4000-8000-0000000000f1']);
    const kept = fs.readdirSync(base).filter(name => name.startsWith('kept-'));
    assert.equal(kept.length, 1, 'the spool with an incomplete record is kept');
    assert.equal(fs.readFileSync(path.join(base, kept[0], 'failure-spool.jsonl.partial'), 'utf8'), '{"id":"torn');
    // A claim whose process has ended is claimed again and imported; one of a live process (this one) is left alone.
    write('claim-999999-abandoned', record + '\n');
    write(`claim-${process.pid}-in-progress`, record + '\n');
    replayed.length = 0;
    assert.equal(await importFinishedSpools(base, 'run-own', real), 1);
    assert.deepEqual(replayed, ['00000000-0000-4000-8000-0000000000f1']);
    assert.ok(!fs.existsSync(path.join(base, 'claim-999999-abandoned')));
    assert.ok(fs.existsSync(path.join(base, `claim-${process.pid}-in-progress`)), 'a live claim is not taken over');
    fs.rmSync(base, { recursive: true, force: true });
  }

  process.stdout.write('Member institution scope contracts passed\n');
})().catch(e => { console.error(e); process.exitCode = 1; });
