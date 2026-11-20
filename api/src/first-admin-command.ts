import { HttpException } from '@nestjs/common';
import { LedgerFailure } from './emr-runtime/store';

/**
 * How the operator command api/prisma/designate-first-admin.cjs ends, decided in one place. The exit code and the
 * printed `designated` follow whether this run's designation transaction committed, not where the command failed:
 *  - 1, designated:false — not designated: refused, or failed before its transaction was asked to commit, or the
 *    transaction is known not to have committed. No rights were granted.
 *  - 0, designated:true — committed and the roster (provider groups/roles) confirmed.
 *  - 2, designated:true — committed; the roster is unconfirmed (the record lookup, the roster send or its answer failed,
 *    or the commit was settled after a failure — then the roster is not sent here, so a later change is never
 *    overwritten). Recover with `node prisma/import-member-rights.cjs --retry-roster` (each member's latest generation).
 *  - 3, designated:null — the commit answer was lost and this run's own audit row is not (or cannot be) seen: it may
 *    still have committed. Check the member list or audit log, then run --retry-roster or the same command again.
 *    The replacement (replaced:null) says first: run the same command with the same arguments again — that run finds
 *    a saved replacement and only confirms its roster, or replaces from the start; also 3 when the database cannot
 *    be read to tell whether an earlier run saved it (OutcomeUndetermined).
 *  - The replacement run again over its own saved result: `again:"standing"` — nothing rewritten, the successor's
 *    latest roster confirmed (0) or not (2); `again:"changed"` — a member changed since: the current state, no roster
 *    sent (2).
 * The run's transaction is observed through `track` (the records work the designation uses): whether its callback
 * returned (COMMIT asked), whether it resolved (committed), and the audit rows it wrote. A lost commit answer is settled
 * only by reading those audit rows by id — never by who holds the rights now. A failure of the final cleanup is reported
 * on its own line and never changes the code.
 */
export const FIRST_ADMIN_EXIT = { designated: 0, notDesignated: 1, rosterUnconfirmed: 2, unknown: 3 } as const;

export const RETRY_ROSTER = 'node prisma/import-member-rights.cjs --retry-roster';

/** Thrown by a command whose earlier run's result cannot be read (the database cannot be read): exit 3, `null`. */
export class OutcomeUndetermined extends Error {
  constructor() { super('The outcome of an earlier run cannot be read'); }
}

/** The first sentence of every exit-3 instruction of the replacement (keycloak/README.md says the same). */
export const RUN_AGAIN = '같은 명령을 같은 인자로 다시 실행하세요.';

/** An operator command's arguments: each flag of `flags` (flag -> option name) exactly once with its value, and
 * nothing else. Only the table's own flags count (an inherited name such as `constructor` is no flag). */
export function operatorArguments(args: readonly string[], flags: Readonly<Record<string, string>>, usage: string): Record<string, string> {
  if (args.length !== Object.keys(flags).length * 2) throw new Error(usage);
  const options: Record<string, string> = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    if (!Object.prototype.hasOwnProperty.call(flags, args[i])) throw new Error(usage);
    const key = flags[args[i]];
    if (Object.prototype.hasOwnProperty.call(options, key)) throw new Error(usage);
    options[key] = args[i + 1];
  }
  return options;
}

type Designation = { id: string; institution: string | null; version: number | null };
type RecordedChange = { generation: number };
type Records = {
  auditLog: { findFirst(args: any): Promise<any> };
  providerChange: { findFirst(args: any): Promise<any> };
};
type RecordsWork = { transactionWithRecords(body: (tx: any, record: any) => Promise<any>, options?: any, failureEvent?: string): Promise<any> };

export type FirstAdminCommand = {
  /** The person this run makes administrator: its own change's audit row is the one with this target. */
  subject: string;
  db: Records;
  /** Opens what the designation needs (the ledger runtime, the provider client). A failure here saved nothing. */
  start(): Promise<void>;
  /** Runs the designation; the records work it hands to the service must be `track(work)`. */
  designate(track: <W extends RecordsWork>(work: W) => W): Promise<{ id: string; institution: string; version: number }>;
  sendRoster(change: RecordedChange): Promise<string>;
  /** The same command again found its replacement standing: confirm (or complete) the member's latest roster. */
  recoverRoster?(subject: string, generation: number): Promise<string>;
  /** Run in order after the outcome is known, each whatever the others did. */
  cleanup: ReadonlyArray<readonly [string, () => Promise<void>]>;
  out(line: string): void;
  err(line: string): void;
};

