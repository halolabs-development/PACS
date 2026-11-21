/**
 * Gateway remote support — pure rules (the request an administrator makes, the result a Gateway reports, the closed
 * diagnostics report, the state of one request).
 *
 * Rule (one place): only an admin of the Gateway's own institution (restricted study scope refused, as for Gateway Status)
 * asks for exactly one of three actions on one Gateway line (the full queueInstance of a heartbeat row of the own
 * institution): `diagnostics`, `restart`, or `update` to a version this server holds. The Gateway fetches the request over
 * its own outbound call and carries it out; nothing reaches into the hospital. The hospital's approval is who holds admin
 * in its institution, and the Gateway host's switch (GW_REMOTE_SUPPORT=off → every request answered `refused`). Whether an
 * update is installed is decided on the Gateway host by its own keys; this server never judges a signature.
 *
 * States: requested → delivered → (accepted →) done | installed | rolled_back | refused. `accepted` is an intermediate
 * state: the line takes no new request until a final one arrives (or the API restarts — memory only, like the heartbeat
 * rows). The same final again is answered as stored; a late `accepted` never covers a final; another final is a conflict.
 */
export const GATEWAY_SUPPORT_INVALID = 'GATEWAY_SUPPORT_INVALID';
export const GATEWAY_SUPPORT_RESTRICTED = 'GATEWAY_SUPPORT_RESTRICTED';
export const GATEWAY_SUPPORT_UNKNOWN_LINE = 'GATEWAY_SUPPORT_UNKNOWN_LINE';
export const GATEWAY_SUPPORT_UNKNOWN_VERSION = 'GATEWAY_SUPPORT_UNKNOWN_VERSION';
export const GATEWAY_SUPPORT_BUSY = 'GATEWAY_SUPPORT_BUSY';
export const GATEWAY_SUPPORT_NOT_FOUND = 'GATEWAY_SUPPORT_NOT_FOUND';
export const GATEWAY_SUPPORT_CONFLICT = 'GATEWAY_SUPPORT_CONFLICT';
/** The diagnostics report's bound (the agent fits its report to it) and the result route's body bound. */
export const GATEWAY_DIAGNOSTICS_MAX_BYTES = 256 * 1024;
export const GATEWAY_SUPPORT_BODY_LIMIT = 512 * 1024;
/** A bundle file this server hands to a Gateway (the agent refuses more). */
export const GATEWAY_UPDATE_MAX_BYTES = 6 * 1024 * 1024;
export const GATEWAY_UPDATES_SHOWN = 32;

export type SupportAction = 'diagnostics' | 'restart' | 'update';
export type SupportState = 'requested' | 'delivered' | 'accepted' | 'done' | 'installed' | 'rolled_back' | 'refused';
export type SupportResult = 'accepted' | 'done' | 'installed' | 'rolled_back' | 'refused';
export const SUPPORT_ACTIONS: readonly SupportAction[] = ['diagnostics', 'restart', 'update'];
export const OPEN_STATES: readonly SupportState[] = ['requested', 'delivered', 'accepted'];
const FINAL: readonly SupportState[] = ['done', 'installed', 'rolled_back', 'refused'];
/** Which results each action can end in (besides `refused`, which every action can). */
const RESULTS: Record<SupportAction, readonly SupportResult[]> = {
  diagnostics: ['done', 'refused'],
  restart: ['accepted', 'done', 'refused'],
  update: ['accepted', 'installed', 'rolled_back', 'refused'],
};

export class GatewaySupportInputError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^[0-9]{1,9}(?:\.[0-9]{1,9}){0,7}$/;
const CODE = /^[a-z_]{1,40}$/;

