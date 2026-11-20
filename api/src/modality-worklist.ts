/*
 * Modality Worklist (DICOM C-FIND, Modality Worklist Information Model - FIND): what a modality is answered.
 *
 * One rule, here: the calling device's AE Title names exactly one institution among the devices its administrators
 * registered (the same resolveDevice that decides an arriving study's hospital); that institution's orders on the
 * Order List (institutionId, removedAt IS NULL) are the population; the query's keys are matched against it. Nothing
 * else decides: the station a query names, the InstitutionName it carries, an order's match to a study, its RIS
 * status, a receipt, a QC flag or a report do not widen or narrow it. A query never writes an order or a study.
 *
 * Every key the answer knows is one row of KEYS below: its VR (a request giving another VR is refused, A900), how a
 * value given to it is matched (single value: exact; person name: exact or `*` `?` wildcards; UID list; date; time; or
 * not matched, which is a warning, FF01 - except a patient attribute, where a value the order cannot be compared on
 * never matches), its return type, and the order value it returns. Values an order does not have are never made up.
 *
 * Whether a matching order can be answered is decided per order, in `returned` only, by the keys the query asks back:
 * an order with no value for a Type 1 key asked for, or with a value its VR cannot carry, is left out of that answer -
 * never sent empty or cut - and the other orders are answered. Left-out orders are counted (the audit row has the
 * count). When orders match and every one of them is left out, the query ends Unable to process (0xC003) with no
 * identifier, so the device can tell a data fault from an empty list; no match at all is a success.
 *
 * The DICOM side (association, encoding, cancel) is the helper process api/mwl/mwl_scp.py; it hands the identifier over
 * in the DICOM JSON model (PS3.18 F.2) and sends back what this module answers. This module has no I/O.
 */

/** C-FIND statuses this answer uses (PS3.4 K.4.1.1.4, PS3.7 C.4.1.1.4). */
export const MWL_STATUS = Object.freeze({
  success: 0x0000,
  pending: 0xff00,
  pendingWarning: 0xff01,
  refused: 0x0124,        // Refused: Not Authorized - the calling device names no single institution
  resources: 0xa700,      // Out of Resources - more orders to answer than one answer carries
  identifier: 0xa900,     // Identifier does not match SOP Class
  unavailable: 0xc001,    // Unable to process - the API did not answer in time (sent by the helper)
  audit: 0xc002,          // Unable to process - the query's audit row could not be written
  missingValue: 0xc003,   // Unable to process - orders match, and none of them can be carried in the keys asked back
  nameGroups: 0xc004,     // Unable to process - a person name searched in more than one representation
});

/** Orders one answer carries at most; more is answered Out of Resources, never cut short as a success. */
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
/** The order's value: a string ('' = known to be empty) or null (the order cannot say). */
type Field = (o: MwlOrder) => string | null;
type Match = 'single' | 'name' | 'uid' | 'day' | 'date' | 'time' | 'none';
interface Key { vr: string; match: Match; type: 1 | 2 | 3; value?: Field }

/**
 * A stored or queried value without its DICOM padding: leading and trailing SPACE (20H) only (PS3.5 6.2). Any other
 * white space is part of the value: an identifier that begins with an ideographic space is another identifier.
 */
const text = (v: unknown) => typeof v === 'string' ? v.replace(/^ +| +$/g, '') : '';
/** A date or time as written, read loosely: white space around it says nothing. */
const loose = (v: unknown) => typeof v === 'string' ? v.trim() : '';
/** Length in characters (Unicode code points), as a VR's limit counts them - not in UTF-16 units. */
const count = (v: string) => Array.from(v).length;

/** An order's scheduled date and time as the hospital wrote them: `YYYY-MM-DD[ HH:MM[:SS]]` or `YYYYMMDD`. */
export function scheduledAt(sched: unknown): { date: string; time: string | null } | null {
  const s = loose(sched);
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
  const b = loose(o.birth).replace(/-/g, '');
  return /^\d{8}$/.test(b) && validDate(b) ? b : '';
};
const sex = (o: MwlOrder) => ['M', 'F', 'O'].includes(text(o.sex)) ? text(o.sex) : '';
const none: Field = () => '';