/** What this run's records transaction did. 'asked': its callback returned, so COMMIT was asked; no answer yet. */
type Transaction = { phase: 'none' | 'asked' | 'committed' | 'not-committed'; auditIds: number[]; saved: boolean };

/** The records work (a plain object of functions, api/src/emr-runtime/record-port.ts) with its one records
 * transaction observed; every other function is the work's own. */
function tracker(transaction: Transaction) {
  return <W extends RecordsWork>(work: W): W => ({ ...work,
    transactionWithRecords: async (body: (tx: any, record: any) => Promise<any>, options?: any, failureEvent?: string) => {
      if (transaction.phase !== 'none') throw new Error('One designation transaction per run');
      try {
        const value = await work.transactionWithRecords(async (tx: any, record: any) => {
          const result = await body(tx, (event: any, effect: () => Promise<any>) => record(event, async () => {
            const reference = await effect();
            if (reference?.kind === 'AuditLog') transaction.auditIds.push(Number(reference.id));
            return reference;
          }));
          transaction.phase = 'asked';
          return result;
        }, options, failureEvent);
        transaction.phase = 'committed';
        return value;
      } catch (error) {
        if ((transaction.phase as Transaction['phase']) === 'asked' && error instanceof LedgerFailure && error.code === 'AppendNotCommitted')
          transaction.phase = 'not-committed';
        throw error;
      }
    } });
}


/** This run's own approval of subject (`admin.user.approve`, or `admin.user.update` when an approved member is
 * promoted), written in its transaction — so it exists only if that transaction committed. Its nested session-end
 * rows (`auth.logout`), another member's change in the same run (a replaced predecessor's `admin.user.suspend`) and
 * other runs' rows are never taken for it. */
async function ownChange(db: Records, transaction: Transaction, subject: string): Promise<Designation | null> {
  if (!transaction.auditIds.length) return null;
  const row = await db.auditLog.findFirst({ where: { id: { in: transaction.auditIds }, target: subject, action: { in: ['admin.user.approve', 'admin.user.update'] } } });
  if (!row) return null;
  const after = JSON.parse(row.detail)?.after;
  return { id: after.id, institution: after.institution, version: after.version };
}

type Say = { out(line: string): void; err(line: string): void };

/** What an operator member command calls its outcome. The codes and the rule that decides them are the same. */
type Words = { key: 'designated' | 'replaced'; failed: string; unknown: string };
const DESIGNATION: Words = { key: 'designated',
  failed: 'First administrator designation failed before it was saved; nothing was granted',
  unknown: 'Outcome unknown: the commit answer was lost; the designation may have been saved. Check the institution\'s '
    + 'members (or the audit log) for this person as administrator, then run ' + RETRY_ROSTER
    + '; if they are not, run the same command again' };
const REPLACEMENT: Words = { key: 'replaced',
  failed: 'Administrator replacement failed before it was saved; nothing was changed',
  unknown: RUN_AGAIN + ' 이번 실행의 교체가 저장됐는지 알 수 없습니다. 다시 실행하면, 저장된 교체는 아무것도 다시 쓰지 않고 '
    + '후임의 명부만 확인하며, 저장되지 않았으면 처음부터 교체합니다.' };

