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
 *  - retentionDays: how long the Gateway keeps its copy once every destination has it (null = keep, as before).
 *  - compression: 'lossless' re-compresses uncompressed pixel data before it is sent to this server ('none' = as stored).
 * No settings stored = no routes, keep, none: exactly the Gateway's behaviour before settings existed.
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
  revision: number; routes: GatewayRoute[]; retentionDays: number | null; compression: 'none' | 'lossless';
}
export interface GatewayPeer { id: string; name: string; aet: string; host: string; port: number }

export const NO_GATEWAY_SETTINGS: GatewaySettings = Object.freeze({
  revision: 0, routes: [], retentionDays: null, compression: 'none' }) as GatewaySettings;

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
 * GatewaySettingsInputError naming the field.
 */
export function parseGatewaySettingsInput(body: unknown, peers: Set<string>):
  { expectedRevision: number; settings: Omit<GatewaySettings, 'revision'> } {
  if (!plain(body) || !keys(body, ['revision', 'routes', 'retentionDays', 'compression']))
    throw new GatewaySettingsInputError('body');
  const { revision, routes, retentionDays, compression } = body;
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
  if (retentionDays !== null && (!Number.isSafeInteger(retentionDays) || (retentionDays as number) < 0
    || (retentionDays as number) > GATEWAY_RETENTION_DAYS_MAX))
    throw new GatewaySettingsInputError('retentionDays');
  if (compression !== 'none' && compression !== 'lossless') throw new GatewaySettingsInputError('compression');
  return { expectedRevision: revision as number,
    settings: { routes: parsed, retentionDays: retentionDays as number | null, compression } };
}

/** What is stored in the institution row, read back defensively: anything unreadable is "no settings". */
export function storedGatewaySettings(value: unknown): GatewaySettings {
  if (!plain(value)) return NO_GATEWAY_SETTINGS;
  const { revision, routes, retentionDays, compression } = value;
  if (!Number.isSafeInteger(revision) || !Array.isArray(routes)) return NO_GATEWAY_SETTINGS;
  return { revision: revision as number, routes: routes as GatewayRoute[],
    retentionDays: Number.isSafeInteger(retentionDays) ? retentionDays as number : null,
    compression: compression === 'lossless' ? 'lossless' : 'none' };
}

/** Peer ids the stored routes name. */
export function routedPeers(settings: GatewaySettings): Set<string> {
  return new Set(settings.routes.flatMap(route => route.destinations.filter(target => target !== KIN_DESTINATION)));
}

/**
 * The Gateway's answer (GET /api/gateway/settings): the settings and every store peer of the institution - not only the
 * routed ones, so a Gateway still holding a study for a peer a route no longer names can finish it. Exactly these keys.
 */
export function gatewaySettingsAnswer(settings: GatewaySettings, peers: GatewayPeer[]) {
  return { revision: settings.revision,
    routes: settings.routes.map(route => ({ modality: route.modality, sourceAe: route.sourceAe,
      destinations: [...route.destinations] })),
    retentionDays: settings.retentionDays, compression: settings.compression,
    destinations: peers.map(peer => ({ id: peer.id, name: peer.name, aet: peer.aet, host: peer.host, port: peer.port })) };
}

/** The audit row's detail: counts and choices, no address. */
export function gatewaySettingsAudit(settings: GatewaySettings) {
  return { revision: settings.revision, routes: settings.routes.length,
    destinations: [...new Set(settings.routes.flatMap(route => route.destinations))].sort(),
    retentionDays: settings.retentionDays, compression: settings.compression };
}
