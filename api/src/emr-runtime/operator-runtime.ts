import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EmrRuntime } from './application';
import { syncDirectory } from './journal-file';

const SPOOL_FILE = 'failure-spool.jsonl';
/** Written when a run's own spool has ended with records in it: from then on it has no writer and may be imported. */
const CLOSED = 'closed';

/**
 * The ledger runtime of an operator command (api/prisma/designate-first-admin.cjs, replace-sole-admin.cjs) run beside
 * the running API. It never settles pending operations (EmrRuntime role 'operator'), and each run writes its failure
 * spool in a directory of its own below <state>/operator-outage, so every spool file has one writer: two commands
 * started together never replay or truncate each other's file.
 *  - start: connect (and verify in production), then import every finished run's spool — a run directory marked
 *    closed, and the single spool file of the earlier layout — each claimed first by one atomic rename, so exactly one
 *    command imports it. A claimed spool that fails to import is put back as it was, and the start fails.
 *  - stop: stop the runtime; an empty spool directory is removed, one with records is marked closed for the next run.
 * A run that ended without stop (killed) leaves its directory unmarked: it is never imported automatically, and kept.
 */
export class OperatorRuntime {
  readonly runtime: EmrRuntime;
  private readonly base: string;
  private readonly own: string;
  constructor(url: string, stateDirectory: string) {
    this.base = path.join(stateDirectory, 'operator-outage');
    fs.mkdirSync(this.base, { recursive: true, mode: 0o700 });
    this.own = path.join(this.base, 'run-' + randomUUID());
    this.runtime = new EmrRuntime(url, this.own, 'operator');
  }
  get port() { return this.runtime.port; }
  async start(): Promise<void> {
    await this.runtime.start();
    await importFinishedSpools(this.base, path.basename(this.own), directory => this.runtime.importSpool(directory));
  }
  async stop(deadline: number): Promise<void> {
    await this.runtime.stop(deadline);
    closeRunSpool(this.own);
  }
}

/** A run's own spool after its writer ended: removed when empty, otherwise marked closed. */
export function closeRunSpool(directory: string): void {
  const file = path.join(directory, SPOOL_FILE);
  const empty = !fs.existsSync(file) || fs.statSync(file).size === 0;
  if (empty && fs.readdirSync(directory).every(name => name === SPOOL_FILE)) {
    fs.rmSync(directory, { recursive: true, force: true });
    return;
  }
  const marker = fs.openSync(path.join(directory, CLOSED), 'w', 0o600);
  try { fs.fsyncSync(marker); } finally { fs.closeSync(marker); }
  syncDirectory(directory);
}

/** Claims (one atomic rename each) and imports every finished spool below `base` except the caller's own run. */
export async function importFinishedSpools(base: string, ownName: string,
  importSpool: (directory: string) => Promise<number>): Promise<number> {
  let imported = 0;
  const claimName = () => 'claim-' + randomUUID();
  const claim = (from: string, to: string) => {
    try { fs.renameSync(from, to); return true; }
    catch (error: any) { if (error?.code === 'ENOENT') return false; throw error; } // another command claimed it
  };
  // The earlier layout: one spool file directly below `base`, written by an operator command that has ended.
  const legacy = path.join(base, SPOOL_FILE);
  if (fs.existsSync(legacy) && fs.statSync(legacy).size > 0) {
    const claimed = path.join(base, claimName());
    fs.mkdirSync(claimed, { mode: 0o700 });
    if (claim(legacy, path.join(claimed, SPOOL_FILE))) {
      try { imported += await importSpool(claimed); }
      catch (error) { fs.renameSync(path.join(claimed, SPOOL_FILE), legacy); fs.rmSync(claimed, { recursive: true, force: true }); throw error; }
      fs.rmSync(claimed, { recursive: true, force: true });
    } else fs.rmSync(claimed, { recursive: true, force: true });
  }
  for (const name of fs.readdirSync(base)) {
    if (!name.startsWith('run-') || name === ownName || !fs.existsSync(path.join(base, name, CLOSED))) continue;
    const claimed = path.join(base, claimName());
    if (!claim(path.join(base, name), claimed)) continue;
    try { imported += await importSpool(claimed); }
    catch (error) { fs.renameSync(claimed, path.join(base, name)); throw error; }
    fs.rmSync(claimed, { recursive: true, force: true });
  }
  return imported;
}
