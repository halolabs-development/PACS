'use strict';
// Operator command: replace the sole administrator of an institution (one who left while their rights are still live)
// with a successor, after the hospital's request has been confirmed. In one transaction it suspends the predecessor and
// ends their sessions, and approves the successor as administrator, with the operator and reason in both audit rows.
// It ships in the API image and runs only as a process in that container (no screen, HTTP route or hospital
// administrator token reaches it). Afterwards the successor manages the institution's members from the screen.
//
//   node prisma/replace-sole-admin.cjs --institution <group> --from <predecessor user id> --to <successor user id> \
//     --operator <who runs it> --reason "<why, e.g. the hospital's request and who confirmed it>"
//
// The exit codes are those of designate-first-admin.cjs, printed as `replaced`. Exit 0: replaced and the roster
// (Keycloak groups/roles) confirmed. Exit 2: replaced (committed), roster unconfirmed — recover with
// `node prisma/import-member-rights.cjs --retry-roster`. Exit 1: not replaced — refused, or failed before its
// transaction committed; nothing was changed. Exit 3 (replaced:null): the commit answer was lost and this run's audit
// row is not seen, or the database could not be read — run the same command with the same arguments again. That run
// finds a saved replacement and rewrites nothing: it confirms the successor's latest roster (exit 0, or 2 unconfirmed;
// `again:"standing"`), or, when a member changed since, prints the current state and sends no roster (exit 2,
// `again:"changed"`); a replacement never saved runs from the start.
// A failed cleanup at the end is reported on its own line and does not change the exit code.
for (const name of ['DATABASE_URL', 'KC_ADMIN_URL', 'KC_REALM', 'KC_ISSUER', 'KC_CLIENT_ID', 'KC_CLIENT_SECRET', 'KIN_EMR_STATE_DIR']) {
  if (!process.env[name]) throw new Error('Missing setting: ' + name);
}
const { PrismaService } = require('../dist/prisma.service');
const { KeycloakService } = require('../dist/keycloak.service');
const { AdminService } = require('../dist/admin.service');
const { sendRecordedRoster, recoverMemberRoster } = require('../dist/member-rights-import');
const { OperatorRuntime } = require('../dist/emr-runtime/operator-runtime');
const { operatorArguments, runReplaceSoleAdminCommand } = require('../dist/first-admin-command');

const USAGE = 'Usage: replace-sole-admin.cjs --institution <group> --from <user id> --to <user id> --operator <name> --reason <text>';
const options = operatorArguments(process.argv.slice(2),
  { '--institution': 'institution', '--from': 'from', '--to': 'to', '--operator': 'operator', '--reason': 'reason' }, USAGE);

const db = new PrismaService();
let runtime, keycloak;
// A closed output pipe must not turn a decided outcome into a crash (the exit code below still stands).
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
// The exit code and the printed `replaced` are decided in one place (api/src/first-admin-command.ts).
runReplaceSoleAdminCommand({
  subject: options.to,
  db,
  async start() {
    // Beside the running API: never settles another process's pending work; a failure spool of this run's own
    // (api/src/emr-runtime/operator-runtime.ts).
    runtime = new OperatorRuntime(process.env.DATABASE_URL, process.env.KIN_EMR_STATE_DIR);
    await runtime.start();
    keycloak = new KeycloakService();
  },
  async designate(track) {
    const begun = runtime.port.begin();
    try {
      // The ledger identities of the operator and both members are resolved inside the replacement transaction, after
      // its decision under the locks: a refusal writes nothing.
      const service = new AdminService(db, keycloak, null, { publishCredentials() {} });
      return await service.replaceSoleAdmin(options.from, options.to, options.institution,
        { name: options.operator, reason: options.reason }, track(begun));
    } finally { begun.end(); }
  },
  sendRoster: change => sendRecordedRoster(db, keycloak, change),
  recoverRoster: (subject, generation) => recoverMemberRoster(db, keycloak, subject, generation),
  cleanup: [
    ['Ledger cleanup', async () => { if (runtime) await runtime.stop(Date.now() + 5000); }],
    ['Database disconnect', () => db.$disconnect()],
  ],
  out: line => process.stdout.write(line + '\n'),
  err: line => process.stderr.write(line + '\n'),
}).then(code => { process.exitCode = code; }, () => { process.exitCode = 3; });