/**
 * The Modality Worklist keys (PS3.4 Table K.6-1). `value` absent: the order does not hold it (returned zero length, a
 * specific value never matches it). A 1C key is listed as Type 1 when its condition holds here: no procedure or protocol
 * code sequence is given, so the descriptions are required. The keys that tell patients apart - name, ID, birth date,
 * sex - are all compared when a value is given: a query naming a birth date and a sex is answered with that patient only.
 */
const TOP: Record<string, Key> = {
  '00100010': { vr: 'PN', match: 'name', type: 1, value: o => text(o.name) },            // Patient's Name
  '00100020': { vr: 'LO', match: 'single', type: 1, value: o => text(o.patientId) },     // Patient ID
  '00100030': { vr: 'DA', match: 'day', type: 2, value: birthDate },                     // Patient's Birth Date
  '00100040': { vr: 'CS', match: 'single', type: 2, value: sex },                        // Patient's Sex
  '00101030': { vr: 'DS', match: 'none', type: 2 },                                      // Patient's Weight
  '00102000': { vr: 'LO', match: 'none', type: 2 },                                      // Medical Alerts
  '00102110': { vr: 'LO', match: 'none', type: 2 },                                      // Allergies
  '001021C0': { vr: 'US', match: 'none', type: 2 },                                      // Pregnancy Status
  '00380050': { vr: 'LO', match: 'none', type: 2 },                                      // Special Needs
  '00380500': { vr: 'LO', match: 'none', type: 2 },                                      // Patient State
  '00403001': { vr: 'LO', match: 'none', type: 2 },                                      // Confidentiality Constraint on Patient Data
  '00380010': { vr: 'LO', match: 'none', type: 2 },                                      // Admission ID
  '00380300': { vr: 'LO', match: 'none', type: 2, value: o => text(o.ward) },            // Current Patient Location
  '00081120': { vr: 'SQ', match: 'none', type: 2 },                                      // Referenced Patient Sequence
  '00080050': { vr: 'SH', match: 'single', type: 2, value: o => text(o.accession) },     // Accession Number (none = empty)
  '00321032': { vr: 'PN', match: 'name', type: 2, value: o => text(o.reqDoc) },          // Requesting Physician
  '00080090': { vr: 'PN', match: 'name', type: 2, value: none },                         // Referring Physician's Name
  '00401001': { vr: 'SH', match: 'single', type: 1, value: o => text(o.mwlProcedureId) }, // Requested Procedure ID
  '00321060': { vr: 'LO', match: 'none', type: 1, value: o => text(o.descr) },           // Requested Procedure Description (1C)
  '00321064': { vr: 'SQ', match: 'none', type: 3 },                                      // Requested Procedure Code Sequence (1C, not given)
  '0020000D': { vr: 'UI', match: 'uid', type: 1, value: o => text(o.mwlStudyUid) },      // Study Instance UID
  '00081110': { vr: 'SQ', match: 'none', type: 2 },                                      // Referenced Study Sequence
  '00401003': { vr: 'SH', match: 'none', type: 2 },                                      // Requested Procedure Priority
  '00401004': { vr: 'LO', match: 'none', type: 2 },                                      // Patient Transport Arrangements
  '00402016': { vr: 'LO', match: 'single', type: 3, value: o => text(o.oid) },           // Placer Order Number / Imaging Service Request
  '00402017': { vr: 'LO', match: 'none', type: 3 },                                      // Filler Order Number / Imaging Service Request
};
const SPS_TAG = '00400100';
/** Scheduled Procedure Step Sequence item keys. */
const SPS: Record<string, Key> = {
  '00400001': { vr: 'AE', match: 'single', type: 1, value: o => text(o.scheduledStationAet) || null }, // Scheduled Station AE Title
  '00400002': { vr: 'DA', match: 'date', type: 1, value: o => scheduledAt(o.sched)?.date ?? null },   // SPS Start Date
  '00400003': { vr: 'TM', match: 'time', type: 1, value: o => scheduledAt(o.sched)?.time ?? null },   // SPS Start Time
  '00080060': { vr: 'CS', match: 'single', type: 1, value: o => text(o.modality) || null },           // Modality
  '00400006': { vr: 'PN', match: 'name', type: 2, value: none },                                      // Scheduled Performing Physician's Name
  '00400007': { vr: 'LO', match: 'none', type: 1, value: o => text(o.descr) },                        // SPS Description (1C)
  '00400008': { vr: 'SQ', match: 'none', type: 3 },                                                   // Scheduled Protocol Code Sequence (1C, not given)
  '00400009': { vr: 'SH', match: 'single', type: 1, value: o => text(o.mwlProcedureId) },             // SPS ID
  '00400010': { vr: 'SH', match: 'none', type: 2, value: none },                                      // Scheduled Station Name
  '00400011': { vr: 'SH', match: 'none', type: 2, value: none },                                      // SPS Location
  '00400012': { vr: 'LO', match: 'none', type: 2 },                                                   // Pre-Medication
  '00321070': { vr: 'LO', match: 'none', type: 2 },                                                   // Requested Contrast Agent
  '00400020': { vr: 'CS', match: 'none', type: 3 },                                                   // SPS Status
  '00400004': { vr: 'DA', match: 'none', type: 3 },                                                   // SPS End Date
  '00400005': { vr: 'TM', match: 'none', type: 3 },                                                   // SPS End Time
};
/** Attributes every answer carries, asked for or not (PS3.4 K.4.1.2.3.1 lets the SCP add them). */
const CHARSET = '00080005', OFFSET = '00080201';

