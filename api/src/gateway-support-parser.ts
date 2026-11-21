/**
 * Gateway remote support results: before Nest's JSON parser (registered beside the other route parsers in main.ts), a
 * Gateway's POST /api/gateway/support/:id is parsed as JSON with room for one diagnostics report (at most 256 KiB,
 * checked by its closed shape in gateway-support.ts). Every other path or method is left as it was.
 */
import { GATEWAY_SUPPORT_BODY_LIMIT } from './gateway-support';

export const GATEWAY_SUPPORT_RESULT_ROUTE = /^\/api\/gateway\/support\/[^/]+$/i;

export function gatewaySupportParser() {
  const json = require('express').json({ limit: GATEWAY_SUPPORT_BODY_LIMIT });
  return (req: any, res: any, next: () => void) => {
    if (req.method !== 'POST' || !GATEWAY_SUPPORT_RESULT_ROUTE.test(String(req.originalUrl ?? '').split('?')[0])) return next();
    json(req, res, next);
  };
}
