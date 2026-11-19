/*
 * Modality Worklist (DICOM C-FIND, Modality Worklist Information Model - FIND): what a modality is answered.
 *
 * One rule, here: the calling device's AE Title names exactly one institution among the devices its administrators
 * registered (the same resolveDevice that decides an arriving study's hospital); that institution's orders on the
 * Order List (institutionId, removedAt IS NULL) are the population; the query's keys are matched against it. Nothing
 * else decides: the station a query names, the InstitutionName it carries, an order's match to a study, its RIS
 * status, a receipt, a QC flag or a report do not widen or narrow it. A query never writes an order or a study.
 *
 * The DICOM side (association, encoding, cancel) is the helper process api/mwl/mwl_scp.py; it hands the identifier over
 * in the DICOM JSON model (PS3.18 F.2) and sends back what this module answers. This module has no I/O.
 *
 * Values an order does not have are never made up: no accession is invented, the Study Instance UID and the procedure
 * identifier are the ones the database gave the order once, and a Type 1 return key the order cannot fill fails the
 * query (0xC003) instead of going out empty or silently dropping the order.
 */

/** C-FIND statuses this answer uses (PS3.4 K.4.1.1.4, PS3.7 C.4.1.1.4). */
export const MWL_STATUS = Object.freeze({
  success: 0x0000,
  pending: 0xff00,
  pendingWarning: 0xff01,
  refused: 0x0124,        // Refused: Not Authorized - the calling device names no single institution
  resources: 0xa700,      // Out of Resources - more matches than one answer carries
  identifier: 0xa900,     // Identifier does not match SOP Class
  unavailable: 0xc001,    // Unable to process - the API did not answer in time (sent by the helper)
  audit: 0xc002,          // Unable to process - the query's audit row could not be written
  missingValue: 0xc003,   // Unable to process - a matched order lacks a Type 1 value the query asked for
});

/** Matches one answer carries at most; more is answered Out of Resources, never cut short as a success. */
export const MWL_MAX_MATCHES = 5000;

/** The hospital's local time: an order's scheduled time is the hospital's wall time (Asia/Seoul, no daylight saving). */
export const MWL_SITE_OFFSET = '+0900';
const SITE_OFFSET_MINUTES = 9 * 60;

/** The order fields the answer reads (the Order row). */
export interface MwlOrder {
  oid: string; patientId: string; name: string; sex: string; birth: string; sched: string; modality: string;
  descr: string; ward: string; reqDoc: string; accession: string | null;
  mwlProcedureId: string; mwlStudyUid: string; scheduledStationAet: string | null;
}

type Json = Record<string, any>;
type Field = (o: MwlOrder) => string | null;
interface Key {
  vr: string;
  /** The order's value, '' = known to be empty, null = the order cannot say (Type 1: the query fails if asked). */
  value: Field;
  type1?: boolean;
  /** How a non-empty query value is matched: 'text' single value or wildcard, 'uid' list of UIDs, 'none' not matched. */
  match: 'text' | 'uid' | 'none' | 'date' | 'time';
}

const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';
const orNull = (v: string | null | undefined) => v == null ? null : v.trim();

/** An order's scheduled date and time as the hospital wrote them: `YYYY-MM-DD[ HH:MM[:SS]]` or `YYYYMMDD`. */
export function scheduledAt(sched: unknown): { date: string; time: string | null } | null {
  const s = text(sched);
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  let date: string, time: string | null = null;
  if (m) {
    date = m[1] + m[2] + m[3];
    if (m[4] !== undefined) time = m[4] + m[5] + (m[6] ?? '00');
  } else if ((m = /^(\d{8})$/.exec(s))) date = m[1];
  else return null;
  if (!validDate(date) || (time !== null && !validTime(time))) return null;
  return { date, time };
}

function validDate(d: string): boolean {
  const y = +d.slice(0, 4), mo = +d.slice(4, 6), da = +d.slice(6, 8);
  const at = new Date(Date.UTC(y, mo - 1, da));
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === da;
}
function validTime(t: string): boolean {
  return +t.slice(0, 2) < 24 && +t.slice(2, 4) < 60 && +t.slice(4, 6) < 60;
}

const birthDate = (o: MwlOrder) => {
  const b = text(o.birth).replace(/-/g, '');
  return /^\d{8}$/.test(b) && validDate(b) ? b : '';
};
const sex = (o: MwlOrder) => ['M', 'F', 'O'].includes(text(o.sex)) ? text(o.sex) : '';