/**
 * A value fits its VR (PS3.5 6.2) as this answer writes it: one value, the VR's characters, and its length counted in
 * characters (SH 16, LO 64, PN 64 for each of at most three representations). An AE Title is the default character
 * repertoire only, 16 bytes at most.
 */
function fits(vr: string, v: string): boolean {
  if (v === '') return true;
  const plain = !/[\\\u0000-\u001f\u007f]/.test(v);
  switch (vr) {
    case 'AE': return /^[\x20-\x5b\x5d-\x7e]{1,16}$/.test(v);
    case 'CS': return /^[A-Z0-9 _]{1,16}$/.test(v);
    case 'SH': return plain && count(v) <= 16;
    case 'LO': return plain && count(v) <= 64;
    case 'PN': { const groups = v.split('='); return plain && groups.length <= 3 && groups.every(g => count(g) <= 64); }
    case 'DA': return /^\d{8}$/.test(v) && validDate(v);
    case 'TM': return /^\d{6}$/.test(v) && validTime(v);
    case 'UI': return /^(0|[1-9]\d*)(\.(0|[1-9]\d*))*$/.test(v) && v.length <= 64;
    default: return false;
  }
}

/**
 * A person name as it is compared: its representations (alphabetic, ideographic, phonetic, between `=`), each without
 * the delimiters and spaces that end it ("KIM^A^^^" is "KIM^A"). A name of delimiters only has none: it is no name.
 */
const nameParts = (v: string) => v.split('=').map(g => g.replace(/[\^ ]+$/, '').replace(/^ +/, '')).filter(Boolean);
/** A stored person name in the DICOM JSON model, each representation kept in its own place. */
function nameValue(v: string): Json {
  const [alphabetic, ideographic, phonetic] = v.split('=');
  return { vr: 'PN', Value: [{ ...(alphabetic ? { Alphabetic: alphabetic } : {}), ...(ideographic ? { Ideographic: ideographic } : {}),
    ...(phonetic ? { Phonetic: phonetic } : {}) }] };
}

type Range = { lo: string | null; hi: string | null; range: boolean };
type Entry = {
  tag: string; key: Key | null; vr: string; value: string[];
  /** A value was given to the key (for a sequence: a value somewhere inside its items), not only the key asked back. */
  given: boolean;
  /** The comparison a given value asks for, read once: a person name, or a birth date (single or range). */
  name?: (value: string) => boolean; day?: Range;
};
export interface PreparedQuery {
  top: Entry[];
  sps: null | { whole: boolean; keys: Entry[] };
  date: Range | null;
  time: Range | null;
  /** Minutes to move an order's hospital time into the query's own UTC offset (0 = the same). */
  shift: number;
  warning: boolean;
  empty: boolean;
}

