import { KST_OFFSET_MS } from './contract';
import type { DisclosureManifest } from './contract';
import { storedClinicalPlan } from './fixed-listing';
import { nativeReportContent } from '../emr-report/native-snapshot';
import { memberNames, versionWriterName } from '../member-rights';

type Original = { recordId: string; versionId: string; original: string };
/** The member name of each version's author, by `versionKey`, read when the copy is generated. */
export type AuthorNames = ReadonlyMap<string, string>;
const esc = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fixedContentType = (manifest: DisclosureManifest) => manifest.delivery.format === 'paper-print'
  ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8';
const versionKey = (item: { recordId: string; versionId: string }) => JSON.stringify([item.recordId, item.versionId]);

/** One stored original read as the paper reads it: a native report row, or a clinical record version. */
type Source =
  | { kind: 'report'; row: Record<string, any>; signed: { at: string; author: string } | null }
  | { kind: 'clinical'; content: any; author: string; signer: string | null };
function source(item: Original): Source {
  const stored = JSON.parse(item.original);
  if (stored.reportVersion !== undefined) return { kind: 'report', row: nativeReportContent(stored.reportVersion), signed: null };
  const plan = stored.plan ? storedClinicalPlan(stored.plan) : null;
  const content = plan ? plan.version :
    JSON.parse(Buffer.from(stored.envelope.payload, 'base64url').toString('utf8'));
  const signing = stored.plan ? JSON.parse(stored.signature ?? 'null')?.registration?.doctor : stored.keyAtSigning?.doctor;
  // 의료법 제22조①: retain the registered signer identity carried by this original.
  const author = signing?.identityRegistrationId ?? (plan ? plan.signing?.identityRegistrationId : content.identityRegistrationId);
  // A signed native report version carries its stored row as the signed body (native-signing.ts).
  if (content.recordKind === 'report-version' && content.text?.kind === 'clinical-entry')
    return { kind: 'report', row: nativeReportContent(content.text.body), signed: { at: content.serverTime, author: author ?? content.author.subject } };
  const own = `${content.author.issuer} / ${content.author.subject}`, by = content.signer;
  // A report signed by someone other than its author (online-approval.ts: a preliminary approved by another doctor) names
  // both: the author by their own identity, the signer by the registration the signature carries.
  if (by && (by.id !== content.author.id || by.issuer !== content.author.issuer || by.subject !== content.author.subject))
    return { kind: 'clinical', content, author: own, signer: author ?? `${by.issuer} / ${by.subject}` };
  return { kind: 'clinical', content, author: author ?? own, signer: null };
}

/**
 * The paper names each version's author, read now and kept in the issued bytes. A native report version: the member name it
 * was written under, from its stored row (member-rights.ts versionWriterName, the one rule the report's history uses), so a
 * later rename does not change who a signed version names; a version without one names none. A clinical record version:
 * the member's name on the account of its stored author subject (member-rights.ts memberNames). A version without a name
 * is left out; the paper then prints its identifier alone, as before.
 */
export async function fixedAuthorNames(tx: any, originals: readonly Original[]): Promise<AuthorNames> {
  const accounts = new Map<string, string>(), reports = new Set<string>(), named = new Map<string, string>();
  for (const item of originals) {
    const read = source(item);
    if (read.kind === 'report') reports.add(item.recordId);
    else if (typeof read.content.author?.subject === 'string') accounts.set(versionKey(item), read.content.author.subject);
  }
  for (const uid of reports) {
    const rows: { version: number; authorName: string | null }[] = await tx.reportVersion.findMany({ where: { uid },
      orderBy: { version: 'asc' }, select: { version: true, authorName: true } });
    for (const row of rows) {
      const key = versionKey({ recordId: uid, versionId: String(row.version) }), name = versionWriterName(row);
      if (name && originals.some(o => versionKey(o) === key && source(o).kind === 'report')) named.set(key, name);
    }
  }
  const names = await memberNames(tx, [...accounts.values()]);
  for (const [key, sub] of accounts) if (names.has(sub)) named.set(key, names.get(sub) as string);
  return named;
}

/** Every time on the paper is shown in Korea Standard Time (Asia/Seoul, UTC+09:00, no daylight saving), the zone written
 * after it. A value that is not a full timestamp is printed as stored. */
export function paperTime(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  const at = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ? Date.parse(text) : NaN;
  if (!Number.isFinite(at)) return text;
  const local = new Date(at + KST_OFFSET_MS).toISOString();
  return `${local.slice(0, 10)} ${local.slice(11, 19)} KST (UTC+09:00)`;
}

const field = (label: string, value: string) => value ? `<h3>${label}</h3><pre>${esc(value)}</pre>` : '';
/** A person on the paper: the member name with the identifier the record carries beside it, or the identifier alone. */
const person = (name: string | undefined, id: string) => `<dd translate="no">${esc(name ? `${name} (${id})` : id)}</dd>`;
const REPORT_ACTIONS: Readonly<Record<string, string>> = { save: 'Saved Report', preliminary: 'Preliminary Report',
  approve: 'Approved Report', amend: 'Amendment', addendum: 'Addendum', reset: 'Cancellation' };
