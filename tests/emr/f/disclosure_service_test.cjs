/* REQ-EMR-16 -> RISK-F-03/04 -> TEST-F-DISCLOSURE-READ.
 * New read route: saved bytes, state, integrity, scope and exact recorded targets.
 * Existing F tests own transitions; this case only verifies the new read boundary.
 */
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const { fixture, intake, F } = require('./disclosure_harness.cjs');
test('issuance read preserves saved bytes, records only disclosed versions, and enforces authority/integrity', async () => {
  const f = fixture(), input = intake();
  const prepared = await f.controller.prepare({}, input), id = prepared.issuanceId;
  const before = f.issuances.length;
  let read = await f.controller.issuance({}, id);
  assert.equal(read.status.state, 'Prepared'); assert.equal(read.artifact, null);
  assert.equal(f.issuances.length, before, 'read never issues');
  const issued = await f.controller.issue({}, id);
  read = await f.controller.issuance({}, id);
  assert.equal(read.status.state, 'Issued');
  assert.equal(read.artifact, issued.artifact); assert.equal(read.sha256, issued.sha256);
  assert.equal(createHash('sha256').update(Buffer.from(read.artifact, 'base64')).digest('hex'), read.sha256);
  assert.deepEqual(f.records.at(-1).targets, F.disclosureLedgerTargets(issued.issuance));
  const saved = f.copies.get(id); f.copies.delete(id);
  await assert.rejects(f.controller.issuance({}, id), { code: 'FixedCopyIntegrityMismatch' });
  f.copies.set(id, { ...saved, body: Buffer.from('changed') });
  await assert.rejects(f.controller.issuance({}, id), { code: 'FixedCopyIntegrityMismatch' });
  for (const [scopes, code] of [[[], 'AuditorNotDesignated'], [['inspection'], 'AuditScopeNotGranted']])
    await assert.rejects(fixture(scopes).controller.issuance({}, id), { code });
  const foreign = fixture(['disclosure'], 'OTHER-SITE');
  foreign.issuances.push(...f.issuances); foreign.copies.set(id, saved);
  await assert.rejects(foreign.controller.issuance({}, id), { code: 'IssuanceNotFound' });
  assert.equal(foreign.records.length, 0, 'foreign saved bytes are never provided');
});

test('a signed report on paper names its author and its signer apart when another doctor signed it', async () => {
  const writer = { id: 'synthetic-writer', issuer: 'synthetic', subject: 'writer' };
  const authors = html => [...html.matchAll(/<dt>(Author|Signer)<\/dt><dd[^>]*>([^<]*)<\/dd>/g)].map(m => [m[1], m[2]]);
  const paper = async f => {
    const prepared = await f.controller.prepare({}, intake('SYN-PAPER', 'in-person'));
    return Buffer.from((await f.controller.issue({}, prepared.issuanceId)).artifact, 'base64').toString('utf8');
  };
  const other = fixture(undefined, undefined, writer);
  other.members.push({ sub: 'writer', name: '박작성' }, { sub: 'auditor', name: '승인자' });
  const html = await paper(other);
  assert.deepEqual(authors(html), [['Author', '박작성 (synthetic / writer)'], ['Signer', 'SYN-DOCTOR'],
    ['Author', '박작성 (synthetic / writer)'], ['Signer', 'SYN-DOCTOR']]);
  assert.ok(html.includes('합성 원문 1 &lt;script&gt;') && html.includes('합성 원문 2 &lt;script&gt;'));
  // The signature state each version carries is on paper, the signed originals being only in the electronic copy.
  assert.deepEqual([...html.matchAll(/<dt>Signature<\/dt><dd>([^<]*)<\/dd>/g)].map(m => m[1]), ['Signed', 'Signed']);
  assert.ok(!html.includes('"envelope"') && !html.includes('keyAtSigning'));
  // Without a member name the two people are still told apart by their identifiers.
  assert.deepEqual(authors(await paper(fixture(undefined, undefined, writer))), [['Author', 'synthetic / writer'], ['Signer', 'SYN-DOCTOR'],
    ['Author', 'synthetic / writer'], ['Signer', 'SYN-DOCTOR']]);
  // The author who signed it themselves is one person: the name with the signing registration, no Signer row.
  const own = fixture(); own.members.push({ sub: 'auditor', name: '김판독' });
  assert.deepEqual(authors(await paper(own)), [['Author', '김판독 (SYN-DOCTOR)'], ['Author', '김판독 (SYN-DOCTOR)']]);
});

// CD-09-D D7 (의료법 제21조①, reduced): a report destroyed at the end of its retention gets no new copy; a copy issued
// before the destruction is still returned as issued (its bytes, its sha256).
test('a destroyed report refuses a new issue and keeps the copy issued before it', async () => {
  const f = fixture();
  const first = await f.controller.prepare({}, intake('SYN-REQUEST-ISSUED')), second = await f.controller.prepare({}, intake('SYN-REQUEST-LATER'));
  const issued = await f.controller.issue({}, first.issuanceId);
  f.destroyed.add('SYN-RECORD');
  const copies = f.copies.size;
  await assert.rejects(f.controller.issue({}, second.issuanceId), { code: 'RecordDestroyed' });
  assert.equal(f.copies.size, copies, 'no copy is written for the destroyed report');
  assert.equal((await f.controller.issuance({}, second.issuanceId)).status.state, 'Prepared');
  const again = await f.controller.issue({}, first.issuanceId);
  assert.equal(again.artifact, issued.artifact); assert.equal(again.sha256, issued.sha256);
});