export class QueryRefused extends Error {
  constructor(readonly status: number, reason: string) { super(reason); }
}
const invalid = (reason: string) => new QueryRefused(MWL_STATUS.identifier, reason);

/** A query value in the DICOM JSON model: its string values ('' for a zero-length element). */
function values(element: Json): string[] {
  const v = element?.Value;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw invalid('Value is not an array');
  return v.map(item => {
    if (item === null) return '';
    if (typeof item === 'string') return element.vr === 'PN' ? oneName(item.split('=')) : item;
    if (typeof item === 'number') return String(item);
    if (typeof item === 'object' && !Array.isArray(item) && element.vr === 'PN')
      return oneName(['Alphabetic', 'Ideographic', 'Phonetic'].map(g => item[g]));
    throw invalid('Value item is not a string');
  });
}

/** A name searched in one representation is compared with each representation the order holds; in several, it cannot be. */
function oneName(representations: unknown[]): string {
  const given = representations.map(text).filter(Boolean);
  if (given.length > 1) throw new QueryRefused(MWL_STATUS.nameGroups, 'Person name in more than one representation');
  return given[0] ?? '';
}

/** Whether an element carries a value: a non-empty one of its own, or one anywhere inside a sequence's items. */
function holdsValue(element: unknown): boolean {
  const v = (element as Json | null)?.Value;
  if (!Array.isArray(v)) return false;
  return v.some(item => {
    if (typeof item === 'string') return text(item) !== '';
    if (typeof item === 'number') return true;
    if (!item || typeof item !== 'object') return false;
    // A person name's representations, or a sequence item's elements.
    return Object.values(item).some(inner => typeof inner === 'string' ? text(inner) !== '' : holdsValue(inner));
  });
}

const DA = /^\d{8}$/;
const TM = /^(\d{2})(\d{2})?(\d{2})?(\.\d{1,6})?$/;

function dateRange(raw: string): Range {
  const v = raw.trim();
  const range = v.includes('-');
  const parts = range ? v.split('-') : [v, v];
  if (parts.length !== 2 || (!parts[0] && !parts[1])) throw invalid('Date range');
  for (const p of parts) if (p && (!DA.test(p) || !validDate(p))) throw invalid('Date value');
  if (parts[0] && parts[1] && parts[0] > parts[1]) throw invalid('Date range order');
  return { lo: parts[0] || null, hi: parts[1] || null, range };
}

/** A time bound as HHMMSS.ffffff: the start of what the value names, or its end. */
function timeBound(p: string, end: boolean): string {
  const m = TM.exec(p);
  if (!m) throw invalid('Time value');
  const hh = m[1], mm = m[2] ?? (end ? '59' : '00'), ss = m[3] ?? (end ? '59' : '00');
  const f = ((m[4] ?? '').slice(1) + (end ? '999999' : '000000')).slice(0, 6);
  const t = hh + mm + ss;
  if (!validTime(t)) throw invalid('Time value');
  return t + '.' + f;
}

function timeRange(raw: string): Range {
  const v = raw.trim();
  if (!v.includes('-')) return { lo: timeBound(v, false), hi: timeBound(v, true), range: false };
  const parts = v.split('-');
  if (parts.length !== 2 || (!parts[0] && !parts[1])) throw invalid('Time range');
  return { lo: parts[0] ? timeBound(parts[0], false) : null, hi: parts[1] ? timeBound(parts[1], true) : null, range: true };
}