/** Top-level keys the answer supports (PS3.4 K.6.1.2.2). */
const TOP: Record<string, Key> = {
  '00100010': { vr: 'PN', value: o => text(o.name), match: 'text' },                  // Patient's Name
  '00100020': { vr: 'LO', value: o => text(o.patientId), match: 'text' },             // Patient ID
  '00100030': { vr: 'DA', value: birthDate, match: 'none' },                          // Patient's Birth Date
  '00100040': { vr: 'CS', value: sex, match: 'none' },                                // Patient's Sex
  '00080050': { vr: 'SH', value: o => text(o.accession), match: 'text' },             // Accession Number (none = empty)
  '00080090': { vr: 'PN', value: () => '', match: 'text' },                           // Referring Physician's Name (not known)
  '00321032': { vr: 'PN', value: o => text(o.reqDoc), match: 'text' },                // Requesting Physician (the order's)
  '00401001': { vr: 'SH', value: o => text(o.mwlProcedureId), type1: true, match: 'text' }, // Requested Procedure ID
  '00321060': { vr: 'LO', value: o => text(o.descr), match: 'none' },                 // Requested Procedure Description
  '0020000D': { vr: 'UI', value: o => text(o.mwlStudyUid), type1: true, match: 'uid' }, // Study Instance UID
  '00402016': { vr: 'LO', value: o => text(o.oid), match: 'text' },                   // Placer Order Number / Imaging Service Request
  '00380300': { vr: 'LO', value: o => text(o.ward), match: 'none' },                  // Current Patient Location
};
const SPS_TAG = '00400100';
/** Scheduled Procedure Step Sequence item keys the answer supports. */
const SPS: Record<string, Key> = {
  '00080060': { vr: 'CS', value: o => text(o.modality) || null, type1: true, match: 'text' }, // Modality
  '00400001': { vr: 'AE', value: o => orNull(o.scheduledStationAet) || null, type1: true, match: 'text' }, // Scheduled Station AE Title
  '00400002': { vr: 'DA', value: o => scheduledAt(o.sched)?.date ?? null, type1: true, match: 'date' },   // SPS Start Date
  '00400003': { vr: 'TM', value: o => scheduledAt(o.sched)?.time ?? null, type1: true, match: 'time' },   // SPS Start Time
  '00400006': { vr: 'PN', value: () => '', match: 'text' },                           // Scheduled Performing Physician (not known)
  '00400007': { vr: 'LO', value: o => text(o.descr), match: 'none' },                 // SPS Description
  '00400009': { vr: 'SH', value: o => text(o.mwlProcedureId), type1: true, match: 'text' }, // SPS ID
  '00400010': { vr: 'SH', value: () => '', match: 'text' },                           // Scheduled Station Name (not known)
  '00400011': { vr: 'SH', value: () => '', match: 'text' },                           // SPS Location (not known)
};
/** Attributes every answer carries, asked for or not (PS3.4 K.4.1.2.3.1 lets the SCP add them). */
const CHARSET = '00080005', OFFSET = '00080201';

type Range = { lo: string | null; hi: string | null };
interface Parsed {
  top: { tag: string; key: Key | null; vr: string; value: string[] }[];
  sps: null | { whole: boolean; keys: { tag: string; key: Key | null; vr: string; value: string[] }[] };
  date: Range | null;
  time: Range | null;
  /** The query's own UTC offset in minutes when it states one other than the hospital's. */
  shift: number | null;
  unsupported: boolean;
  empty: boolean;
}

export class InvalidIdentifier extends Error {}

/** A query value in the DICOM JSON model: its string values ('' for a zero-length element). */
function values(element: Json): string[] {
  const v = element?.Value;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new InvalidIdentifier('Value is not an array');
  return v.map(item => {
    if (item === null) return '';
    if (typeof item === 'string') return item;
    if (typeof item === 'number') return String(item);
    if (typeof item === 'object' && !Array.isArray(item) && element.vr === 'PN')
      return typeof item.Alphabetic === 'string' ? item.Alphabetic : '';
    throw new InvalidIdentifier('Value item is not a string');
  });
}

const DA = /^\d{8}$/;
const TM = /^(\d{2})(\d{2})?(\d{2})?(\.\d{1,6})?$/;

