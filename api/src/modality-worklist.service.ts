/*
 * Modality Worklist: the API owns one helper process (api/mwl/mwl_scp.py, the DICOM print helper's Python and pynetdicom)
 * that accepts a modality's association and C-FIND, and asks this service, one JSON line per query, what to answer.
 * Off unless KIN_MWL_PORT is set: no port and no process otherwise (the hospital decides at go-live whether to turn it on).
 *
 * Which orders a device gets is decided only in `answer` (rule in modality-worklist.ts): the calling AE Title's one
 * institution by the registered devices (PacsService.resolveDevice, the arrival rule), that institution's orders on the
 * Order List. A query reads; the only row it writes is its audit row (device, institution, outcome, match count — no
 * patient value and no search value), committed before any patient identifier is handed back.
 */
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { PrismaService } from './prisma.service';
import { PacsService } from './pacs.service';
import { aeTitle, answerQuery, MWL_ORDER_SELECT, MWL_STATUS } from './modality-worklist';
import { dump } from './pacs/values';

export interface MwlConfig { port: number; aet: string; answerSeconds: number; python: string; script: string }

/** The helper's settings from the environment, or null (off) when KIN_MWL_PORT is not set. A bad value refuses to start. */
export function mwlConfig(env: NodeJS.ProcessEnv): MwlConfig | null {
  const raw = (env.KIN_MWL_PORT ?? '').trim();
  if (!raw) return null;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) throw new Error('KIN_MWL_PORT must be a port number (1-65535)');
  const aet = aeTitle(env.KIN_MWL_AET ?? 'KINMWL');
  if (!aet) throw new Error('KIN_MWL_AET must be an AE Title of 1-16 characters');
  const secondsRaw = (env.KIN_MWL_ANSWER_SECONDS ?? '10').trim();
  const answerSeconds = Number(secondsRaw);
  if (!/^\d+$/.test(secondsRaw) || answerSeconds < 1 || answerSeconds > 120) throw new Error('KIN_MWL_ANSWER_SECONDS must be 1-120');
  return { port, aet, answerSeconds,
    python: env.KIN_MWL_PYTHON || '/opt/kin-print/bin/python',
    script: env.KIN_MWL_HELPER || path.resolve(__dirname, '..', 'mwl', 'mwl_scp.py') };
}

const RESTART_MS = [1000, 5000, 15000, 60000];

@Injectable()
export class ModalityWorklistService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('ModalityWorklist');
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private failures = 0;
  private config: MwlConfig | null = null;

  constructor(private readonly prisma: PrismaService, private readonly pacs: PacsService) {}

  /** After every module's init (institutions and their cache are loaded): the port opens only when the API is ready. */
  onApplicationBootstrap() {
    this.config = mwlConfig(process.env);
    if (this.config) this.start();
  }

  onApplicationShutdown() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.child?.kill('SIGTERM');
    this.child = null;
  }

  /** Whether the helper reported its port open (for tests and the log). */
  listening = false;

  private start() {
    const cfg = this.config!;
    this.listening = false;
    let child: ChildProcess;
    try {
      child = spawn(cfg.python, ['-I', cfg.script, '--port', String(cfg.port), '--aet', cfg.aet,
        '--answer-seconds', String(cfg.answerSeconds)], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      this.log.error(`Modality Worklist helper could not start: ${(error as Error).message}`);
      return this.again();
    }
    this.child = child;
    let buffered = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffered += chunk;
      for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        this.line(child, line);
      }
    });
    // The helper logs no identifier; its stderr is its own diagnostics.
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => { for (const l of chunk.split('\n')) if (l.trim()) this.log.warn(l.trim().slice(0, 500)); });
    child.stdin!.on('error', () => undefined);
    child.on('error', error => this.log.error(`Modality Worklist helper: ${error.message}`));
    child.on('exit', code => {
      if (this.child === child) { this.child = null; this.listening = false; }
      if (!this.stopping) { this.log.warn(`Modality Worklist helper stopped (${code}); starting it again`); this.again(); }
    });
  }

  private again() {
    if (this.stopping || this.timer) return;
    const wait = RESTART_MS[Math.min(this.failures, RESTART_MS.length - 1)];
    this.failures++;
    this.timer = setTimeout(() => { this.timer = null; if (!this.stopping) this.start(); }, wait);
  }

  private line(child: ChildProcess, text: string) {
    let message: any;
    try { message = JSON.parse(text); } catch { return; }
    if (message?.type === 'listening') {
      this.listening = true;
      this.failures = 0;
      this.log.log(`Modality Worklist on DICOM port ${message.port} (AE ${this.config?.aet})`);
      return;
    }
    if (message?.type === 'bind_failed') { this.log.error(`Modality Worklist port not opened: ${String(message.error ?? '').slice(0, 200)}`); return; }
    if (message?.type !== 'find' || typeof message.id !== 'string') return;
    void this.answer(message.calling, message.identifier).then(result => {
      // The answer goes to the helper that asked; a helper that has since stopped never gets another's answer.
      if (child.exitCode === null && !child.killed)
        child.stdin!.write(JSON.stringify({ id: message.id, status: result.status, warning: result.warning, items: result.items }) + '\n');
    });
  }

  /**
   * One C-FIND: the device's institution, its listed orders, the match, the audit row, then the identifiers. A device that
   * names no single institution is refused (0x0124) without reading any order. Any failure answers no identifier.
   */
  async answer(calling: unknown, identifier: unknown): Promise<{ status: number; warning: boolean; items: any[] }> {
    const aet = aeTitle(calling) ?? '';
    const institution = aet ? this.pacs.resolveDevice(aet) : null;
    const audit = (outcome: string, matches: number) => this.prisma.auditLog.create({ data: {
      actor: `device:${aet || '(none)'}`, action: 'modality-worklist.query', target: institution ?? '-',
      detail: dump({ institution, aet: aet || null, outcome, matches }) } });
    if (!institution) {
      await audit('refused', 0).catch(() => undefined);
      return { status: MWL_STATUS.refused, warning: false, items: [] };
    }
    let result;
    try {
      const orders = await this.prisma.order.findMany({ where: { institutionId: institution, removedAt: null },
        select: MWL_ORDER_SELECT, orderBy: [{ sched: 'asc' }, { oid: 'asc' }] });
      result = answerQuery(orders, identifier);
    } catch (error) {
      this.log.error(`Modality Worklist query failed: ${(error as Error).message}`);
      await audit('failed', 0).catch(() => undefined);
      return { status: MWL_STATUS.unavailable, warning: false, items: [] };
    }
    const outcome = result.status === MWL_STATUS.success ? 'answered'
      : result.status === MWL_STATUS.identifier ? 'invalid' : result.status === MWL_STATUS.resources ? 'too-many' : 'failed';
    try { await audit(outcome, result.matches); }
    catch { return { status: MWL_STATUS.audit, warning: false, items: [] }; }
    return { status: result.status, warning: result.warning, items: result.items };
  }
}