async function outcome(command: FirstAdminCommand, say: Say, transaction: Transaction, words: Words): Promise<number> {
  const notDesignated = (error: unknown) => {
    const body = error instanceof HttpException ? error.getResponse() : null;
    const code = body && typeof body === 'object' ? (body as any).code ?? null : null;
    const message = body && typeof body === 'object' ? (body as any).message : null;
    say.err(JSON.stringify({ [words.key]: false, code, message: typeof message === 'string' ? message : words.failed }));
    return FIRST_ADMIN_EXIT.notDesignated;
  };
  try { await command.start(); } catch (error) { return notDesignated(error); }
  let designated: Designation | null = null;
  // Only a designation this command saw return sends its own generation. Settled after a failure, a later change may
  // already be on the roster: leave the roster to --retry-roster (it sends each member's latest generation).
  let send = false;
  let again: 'standing' | 'changed' | undefined, current: unknown;
  try {
    const result: any = await command.designate(tracker(transaction));
    designated = result;
    again = result?.again; current = result?.current;
    send = true;
  } catch (error) {
    if (error instanceof OutcomeUndetermined) {
      say.err(JSON.stringify({ [words.key]: null, code: null, message: words.unknown }));
      return FIRST_ADMIN_EXIT.unknown;
    }
    if (transaction.phase === 'none' || transaction.phase === 'not-committed') return notDesignated(error);
    // Committed (a later step threw), or COMMIT asked without an answer: this run's own audit row says what was saved.
    try { designated = await ownChange(command.db, transaction, command.subject); } catch { designated = null; }
    if (!designated && transaction.phase === 'asked') {
      say.err(JSON.stringify({ [words.key]: null, code: null, message: words.unknown }));
      return FIRST_ADMIN_EXIT.unknown;
    }
    designated ??= { id: command.subject, institution: null, version: null };
  }
  // Saved. Nothing after this point may report it as not designated.
  transaction.saved = true;
  if (again === 'changed') {
    // Saved by an earlier run, and a member changed since: the current state, and no older roster sent over it.
    say.out(JSON.stringify({ [words.key]: true, institution: designated.institution, subject: designated.id,
      version: designated.version, roster: 'not-sent', again, current }));
    say.err('Saved by an earlier run; the members changed since (current state above). This run sent no roster; '
      + 'if one is unconfirmed: ' + RETRY_ROSTER);
    return FIRST_ADMIN_EXIT.rosterUnconfirmed;
  }
  let roster = 'unknown';
  try {
    if (again === 'standing') {
      if (command.recoverRoster && designated.version !== null) roster = await command.recoverRoster(command.subject, designated.version);
    } else {
      const change = !send || designated.version === null ? null : await command.db.providerChange.findFirst({ where: {
        kind: 'credentials', sub: command.subject, target: command.subject, generation: designated.version }, orderBy: { id: 'desc' } });
      if (change) roster = await command.sendRoster(change);
    }
  } catch { roster = 'unknown'; }
  say.out(JSON.stringify({ [words.key]: true, institution: designated.institution, subject: designated.id,
    version: designated.version, roster, ...(again ? { again } : {}) }));
  if (roster === 'done') return FIRST_ADMIN_EXIT.designated;
  say.err('Roster unconfirmed; recover with: ' + RETRY_ROSTER);
  return FIRST_ADMIN_EXIT.rosterUnconfirmed;
}

export function runFirstAdminCommand(command: FirstAdminCommand): Promise<number> {
  return runOperatorMemberCommand(command, DESIGNATION);
}

/** api/prisma/replace-sole-admin.cjs: the same codes, printed as `replaced`; `subject` is the successor. */
export function runReplaceSoleAdminCommand(command: FirstAdminCommand): Promise<number> {
  return runOperatorMemberCommand(command, REPLACEMENT);
}

async function runOperatorMemberCommand(command: FirstAdminCommand, words: Words): Promise<number> {
  const transaction: Transaction = { phase: 'none', auditIds: [], saved: false };
  // Writing the outcome never changes it: a failing write is dropped.
  const say: Say = { out: line => { try { command.out(line); } catch { /* the code still reports it */ } },
    err: line => { try { command.err(line); } catch { /* the code still reports it */ } } };
  let code: number;
  try { code = await outcome(command, say, transaction, words); }
  catch {
    code = transaction.saved ? FIRST_ADMIN_EXIT.rosterUnconfirmed
      : transaction.phase === 'none' || transaction.phase === 'not-committed' ? FIRST_ADMIN_EXIT.notDesignated : FIRST_ADMIN_EXIT.unknown;
    say.err(JSON.stringify({ [words.key]: code === FIRST_ADMIN_EXIT.unknown ? null : code !== FIRST_ADMIN_EXIT.notDesignated,
      code: null, message: 'The command failed while reporting its outcome' }));
  }
  for (const [label, run] of command.cleanup) {
    try { await run(); } catch { say.err(label + ' failed (the outcome above stands)'); }
  }
  return code;
}