function offsetMinutes(raw: string): number {
  const m = /^([+-])(\d{2})(\d{2})$/.exec(raw.trim());
  if (!m || +m[3] >= 60 || +m[2] > 14) throw invalid('Timezone Offset From UTC');
  return (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
}

function entries(identifier: Json, table: Record<string, Key>): Entry[] {
  const out: Entry[] = [];
  for (const [rawTag, element] of Object.entries(identifier)) {
    const tag = rawTag.toUpperCase();
    if (!/^[0-9A-F]{8}$/.test(tag) || !element || typeof element !== 'object') throw invalid('Element');
    if (tag === CHARSET || tag === OFFSET || tag === SPS_TAG) continue;
    // Group length and command elements are not keys.
    if (tag.endsWith('0000') || tag.startsWith('0000')) continue;
    const key = table[tag] ?? null;
    const vr = typeof element.vr === 'string' ? element.vr : '';
    if (key && vr !== key.vr) throw invalid(`Key ${tag} given as ${vr || 'no VR'}`);
    const value = vr === 'SQ' ? [] : values(element);
    // Only a list of UIDs may carry more than one value (PS3.4 C.2.2.2.2).
    if (value.length > 1 && key?.match !== 'uid') throw invalid('More than one value');
    // A sequence key with an item asks to match inside it, which this answer does not do.
    const sequenceMatch = vr === 'SQ' && Array.isArray(element.Value) && element.Value.some((i: any) => i && Object.keys(i).length);
    const entry: Entry = { tag, key, vr: key ? key.vr : (vr || 'UN'), value: sequenceMatch ? ['*'] : value, given: holdsValue(element) };
    if (entry.given && key?.match === 'name') entry.name = nameMatcher(text(value[0]));
    if (entry.given && key?.match === 'day') entry.day = dateRange(text(value[0]));
    out.push(entry);
  }
  return out;
}

/** The query as the answer reads it; QueryRefused (with its status) for a query that cannot be answered. */
export function prepareQuery(identifier: unknown): PreparedQuery {
  if (!identifier || typeof identifier !== 'object' || Array.isArray(identifier)) throw invalid('Identifier');
  const id = identifier as Json;
  const top = entries(id, TOP);
  let sps: PreparedQuery['sps'] = null;
  const spsElement = id[SPS_TAG] ?? id[SPS_TAG.toLowerCase()];
  if (spsElement !== undefined) {
    if (!spsElement || typeof spsElement !== 'object' || spsElement.vr !== 'SQ') throw invalid('Scheduled Procedure Step Sequence');
    const items = spsElement.Value ?? [];
    if (!Array.isArray(items) || items.length > 1) throw invalid('More than one Scheduled Procedure Step item');
    const item = items[0];
    if (item !== undefined && (!item || typeof item !== 'object' || Array.isArray(item))) throw invalid('SPS item');
    const keys = item ? entries(item, SPS) : [];
    sps = { whole: keys.length === 0, keys };
  }
  const first = (list: Entry[], tag: string) => list.find(e => e.tag === tag)?.value[0]?.trim() ?? '';
  const spsKeys = sps?.keys ?? [];
  const dateText = first(spsKeys, '00400002'), timeText = first(spsKeys, '00400003');
  const date = dateText ? dateRange(dateText) : null;
  const time = timeText ? timeRange(timeText) : null;
  // Two times out of order are one span only when both keys are ranges over different dates (PS3.4 C.2.2.2.5.1).
  if (time?.lo && time.hi && time.lo > time.hi && !(time.range && date?.range && date.lo && date.hi && date.lo < date.hi))
    throw invalid('Time range order');
  let shift = 0;
  const offsetElement = id[OFFSET];
  if (offsetElement) {
    if (offsetElement.vr !== 'SH') throw invalid('Timezone Offset From UTC given as ' + offsetElement.vr);
    const stated = values(offsetElement)[0]?.trim() ?? '';
    if (stated) shift = offsetMinutes(stated) - SITE_OFFSET_MINUTES;
  }
  // A key the answer does not know, or a value given to a key it returns but does not match: a warning (FF01).
  const warning = [...top, ...spsKeys].some(e => !e.key || (e.key.match === 'none' && e.value.some(v => text(v))));
  // An identifier with no key at all asks for nothing: no match (PS3.4 K.4.1.3).
  const empty = top.length === 0 && sps === null;
  return { top, sps, date, time, shift, warning, empty };
}

/**
 * Person name match for one searched name: exact, or with wildcards - `*` any run, `?` one character (a character, also
 * outside the Basic Multilingual Plane, never half of one). It holds when any representation of the order's name
 * matches. Only `*`, or a name of delimiters only, asks for every order, those without a name too.
 */
function nameMatcher(query: string): (value: string) => boolean {
  const [q] = nameParts(query);
  if (!q || /^\*+$/.test(q)) return () => true;
  if (!/[*?]/.test(q)) return value => nameParts(value).includes(q);
  const pattern = new RegExp('^' + q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'su');
  return value => nameParts(value).some(part => pattern.test(part));
}

/** The patient's own attributes (group 0010) and the reference to the patient: what a query can tell patients apart by. */
const patientKey = (tag: string) => tag.startsWith('0010') || tag === '00081120';

function keyMatch(e: Entry, o: MwlOrder): boolean {
  const k = e.key;
  // A value given to a patient attribute the order cannot be compared on (the issuer of the patient ID, another patient
  // ID, ...) is never taken as matched: nothing says the order is that patient's. For any other attribute the answer
  // does not match, the value is not used (the warning, FF01).
  if (!k || k.match === 'none') return !(e.given && patientKey(e.tag));
  if (k.match === 'date' || k.match === 'time') return true;   // the scheduled date and time: whenMatch
  if (!e.given) return true;                                   // zero length: universal match
  const have = k.value ? k.value(o) : '';
  if (k.match === 'name') return e.name!(have ?? '');
  // Every other value: an order without one never matches a value.
  if (have === null || have === '') return false;
  if (k.match === 'day') return inRange(have, e.day!);
  const q = e.value.map(text);
  return k.match === 'uid' ? q.includes(have) : have === q[0];
}

function moved(date: string, time: string, minutes: number): { date: string; time: string } {
  if (!minutes) return { date, time };
  const at = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +time.slice(0, 2), +time.slice(2, 4) + minutes, +time.slice(4, 6)));
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return { date: p(at.getUTCFullYear(), 4) + p(at.getUTCMonth() + 1) + p(at.getUTCDate()),
    time: p(at.getUTCHours()) + p(at.getUTCMinutes()) + p(at.getUTCSeconds()) };
}

