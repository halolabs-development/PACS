/*
 * Server Status for the admin console's Operations panel: one row per server component (the HALO PACS API, the image
 * store Orthanc, the HALO PACS database, the login server Keycloak), from what this request itself asked that component.
 *
 * The rule, in one place (serverComponentRows):
 *  - A component "answered" only when, in this request and within the metrics wait bound, it gave a well-formed answer.
 *    Otherwise its answer is source_failed / timeout / invalid_answer and it has no uptime.
 *  - Its uptime is only what the component itself reports: the API process (performance clock), Orthanc's own
 *    `orthanc_up_time_s` sample on GET /tools/metrics-prometheus, PostgreSQL's `now() - pg_postmaster_start_time()`.
 *    The login server reports none (no_source); it answered when its realm discovery document, read at the address the
 *    API itself uses, names exactly the issuer the API accepts (KC_ISSUER).
 *  - Each row says when it was checked; an answer is never carried over from an earlier request.
 *  - No availability percentage: nothing records a history.
 * The answer carries no address, no issuer text and no raw metrics body.
 */

export const SERVER_COMPONENTS = Object.freeze(['api', 'image_store', 'database', 'login_server'] as const);
export type ServerComponent = typeof SERVER_COMPONENTS[number];
export type ServerAnswer = 'answered' | 'source_failed' | 'timeout' | 'invalid_answer';
export type ServerUptimeReason = 'no_source' | 'source_failed' | 'timeout' | 'invalid_answer';

/** What one reader found: an answer (with what it proved) or why there is none, and when it settled (server ms). */
export type ServerRead<T> = { at: number; value: T } | { at: number; failure: Exclude<ServerAnswer, 'answered'> };

export interface ServerStatusFacts {
  api?: { uptimeSeconds: number; startedAt: number; observedAt: number };
  /** The Orthanc /statistics read this request already made (its success proves Orthanc answered). */
  imageStoreStatistics?: ServerRead<true>;
  /** Orthanc's metrics text: the uptime sample, or null when the answer has none (metrics disabled). */
  imageStoreMetrics?: ServerRead<number | null>;
  database?: ServerRead<{ uptimeSeconds: number; startedAt: number }>;
  loginServer?: ServerRead<true>;
}

const SOURCES: Record<ServerComponent, { answer: string; uptime: string | null }> = {
  api: { answer: 'HALO PACS API process', uptime: 'HALO PACS API process (performance.now, performance.timeOrigin)' },
  image_store: { answer: 'Orthanc GET /statistics, GET /tools/metrics-prometheus', uptime: 'Orthanc orthanc_up_time_s' },
  database: { answer: 'HALO PACS DB', uptime: 'PostgreSQL now() - pg_postmaster_start_time()' },
  login_server: { answer: 'Keycloak realm discovery (issuer)', uptime: null },
};
/** Ten years: a larger uptime is a broken answer. */
const MAX_UPTIME = 10 * 366 * 24 * 3600;
const uptimeOk = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_UPTIME;
const iso = (ms: number) => new Date(ms).toISOString();
const failed = <T>(read: ServerRead<T> | undefined): read is { at: number; failure: Exclude<ServerAnswer, 'answered'> } =>
  !!read && 'failure' in read;

/**
 * The `orthanc_up_time_s` sample of a Prometheus text answer (its value; an optional trailing timestamp is not the value).
 * undefined when the text is not a text answer, null when it has no such sample, NaN when the sample is unreadable.
 */
export function orthancUptimeSample(text: unknown): number | null | undefined {
  if (typeof text !== 'string') return undefined;
  const found: number[] = [];
  for (const line of text.split('\n')) {
    const match = /^orthanc_up_time_s(?:\{[^}]*\})?[ \t]+(\S+)(?:[ \t]+-?\d+)?[ \t]*\r?$/.exec(line);
    if (!match) continue;
    const value = /^\d+(?:\.\d+)?$/.test(match[1]) ? Math.floor(Number(match[1])) : NaN;
    found.push(value);
  }
  if (!found.length) return null;
  return found.length === 1 && uptimeOk(found[0]) ? found[0] : NaN;
}