const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const closed = (value: Record<string, unknown>, keys: string[]) => {
  const own = Object.keys(value).sort();
  const want = [...keys].sort();
  return own.length === want.length && own.every((key, index) => key === want[index]);
};
export const validVersion = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 32 && VERSION.test(value);
/** Numeric parts, trailing zeros dropped: 1.10 > 1.9, 1.2.0 = 1.2 (the agent's rule). */
export function versionKey(value: string): number[] {
  const parts = value.split('.').map(Number);
  while (parts.length > 1 && parts[parts.length - 1] === 0) parts.pop();
  return parts;
}
export function compareVersions(a: string, b: string): number {
  const x = versionKey(a), y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export interface SupportRequestInput { queueInstance: string; action: SupportAction; version: string | null }

/** The administrator's body: `{ queueInstance, action, version }` — version only (and always) for `update`. */
export function parseSupportRequest(body: unknown): SupportRequestInput {
  if (!plain(body) || !closed(body, ['queueInstance', 'action', 'version'])) throw new GatewaySupportInputError('body');
  const { queueInstance, action, version } = body;
  if (typeof queueInstance !== 'string' || !UUID.test(queueInstance)) throw new GatewaySupportInputError('queueInstance');
  if (typeof action !== 'string' || !(SUPPORT_ACTIONS as readonly string[]).includes(action))
    throw new GatewaySupportInputError('action');
  if (action === 'update' ? !validVersion(version) : version !== null) throw new GatewaySupportInputError('version');
  return { queueInstance, action: action as SupportAction, version: version as string | null };
}

export interface SupportResultInput {
  epoch: string; bootId: string; result: SupportResult; code: string | null; version: string | null;
  diagnostics: Record<string, unknown> | null;
}

/** The Gateway's body for one request: closed; a report only with `done` of diagnostics (checked by the service). */
export function parseSupportResult(body: unknown): SupportResultInput {
  if (!plain(body) || !closed(body, ['epoch', 'bootId', 'result', 'code', 'version', 'diagnostics']))
    throw new GatewaySupportInputError('body');
  const { epoch, bootId, result, code, version, diagnostics } = body;
  if (typeof epoch !== 'string' || !UUID.test(epoch)) throw new GatewaySupportInputError('epoch');
  if (typeof bootId !== 'string' || !UUID.test(bootId)) throw new GatewaySupportInputError('bootId');
  if (typeof result !== 'string' || !['accepted', 'done', 'installed', 'rolled_back', 'refused'].includes(result))
    throw new GatewaySupportInputError('result');
  if (code !== null && (typeof code !== 'string' || !CODE.test(code))) throw new GatewaySupportInputError('code');
  if (version !== null && !validVersion(version)) throw new GatewaySupportInputError('version');
  if ((result === 'refused' || result === 'rolled_back') !== (code !== null)) throw new GatewaySupportInputError('code');
  if (diagnostics !== null) parseDiagnostics(diagnostics);
  return { epoch, bootId, result: result as SupportResult, code: code as string | null, version: version as string | null,
    diagnostics: diagnostics as Record<string, unknown> | null };
}

// ── the diagnostics report: a closed shape (the agent's `Support.diagnostics`) ──
type Shape = 'int' | 'num' | 'bool' | 'str' | 'version' | 'name' | 'code' | 'uid' | 'dest' | 'phase' | 'url'
  | { null: Shape } | { obj: Record<string, Shape> } | { list: Shape; max: number } | { map: Shape; max: number }
  | { log: true };
const nul = (shape: Shape): Shape => ({ null: shape });
const LAUNCHER: Shape = nul({ obj: { current: nul('name'), previous: nul('name'), running: nul('name'), installing: 'bool',
  last: nul({ obj: { version: nul('name'), result: nul('code'), code: nul('code') } }) } });
const FORWARD: Shape = { obj: { destination: 'dest', phase: 'phase', attempt: 'int', errorCode: nul('code') } };
const ROW: Shape = { obj: { uid: 'uid', phase: 'phase', attempt: 'int', errorCode: nul('code'),
  destinations: { list: 'dest', max: 10 }, forwards: { list: FORWARD, max: 9 } } };
const REPORT: Shape = { obj: {
  format: 'int', version: 'version', uptimeSeconds: 'int', launcher: LAUNCHER,
  config: { obj: { kinBaseUrl: 'url', clientId: 'str', tlsVerify: 'bool', byteBudget: 'int', pollSeconds: 'num',
    httpTimeoutSeconds: 'num', stowTimeoutSeconds: 'num', backoffBaseSeconds: 'num', backoffMaxSeconds: 'num',
    remoteSupport: 'bool' } },
  settings: { obj: { known: 'bool', revision: nul('int'), routes: nul('int'), compression: nul('code') } },
  localOrthanc: nul({ obj: { answered: 'bool', ageSeconds: 'int' } }), lastStowAgeSeconds: nul('int'),
  dataFreeBytes: nul('int'),
  queue: nul({ obj: { counts: { map: 'int', max: 16 }, total: 'int', rows: { list: ROW, max: 200 }, omitted: 'int' } }),
  log: { list: { log: true }, max: 200 },
} };
const LOG_KEY = /^[A-Za-z]{1,32}$/;
const EVENT = /^[a-z_.]{1,64}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const UID = /^[0-9.]{1,64}$/;
const PHASE = /^[a-z_]{1,24}$/;

function check(value: unknown, shape: Shape, path: string): void {
  const fail = () => { throw new GatewaySupportInputError('diagnostics' + path); };
  if (typeof shape === 'string') {
    const ok = {
      int: () => Number.isSafeInteger(value) && (value as number) >= 0,
      num: () => typeof value === 'number' && Number.isFinite(value) && value >= 0,
      bool: () => typeof value === 'boolean',
      str: () => typeof value === 'string' && value.length >= 1 && value.length <= 256 && !/[\u0000-\u001f]/.test(value),
      version: () => validVersion(value),
      name: () => value === 'builtin' || validVersion(value),
      code: () => typeof value === 'string' && CODE.test(value),
      uid: () => typeof value === 'string' && UID.test(value),
      dest: () => value === 'kin' || value === 'other' || (typeof value === 'string' && UUID.test(value)),
      phase: () => typeof value === 'string' && PHASE.test(value),
      url: () => typeof value === 'string' && value.length <= 512 && /^https?:\/\/[^\s]+$/.test(value),
    }[shape]();
    if (!ok) fail();
    return;
  }
  if ('null' in shape) { if (value !== null) check(value, shape.null, path); return; }
  if ('obj' in shape) {
    if (!plain(value) || !closed(value, Object.keys(shape.obj))) fail();
    for (const [key, inner] of Object.entries(shape.obj)) check((value as any)[key], inner, `${path}.${key}`);
    return;
  }
  if ('list' in shape) {
    if (!Array.isArray(value) || value.length > shape.max) fail();
    (value as unknown[]).forEach((item, index) => check(item, shape.list, `${path}[${index}]`));
    return;
  }
  if ('map' in shape) {
    if (!plain(value) || Object.keys(value).length > shape.max) fail();
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (!PHASE.test(key)) fail();
      check(inner, shape.map, `${path}.${key}`);
    }
    return;
  }
  // One log line: time, event, then only numbers, true/false and error codes.
  if (!plain(value) || typeof value.at !== 'string' || !TIME.test(value.at) || typeof value.event !== 'string'
    || !EVENT.test(value.event) || Object.keys(value).length > 24) fail();
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'at' || key === 'event') continue;
    if (!LOG_KEY.test(key)) fail();
    const ok = typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))
      || ((key === 'error' || key === 'code') && typeof item === 'string' && CODE.test(item));
    if (!ok) fail();
  }
}