function dateRange(raw: string): Range {
  const v = raw.trim();
  const parts = v.includes('-') ? v.split('-') : [v, v];
  if (parts.length !== 2 || (!parts[0] && !parts[1])) throw new InvalidIdentifier('Date range');
  for (const p of parts) if (p && (!DA.test(p) || !validDate(p))) throw new InvalidIdentifier('Date value');
  if (parts[0] && parts[1] && parts[0] > parts[1]) throw new InvalidIdentifier('Date range order');
  return { lo: parts[0] || null, hi: parts[1] || null };
}

/** A time bound as HHMMSS.ffffff: the start of what the value names, or its end. */
function timeBound(p: string, end: boolean): string {
  const m = TM.exec(p);
  if (!m) throw new InvalidIdentifier('Time value');
  const hh = m[1], mm = m[2] ?? (end ? '59' : '00'), ss = m[3] ?? (end ? '59' : '00');
  const frac = (m[4] ?? '').slice(1);
  const f = (frac + (end ? '999999' : '000000')).slice(0, 6);
  const t = hh + mm + ss;
  if (!validTime(t)) throw new InvalidIdentifier('Time value');
  return t + '.' + f;
}

function timeRange(raw: string): Range {
  const v = raw.trim();
  if (!v.includes('-')) return { lo: timeBound(v, false), hi: timeBound(v, true) };
  const parts = v.split('-');
  if (parts.length !== 2 || (!parts[0] && !parts[1])) throw new InvalidIdentifier('Time range');
  // The bounds' order is checked with the date: with a date range the two times are one span's ends (PS3.4 C.2.2.2.5.1).
  return { lo: parts[0] ? timeBound(parts[0], false) : null, hi: parts[1] ? timeBound(parts[1], true) : null };
}

