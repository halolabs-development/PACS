'use strict';
// Preloaded (`node -r`) by admin_member_scope_test.cjs section 9 to run the real operator command
// api/prisma/designate-first-admin.cjs without a database or identity provider: each `../dist/<module>` the command
// requires resolves to a synthetic stand-in below (the command's own outcome module is the real source, transpiled),
// and the comma-separated scenario in KIN_TEST_FIRST_ADMIN_SCENARIO decides where a step fails. Every step the
// command took is appended to the JSON-lines file KIN_TEST_FIRST_ADMIN_LOG.
const Module = require('node:module'), path = require('node:path'), fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'api/node_modules/typescript'));
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, experimentalDecorators: true,
    emitDecoratorMetadata: true, esModuleInterop: true }, fileName: filename,
}).outputText, filename);
const { ConflictException } = require(path.join(root, 'api/node_modules/@nestjs/common'));
const { LedgerFailure } = require(path.join(root, 'api/src/emr-runtime/store.ts'));

const scenario = new Set((process.env.KIN_TEST_FIRST_ADMIN_SCENARIO || '').split(',').filter(Boolean));
const log = step => fs.appendFileSync(process.env.KIN_TEST_FIRST_ADMIN_LOG, JSON.stringify(step) + '\n');
const SUB = 'synthetic-first-admin', INSTITUTION = 'synthetic-hospital-c', AUDIT_ID = 41, VERSION = 2;
const change = { id: 7, kind: 'credentials', sub: SUB, target: SUB, generation: VERSION, state: 'unknown' };
let committed = false;

class PrismaService {
  constructor() {
    this.auditLog = { findFirst: async ({ where }) => {
      log('reread-audit');
      if (scenario.has('reread-fails')) throw new Error('synthetic database outage');
      // Another run's approval of the same person (a different audit id) is never this run's.
      // A session it ended (auth.logout) is this run's row too, but not the member change.
      const action = scenario.has('promoted') ? 'admin.user.update' : 'admin.user.approve';
      const rows = [...(scenario.has('other-run-committed') ? [{ id: 99, action: 'admin.user.approve' }] : []),
        ...(committed ? [{ id: AUDIT_ID - 1, action: 'auth.logout' }, { id: AUDIT_ID, action }] : [])];
      const row = rows.find(r => where.id.in.includes(r.id) && r.action.startsWith(where.action.startsWith));
      return row ? { ...row, target: SUB, detail: row.action === 'auth.logout' ? '{}'
        : JSON.stringify({ after: { id: SUB, institution: INSTITUTION, version: VERSION } }) } : null;
    } };
    this.providerChange = { findFirst: async ({ where }) => {
      log('lookup-change');
      if (scenario.has('lookup-throws')) throw new Error('synthetic lookup failure');
      return committed && where.generation === change.generation ? change : null;
    } };
  }
  async $disconnect() { log('disconnect'); if (scenario.has('disconnect-fails')) throw new Error('synthetic disconnect failure'); }
}
class KeycloakService {}
class AdminService {
  async designateFirstAdmin(sub, institution, operator, makeFacts) {
    log('designate');
    if (scenario.has('refused')) throw new ConflictException({ code: 'FIRST_ADMIN_EXISTS', message: '이 기관에는 이미 활성 관리자가 있습니다' });
    if (scenario.has('fails-before-commit')) throw new Error('synthetic failure before the transaction');
    const facts = await makeFacts();
    await facts.request.work.transactionWithRecords(async (tx, record) => {
      if (scenario.has('callback-refused')) throw new ConflictException({ code: 'FIRST_ADMIN_EXISTS', message: '이 기관에는 이미 활성 관리자가 있습니다' });
      await record({ eventId: 'synthetic-event' }, async () => {
        await record({ eventId: 'synthetic-session-end' }, async () => ({ kind: 'AuditLog', id: String(AUDIT_ID - 1), version: null }));
        return { kind: 'AuditLog', id: String(AUDIT_ID), version: null };
      });
      return { synthetic: true };
    });
    if (scenario.has('http-after-commit')) throw new ConflictException({ code: 'SYNTHETIC_AFTER_COMMIT', message: 'synthetic' });
    return { id: sub, institution, version: VERSION, roles: ['admin'] };
  }
}
const sendRecordedRoster = async () => {
  log('send-roster');
  if (scenario.has('roster-throws')) throw new Error('synthetic provider failure');
  return scenario.has('roster-unknown') ? 'unknown' : 'done';
};
class EmrRuntime {
  constructor() { this.port = { begin: () => ({
    resolveRequestIdentity: async () => { log('operator-identity'); return '00000000-0000-4000-8000-000000000009'; },
    // As EmrRecordStore.transactionWithRecords: the callback's value once committed; LedgerFailure after a returned
    // callback whose COMMIT is known not committed (AppendNotCommitted) or unanswered (CommitUnknown).
    transactionWithRecords: async body => {
      log('transaction');
      const value = await body({}, async (event, effect) => effect());
      if (scenario.has('not-committed')) throw new LedgerFailure('AppendNotCommitted');
      committed = !scenario.has('commit-lost-not-committed');
      if (scenario.has('commit-lost') || scenario.has('commit-lost-not-committed')) throw new LedgerFailure('CommitUnknown');
      return value;
    },
    end: () => { log('work-end'); if (scenario.has('work-end-fails')) throw new Error('synthetic work end failure'); },
  }) }; }
  async start() { log('start'); if (scenario.has('start-fails')) throw new Error('synthetic ledger start failure'); }
  async stop() { log('stop'); if (scenario.has('stop-fails')) throw new Error('synthetic ledger stop failure'); }
}
const fakes = {
  'prisma.service': { PrismaService },
  'keycloak.service': { KeycloakService },
  'admin.service': { AdminService },
  'member-rights-import': { sendRecordedRoster },
  'emr-runtime/application': { EmrRuntime },
};
// Writing the outcome throws at once (as a write on a destroyed stream can); the exit code must still say it.
if (scenario.has('write-throws')) process.stdout.write = () => { throw new Error('synthetic write failure'); };
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (parent?.filename && request.startsWith('../dist/')) {
    const name = request.slice('../dist/'.length);
    return fakes[name] ? 'kin-test-fake:' + name : path.join(root, 'api', 'src', name + '.ts');
  }
  return resolve.call(this, request, parent, ...rest);
};
for (const [name, exports] of Object.entries(fakes)) {
  const id = 'kin-test-fake:' + name, mod = new Module(id);
  mod.filename = id; mod.loaded = true; mod.exports = exports;
  require.cache[id] = mod;
}
