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
      findMany: async ({ where }) => audits.filter(a => (where.target?.in ? where.target.in.includes(a.target) : a.target === where.target)
        && where.action.in.includes(a.action)).reverse() },
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
    transactionWithRecords: async work => {
      const out = await work(db, async (event, mutation) => { events.push(event); return mutation(); });
      // A test's commit outcome after the work returned (Change Name / Email: a lost commit answer).
      if (commitHook) await commitHook();
      return out;
    },
    end() {},
  }) };
  let commitHook = null;
  const service = new AdminService(db, kc, null, { publishCredentials() {} });
  const requests = createRequestContext(createRequestIngress({ proxyPeers: [] }), ledger);
  const controller = new AdminController(service, null, requests.source);
  const keys = new SigningKeyAdminController(db, requests.source, { manage: async () => { kcCalls.push(['key']); } });
  const adminA = { sub: 'admin-a', actor: 'admin-a@example.test', roles: ['admin'], institution: A, kind: 'member' };
  // `current`: the admitted request's recheck of its caller's authorization (AuthService.bindCurrentAuthorization).
  const call = async (route, method, run, who = adminA, current = async () => {}) => {
    const req = Object.assign(new IncomingMessage(new Socket()), who), res = new ServerResponse(req);
    await requests.capture.capture(req, res, { issuer: process.env.KC_ISSUER, subject: who.sub, roles: who.roles,
      rightsVersion: 1, institution: who.institution, binding: { method: 'bearer', sessionRef: null } },
      { method, route, purpose: 'clinical' }, current);
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
    replace, raws, identities: () => identities, put, standingOverride: f => { standingHook = f; },
    commitOutcome: f => { commitHook = f; }, ledger,
    // The reset route through the request context, as AuthGuard admits it.
    reset: (id, body, who = adminA, current) => call('admin/users/:id/reset-password', 'POST', req => controller.resetPassword(id, body, req), who, current) };
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
      ['temp', id => w.reset(id, { mode: 'temp' }, w.adminA)],
      ['email', id => w.reset(id, { mode: 'email' }, w.adminA)],
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
    await assert.rejects(w.reset('waiting', { mode: 'temp' }, w.adminA), sameAsUnknown,
      'the temporary password of a member B took during the provider write is not shown to A');
    Object.assign(w.rows.get('waiting'), { institution: null, approved: false, roles: [], version: 1 });
    w.kc.resetPassword = async (id, mode) => { if (mode === 'email') claim(); };
    await assert.rejects(w.reset('waiting', { mode: 'email' }, w.adminA), sameAsUnknown,
      'a member B took during the send is not shown to A');
    w.kc.getUser = async () => { throw new RosterWriteFailure({ state: 'unknown', outcome: 'http_500' }); };
    await assert.rejects(w.reset('reader-a', { mode: 'email' }, w.adminA), error => {
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
    const temp = await w.reset('reader-a', { mode: 'temp' }, w.adminA);
    assert.ok(temp.temporaryPassword);
    const mail = await w.reset('waiting', { mode: 'email' }, w.adminA);
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
    await assert.rejects(w.reset('reader-a', { mode: 'email' }, w.adminA), error => {
      assert.equal(error.getStatus(), 503);
      const body = error.getResponse();
      assert.equal(body.code, 'RESET_MAIL_NOT_CONFIGURED');
      assert.doesNotMatch(body.message, /Keycloak|roster|http_/i);
      assert.match(body.message, /Temp Password/);
      return true;
    });
    w.kc.mailSettings = async () => ({ configured: true });
    await assert.rejects(w.reset('reader-a', { mode: 'email' }, w.adminA), error => {
      assert.equal(error.getResponse().code, 'RESET_MAIL_FAILED');
      assert.doesNotMatch(error.getResponse().message, /Keycloak|roster|http_/i);
      return true;
    });
    w.kc.mailSettings = async () => { throw new Error('synthetic read failure'); };
    await assert.rejects(w.reset('reader-a', { mode: 'email' }, w.adminA), error => {
      assert.equal(error.getResponse().code, 'RESET_MAIL_FAILED', 'an unknown cause is never reported as missing settings');
      return true;
    });
    w.kc.resetPassword = async () => { throw new TypeError('fetch failed'); };
    w.kc.mailSettings = async () => ({ configured: true });
    await assert.rejects(w.reset('reader-a', { mode: 'email' }, w.adminA), error => {
      assert.equal(error.getResponse().code, 'RESET_MAIL_FAILED', 'a transport failure also gets the page message');
      return true;
    });
    w.rows.get('reader-a').email = '';
    await assert.rejects(w.reset('reader-a', { mode: 'email' }, w.adminA), error => {
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

  // 7b. Create Member with a username or email that already has an account says so (409), creates nothing and records
  //     no half-made member; any other provider failure of the create request keeps its earlier answer.
  {
    const { MemberExists } = require('../api/src/keycloak.service.ts');
    // The provider client: only the create request's own 409 is "already exists"; the field is the one its words name.
    const provider = new KeycloakService();
    provider.secret = 'synthetic';
    provider.token = { value: 'synthetic-token', exp: Date.now() + 3600_000 };
    const realFetch = global.fetch;
    const answers = [
      [409, JSON.stringify({ errorMessage: 'User exists with same username' }), 'username'],
      [409, JSON.stringify({ errorMessage: 'User exists with same email' }), 'email'],
      [409, JSON.stringify({ errorMessage: 'User exists with same username or email' }), null],
      [409, JSON.stringify({ errorMessage: 'toString' }), null],
      [409, '', null],
      [409, 'not json', null],
    ];
    try {
      for (const [code, body, field] of answers) {
        const seen = [];
        global.fetch = async (url, init) => { seen.push(init.method); return new Response(body || null, { status: code }); };
        await assert.rejects(provider.createUser({ username: 'dup', email: 'dup@example.test', firstName: 'D', lastName: 'Up' }),
          error => { assert.ok(error instanceof MemberExists, body); assert.equal(error.field, field, body); return true; });
        assert.deepEqual(seen, ['POST'], 'nothing is read or changed after a refused create');
      }
      for (const code of [400, 403, 500, 502, 503]) {
        global.fetch = async () => new Response(JSON.stringify({ errorMessage: 'User exists with same username' }), { status: code });
        await assert.rejects(provider.createUser({ username: 'x', email: 'x@example.test', firstName: 'X', lastName: 'Y' }), error => {
          assert.ok(error instanceof RosterWriteFailure && !(error instanceof MemberExists), String(code));
          assert.equal(error.message, `Keycloak roster http_${code}`, 'other failures keep their earlier answer');
          return true;
        });
      }
      // A created member whose read-back fails is not "already exists".
      global.fetch = async (url, init) => init.method === 'POST' ? new Response(null, { status: 201 }) : new Response(null, { status: 500 });
      await assert.rejects(provider.createUser({ username: 'z', email: 'z@example.test', firstName: 'Z', lastName: 'Z' }),
        error => { assert.ok(!(error instanceof MemberExists)); assert.equal(error.message, 'Keycloak roster http_500'); return true; });
      global.fetch = async () => { throw new TypeError('fetch failed'); };
      await assert.rejects(provider.createUser({ username: 'z', email: 'z@example.test', firstName: 'Z', lastName: 'Z' }),
        error => { assert.ok(!(error instanceof MemberExists)); assert.ok(!(error instanceof RosterWriteFailure)); return true; },
        'no answer stays as before');
    } finally { global.fetch = realFetch; }

    // The administration service: 409 MEMBER_EXISTS with the field's words, no provider words, nothing written or audited.
    const words = {
      username: '같은 아이디의 계정이 이미 있습니다. 다른 아이디로 만드세요.',
      email: '같은 이메일의 계정이 이미 있습니다. 다른 이메일로 만드세요.',
      null: '같은 아이디 또는 이메일의 계정이 이미 있습니다. 아이디나 이메일을 바꿔 다시 만드세요.',
    };
    const glossary = fs.readFileSync(path.join(root, 'worklist-v0/hpacs-lite/worklist-language-terms.js'), 'utf8');
    for (const field of ['username', 'email', null]) {
      for (const body of [
        { username: 'reader-a', email: 'new@example.test', firstName: 'New', lastName: 'Member', institution: A, roles: ['radiologist'] },
        { username: 'reader-a', email: 'new@example.test', firstName: 'New', lastName: 'Member', verificationOverride: false },
      ]) {
        const w = world();
        w.kc.createUser = async user => { w.kcCalls.push(['create', user]); throw new MemberExists(field); };
        const before = w.writes();
        await assert.rejects(w.call('admin/users', 'POST', req => w.controller.create(body, req)), error => {
          assert.equal(error.getStatus(), 409);
          const answer = error.getResponse();
          assert.equal(answer.code, 'MEMBER_EXISTS');
          assert.equal(answer.field, field);
          assert.equal(answer.message, words[field]);
          assert.doesNotMatch(answer.message, /Keycloak|roster|http_/i);
          return true;
        });
        assert.deepEqual(w.kcCalls.map(c => c[0]), ['create'], 'no group, role, password or enable call after a refused create');
        assert.equal(w.writes(), before, 'no member row');
        assert.equal(w.audits.length, 0, 'no half-made member to record');
      }
      assert.ok(glossary.includes(JSON.stringify(words[field])), 'both screen languages have the words');
    }
    const w = world();
    w.kc.createUser = async () => { throw new RosterWriteFailure({ state: 'unknown', outcome: 'http_503' }); };
    await assert.rejects(w.call('admin/users', 'POST', req => w.controller.create({ username: 'n', email: 'n@example.test',
      firstName: 'N', lastName: 'M', institution: A, roles: ['radiologist'] }, req)), error => {
      assert.equal(error.getStatus(), 503);
      assert.equal(error.message, 'Keycloak roster http_503', 'a provider outage keeps its earlier answer');
      return true;
    });
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
      // The two rights changes are recorded as the operator's service identity, as its session ends are: no member
      // roles, no acting institution; X is the institution they manage.
      assert.deepEqual(w.events.filter(e => e.formatVersion === 1).map(e => [e.executor, e.cause, e.userId.value.subject, e.rolesAtTime,
        e.actingInstitution, e.managingInstitution]), Array(2).fill(['service', 'service-job', 'ops', { status: 'known', value: [] },
        { status: 'not-applicable', reason: 'in-process-service' }, { status: 'known', value: D }]));
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
      // The same command with the same arguments again (after a lost answer, exit 3): its replacement stands — nothing is
      // rewritten (rights, sessions, audits, ledger), and the successor is returned for the roster check.
      const quiet = () => JSON.stringify([w.writes(), w.audits.length, w.identities(), w.sessions.length, w.changes.length, [...w.rows.values()]]);
      const unchanged = quiet();
      const standing = await w.replace('admin-d', 'reader-d', D);
      assert.deepEqual([standing.id, standing.again, standing.version], ['reader-d', 'standing', 2]);
      assert.equal(quiet(), unchanged, 'a standing replacement run again writes nothing');
      // Another operator or reason is another command: never taken for this one.
      await refused(w, 'admin-d', 'reader-d', 'REPLACE_ADMIN_FROM_NOT_ADMIN', 'the same pair with another reason', D,
        { name: 'ops', reason: 'another synthetic request' });
      await refused(w, 'admin-d', 'reader-d', 'REPLACE_ADMIN_FROM_NOT_ADMIN', 'the same pair by another operator', D,
        { name: 'ops2', reason: 'synthetic hospital request confirmed by phone' });
      // A member changed since: the current state of both, nothing written (the command sends no roster).
      w.rows.get('reader-d').version = 5;
      const changedAgain = await w.replace('admin-d', 'reader-d', D);
      assert.deepEqual([changedAgain.again, changedAgain.current.to.version, changedAgain.current.from.enabled], ['changed', 5, false]);
      w.rows.get('reader-d').version = 2;
      assert.equal(quiet(), unchanged);
      // Rerun while the provider cannot be read: the database alone tells a saved replacement.
      const realInstitutions = w.kc.institutions;
      w.kc.institutions = async () => { throw new Error('synthetic provider outage'); };
      assert.equal((await w.replace('admin-d', 'reader-d', D)).again, 'standing');
      w.kc.institutions = realInstitutions;
      // The hospital made the predecessor sole administrator again since (reactivated; the successor demoted): the
      // original command run again reports that change and never replaces twice.
      const pre = w.rows.get('admin-d'), suc = w.rows.get('reader-d');
      Object.assign(pre, { suspended: false, version: pre.version + 1 });
      Object.assign(suc, { roles: ['radiologist'], version: suc.version + 1 });
      const reinstated = quiet();
      const changedBack = await w.replace('admin-d', 'reader-d', D);
      assert.deepEqual([changedBack.again, changedBack.current.from.enabled, changedBack.current.to.roles], ['changed', true, ['radiologist']]);
      assert.equal(quiet(), reinstated, 'never replaced twice');
      Object.assign(pre, { suspended: true, version: pre.version - 1 });
      Object.assign(suc, { roles: ['radiologist', 'admin'], version: suc.version - 1 });
      // Unreadable: the earlier run's result cannot be told — exit 3 again (OutcomeUndetermined).
      const { OutcomeUndetermined } = require('../api/src/first-admin-command.ts');
      const realAudits = w.db.auditLog.findMany;
      w.db.auditLog.findMany = async () => { throw new Error('synthetic database outage'); };
      await assert.rejects(w.replace('admin-d', 'reader-d', D), OutcomeUndetermined);
      w.db.auditLog.findMany = realAudits;
      const realFind = w.db.memberRights.findUnique;
      w.db.memberRights.findUnique = async () => { throw new Error('synthetic database outage'); };
      await assert.rejects(w.replace('admin-d', 'reader-d', D), OutcomeUndetermined, 'the first read fails: undetermined');
      w.db.memberRights.findUnique = realFind;
      assert.equal(quiet(), unchanged);
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
      // A successor who now has the predecessor's old email or username is not refused: drafts and history belong to an
      // account id, so none of the predecessor's answers to them (the real PostgreSQL case is in the owner-keys test).
      for (const [field, value] of [['email', 'admin-d@example.test'], ['username', 'admin-d']]) {
        const w3 = setup();
        w3.identityOverride(sub => sub === 'reader-d' ? { id: sub, username: 'reader-d', email: 'reader-d@example.test', emailVerified: true,
          firstName: 'S', lastName: sub, enabled: true, serviceAccountClientId: null, groups: [D], roles: [], [field]: value } : undefined);
        assert.equal((await w3.replace('admin-d', 'reader-d', D)).approvalState, 'APPROVED', `a successor ${field} ${value}`);
      }
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
    // The predecessor, admitted before, resets a colleague's temporary password; while the server reads the provider for
    // it, the operator replaces them: the caller's recheck under the member lock refuses — no provider write, no password.
    {
      const w = setup();
      const adminD = { sub: 'admin-d', actor: 'admin-d@example.test', roles: ['admin'], institution: D, kind: 'member' };
      const current = async () => { if (w.rows.get('admin-d').suspended) throw Object.assign(new Error('session ended'), { getStatus: () => 401 }); };
      const realGet = w.kc.getUser;
      let pending = true;
      w.kc.getUser = async id => {
        if (id === 'colleague-d' && pending) { pending = false; await w.replace('admin-d', 'reader-d', D); }
        return realGet(id);
      };
      await assert.rejects(w.reset('colleague-d', { mode: 'temp' }, adminD, current), e => e.getStatus?.() === 401);
      assert.ok(!pending && !w.kcCalls.some(c => c[0] === 'reset'), 'replaced meanwhile: no provider write, no password');
      assert.ok(!w.audits.some(a => a.action.startsWith('admin.user.reset-password')));
      // The replacement commits while the reset registers a provider-only member (after the recheck under the lock):
      // the recheck just before the provider write refuses — no provider write, no password.
      const w3 = setup();
      const current3 = async () => { if (w3.rows.get('admin-d').suspended) throw Object.assign(new Error('session ended'), { getStatus: () => 401 }); };
      const realCreate = w3.db.memberRights.create;
      w3.db.memberRights.create = async args => {
        const created = await realCreate(args);
        if (args.data.sub === 'kc-d-group') await w3.replace('admin-d', 'reader-d', D);
        return created;
      };
      await assert.rejects(w3.reset('kc-d-group', { mode: 'temp' }, adminD, current3), e => e.getStatus?.() === 401);
      assert.ok(w3.rows.get('admin-d').suspended && !w3.kcCalls.some(c => c[0] === 'reset'), 'no provider write after the replacement');
      // Through the real provider client: the replacement commits while it waits for its service token (after every
      // earlier recheck). The caller is checked again after the token and before the PUT — refused, nothing sent.
      {
        const w4 = setup();
        const current4 = async () => { if (w4.rows.get('admin-d').suspended) throw Object.assign(new Error('session ended'), { getStatus: () => 401 }); };
        const provider = new KeycloakService();
        provider.secret = 'synthetic-secret';
        w4.kc.resetPassword = (...a) => provider.resetPassword(...a);
        const sent = [], realFetch = globalThis.fetch;
        globalThis.fetch = async (url, init = {}) => {
          sent.push([init.method ?? 'GET', String(url)]);
          if (/\/protocol\/openid-connect\/token$/.test(String(url))) {
            await w4.replace('admin-d', 'reader-d', D);
            return new Response(JSON.stringify({ access_token: 'synthetic-token', expires_in: 300 }), { status: 200 });
          }
          return new Response(null, { status: 204 });
        };
        try {
          await assert.rejects(w4.reset('colleague-d', { mode: 'temp' }, adminD, current4), e => e.getStatus?.() === 401);
        } finally { globalThis.fetch = realFetch; }
        assert.ok(w4.rows.get('admin-d').suspended, 'replaced during the token wait');
        assert.deepEqual(sent.filter(([, url]) => /reset-password/.test(url)), [], 'no reset PUT after the replacement');
        assert.ok(!w4.audits.some(a => a.action.startsWith('admin.user.reset-password')));
        // Not replaced: the same real client sends the PUT once and the password is returned.
        const w5 = setup();
        const provider5 = new KeycloakService();
        provider5.secret = 'synthetic-secret';
        w5.kc.resetPassword = (...a) => provider5.resetPassword(...a);
        const sent5 = [];
        globalThis.fetch = async (url, init = {}) => {
          sent5.push([init.method ?? 'GET', String(url)]);
          return /\/token$/.test(String(url))
            ? new Response(JSON.stringify({ access_token: 'synthetic-token', expires_in: 300 }), { status: 200 })
            : new Response(null, { status: 204 });
        };
        try {
          assert.ok((await w5.reset('colleague-d', { mode: 'temp' }, adminD, async () => {})).temporaryPassword);
        } finally { globalThis.fetch = realFetch; }
        assert.equal(sent5.filter(([method, url]) => method === 'PUT' && /reset-password/.test(url)).length, 1);
      }
      // Not replaced: the same reset returns the temporary password.
      const w2 = setup();
      const current2 = async () => { if (w2.rows.get('admin-d').suspended) throw new Error('unexpected'); };
      assert.ok((await w2.reset('colleague-d', { mode: 'temp' }, adminD, current2)).temporaryPassword);
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
    // Unable to open the database, a rerun cannot say "not replaced": exit 3, run again.
    expect('start-fails', 3, null, 'the ledger did not start', r => { assert.ok(!r.steps.includes('replace'));
      assert.ok(r.errJson[0].message.startsWith('같은 명령을 같은 인자로 다시 실행하세요.'), r.stderr); });
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
    // Exit 3 says first: run the same command with the same arguments again.
    const runAgain = r => assert.ok(r.errJson[0].message.startsWith('같은 명령을 같은 인자로 다시 실행하세요.'), r.stderr);
    expect('commit-lost-not-committed', 3, null, 'a lost commit answer and no row of this run', runAgain);
    expect('commit-lost,reread-fails', 3, null, 'a lost commit answer and an unreadable record', runAgain);
    expect('undetermined', 3, null, 'an earlier run\'s result cannot be read', r => {
      runAgain(r); assert.ok(!r.steps.includes('transaction') && !r.steps.includes('send-roster')); });
    // The same command again over its own saved replacement: nothing rewritten; the successor's latest roster confirmed.
    expect('again-standing', 0, true, 'run again: the replacement stands, roster confirmed', r => {
      assert.deepEqual([r.out[0].again, r.out[0].roster], ['standing', 'done']);
      assert.ok(r.steps.includes('recover-roster') && !r.steps.includes('transaction') && !r.steps.includes('send-roster')); noRetry(r); });
    expect('again-standing,roster-unknown', 2, true, 'run again: the replacement stands, roster unconfirmed', retry);
    // A member changed since: the current state, and no roster sent over the later change.
    expect('again-changed', 2, true, 'run again: a member changed since', r => {
      assert.deepEqual([r.out[0].again, r.out[0].roster, r.out[0].current.to.version], ['changed', 'not-sent', 3]);
      assert.ok(!r.steps.includes('recover-roster') && !r.steps.includes('send-roster') && !r.steps.includes('lookup-change')); });
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
    fs.rmSync(path.join(base, kept[0]), { recursive: true, force: true });
    // The earlier layout's single spool, replayed for real, fails after it was emptied (fsync fails): the complete record
    // was imported, the file to replay is back, and the torn tail is kept with its original bytes — no line is lost.
    fs.writeFileSync(path.join(base, 'failure-spool.jsonl'), record + '\n{"id":"legacy-torn');
    replayed.length = 0;
    const { fsyncSync, ftruncateSync } = fs;
    let emptied = false;
    fs.ftruncateSync = (...args) => { const out = ftruncateSync(...args); emptied = true; return out; };
    fs.fsyncSync = (...args) => { if (emptied) throw new Error('synthetic fsync failure'); return fsyncSync(...args); };
    try { await assert.rejects(importFinishedSpools(base, 'run-own', real), /synthetic fsync failure/); }
    finally { fs.fsyncSync = fsyncSync; fs.ftruncateSync = ftruncateSync; }
    assert.deepEqual(replayed, ['00000000-0000-4000-8000-0000000000f1'], 'the complete record reached the importer');
    assert.ok(fs.existsSync(path.join(base, 'failure-spool.jsonl')), 'the file to replay is put back');
    const keptTail = fs.readdirSync(base).filter(name => name.startsWith('kept-'));
    assert.equal(keptTail.length, 1, 'what replay set aside is kept');
    assert.equal(fs.readFileSync(path.join(base, keptTail[0], 'failure-spool.jsonl.partial'), 'utf8'), '{"id":"legacy-torn');
    assert.ok(!fs.readdirSync(base).some(name => name.startsWith('claim-')), 'no claim left behind');
    fs.rmSync(path.join(base, keptTail[0]), { recursive: true, force: true });
    fs.rmSync(path.join(base, 'failure-spool.jsonl'), { force: true });
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

  // 13. Change Name / Email: an administrator corrects an approved member's email and name in the login account (the
  //     identity provider) and the member row together. The provider below is a store of its own (not the member row),
  //     so one side changing without the other is seen.
  {
    const { LedgerFailure } = require('../api/src/emr-runtime/store.ts');
    const { PacsPreferences } = require('../api/src/pacs/preferences.ts');
    const { draftOf } = require('../api/src/owner-identity.ts');
    const glossary = fs.readFileSync(path.join(root, 'worklist-v0/hpacs-lite/worklist-language-terms.js'), 'utf8');

    // 13a. The provider client: only the given fields are sent; the answer is the status code's; the send is bounded and
    //      the caller's last check runs just before it (a refusal sends nothing).
    {
      const provider = new KeycloakService();
      provider.secret = 'synthetic';
      provider.token = { value: 'synthetic-token', exp: Date.now() + 3600_000 };
      const realFetch = global.fetch;
      try {
        const seen = [];
        global.fetch = async (url, init) => { seen.push([init.method, String(url), init.body, !!init.signal]); return new Response(null, { status: 204 }); };
        const done = await provider.updateIdentity('m-1', { firstName: 'Given', lastName: 'Family' }, AbortSignal.timeout(1000), async () => {});
        assert.deepEqual(done, { state: 'done', outcome: 'http_204' });
        assert.equal(seen.length, 1);
        assert.equal(seen[0][0], 'PUT');
        assert.match(seen[0][1], /\/users\/m-1$/);
        assert.deepEqual(JSON.parse(seen[0][2]), { firstName: 'Given', lastName: 'Family' }, 'a name change sends no email or verification');
        assert.ok(seen[0][3], 'the send is bounded');
        for (const [code, state] of [[409, 'void'], [400, 'void'], [500, 'unknown'], [503, 'unknown']]) {
          global.fetch = async () => new Response(null, { status: code });
          assert.equal((await provider.updateIdentity('m-1', { email: 'n@example.test', emailVerified: false },
            AbortSignal.timeout(1000), async () => {})).state, state, String(code));
        }
        global.fetch = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
        // AbortSignal.timeout's timer does not hold the process open by itself; this one does, for the bound's length.
        const alive = setTimeout(() => {}, 1000);
        assert.deepEqual(await provider.updateIdentity('m-1', { email: 'n@example.test' }, AbortSignal.timeout(20), async () => {}),
          { state: 'unknown', outcome: 'transport' }, 'a send cut by its bound has an unknown outcome');
        clearTimeout(alive);
        let sent = 0;
        global.fetch = async () => { sent++; return new Response(null, { status: 204 }); };
        await assert.rejects(provider.updateIdentity('m-1', { email: 'n@example.test' }, AbortSignal.timeout(1000),
          async () => { throw new Error('synthetic authorization ended'); }), /synthetic authorization ended/);
        assert.equal(sent, 0, 'a refused last check sends nothing');
        const asked = [];
        global.fetch = async url => { asked.push(String(url)); return new Response(JSON.stringify([
          { id: 'x', email: 'Same@Example.test' }, { id: 'y', email: 'same@example.test.other' }]), { status: 200 }); };
        assert.deepEqual(await provider.accountsWithEmail('same@example.test'), ['x'], 'exact, ignoring case');
        assert.match(asked[0], /email=same%40example\.test&exact=true/);
        global.fetch = async () => new Response(JSON.stringify({ not: 'a list' }), { status: 200 });
        await assert.rejects(provider.accountsWithEmail('same@example.test'), RosterWriteFailure, 'an unreadable answer is a failed read');
      } finally { global.fetch = realFetch; }
    }

    // The world with a provider of its own: each member's login account, separate from the member row.
    const separate = w => {
      const accounts = new Map();
      for (const row of w.rows.values()) accounts.set(row.sub, { id: row.sub, username: row.username, email: row.email,
        emailVerified: row.emailVerified, firstName: row.name.replace(/^Synthetic /, ''), lastName: 'Synthetic', enabled: true,
        serviceAccountClientId: null, groups: row.institution ? [row.institution] : [], roles: [] });
      const writes = [];
      const plan = { answer: null, reread: null, refuse: null };
      w.kc.getUser = async id => {
        if (plan.reread) { const forced = plan.reread(id); if (forced !== undefined) return forced; }
        return accounts.has(id) ? { ...accounts.get(id), groups: [...accounts.get(id).groups] } : null;
      };
      w.kc.listUsers = async page => { const users = [...accounts.values()].map(u => ({ ...u }));
        return { page, pageSize: 25, total: users.length, pendingCount: 0, users, realmUsers: users }; };
      w.kc.accountsWithEmail = async email => [...accounts.values()].filter(u => u.email.toLowerCase() === email.toLowerCase()).map(u => u.id);
      w.kc.updateIdentity = async (id, fields, within, beforeSend) => {
        assert.ok(within instanceof AbortSignal, 'bounded');
        await beforeSend();
        // The member's lock is held when the provider is written.
        assert.ok(w.raws.filter(r => r[0].includes('pg_advisory_xact_lock')).length >= 2, 'institution and member locks before the write');
        writes.push([id, { ...fields }]);
        w.kcCalls.push(['identity', id, { ...fields }]);
        const answer = plan.answer ? plan.answer(writes.length) : { state: 'done', outcome: 'http_204' };
        if (answer.state !== 'void' && !answer.skip) Object.assign(accounts.get(id), fields);
        return answer;
      };
      return { accounts, writes, plan };
    };
    const change = (w, id, identity, version = w.rows.get(id)?.version ?? 1, who = w.adminA) =>
      w.call('admin/users/:id', 'PATCH', req => w.controller.patch(id, { identity, version }, req), who);
    const answerOf = code => error => { assert.ok(error.getResponse, String(error)); assert.equal(error.getResponse().code, code); return true; };

    // 13b. Email (B1): both sides take the new address, unverified; one version; the member's sessions end; one audit row.
    {
      const w = world(), p = separate(w);
      w.sessions.push({ sid: 'sid-reader-a', sub: 'reader-a', auditRef: 'authref:00000000-0000-4000-8000-0000000000a1', institution: A });
      const after = await change(w, 'reader-a', { email: 'corrected@example.test' });
      assert.equal(after.email, 'corrected@example.test');
      assert.equal(after.version, 2);
      assert.deepEqual(p.writes, [['reader-a', { email: 'corrected@example.test', emailVerified: false }]]);
      const row = w.rows.get('reader-a'), account = p.accounts.get('reader-a');
      assert.equal(row.email, 'corrected@example.test');
      assert.equal(row.emailVerified, false);
      assert.equal(account.email, 'corrected@example.test');
      assert.equal(account.emailVerified, false);
      assert.deepEqual([row.institution, row.roles, row.approved, row.suspended], [A, ['radiologist'], true, false], 'rights unchanged');
      assert.equal(w.sessions.filter(s => s.sub === 'reader-a').length, 0, 'the member signs in again');
      const rows = w.audits.filter(a => a.action === 'admin.user.identity');
      assert.equal(rows.length, 1);
      const detail = JSON.parse(rows[0].detail);
      assert.deepEqual(detail.identity, { email: { from: 'reader-a@example.test', to: 'corrected@example.test' } });
      assert.equal(detail.before.email, 'reader-a@example.test');
      assert.equal(rows[0].actor, 'admin-a@example.test');
      assert.equal(w.changes.length, 0, 'no roster intent: institution and roles are untouched');
      assert.ok(w.events.some(e => e.surface === 'PATCH admin/users/:id'), 'the member change ledger event');
      const list = await w.controller.list('1', w.adminA);
      const shown = list.users.find(u => u.id === 'reader-a');
      assert.equal(shown.email, 'corrected@example.test');
      assert.equal(shown.identityUnconfirmed, false);
    }

    // 13c. Name (B2): only the names are sent; the verification state stays; both at once is one row with two changes;
    //      a suspended member is corrected and stays suspended.
    {
      const w = world(), p = separate(w);
      await change(w, 'reader-a', { lastName: 'Kim', firstName: 'Corrected' });
      assert.deepEqual(p.writes, [['reader-a', { firstName: 'Corrected', lastName: 'Kim' }]]);
      assert.equal(w.rows.get('reader-a').name, 'Kim Corrected');
      assert.equal(w.rows.get('reader-a').emailVerified, true, 'a name change keeps the verification');
      assert.deepEqual(JSON.parse(w.audits.at(-1).detail).identity, { name: { from: 'Synthetic reader-a', to: 'Kim Corrected' } });
      w.rows.get('reader-a').suspended = true;
      await change(w, 'reader-a', { email: 'both@example.test', lastName: 'Lee', firstName: 'Both' });
      const detail = JSON.parse(w.audits.at(-1).detail);
      assert.deepEqual(Object.keys(detail.identity).sort(), ['email', 'name']);
      assert.equal(w.rows.get('reader-a').suspended, true, 'still suspended');
      assert.equal(w.rows.get('reader-a').version, 3);
    }

    // 13d. Ownership (B3): after the change the same account — a new token naming the new email — opens the same drafts,
    //      saved searches and templates; an account that now has the old email gets none of them.
    {
      const w = world(); separate(w);
      const templates = [{ id: 11, ownerSub: 'reader-a', owner: 'reader-a@example.test', name: 'Mine', ord: 0 }];
      const filters = [{ id: 21, ownerSub: 'reader-a', owner: 'reader-a@example.test', name: 'My search', cols: '{}', createdAt: new Date() }];
      const drafts = [{ uid: '1.2.3', author: 'reader-a@example.test', authorSub: 'reader-a', findings: 'kept' }];
      const prisma = {
        readingTemplate: { count: async ({ where }) => templates.filter(t => t.ownerSub === where.ownerSub).length,
          createMany: async () => { throw new Error('no seed: the account has its templates'); },
          findMany: async ({ where }) => templates.filter(t => t.ownerSub === where.ownerSub) },
        userFilter: { findMany: async ({ where }) => filters.filter(f => f.ownerSub === where.ownerSub) },
        reportDraft: { findFirst: async ({ where }) => drafts.find(d => d.uid === where.uid && d.authorSub === where.authorSub) ?? null },
      };
      await change(w, 'reader-a', { email: 'renamed@example.test' });
      const prefs = new PacsPreferences(prisma);
      const again = { sub: 'reader-a', actor: 'renamed@example.test', roles: ['radiologist'], institution: A, kind: 'member' };
      const mine = await prefs.prefs(again);
      assert.deepEqual(mine.templates.map(t => t.id), [11]);
      assert.deepEqual(mine.filters.map(f => f.id), [21]);
      assert.equal((await draftOf(prisma, '1.2.3', again)).findings, 'kept');
      const other = { sub: 'someone-else', actor: 'reader-a@example.test', roles: ['technician'], institution: A, kind: 'member' };
      const theirs = await prefs.prefs(other);
      assert.deepEqual([theirs.templates.length, theirs.filters.length], [0, 0]);
      assert.equal(await draftOf(prisma, '1.2.3', other), null);
      assert.equal(templates[0].owner, 'reader-a@example.test', 'the stored old email text is not rewritten');
    }

    // 13e. An address another account has (B4): 409 MEMBER_EXISTS with Create Member's code, nothing sent or written; the
    //      write's own 409 to an email change says the same; to a name change it says nothing changed.
    {
      const w = world(), p = separate(w);
      const before = w.writes();
      await assert.rejects(change(w, 'reader-a', { email: 'ADMIN-A@example.test' }), error => {
        assert.equal(error.getStatus(), 409);
        assert.deepEqual(error.getResponse(), { code: 'MEMBER_EXISTS', field: 'email', message: '같은 이메일의 계정이 이미 있습니다. 다른 이메일로 바꾸세요.' });
        return true;
      });
      assert.deepEqual([p.writes.length, w.writes(), w.audits.length], [0, before, 0]);
      p.plan.answer = () => ({ state: 'void', outcome: 'http_409' });
      await assert.rejects(change(w, 'reader-a', { email: 'raced@example.test' }), answerOf('MEMBER_EXISTS'));
      await assert.rejects(change(w, 'reader-a', { lastName: 'X', firstName: 'Y' }), answerOf('MEMBER_IDENTITY_NOT_CHANGED'));
      assert.equal(p.writes.length, 2);
      assert.deepEqual([w.rows.get('reader-a').email, w.rows.get('reader-a').version, w.writes()], ['reader-a@example.test', 1, before]);
      assert.equal(w.audits.length, 0, 'a refused write is no success and no failure to record');
    }

    // 13f. Scope and input (B5): another institution and an unknown id answer alike with no provider call; the waiting
    //      room, a mixed request, a bad version, no change are 400; a non-administrator 403. Nothing written.
    {
      const w = world(), p = separate(w);
      const before = w.writes();
      for (const id of ['reader-b', 'kc-b', 'no-such-member'])
        await assert.rejects(change(w, id, { email: 'x@example.test' }, 1), sameAsUnknown, id);
      for (const [id, body] of [['waiting', { identity: { email: 'x@example.test' }, version: 1 }],
        ['reader-a', { identity: { email: 'x@example.test' }, version: 1, roles: ['clinician'] }],
        ['reader-a', { identity: { email: 'x@example.test' }, version: '1' }],
        ['reader-a', { identity: { email: 'x@example.test' } }],
        ['reader-a', { identity: null, version: 1 }],
        ['reader-a', { identity: {}, version: 1 }],
        ['reader-a', { identity: { username: 'other' }, version: 1 }],
        ['reader-a', { identity: { firstName: 'Only' }, version: 1 }],
        ['reader-a', { identity: { email: 'no-at-sign' }, version: 1 }],
        ['reader-a', { identity: { email: 'line\nbreak@example.test' }, version: 1 }],
        ['reader-a', { identity: { email: 'READER-A@example.test' }, version: 1 }]])
        await assert.rejects(w.call('admin/users/:id', 'PATCH', req => w.controller.patch(id, body, req)), status(400), JSON.stringify(body));
      const reader = { sub: 'reader-a', actor: 'reader-a@example.test', roles: ['radiologist'], institution: A, kind: 'member' };
      await assert.rejects(change(w, 'reader-a', { email: 'x@example.test' }, 1, reader), status(403));
      assert.deepEqual([p.writes.length, w.writes(), w.audits.length], [0, before, 0]);
      assert.deepEqual(w.kcCalls, []);
      for (const words of ['이메일·이름 변경은 다른 회원 변경과 함께 보낼 수 없습니다', '성과 이름을 함께 보내세요', '바뀐 값이 없습니다',
        '이 기관의 승인된 회원만 이메일·이름을 바꿀 수 있습니다', '같은 이메일의 계정이 이미 있습니다. 다른 이메일로 바꾸세요.',
        '이메일·이름을 바꾸지 못했습니다. 아무것도 바뀌지 않았습니다. 다시 시도하세요.',
        '바뀌었는지 확인하지 못했습니다. Refresh로 목록을 다시 읽고, 바뀌지 않았으면 같은 값으로 다시 저장하세요.',
        '명부의 이메일이 이 화면의 이메일과 다릅니다. Change Name / Email로 주소를 확인해 저장한 뒤 다시 보내세요.'])
        assert.ok(glossary.includes(JSON.stringify(words)), words);
    }

    // 13g. A version the dialog opened on is stale (B6, before the locks): 409 and nothing sent.
    {
      const w = world(), p = separate(w);
      await assert.rejects(change(w, 'reader-a', { email: 'late@example.test' }, 7), answerOf('MEMBER_VERSION_CONFLICT'));
      assert.equal(p.writes.length, 0);
    }

    // 13h. Provider outcomes (B7): a refusal changes nothing; a lost answer the read-back confirms goes on; a lost answer
    //      the read-back does not settle is unconfirmed — no success, no version, nothing put back.
    {
      const w = world(), p = separate(w);
      p.plan.answer = () => ({ state: 'void', outcome: 'http_400' });
      await assert.rejects(change(w, 'reader-a', { email: 'refused@example.test' }), error => {
        assert.equal(error.getStatus(), 503); assert.equal(error.getResponse().code, 'MEMBER_IDENTITY_NOT_CHANGED'); return true; });
      assert.equal(w.rows.get('reader-a').version, 1);
      p.plan.answer = () => ({ state: 'unknown', outcome: 'transport' });
      const after = await change(w, 'reader-a', { email: 'landed@example.test' });
      assert.equal(after.email, 'landed@example.test', 'the read-back settles a lost answer');
      p.plan.answer = () => ({ state: 'unknown', outcome: 'transport', skip: true });
      await assert.rejects(change(w, 'reader-a', { email: 'unsettled@example.test' }), answerOf('MEMBER_IDENTITY_UNCONFIRMED'));
      p.plan.answer = () => ({ state: 'done', outcome: 'http_204' });
      // The read after the write fails (the first read, before the locks, succeeds).
      p.plan.reread = () => p.writes.length >= 4 ? null : undefined;
      await assert.rejects(change(w, 'reader-a', { lastName: 'Unread', firstName: 'Back' }), answerOf('MEMBER_IDENTITY_UNCONFIRMED'));
      p.plan.reread = null;
      assert.equal(w.rows.get('reader-a').email, 'landed@example.test');
      assert.equal(w.rows.get('reader-a').version, 2, 'only the confirmed change committed');
      assert.equal(p.writes.length, 4, 'nothing put back while the outcome is unknown');
      assert.equal(w.audits.filter(a => a.action === 'admin.user.identity').length, 1);
      assert.equal(w.audits.filter(a => a.action === 'admin.user.patch.failed').length, 0);
    }

    // 13i. The database does not commit (B8): what this request wrote is put back — under the locks, only while the row and
    //      the provider are as it left them — and the failure is recorded. A lost commit answer is settled by the own
    //      audit row: committed stays committed; not found is unconfirmed and nothing is put back.
    {
      const w = world(), p = separate(w);
      const updateMany = w.db.memberRights.updateMany;
      w.db.memberRights.updateMany = async () => { throw new Error('synthetic database failure'); };
      await assert.rejects(change(w, 'reader-a', { email: 'rolled@example.test' }), /synthetic database failure/);
      assert.deepEqual(p.writes, [['reader-a', { email: 'rolled@example.test', emailVerified: false }],
        ['reader-a', { email: 'reader-a@example.test', emailVerified: true }]], 'put back with its verification');
      assert.equal(p.accounts.get('reader-a').email, 'reader-a@example.test');
      assert.equal(w.audits.filter(a => a.action === 'admin.user.patch.failed').length, 1);
      assert.equal(w.audits.filter(a => a.action === 'admin.user.identity').length, 0);
      // Another administrator's change committed meanwhile (the row's version moved): nothing is put back.
      w.db.memberRights.updateMany = async () => { w.rows.get('reader-a').version = 9; throw new Error('synthetic database failure'); };
      await assert.rejects(change(w, 'reader-a', { email: 'other-won@example.test' }), /synthetic database failure/);
      assert.equal(p.writes.length, 3, 'no write back over a later change');
      assert.equal(w.audits.filter(a => a.action === 'admin.user.patch.failed').length, 2, 'this request\'s failure is still recorded');
      w.rows.get('reader-a').version = 1;
      w.db.memberRights.updateMany = updateMany;
      // A lost commit answer whose own audit row exists: the change stands, nothing is put back.
      w.db.auditLog.findFirst = async ({ where }) => {
        const row = w.audits[where.id - 1];
        return row && row.target === where.target && row.action === where.action ? { id: where.id, ...row } : null;
      };
      w.commitOutcome(() => { throw new LedgerFailure('CommitUnknown'); });
      const stood = await change(w, 'reader-a', { email: 'stood@example.test' });
      assert.equal(stood.email, 'stood@example.test');
      assert.equal(p.writes.length, 4);
      assert.equal(w.audits.filter(a => a.action === 'admin.user.patch.failed').length, 2, 'no failure row over a committed change');
      // A lost commit answer without its audit row: unconfirmed, nothing put back.
      w.commitOutcome(() => { w.audits.splice(0, w.audits.length, ...w.audits.filter(a => a.action !== 'admin.user.identity' || !a.detail.includes('lost@'))); throw new LedgerFailure('CommitUnknown'); });
      await assert.rejects(change(w, 'reader-a', { email: 'lost@example.test' }), answerOf('MEMBER_IDENTITY_UNCONFIRMED'));
      assert.equal(p.writes.length, 5, 'nothing put back while the commit is unknown');
      w.commitOutcome(null);
    }

    // 13j. The provider changed and the row did not (B9): the list marks it and opens on the provider's values; saving
    //      them makes the two one with one audit row (no provider write); saving again changes nothing.
    {
      const w = world(), p = separate(w);
      p.accounts.get('reader-a').email = 'provider-only@example.test';
      const list = await w.controller.list('1', w.adminA);
      const shown = list.users.find(u => u.id === 'reader-a');
      assert.equal(shown.email, 'reader-a@example.test', 'the row shows the member row');
      assert.equal(shown.identityUnconfirmed, true);
      assert.deepEqual(shown.provider, { email: 'provider-only@example.test', firstName: 'reader-a', lastName: 'Synthetic' });
      assert.equal(list.users.find(u => u.id === 'waiting').provider, undefined, 'no provider values for a member it may not change');
      await change(w, 'reader-a', { email: 'provider-only@example.test' });
      assert.equal(p.writes.length, 0, 'the provider already holds them');
      assert.equal(w.rows.get('reader-a').email, 'provider-only@example.test');
      assert.deepEqual(JSON.parse(w.audits.at(-1).detail).identity, { email: { from: 'reader-a@example.test', to: 'provider-only@example.test' } });
      await assert.rejects(change(w, 'reader-a', { email: 'provider-only@example.test' }), status(400));
      assert.equal(w.rows.get('reader-a').version, 2, 'no version, session end or audit for no change');
      assert.equal((await w.controller.list('1', w.adminA)).users.find(u => u.id === 'reader-a').identityUnconfirmed, false);
    }

    // 13k. Another member change never takes a differing provider identity silently (it stays marked for the explicit,
    //      audited change); the same address's verification is still refreshed.
    {
      const w = world(), p = separate(w);
      p.accounts.get('reader-a').email = 'console-edit@example.test';
      p.accounts.get('reader-a').firstName = 'Elsewhere';
      await w.call('admin/users/:id', 'PATCH', req => w.controller.patch('reader-a', { roles: ['radiologist', 'clinician'], version: 1 }, req));
      assert.deepEqual([w.rows.get('reader-a').email, w.rows.get('reader-a').name], ['reader-a@example.test', 'Synthetic reader-a']);
      assert.equal((await w.controller.list('1', w.adminA)).users.find(u => u.id === 'reader-a').identityUnconfirmed, true);
      p.accounts.get('admin-a').emailVerified = false;
      await w.call('admin/users/:id', 'PATCH', req => w.controller.patch('admin-a', { roles: ['admin', 'radiologist'], version: 1 }, req));
      assert.equal(w.rows.get('admin-a').emailVerified, false, 'the same address keeps the provider verification');
    }

    // 13l. The reset mail goes to the provider's address: while it differs from the shown one nothing is sent; a name
    //      difference or a temporary password is not held back.
    {
      const w = world(), p = separate(w);
      p.accounts.get('reader-a').email = 'elsewhere@example.test';
      await assert.rejects(w.reset('reader-a', { mode: 'email' }), answerOf('RESET_MAIL_ADDRESS_UNCONFIRMED'));
      assert.ok(!w.kcCalls.some(call => call[0] === 'reset'), 'no mail');
      assert.equal(w.audits.at(-1).action, 'admin.user.reset-password.failed');
      await w.reset('reader-a', { mode: 'temp' });
      p.accounts.get('reader-a').email = 'reader-a@example.test';
      p.accounts.get('reader-a').firstName = 'Renamed elsewhere';
      await w.reset('reader-a', { mode: 'email' });
      assert.deepEqual(w.kcCalls.filter(call => call[0] === 'reset').map(call => call[2]), ['temp', 'email']);
    }

    // 13n. The audit row names every field that changed in either store: the login account corrected back to the row's
    //      value, or only the family/given split moved (the shown name the same); a commit that fails on a save that
    //      needed no provider write is still this request's failure to record.
    {
      const w = world(), p = separate(w);
      p.accounts.get('reader-a').email = 'typo@example.test';
      await change(w, 'reader-a', { email: 'reader-a@example.test' });
      assert.deepEqual(p.writes, [['reader-a', { email: 'reader-a@example.test', emailVerified: false }]]);
      assert.deepEqual(JSON.parse(w.audits.at(-1).detail).identity, { email: { from: 'typo@example.test', to: 'reader-a@example.test' } },
        'a correction of the login account alone is recorded');
      // Shown "Synthetic reader-a" either way: family "Synthetic reader-a", given "" -> family "Synthetic", given "reader-a".
      p.accounts.get('reader-a').lastName = 'Synthetic reader-a';
      p.accounts.get('reader-a').firstName = '';
      await change(w, 'reader-a', { lastName: 'Synthetic', firstName: 'reader-a' });
      assert.deepEqual(JSON.parse(w.audits.at(-1).detail).identity, { name: { from: 'Synthetic reader-a / ', to: 'Synthetic / reader-a' } });
      assert.equal(w.audits.filter(a => a.action === 'admin.user.identity').every(a => Object.keys(JSON.parse(a.detail).identity).length), true);
      // The row differs, the provider already holds the values (no write), and the commit fails: recorded, nothing put back.
      p.accounts.get('reader-a').email = 'provider-ahead@example.test';
      const updateMany = w.db.memberRights.updateMany;
      w.db.memberRights.updateMany = async () => { throw new Error('synthetic database failure'); };
      const writes = p.writes.length;
      await assert.rejects(change(w, 'reader-a', { email: 'provider-ahead@example.test' }), /synthetic database failure/);
      w.db.memberRights.updateMany = updateMany;
      assert.equal(p.writes.length, writes, 'no provider write to put back');
      assert.equal(w.audits.at(-1).action, 'admin.user.patch.failed');
    }

    // 13m. The administrator corrects their own email: saved, and their own sessions end too (they sign in again).
    {
      const w = world(), p = separate(w);
      w.sessions.push({ sid: 'sid-admin-a', sub: 'admin-a', auditRef: 'authref:00000000-0000-4000-8000-0000000000a2', institution: A });
      await change(w, 'admin-a', { email: 'me-corrected@example.test' });
      assert.equal(p.accounts.get('admin-a').email, 'me-corrected@example.test');
      assert.equal(w.rows.get('admin-a').email, 'me-corrected@example.test');
      assert.equal(w.sessions.length, 0);
    }
  }

  process.stdout.write('Member institution scope contracts passed\n');
  finished = true;
})().catch(e => { console.error(e); process.exitCode = 1; });
// A wait that never settles empties the event loop and would end the run with code 0 before the last line: that is a failure.
let finished = false;
process.on('exit', code => { if (!finished && code === 0) { console.error('Member scope contracts did not finish'); process.exitCode = 1; } });