function offsetMinutes(raw: string): number {
  const m = /^([+-])(\d{2})(\d{2})$/.exec(raw.trim());
  if (!m || +m[3] >= 60 || +m[2] > 14) throw new InvalidIdentifier('Timezone Offset From UTC');
  return (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
}

function entries(identifier: Json, table: Record<string, Key>) {
  const out: { tag: string; key: Key | null; vr: string; value: string[] }[] = [];
  for (const [rawTag, element] of Object.entries(identifier)) {
    const tag = rawTag.toUpperCase();
    if (!/^[0-9A-F]{8}$/.test(tag) || !element || typeof element !== 'object') throw new InvalidIdentifier('Element');
    if (tag === CHARSET || tag === OFFSET || tag === SPS_TAG) continue;
    // Group length and command elements are not keys.
    if (tag.endsWith('0000') || tag.startsWith('0000')) continue;
    const key = table[tag] ?? null;
    const vr = typeof element.vr === 'string' ? element.vr : '';
    if (key && vr === 'SQ') throw new InvalidIdentifier('A value key given as a sequence');
    const value = vr === 'SQ' ? [] : values(element);
    // Only a list of UIDs may carry more than one value (PS3.4 C.2.2.2.2).
    if (value.length > 1 && key?.match !== 'uid') throw new InvalidIdentifier('More than one value');
    out.push({ tag, key, vr: key ? key.vr : (vr || 'UN'), value });
  }
  return out;
}

/** The query as the answer reads it. An identifier the SOP Class does not allow throws InvalidIdentifier. */
export function parseIdentifier(identifier: unknown): Parsed {
  if (!identifier || typeof identifier !== 'object' || Array.isArray(identifier)) throw new InvalidIdentifier('Identifier');
  const id = identifier as Json;
  const top = entries(id, TOP);
  let sps: Parsed['sps'] = null;
  const spsElement = id[SPS_TAG] ?? id[SPS_TAG.toLowerCase()];
  if (spsElement !== undefined) {
    if (!spsElement || typeof spsElement !== 'object' || (spsElement.vr && spsElement.vr !== 'SQ'))
      throw new InvalidIdentifier('Scheduled Procedure Step Sequence');
    const items = spsElement.Value ?? [];
    if (!Array.isArray(items) || items.length > 1) throw new InvalidIdentifier('More than one Scheduled Procedure Step item');
    const item = items[0];
    if (item !== undefined && (!item || typeof item !== 'object' || Array.isArray(item))) throw new InvalidIdentifier('SPS item');
    const keys = item ? entries(item, SPS) : [];
    sps = { whole: keys.length === 0, keys };
  }
  const first = (list: { tag: string; value: string[] }[], tag: string) => list.find(e => e.tag === tag)?.value[0]?.trim() ?? '';
  const spsKeys = sps?.keys ?? [];
  const dateText = first(spsKeys, '00400002'), timeText = first(spsKeys, '00400003');
  const date = dateText ? dateRange(dateText) : null;
  const time = timeText ? timeRange(timeText) : null;
  if (time?.lo && time.hi && time.lo > time.hi && !(date?.lo && date.hi && date.lo < date.hi))
    throw new InvalidIdentifier('Time range order');
  const offsetElement = id[OFFSET];
  let shift: number | null = null;
  if (offsetElement) {
    const stated = values(offsetElement)[0]?.trim() ?? '';
    if (stated) {
      const minutes = offsetMinutes(stated);
      if (minutes !== SITE_OFFSET_MINUTES) shift = minutes;
    }
  }
  // A key the answer does not support is a warning (FF01), and so is a value given to a key it returns but does not match.
  const unsupported = [...top, ...spsKeys].some(e => !e.key || (e.key.match === 'none' && e.value.some(v => v.trim())));
  // An identifier with no key at all asks for nothing: no match (PS3.4 K.4.1.3).
  const empty = top.length === 0 && sps === null;
  return { top, sps, date, time, shift, unsupported, empty };
}

/** DICOM wildcard match: `*` any run, `?` one character; a value of only `*` matches every value, empty ones too. */
function textMatch(query: string, value: string): boolean {
  if (/^\*+$/.test(query)) return true;
  if (!/[*?]/.test(query)) return query === value;
  const pattern = '^' + query.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  return new RegExp(pattern, 's').test(value);
}

function matchKey(e: { key: Key | null; value: string[] }, o: MwlOrder): boolean {
  if (!e.key || e.key.match === 'none' || e.key.match === 'date' || e.key.match === 'time') return true;
  const q = e.value.map(v => v.trim());
  if (!q.length || q.every(v => !v)) return true;   // zero length: universal match
  const have = e.key.value(o);
  if (e.key.match === 'uid') return have !== null && q.includes(have);
  // A value the order does not have (unknown or empty) matches only a query of all `*`.
  if (have === null || have === '') return /^\*+$/.test(q[0]);
  return textMatch(q[0], have);
}

/** Minutes since the epoch of a hospital-local `YYYYMMDD` + `HHMMSS.ffffff`, as a sortable string with microseconds. */
function stamp(date: string, time: string): string { return date + time; }

function shiftStamp(date: string, time: string, minutes: number): { date: string; time: string } {
  const at = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +time.slice(0, 2), +time.slice(2, 4) + minutes, +time.slice(4, 6));
  const d = new Date(at);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return { date: p(d.getUTCFullYear(), 4) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()),
    time: p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + time.slice(6) };
}

/**
 * Scheduled date and time matching (PS3.4 C.2.2.2.5): date alone, time alone, or both — both together are one continuous
 * span from the first date's start time to the last date's end time. A date-only order (no time) never matches a time
 * key. A query in another UTC offset is moved to the hospital's.
 */
function whenMatch(p: Parsed, o: MwlOrder): boolean {
  if (!p.date && !p.time) return true;
  const at = scheduledAt(o.sched);
  if (!at) return false;
  if (p.time && at.time === null) return false;
  const t = at.time === null ? null : at.time + '.000000';
  if (p.shift !== null) {
    // The query's bounds are instants in its own offset; move them to the hospital's and compare instants.
    const move = SITE_OFFSET_MINUTES - p.shift;
    const loDate = p.date?.lo ?? null, hiDate = p.date?.hi ?? null;
    if (!p.date) {
      // Time alone: a window of the day, moved; a window that crosses midnight wraps.
      const lo = p.time!.lo ? shiftStamp('20000101', p.time!.lo, move).time : '000000.000000';
      const hi = p.time!.hi ? shiftStamp('20000101', p.time!.hi, move).time : '235959.999999';
      return lo <= hi ? t! >= lo && t! <= hi : t! >= lo || t! <= hi;
    }
    const lo = loDate ? shiftStamp(loDate, p.time?.lo ?? '000000.000000', move) : null;
    const hi = hiDate ? shiftStamp(hiDate, p.time?.hi ?? '235959.999999', move) : null;
    const mine = stamp(at.date, t ?? '000000.000000');
    const mineEnd = stamp(at.date, t ?? '235959.999999');
    return (!lo || mineEnd >= stamp(lo.date, lo.time)) && (!hi || mine <= stamp(hi.date, hi.time));
  }
  if (p.date && !p.time) return (!p.date.lo || at.date >= p.date.lo) && (!p.date.hi || at.date <= p.date.hi);
  if (!p.date && p.time) return (!p.time.lo || t! >= p.time.lo) && (!p.time.hi || t! <= p.time.hi);
  const lo = p.date!.lo ? stamp(p.date!.lo, p.time!.lo ?? '000000.000000') : null;
  const hi = p.date!.hi ? stamp(p.date!.hi, p.time!.hi ?? '235959.999999') : null;
  const mine = stamp(at.date, t!);
  return (!lo || mine >= lo) && (!hi || mine <= hi);
}

