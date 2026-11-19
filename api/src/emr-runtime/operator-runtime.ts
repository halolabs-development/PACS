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
 *  - start: connect (and verify in production), then import every finished spool (importFinishedSpools), each claimed
 *    first by one atomic rename, so exactly one command imports it. A claimed spool that fails to import is put back as
 *    it was, and the start fails.
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

/** A claimed spool is named after the claiming process: `claim-<pid>-<uuid>`. */
const CLAIM = /^claim-(\d+)-/;
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code !== 'ESRCH'; }
};

/**
 * Claims (one atomic rename each) and imports every finished spool below `base` except the caller's own run: a run
 * directory marked closed, the single spool file of the earlier layout, and a spool another command claimed but did
 * not finish because its process ended. After the import a spool directory is removed only if nothing but its emptied
 * spool file is left; anything replay set aside (an incomplete last record) is kept as `kept-<uuid>` for inspection.
 * A failed import puts the spool back as it was and fails.
 */
export async function importFinishedSpools(base: string, ownName: string,
  importSpool: (directory: string) => Promise<number>): Promise<number> {
  let imported = 0;
  const claimName = () => `claim-${process.pid}-${randomUUID()}`;
  const claim = (from: string, to: string) => {
    try { fs.renameSync(from, to); return true; }
    catch (error: any) { if (error?.code === 'ENOENT') return false; throw error; } // another command claimed it
  };
  const finish = (claimed: string) => {
    const left = fs.readdirSync(claimed).filter(name => name !== CLOSED);
    const empty = left.every(name => name === SPOOL_FILE) && (!left.length || fs.statSync(path.join(claimed, SPOOL_FILE)).size === 0);
    if (empty) fs.rmSync(claimed, { recursive: true, force: true });
    else fs.renameSync(claimed, path.join(base, 'kept-' + randomUUID()));
  };
  // The earlier layout: one spool file directly below `base`, written by an operator command that has ended.
  const legacy = path.join(base, SPOOL_FILE);
  if (fs.existsSync(legacy) && fs.statSync(legacy).size > 0) {
    const claimed = path.join(base, claimName());
    fs.mkdirSync(claimed, { mode: 0o700 });
    if (claim(legacy, path.join(claimed, SPOOL_FILE))) {
      try { imported += await importSpool(claimed); }
      catch (error) { fs.renameSync(path.join(claimed, SPOOL_FILE), legacy); fs.rmSync(claimed, { recursive: true, force: true }); throw error; }
      finish(claimed);
    } else fs.rmSync(claimed, { recursive: true, force: true });
  }
  for (const name of fs.readdirSync(base)) {
    const orphan = CLAIM.exec(name);
    const finished = name.startsWith('run-') && name !== ownName && fs.existsSync(path.join(base, name, CLOSED));
    if (!finished && !(orphan && Number(orphan[1]) !== process.pid && !alive(Number(orphan[1])))) continue;
    const claimed = path.join(base, claimName());
    if (!claim(path.join(base, name), claimed)) continue;
    try { imported += await importSpool(claimed); }
    catch (error) { fs.renameSync(claimed, path.join(base, name)); throw error; }
    finish(claimed);
  }
  return imported;
}