const inRange = (v: string, r: Range) => (!r.lo || v >= r.lo) && (!r.hi || v <= r.hi);

/**
 * Scheduled date and time matching (PS3.4 C.2.2.2.5): the order's hospital time is first moved into the query's own UTC
 * offset. Date alone, time alone, or both: both ranges are one continuous span from the first date's start time to the
 * last date's end time; otherwise each key holds on its own. A date-only order (no time) never matches a time key; with
 * a date key and another offset it matches when either end of its day falls in the dates.
 */
function whenMatch(p: PreparedQuery, o: MwlOrder): boolean {
  if (!p.date && !p.time) return true;
  const at = scheduledAt(o.sched);
  if (!at) return false;
  if (at.time === null) {
    if (p.time) return false;
    const dates = p.shift ? [moved(at.date, '000000', p.shift).date, moved(at.date, '235959', p.shift).date] : [at.date];
    return dates.some(d => inRange(d, p.date!));
  }
  const local = moved(at.date, at.time, p.shift);
  const t = local.time + '.000000';
  if (p.date && p.time && p.date.range && p.time.range) {
    const lo = p.date.lo ? p.date.lo + (p.time.lo ?? '000000.000000') : null;
    const hi = p.date.hi ? p.date.hi + (p.time.hi ?? '235959.999999') : null;
    const mine = local.date + t;
    return (!lo || mine >= lo) && (!hi || mine <= hi);
  }
  return (!p.date || inRange(local.date, p.date)) && (!p.time || inRange(t, p.time));
}

type Asked = { tag: string; key: Key | null; vr: string };
const WHOLE_SPS: Asked[] = Object.entries(SPS).map(([tag, key]) => ({ tag, key, vr: key.vr }));