function element(vr: string, value: string | null): Json {
  if (value === null || value === '') return { vr };
  return vr === 'PN' ? { vr, Value: [{ Alphabetic: value }] } : { vr, Value: [value] };
}

class MissingValue extends Error {}

function returned(list: { tag: string; key: Key | null; vr: string }[], o: MwlOrder): Json {
  const out: Json = {};
  for (const e of list) {
    if (!e.key) { out[e.tag] = e.vr === 'SQ' ? { vr: 'SQ', Value: [] } : { vr: e.vr }; continue; }
    const v = e.key.value(o);
    if (e.key.type1 && (v === null || v === '')) throw new MissingValue(e.tag);
    out[e.tag] = element(e.key.vr, v);
  }
  return out;
}

const WHOLE_SPS = Object.entries(SPS).map(([tag, key]) => ({ tag, key, vr: key.vr }));

export type MwlAnswer =
  | { status: typeof MWL_STATUS.success; items: Json[]; warning: boolean; matches: number }
  | { status: number; items: []; warning: false; matches: number; reason: string };

/**
 * The answer to one query over one institution's listed orders (already chosen by the caller: the device's institution,
 * removedAt IS NULL). Returns the pending identifiers in order, or a failure status with no identifier at all.
 */
export function answerQuery(orders: readonly MwlOrder[], identifier: unknown): MwlAnswer {
  let p: Parsed;
  try { p = parseIdentifier(identifier); }
  catch (error) {
    if (error instanceof InvalidIdentifier) return { status: MWL_STATUS.identifier, items: [], warning: false, matches: 0, reason: error.message };
    throw error;
  }
  if (p.empty) return { status: MWL_STATUS.success, items: [], warning: false, matches: 0 };
  const spsKeys = p.sps?.keys ?? [];
  const matched = orders.filter(o => p.top.every(e => matchKey(e, o)) && spsKeys.every(e => matchKey(e, o)) && whenMatch(p, o));
  if (matched.length > MWL_MAX_MATCHES)
    return { status: MWL_STATUS.resources, items: [], warning: false, matches: matched.length, reason: 'too many matches' };
  const items: Json[] = [];
  try {
    for (const o of matched) {
      const item: Json = { [CHARSET]: { vr: 'CS', Value: ['ISO_IR 192'] }, [OFFSET]: { vr: 'SH', Value: [MWL_SITE_OFFSET] },
        ...returned(p.top, o) };
      if (p.sps) item[SPS_TAG] = { vr: 'SQ', Value: [returned(p.sps.whole ? WHOLE_SPS : p.sps.keys, o)] };
      items.push(item);
    }
  } catch (error) {
    if (error instanceof MissingValue)
      return { status: MWL_STATUS.missingValue, items: [], warning: false, matches: matched.length, reason: 'Type 1 value missing: ' + error.message };
    throw error;
  }
  return { status: MWL_STATUS.success, items, warning: p.unsupported, matches: matched.length };
}

/** The Order fields a query reads (Prisma select). */
export const MWL_ORDER_SELECT = Object.freeze({
  oid: true, patientId: true, name: true, sex: true, birth: true, sched: true, modality: true, descr: true, ward: true,
  reqDoc: true, accession: true, mwlProcedureId: true, mwlStudyUid: true, scheduledStationAet: true,
});

/** An AE Title as it may stand in a configuration or an audit row: 1-16 characters, no backslash or control character. */
export function aeTitle(value: unknown): string | null {
  const v = typeof value === 'string' ? value.trim() : '';
  return v && v.length <= 16 && !/[\\\u0000-\u001f\u007f]/.test(v) ? v : null;
}
