'use strict';
/* The API's side of the Modality Worklist for tests/modality_worklist_helper_test.py: the real service and rule
 * (api/src/modality-worklist.service.ts, modality-worklist.ts) over an in-memory order table, the real device rule
 * (PacsInstitutions.resolveDevice) and the real helper (api/mwl/mwl_scp.py), which the service starts on the given port,
 * on loopback. So a DICOM client of that port is answered exactly as a modality is, without a database.
 *
 *   stdout  {"listening": port}                       the helper's port is open
 *           one JSON line for each command line read on stdin:
 *   stdin   {"orders": [...]}                         replaces the order table
 *           {"set": {"delayMs", "auditFails"}}        a slow order read; an audit table that refuses rows
 *           {"audits": true}                          the audit rows and the service's log lines so far
 *           {"stopHelper": true}                      ends the helper process (the service starts it again)
 *
 * Ends when stdin closes. Synthetic values only; no credentials, no network beyond loopback.
 *
 * Usage: node tests/modality_worklist_bridge.cjs <port> <python with pydicom and pynetdicom>
 */
require('./service_test_loader.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const { ModalityWorklistService } = require('/app/dist/modality-worklist.service');
const { PacsInstitutions } = require('/app/dist/pacs/institutions');

const [port, python] = process.argv.slice(2);
if (!/^\d+$/.test(port || '') || !python) { process.stderr.write('usage: modality_worklist_bridge.cjs <port> <python>\n'); process.exit(2); }

// Every line is ASCII, so no name depends on either process's locale.
const say = value => process.stdout.write(JSON.stringify(value).replace(/[\u0080-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n');

let rows = [];
const settings = { delayMs: 0, auditFails: false };
const audits = [], logged = [];

const institutions = new PacsInstitutions(null, null, null, null, null);
institutions.institutions = [
  { id: 'inst-a', name: 'A', dicomNames: '', dicomAets: 'SYNCT1,SYNCT2' },
  { id: 'inst-b', name: 'B', dicomNames: '', dicomAets: 'SYNCTB' },
  { id: 'inst-c', name: 'C', dicomNames: '', dicomAets: 'SYNSHARED' },
  { id: 'inst-d', name: 'D', dicomNames: '', dicomAets: 'SYNSHARED' },
];
const before = (x, y) => x.sched < y.sched || (x.sched === y.sched && x.oid < y.oid);
const prisma = {
  order: {
    findMany: async (q) => {
      if (settings.delayMs) await new Promise(r => setTimeout(r, settings.delayMs));
      const after = q.where.OR ? { sched: q.where.OR[0].sched.gt, oid: q.where.OR[1].oid.gt } : null;
      return rows.filter(o => o.institutionId === q.where.institutionId && o.removedAt === null && (!after || before(after, o)))
        .sort((x, y) => before(x, y) ? -1 : before(y, x) ? 1 : 0).slice(0, q.take)
        .map(o => Object.fromEntries(Object.keys(q.select).map(k => [k, o[k]])));
    },
  },
  auditLog: { create: async ({ data }) => {
    if (settings.auditFails) throw new Error('audit down');
    audits.push({ ...data, detail: JSON.parse(data.detail) });
    return data;
  } },
};

// The real helper, bound to loopback only: the service gives no host, so a wrapper adds it and runs the helper's own file.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mwl-bridge-'));
const real = path.resolve(__dirname, '..', 'api', 'mwl', 'mwl_scp.py');
const helper = path.join(dir, 'loopback.py');
fs.writeFileSync(helper, ['import runpy, sys', `real = ${JSON.stringify(real)}`,
  "sys.argv = [real] + sys.argv[1:] + ['--host', '127.0.0.1']", "runpy.run_path(real, run_name='__main__')", ''].join('\n'));

Object.assign(process.env, { KIN_MWL_PORT: port, KIN_MWL_AET: 'SYNMWL', KIN_MWL_PYTHON: python, KIN_MWL_HELPER: helper, KIN_MWL_ANSWER_SECONDS: '5' });
const service = new ModalityWorklistService(prisma, { resolveDevice: aet => institutions.resolveDevice(aet) });
service.log = { log: m => logged.push(['log', m]), warn: m => logged.push(['warn', m]), error: m => logged.push(['error', m]) };
service.onApplicationBootstrap();

const started = Date.now();
const opened = setInterval(() => {
  if (service.listening) { clearInterval(opened); say({ listening: Number(port) }); }
  else if (Date.now() - started > 60000) { clearInterval(opened); say({ failed: logged }); end(1); }
}, 50);

function end(code) {
  clearInterval(opened);
  service.onApplicationShutdown();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  let command;
  try { command = JSON.parse(line); } catch { return say({ error: 'not JSON' }); }
  if (Array.isArray(command.orders)) { rows = command.orders.map(o => ({ removedAt: null, ...o })); return say({ orders: rows.length }); }
  if (command.set) { Object.assign(settings, command.set); return say({ set: settings }); }
  if (command.audits) return say({ audits, logged });
  if (command.stopHelper) { const child = service.child; if (child) child.kill(); return say({ stopped: Boolean(child) }); }
  return say({ error: 'unknown command' });
}).on('close', () => end(0));