/**
 * The identifier one matching order is answered with - only the keys asked for (a whole Scheduled Procedure Step is
 * every step key), with the character set and the offset - or null when the order cannot be carried in them: it has no
 * value for a Type 1 key asked for (a person name of delimiters only is no name), or a value asked for does not fit its
 * VR. The one place that decides it, per order and only by what was asked: a flaw in a field nobody asked for leaves the
 * order in, and an order left out never takes another order with it.
 */
function returned(p: PreparedQuery, o: MwlOrder): Json | null {
  const carried = (list: readonly Asked[]): Json | null => {
    const out: Json = {};
    for (const e of list) {
      if (!e.key || e.key.vr === 'SQ') { out[e.tag] = e.vr === 'SQ' ? { vr: 'SQ', Value: [] } : { vr: e.vr }; continue; }
      let v = e.key.value ? e.key.value(o) : '';
      if (e.key.vr === 'PN' && v !== null && !nameParts(v).length) v = '';
      if (e.key.type === 1 && (v === null || v === '')) return null;
      if (v !== null && !fits(e.key.vr, v)) return null;
      out[e.tag] = v === null || v === '' ? { vr: e.key.vr } : e.key.vr === 'PN' ? nameValue(v) : { vr: e.key.vr, Value: [v] };
    }
    return out;
  };
  const top = carried(p.top);
  const step = top && p.sps ? carried(p.sps.whole ? WHOLE_SPS : p.sps.keys) : null;
  if (!top || (p.sps && !step)) return null;
  return { [CHARSET]: { vr: 'CS', Value: ['ISO_IR 192'] }, [OFFSET]: { vr: 'SH', Value: [MWL_SITE_OFFSET] }, ...top,
    ...(step ? { [SPS_TAG]: { vr: 'SQ', Value: [step] } } : {}) };
}

/** Whether an order of the institution's list answers the query. */
export function orderMatches(p: PreparedQuery, o: MwlOrder): boolean {
  if (p.empty) return false;
  return p.top.every(e => keyMatch(e, o)) && (p.sps?.keys ?? []).every(e => keyMatch(e, o)) && whenMatch(p, o);
}

/**
 * One query's answer. `matches`: the orders the keys matched; `excluded`: those of them left out because the keys asked
 * back cannot carry them (see `returned`). The counts say nothing about any value.
 */
export type MwlAnswer = { status: number; items: Json[]; warning: boolean; matches: number; excluded: number; reason?: string };

/** Answers one query over orders read page by page (`pages` yields the institution's listed orders in turn). */
export async function answerPages(identifier: unknown, pages: AsyncIterable<readonly MwlOrder[]> | Iterable<readonly MwlOrder[]>): Promise<MwlAnswer> {
  let p: PreparedQuery;
  try { p = prepareQuery(identifier); }
  catch (error) {
    if (error instanceof QueryRefused) return { status: error.status, items: [], warning: false, matches: 0, excluded: 0, reason: error.message };
    throw error;
  }
  if (p.empty) return { status: MWL_STATUS.success, items: [], warning: false, matches: 0, excluded: 0 };
  const items: Json[] = [];
  let matches = 0, excluded = 0;
  for await (const page of pages) {
    for (const o of page) {
      if (!orderMatches(p, o)) continue;
      matches += 1;
      const item = returned(p, o);
      // An order that cannot be carried is left out and counted; the next orders are still read and answered.
      if (!item) { excluded += 1; continue; }
      // The limit is on what the answer carries: orders left out do not use it up.
      if (items.length === MWL_MAX_MATCHES)
        return { status: MWL_STATUS.resources, items: [], warning: false, matches, excluded, reason: 'too many orders to answer' };
      items.push(item);
    }
  }
  // Orders matched and none can be carried: a data fault the device must be able to tell from an empty list.
  if (matches && !items.length)
    return { status: MWL_STATUS.missingValue, items: [], warning: false, matches, excluded, reason: 'no matching order can be carried in the keys asked back' };
  return { status: MWL_STATUS.success, items, warning: p.warning, matches, excluded };
}

/** The same answer over orders already in memory (one page). */
export function answerQuery(orders: readonly MwlOrder[], identifier: unknown): Promise<MwlAnswer> {
  return answerPages(identifier, [orders]);
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