/** The rows, fixed order. Pure: every fact comes in; nothing is read here. */
export function serverComponentRows(facts: ServerStatusFacts) {
  const row = (component: ServerComponent, answer: ServerAnswer, checkedAt: number | null,
    uptime: { state: 'observed' | 'unobservable'; reason: ServerUptimeReason | null; seconds: number | null; startedAt: string | null }) =>
    ({ component, answer, checkedAt: checkedAt === null ? null : iso(checkedAt), source: SOURCES[component].answer,
      uptime: { ...uptime, source: SOURCES[component].uptime } });
  const none = (reason: ServerUptimeReason) => ({ state: 'unobservable' as const, reason, seconds: null, startedAt: null });
  const rows = [];

  const api = facts.api;
  if (api && uptimeOk(api.uptimeSeconds) && Number.isSafeInteger(api.startedAt) && api.startedAt > 0 && Number.isFinite(api.observedAt))
    rows.push(row('api', 'answered', api.observedAt,
      { state: 'observed', reason: null, seconds: api.uptimeSeconds, startedAt: iso(api.startedAt) }));
  else rows.push(row('api', 'invalid_answer', null, none('invalid_answer')));

  // Orthanc answered when either read of this request got a well-formed answer; the uptime is the metrics sample only.
  const stats = facts.imageStoreStatistics, metrics = facts.imageStoreMetrics;
  const metricsAnswered = !!metrics && !failed(metrics) && (metrics.value === null || uptimeOk(metrics.value));
  const statsAnswered = !!stats && !failed(stats);
  const at = Math.max(stats?.at ?? -Infinity, metrics?.at ?? -Infinity);
  const checked = Number.isFinite(at) ? at : null;
  if (statsAnswered || metricsAnswered) {
    const uptime = metricsAnswered
      ? metrics!.value === null ? none('no_source')
        : { state: 'observed' as const, reason: null, seconds: metrics!.value as number, startedAt: null }
      : none(failed(metrics) ? metrics.failure : 'invalid_answer');
    rows.push(row('image_store', 'answered', checked, uptime));
  } else {
    const reason = failed(stats) ? stats.failure : failed(metrics) ? metrics.failure : 'invalid_answer';
    rows.push(row('image_store', reason, checked, none(reason)));
  }

  const db = facts.database;
  if (db && !failed(db) && uptimeOk(db.value.uptimeSeconds) && Number.isSafeInteger(db.value.startedAt) && db.value.startedAt > 0)
    rows.push(row('database', 'answered', db.at,
      { state: 'observed', reason: null, seconds: db.value.uptimeSeconds, startedAt: iso(db.value.startedAt) }));
  else {
    const reason = failed(db) ? db.failure : 'invalid_answer';
    rows.push(row('database', reason, db?.at ?? null, none(reason)));
  }

  const login = facts.loginServer;
  if (login && !failed(login)) rows.push(row('login_server', 'answered', login.at, none('no_source')));
  else {
    const reason = failed(login) ? login.failure : 'invalid_answer';
    rows.push(row('login_server', reason, login?.at ?? null, none(reason)));
  }
  return rows;
}

/** PostgreSQL's own start and uptime from its one-row answer; null when the answer does not prove them. */
export function databaseUptime(rows: unknown): { uptimeSeconds: number; startedAt: number } | null {
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') return null;
  const { up, started } = rows[0] as { up?: unknown; started?: unknown };
  const seconds = typeof up === 'bigint' ? Number(up) : typeof up === 'number' ? up : NaN;
  const at = started instanceof Date ? started.getTime() : NaN;
  if (!uptimeOk(seconds) || !Number.isSafeInteger(at) || at <= 0) return null;
  return { uptimeSeconds: seconds, startedAt: at };
}

/**
 * The login server's realm discovery, at the address the API itself uses for Keycloak (KC_ADMIN_URL, KC_REALM): true only
 * when it answers 200 with JSON whose `issuer` is exactly the issuer the API accepts (KC_ISSUER). Throws on a transport
 * failure (the caller maps it); `signal` is the caller's deadline. The body is bounded and never returned.
 */
export async function loginServerAnswers(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<boolean> {
  const base = (process.env.KC_ADMIN_URL ?? 'http://keycloak:8080').replace(/\/$/, '');
  const realm = process.env.KC_REALM ?? 'kin', issuer = process.env.KC_ISSUER ?? '';
  const response = await fetcher(`${base}/realms/${encodeURIComponent(realm)}/.well-known/openid-configuration`,
    { method: 'GET', redirect: 'error', signal });
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`login server HTTP ${response.status}`); }
  const text = await response.text();
  if (text.length > 262144) return false;
  let body: any;
  try { body = JSON.parse(text); } catch { return false; }
  return !!issuer && !!body && typeof body === 'object' && body.issuer === issuer;
}
