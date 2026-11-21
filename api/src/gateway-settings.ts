/**
 * Gateway settings - the one place their rule lives (pure: no DB, no request).
 *
 * An institution's administrator sets, for every Gateway of the institution:
 *  - routes: which destinations a study goes to. A route names a Modality and/or a sending device's AE Title; a study
 *    matches when any of its series has that Modality and any of its instances came from that device (an empty
 *    condition matches every study). Destinations are this server ("kin") and the institution's DICOM Peers that are
 *    another PACS or device (kind store). A study goes to every destination of every route it matches - one study can
 *    hold a CT and an SR series, or come from two devices, so routes are never ranked against each other; a study no
 *    route matches goes to this server only, as before routes existed.
 *  - compression: 'lossless' re-compresses uncompressed pixel data before it is sent to this server ('none' = as stored).
 *  - retentionDays: how many whole days the Gateway keeps a local copy after every destination has it (1..3650); null =
 *    it never deletes one. The Gateway decides what is delivered (gateway/agent/agent.py Queue.retention_due); nothing
 *    undelivered is ever deleted. A Gateway receives it only when it asks for it (an older one would refuse the key).
 * No settings stored = no routes, no compression, no deletion: exactly the Gateway's behaviour before settings existed.
 *
 * `revision` grows by one with every change. A save names the revision it started from; another one in between is a
 * conflict (409), never a silent overwrite of another administrator's change.
 */
export const GATEWAY_SETTINGS_INVALID = 'GATEWAY_SETTINGS_INVALID';
export const GATEWAY_SETTINGS_STALE = 'GATEWAY_SETTINGS_STALE';
export const GATEWAY_SETTINGS_RESTRICTED = 'GATEWAY_SETTINGS_RESTRICTED';
export const GATEWAY_PEER_ROUTED = 'GATEWAY_PEER_ROUTED';
export const KIN_DESTINATION = 'kin';
export const GATEWAY_ROUTES_MAX = 32;
export const GATEWAY_DESTINATIONS_MAX = 9;
export const GATEWAY_RETENTION_DAYS_MAX = 3650;

export interface GatewayRoute { modality: string | null; sourceAe: string | null; destinations: string[] }
export interface GatewaySettings {
  revision: number; routes: GatewayRoute[]; compression: 'none' | 'lossless'; retentionDays: number | null;
}
export interface GatewayPeer { id: string; name: string; aet: string; host: string; port: number }

export const NO_GATEWAY_SETTINGS: GatewaySettings = Object.freeze({
  revision: 0, routes: [], compression: 'none', retentionDays: null }) as GatewaySettings;

const retentionDays = (value: unknown): value is number | null =>
  value === null || (Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= GATEWAY_RETENTION_DAYS_MAX);

export class GatewaySettingsInputError extends Error {
  constructor(readonly field: string, readonly code = GATEWAY_SETTINGS_INVALID) { super(field); }
}

const MODALITY = /^[A-Z0-9]{1,16}$/;
// DICOM AE: 1..16, no backslash or control character, no leading or trailing space (as a DICOM Peer's AE Title).
const AE = /^[\x21-\x5b\x5d-\x7e](?:[\x20-\x5b\x5d-\x7e]{0,14}[\x21-\x5b\x5d-\x7e])?$/;
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every(key => allowed.includes(key));
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const optional = (value: unknown, upper: boolean) => {
  if (value == null) return null;
  if (typeof value !== 'string') return undefined;
  const text = upper ? value.trim().toUpperCase() : value.trim();
  return text === '' ? null : text;
};

/**
 * The administrator's form → the settings to store. `peers` are the institution's store peers (ids). Throws
 * GatewaySettingsInputError naming the field. retentionDays: a whole number of days or null (never delete); a form
 * without the key (a page from before it) keeps `currentRetention`.
 */
