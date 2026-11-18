'use strict';
// Operator command: designate the first administrator of an institution that has no active administrator.
// It ships in the API image and runs only as a process in that container (no screen, HTTP route or hospital
// administrator token reaches it). After that, the institution's own administrator manages its members.
//
//   node prisma/designate-first-admin.cjs --institution <group> --subject <Keycloak user id> \
//     --operator <who runs it> --reason "<why, e.g. the hospital's request and who confirmed it>"
//
// Exit 0: designated and the roster (Keycloak groups/roles) confirmed. Exit 2: designated, roster unconfirmed —
// recover with `node prisma/import-member-rights.cjs --retry-roster`. Exit 1: refused or failed; nothing written.
for (const name of ['DATABASE_URL', 'KC_ADMIN_URL', 'KC_REALM', 'KC_ISSUER', 'KC_CLIENT_ID', 'KC_CLIENT_SECRET', 'KIN_EMR_STATE_DIR']) {
  if (!process.env[name]) throw new Error('Missing setting: ' + name);
}
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { PrismaService } = require('../dist/prisma.service');
const { KeycloakService } = require('../dist/keycloak.service');
const { AdminService } = require('../dist/admin.service');
const { sendRecordedRoster } = require('../dist/member-rights-import');
const { EmrRuntime } = require('../dist/emr-runtime/application');

const USAGE = 'Usage: designate-first-admin.cjs --institution <group> --subject <user id> --operator <name> --reason <text>';
const options = {};
const args = process.argv.slice(2);
if (args.length !== 8) throw new Error(USAGE);
for (let i = 0; i < args.length; i += 2) {
  const key = { '--institution': 'institution', '--subject': 'subject', '--operator': 'operator', '--reason': 'reason' }[args[i]];
  if (!key || key in options) throw new Error(USAGE);
  options[key] = args[i + 1];
}

const db = new PrismaService();
let runtime;
(async () => {
  try {
    // Its own failure journal: the running API is the one writer of its own.
    runtime = new EmrRuntime(process.env.DATABASE_URL, join(process.env.KIN_EMR_STATE_DIR, 'operator-outage'));
    await runtime.start();
    const keycloak = new KeycloakService();
    const work = runtime.port.begin();
    let after;
    try {
      const issuer = 'urn:kin:pacs:operator';
      const actor = { issuer, subject: options.operator, id: await work.resolveRequestIdentity(issuer, options.operator) };
      const facts = { surface: 'service:first-admin-designation', actor, roles: ['admin'], rightsVersion: 0, institution: options.institution,
        ip: null, sessionRef: null, requestId: randomUUID(), request: { work, requireCurrent: async () => {} } };
      const service = new AdminService(db, keycloak, null, { publishCredentials() {} });
      after = await service.designateFirstAdmin(options.subject, options.institution,
        { name: options.operator, reason: options.reason }, facts);
    } finally { work.end(); }
    const change = await db.providerChange.findFirst({ where: { kind: 'credentials', sub: options.subject,
      target: options.subject, generation: after.version }, orderBy: { id: 'desc' } });
    const roster = change ? await sendRecordedRoster(db, keycloak, change) : 'unknown';
    process.stdout.write(JSON.stringify({ designated: true, institution: after.institution, subject: after.id,
      version: after.version, roster }) + '\n');
    if (roster !== 'done') {
      process.stderr.write('Roster unconfirmed; recover with: node prisma/import-member-rights.cjs --retry-roster\n');
      process.exitCode = 2;
    }
  } catch (error) {
    const body = typeof error?.getResponse === 'function' ? error.getResponse() : null;
    const code = body && typeof body === 'object' ? body.code ?? null : null;
    const message = body && typeof body === 'object' ? body.message : null;
    process.stderr.write(JSON.stringify({ designated: false, code, message: typeof message === 'string' ? message
      : 'First administrator designation failed; inspect the recorded outcome' }) + '\n');
    process.exitCode = 1;
  } finally {
    try { if (runtime) await runtime.stop(Date.now() + 5000); }
    catch { process.stderr.write('Ledger cleanup failed\n'); process.exitCode = 1; }
    finally { await db.$disconnect(); }
  }
})();