/** Whether a version is signed, as the issued manifest records its verified signature (fixed-versions.ts) - the one
 * answer every section prints, now that the signed originals are not on paper. */
const signature = (manifest: DisclosureManifest, item: Original) =>
  `<dt>Signature</dt><dd>${manifest.records.find(r => r.recordId === item.recordId)?.versions
    .find(v => v.versionId === item.versionId)?.signature ? 'Signed' : 'Not Signed'}</dd>`;
/** One native ReportVersion row in the report's own fields. An unsigned save is printed as not signed,
 * never under a signer's name; its author is the stored row's author. */
function reportSection(manifest: DisclosureManifest, item: Original, row: Record<string, any>,
  signed: { at: string; author: string } | null, name?: string): string {
  return `<section><h2>${REPORT_ACTIONS[row.action] ?? 'Report Version'}</h2><dl><dt>Recorded</dt><dd>${esc(paperTime(signed?.at ?? row.at))}</dd>` +
    `<dt>Author</dt>${person(name, signed?.author ?? row.author)}${signature(manifest, item)}` +
    `<dt>Study</dt><dd>${esc(row.uid)}</dd><dt>Record</dt><dd>${esc(item.recordId)}</dd><dt>Version</dt><dd>${esc(item.versionId)}</dd></dl>` +
    field('Findings', row.findings) + field('Conclusion', row.conclusion) + field('Recommendation', row.recommendation) +
    field('Reason', row.reason ?? '') + '</section>';
}

/** Paper needs readable text: every version with its content, its author's name and Korean time. The signed source
 * strings travel only in the electronic document, unchanged. Both are generated once and reopened from the saved bytes. */
export function fixedDocument(manifest: DisclosureManifest, originals: Original[], names: AuthorNames = new Map()): Buffer {
  if (manifest.delivery.format === 'signed-electronic') return Buffer.from(JSON.stringify({ manifest, originals }), 'utf8');
  const sections = originals.map(item => {
    const read = source(item), name = names.get(versionKey(item));
    if (read.kind === 'report') return reportSection(manifest, item, read.row, read.signed, name);
    const content = read.content;
    const action = { 'approve-sign': 'Approved Report', addendum: 'Addendum', amend: 'Amendment',
      cancel: 'Cancellation', entry: 'Original Entry', 'additional-entry': 'Additional Entry', correction: 'Correction' }[content.action ?? content.act] ?? 'Record Version';
    const text = content.text?.kind === 'report'
      ? field('Findings', content.text.findings) + field('Conclusion', content.text.conclusion) + field('Recommendation', content.text.recommendation)
      : field('Content', typeof content.text === 'string' ? content.text : content.text?.body ?? '');
    return `<section><h2>${action}</h2><dl><dt>Recorded</dt><dd>${esc(paperTime(content.serverTime ?? content.at))}</dd>` +
      `<dt>Author</dt>${person(name, read.author)}` + (read.signer ? `<dt>Signer</dt>${person(undefined, read.signer)}` : '') +
      signature(manifest, item) + `<dt>Study</dt><dd>${esc(content.studyId)}</dd>` +
      `<dt>Record</dt><dd>${esc(item.recordId)}</dd><dt>Version</dt><dd>${esc(item.versionId)}</dd></dl>` +
      text + field('Reason', content.reason ?? '') + '</section>';
  }).join('');
  return Buffer.from('<!doctype html><html lang="en"><meta charset="utf-8"><title>Fixed Record Copy</title>' +
    '<style>body{font:16px/1.5 sans-serif;margin:2rem;color:#17212b;max-width:52rem}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}' +
    'dl{display:grid;grid-template-columns:8rem 1fr;gap:.3rem}dt{font-weight:bold}dd{margin:0;overflow-wrap:anywhere}h3{font-size:1rem;margin-bottom:0}' +
    'section{border-top:1px solid #ccc;margin-top:2rem;padding-top:1rem}@media print{section{break-inside:avoid}}</style>' +
    '<body><h1>Fixed Record Copy</h1><p>발급 시점의 고정 사본입니다. 수령 사실은 별도로 기록합니다.</p>' +
    `<dl><dt>Patient ID</dt><dd>${esc(manifest.patient.patientId)}</dd><dt>Assigning Authority</dt><dd>${esc(manifest.patient.assigningAuthority)}</dd>` +
    `<dt>Institution</dt><dd>${esc(manifest.institutionId)}</dd><dt>Prepared</dt><dd>${esc(paperTime(manifest.preparedAt))}</dd>` +
    `<dt>Recipient</dt><dd>${esc(manifest.delivery.recipient)}</dd></dl>${sections}</body></html>`, 'utf8');
}