export function parseGatewaySettingsInput(body: unknown, peers: Set<string>, currentRetention: number | null = null):
  { expectedRevision: number; settings: Omit<GatewaySettings, 'revision'> } {
  if (!plain(body) || !keys(body, ['revision', 'routes', 'compression', 'retentionDays']))
    throw new GatewaySettingsInputError('body');
  const { revision, routes, compression } = body;
  const days = 'retentionDays' in body ? body.retentionDays : currentRetention;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw new GatewaySettingsInputError('revision');
  if (!Array.isArray(routes) || routes.length > GATEWAY_ROUTES_MAX) throw new GatewaySettingsInputError('routes');
  const parsed: GatewayRoute[] = routes.map((route, index) => {
    const at = `routes[${index}]`;
    if (!plain(route) || !keys(route, ['modality', 'sourceAe', 'destinations'])) throw new GatewaySettingsInputError(at);
    const modality = optional(route.modality, true), sourceAe = optional(route.sourceAe, false);
    if (modality === undefined || (modality !== null && !MODALITY.test(modality)))
      throw new GatewaySettingsInputError(at + '.modality');
    if (sourceAe === undefined || (sourceAe !== null && !AE.test(sourceAe)))
      throw new GatewaySettingsInputError(at + '.sourceAe');
    const targets = route.destinations;
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > GATEWAY_DESTINATIONS_MAX
      || new Set(targets).size !== targets.length
      || !targets.every(target => typeof target === 'string' && (target === KIN_DESTINATION || peers.has(target))))
      throw new GatewaySettingsInputError(at + '.destinations');
    return { modality, sourceAe, destinations: [...targets] as string[] };
  });
  if (compression !== 'none' && compression !== 'lossless') throw new GatewaySettingsInputError('compression');
  if (!retentionDays(days)) throw new GatewaySettingsInputError('retentionDays');
  return { expectedRevision: revision as number,
    settings: { routes: parsed, compression, retentionDays: days } };
}

/** What is stored in the institution row, read back defensively: anything unreadable is "no settings" (and an
 * unreadable period is "never delete"). */
export function storedGatewaySettings(value: unknown): GatewaySettings {
  if (!plain(value)) return NO_GATEWAY_SETTINGS;
  const { revision, routes, compression } = value;
  if (!Number.isSafeInteger(revision) || !Array.isArray(routes)) return NO_GATEWAY_SETTINGS;
  const days = value.retentionDays ?? null;
  return { revision: revision as number, routes: routes as GatewayRoute[],
    compression: compression === 'lossless' ? 'lossless' : 'none', retentionDays: retentionDays(days) ? days : null };
}

/** Peer ids the stored routes name. */
export function routedPeers(settings: GatewaySettings): Set<string> {
  return new Set(settings.routes.flatMap(route => route.destinations.filter(target => target !== KIN_DESTINATION)));
}

/**
 * The current rules and the institution's store registrations used to verify their destinations. retentionDays only
 * for a Gateway that asked for it (`withRetention`): an older Gateway reads a closed shape and would refuse the key.
 */
export function gatewaySettingsAnswer(settings: GatewaySettings, peers: GatewayPeer[], withRetention = false) {
  return { revision: settings.revision,
    routes: settings.routes.map(route => ({ modality: route.modality, sourceAe: route.sourceAe,
      destinations: [...route.destinations] })),
    compression: settings.compression,
    destinations: peers.map(peer => ({ id: peer.id, name: peer.name, aet: peer.aet, host: peer.host, port: peer.port })),
    ...(withRetention ? { retentionDays: settings.retentionDays } : {}) };
}

/** The audit row's detail: counts and choices, no address. */
export function gatewaySettingsAudit(settings: GatewaySettings) {
  return { revision: settings.revision, routes: settings.routes.length,
    destinations: [...new Set(settings.routes.flatMap(route => route.destinations))].sort(),
    compression: settings.compression, retentionDays: settings.retentionDays };
}
