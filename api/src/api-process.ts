/**
 * The API process's own start, for the admin console's operational status (Operations "API Uptime (since start)" and
 * "Last Restart", and the Gateway block's "since the server started"). One process serves the API (docker-compose `api`).
 * The start is `performance.timeOrigin` (the process's time origin, wall clock at start); the uptime is
 * `performance.now()` (monotonic milliseconds since that origin), so a later wall-clock change moves neither the start
 * nor the uptime.
 */
export const API_PROCESS_STARTED_AT = Math.floor(performance.timeOrigin);

export function apiProcessFacts(now: number = Date.now()) {
  return { startedAt: API_PROCESS_STARTED_AT, uptimeSeconds: Math.max(0, Math.floor(performance.now() / 1000)), observedAt: now };
}
