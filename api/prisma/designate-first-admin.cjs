'use strict';
// Operator command: designate the first administrator of an institution that has no active administrator.
// It ships in the API image and runs only as a process in that container (no screen, HTTP route or hospital
// administrator token reaches it). After that, the institution's own administrator manages its members.
//
//   node prisma/designate-first-admin.cjs --institution <group> --subject <Keycloak user id> \
//     --operator <who runs it> --reason "<why, e.g. the hospital's request and who confirmed it>"
//
// Exit 0: designated and the roster (Keycloak groups/roles) confirmed. Exit 2: designated (committed), roster
// unconfirmed — recover with `node prisma/import-member-rights.cjs --retry-roster`. Exit 1: not designated — refused,
// or failed before its transaction committed. Exit 3: the commit answer was lost and this run's audit row is not seen —
// it may still commit: check the institution's members for this person as administrator, then --retry-roster if
// they are, or the same command again if they are not.
// A failed cleanup at the end is reported on its own line and does not change the exit code.
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
const { runFirstAdminCommand } = require('../dist/first-admin-command');

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
let runtime, keycloak;
// A closed output pipe must not turn a decided outcome into a crash (the exit code below still stands).
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
// The exit code and the printed `designated` are decided in one place (api/src/first-admin-command.ts).
runFirstAdminCommand({
  subject: options.subject,
  db,
  async start() {
    // Its own failure journal: the running API is the one writer of its own.
    runtime = new EmrRuntime(process.env.DATABASE_URL, join(process.env.KIN_EMR_STATE_DIR, 'operator-outage'));
    await runtime.start();
    keycloak = new KeycloakService();
  },
  async designate(track) {
    const begun = runtime.port.begin(), work = track(begun);
    try {
      // The operator's ledger identity is resolved (written once) only after every refusal has passed.
      const makeFacts = async () => {
        const issuer = 'urn:kin:pacs:operator';
        const actor = { issuer, subject: options.operator, id: await work.resolveRequestIdentity(issuer, options.operator) };
        return { surface: 'service:first-admin-designation', actor, roles: ['admin'], rightsVersion: 0, institution: options.institution,
          ip: null, sessionRef: null, requestId: randomUUID(), request: { work, requireCurrent: async () => {} } };
      };
      const service = new AdminService(db, keycloak, null, { publishCredentials() {} });
      return await service.designateFirstAdmin(options.subject, options.institution,
        { name: options.operator, reason: options.reason }, makeFacts);
    } finally { begun.end(); }
  },
  sendRoster: change => sendRecordedRoster(db, keycloak, change),
  cleanup: [
    ['Ledger cleanup', async () => { if (runtime) await runtime.stop(Date.now() + 5000); }],
    ['Database disconnect', () => db.$disconnect()],
  ],
  out: line => process.stdout.write(line + '\n'),
  err: line => process.stderr.write(line + '\n'),
}).then(code => { process.exitCode = code; }, () => { process.exitCode = 3; });