/** The report as KIN keeps it, or an input error: the closed shape and its size bound. */
export function parseDiagnostics(value: unknown): Record<string, unknown> {
  check(value, REPORT, '');
  if (JSON.stringify(value).length > GATEWAY_DIAGNOSTICS_MAX_BYTES) throw new GatewaySupportInputError('diagnostics');
  return value as Record<string, unknown>;
}

// ── one request ──
export interface SupportRequestRow {
  id: string; institutionId: string; gateway: string; epoch: string; label: string;
  action: SupportAction; version: string | null; state: SupportState | 'claiming'; code: string | null;
  requestedBy: string; requestedAt: number; updatedAt: number; acceptedBootId: string | null;
  resultVersion: string | null; diagnostics: Record<string, unknown> | null; diagnosticsBytes: number;
}

export type SupportDecision = { kind: 'store'; state: SupportState } | { kind: 'same' } | { kind: 'conflict' }
  | { kind: 'invalid'; field: string };

/** The one state rule for a Gateway's result (see the header). */
export function decideSupportResult(row: SupportRequestRow, input: SupportResultInput): SupportDecision {
  if (!RESULTS[row.action].includes(input.result) && input.result !== 'refused') return { kind: 'invalid', field: 'result' };
  if ((input.diagnostics !== null) !== (row.action === 'diagnostics' && input.result === 'done'))
    return { kind: 'invalid', field: 'diagnostics' };
  if (row.action === 'update' && input.result !== 'accepted' && input.version !== null && row.version !== null
    && compareVersions(input.version, row.version) !== 0) return { kind: 'invalid', field: 'version' };
  const state = row.state;
  if (state === 'claiming') return { kind: 'conflict' };
  if (input.result === 'accepted') {
    if (state === 'requested' || state === 'delivered') return { kind: 'store', state: 'accepted' };
    return { kind: 'same' };   // already accepted, or a final already came: never covers it
  }
  if ((FINAL as readonly string[]).includes(state))
    return state === input.result && row.code === input.code ? { kind: 'same' } : { kind: 'conflict' };
  // A restart is done only when another run of the Gateway says so.
  if (row.action === 'restart' && input.result === 'done' && row.acceptedBootId !== null
    && row.acceptedBootId === input.bootId) return { kind: 'invalid', field: 'bootId' };
  return { kind: 'store', state: input.result };
}

/** The request as the admin console reads it (no Gateway identity, no report body). */
export function supportRequestView(row: SupportRequestRow) {
  const iso = (ms: number) => new Date(ms).toISOString();
  return { id: row.id, action: row.action, version: row.version, state: row.state, code: row.code,
    requestedBy: row.requestedBy, requestedAt: iso(row.requestedAt), updatedAt: iso(row.updatedAt),
    diagnostics: row.diagnostics !== null };
}
