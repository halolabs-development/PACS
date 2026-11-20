'use strict';
// Image Report: a drawing attached to the report is part of its draft and of the version made from it, under the same
// boundary as the text. Real authenticated HTTP (PUT report, POST commit, the drawing reads), the guard, PostgreSQL,
// the B2 ledger and C2 signing; only identities, the study source and the PNG are synthetic.
//   - attach / remove ride the draft write: a late attach (old revision), a screen that did not see a drawing, the same
//     background without naming the drawing it replaces, a key image frame that is not the study's: refused, no change;
//   - a version holds the draft's drawings; the signature names each by the server's hash; a failed signing keeps nothing;
//   - an amendment that only removes a drawing is a change; a removed drawing does not come back in the next version;
//   - reset leaves the head without drawings and keeps them on the discarded copy; a later save does not revive them;
//   - reads: a version's drawing for any reader of the report, a draft-only drawing for its author only, a drawing no
//     version and no live draft holds for nobody; the fixed version chain (with and without drawings) still verifies.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const zlib = require('node:zlib');
const { randomUUID, randomBytes } = require('node:crypto');
const api = process.env.KIN_D_API || path.resolve(__dirname, '../../../api');
const dependency = name => require(path.join(api, 'node_modules', name));
const product = name => require(path.join(api, 'dist', name));
dependency('reflect-metadata');
const { PrismaClient } = dependency('@prisma/client');
const jose = dependency('jose');
const { Module } = dependency('@nestjs/common');
const { NestFactory, APP_GUARD } = dependency('@nestjs/core');

function png(w, h, shade = 0xff, noise = false) {
  const crc = buf => { let c, r = 0xffffffff; for (const b of buf) { c = (r ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; r = (r >>> 8) ^ c; } return (r ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = noise ? randomBytes((w * 3 + 1) * h) : Buffer.alloc((w * 3 + 1) * h, shade);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const RED = '#e0242b';
const strokes = [{ tool: 'ellipse', color: RED, points: [[0.1, 0.2], [0.3, 0.4]] }, { tool: 'text', color: RED, points: [[0.32, 0.3]], text: 'Mass 1.5 cm' }];

test('Image Report drawings ride the draft boundary, are bound and signed with the version, and are read by its rules', async () => {
  const { EmrRuntime } = product('emr-runtime/application');
  const { EMR_RECORD_PORT } = product('emr-runtime/record-port');
  const { EMR_BACKGROUND_WORK } = product('emr-runtime/background-work');
  const { PrismaService } = product('prisma.service');
  const { AuthService } = product('auth.service');
  const { PresenceService } = product('presence.service');
  const { AuthGuard } = product('auth.guard');
  const { PacsController } = product('pacs.controller');
  const { ImageReportController } = product('image-report.controller');
  const { PacsService } = product('pacs.service');
  const { StudyAccessService } = product('study-access.service');
  const { OrthancService } = product('orthanc.service');
  const { KeycloakService } = product('keycloak.service');
  const { FindingService } = product('finding.service');
  const { StudyTransferLocalService } = product('study-transfer-local.service');
  const { EmrViewingModule } = product('emr-viewing/emr-viewing.module');
  const drawingRules = product('image-report');
  const issuer = 'https://synthetic.example.test/realms/drawing', institution = 'drawing-fixture';
  const sub = 'synthetic-drawing-doctor', author = 'drawer@example.test';
  Object.assign(process.env, { KC_ISSUER: issuer, KC_AUDIENCE: 'kin-api', AUTH_REQUIRED: 'true',
    KIN_COOKIE_SECRET: randomUUID(), KC_WEB_SECRET: randomUUID(), PUBLIC_ORIGIN: 'https://synthetic.example.test' });
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  const jwk = { ...await jose.exportJWK(publicKey), kid: 'drawing-fixture', alg: 'RS256', use: 'sig' };
  const provider = require('node:http').createServer((_req, res) => {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  process.env.KC_JWKS_URL = 'http://127.0.0.1:' + provider.address().port + '/certs';
  const bearer = (email, subject) => new jose.SignJWT({ email, realm_access: { roles: ['radiologist'] }, groups: ['/' + institution] })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer).setSubject(subject).setAudience('kin-api')
    .setIssuedAt().setExpirationTime('10m').sign(privateKey);
  const token = await bearer(author, sub);
  const second = { sub: 'synthetic-drawing-second', author: 'second-drawer@example.test' };
  second.token = await bearer(second.author, second.sub);
  const witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_D_WITNESS_URL } } });
  const runtime = new EmrRuntime(process.env.DATABASE_URL, process.env.KIN_D_SPOOL);
  // CD-09-P as the server composes it (main.ts): ended works are destroyed after their commit, with their own drawings.
  const { DraftPurposeDisposal, PurposeLedgerFile, configureDraftPurpose } = product('emr-retention/draft-purpose');
  const purposeDb = new PrismaClient();
  const purpose = configureDraftPurpose(new DraftPurposeDisposal(purposeDb,
    new PurposeLedgerFile(require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'drawing-purpose-')))));
  let app, ready = false;
  try {
    await witness.memberRightsImport.create({ data: { id: 'realm-v1' } });
    for (const member of [{ sub, author }, second])
      await witness.memberRights.create({ data: { sub: member.sub, username: member.sub, email: member.author, name: 'Synthetic',
        emailVerified: true, approved: true, suspended: false, institution, roles: ['radiologist'] } });
    await runtime.start(); ready = true;
    const clinical = await require('./clinical_fixture.cjs').clinicalFixture(witness, runtime.port, issuer,
      [sub, second.sub].map(member => ({ sub: member, institution, roles: ['radiologist'] })));
    // The studies of the Merge Exam part below answer with their original patient (a merged exam needs one identified).
    const patients = new Map();
    const orthanc = { studyIdentityResources: async uid => [{ '0020000D': { Value: [uid] },
      ...(patients.has(uid) ? { '00100020': { Value: [patients.get(uid)] } } : {}) }], studyIdentities: async () => [] };
    class HttpFixture {}
    const { createRequestContext, REQUEST_CONTEXT_CAPTURE, REQUEST_CONTEXT_SOURCE } = product('emr-runtime/request-context');
    const { createRequestIngress } = product('emr-runtime/request-ingress');
    const requests = createRequestContext(createRequestIngress({ proxyPeers: ['127.0.0.1'] }), runtime.port);
    Module({ imports: [EmrViewingModule.withRequests(requests.source)],
      controllers: [PacsController, ImageReportController], providers: [PrismaService, PacsService, AuthService, PresenceService, ...clinical.providers,
      { provide: REQUEST_CONTEXT_CAPTURE, useValue: requests.capture }, { provide: REQUEST_CONTEXT_SOURCE, useValue: requests.source },
      { provide: OrthancService, useValue: orthanc }, { provide: KeycloakService, useValue: {} },
      { provide: FindingService, useValue: {} },
      { provide: StudyAccessService, useFactory: db => new StudyAccessService(db, orthanc, {}), inject: [PrismaService] },
      { provide: EMR_RECORD_PORT, useValue: runtime.port },
      { provide: EMR_BACKGROUND_WORK, useValue: runtime.background.work },
      { provide: APP_GUARD, useClass: AuthGuard }, { provide: StudyTransferLocalService, useValue: {} }] })(HttpFixture);
    app = await NestFactory.create(HttpFixture, { logger: ['error'] });
    app.use(product('report-draft-parser').reportDraftParser());   // as main.ts registers it
    app.setGlobalPrefix('api'); await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const call = async (method, uid, endpoint, body, as = token) => {
      const response = await fetch(origin + '/api/studies/' + uid + endpoint, {
        method, headers: { authorization: 'Bearer ' + as, 'content-type': 'application/json', 'x-real-ip': '192.0.2.24' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    const put = (uid, body, as) => call('PUT', uid, '/report', body, as);
    const commit = (uid, body, as) => call('POST', uid, '/report/commit', body, as);
    const read = (uid, rest = '', as) => call('GET', uid, '/report/drawings' + rest, undefined, as);
    const drawingRows = uid => witness.reportDrawing.count({ where: { studyUid: uid } });
    const discard = (uid, body, as) => call('DELETE', uid, '/draft', body, as);
    /** My draft row, the versions and the drawing rows of a study: a request the gate refuses leaves all three as they were. */
    const facts = async uid => JSON.stringify([
      await witness.reportDraft.findUnique({ where: { uid_authorSub: { uid, authorSub: sub } },
        select: { revision: true, present: true, findings: true, conclusion: true, recommendation: true, baseVersion: true, drawings: true } }),
      await witness.reportVersion.count({ where: { uid } }), await drawingRows(uid)]);
    const refusedByGate = async (uid, send, label) => {
      const before = await facts(uid), answer = await send();
      assert.equal(answer.status, 409, label + ': ' + JSON.stringify(answer.body));
      assert.equal(answer.body.code, 'REPORT_DRAWINGS_CONFLICT', label);
      assert.equal(await facts(uid), before, label + ': nothing was written');
    };

    const state = await witness.studyState.create({ data: { uid: '1.2.840.9999.137', institutionId: institution, ss: 'Verified' } });
    const other = await witness.studyState.create({ data: { uid: '1.2.840.9999.138', institutionId: institution, ss: 'Verified' } });
    const uid = state.uid, epoch = state.draftEpoch;
    const owner = { institution, sub, author };
    const texts = { findings: '합성 판독 원문', conclusion: '합성 결론', recommendation: '' };
    const base = (revision, extra = {}) => ({ expectedOwner: owner, expectedRevision: epoch + ':' + revision, baseVersion: 0,
      findings: '', conclusion: '', recommendation: '', citationIds: [], structureIds: [], ...extra });
    const breast = { background: 'breast', strokes, png: png(640, 440).toString('base64') };

    // ── the named list has three states, and no list is not an empty list ──
    // No draft yet: the screen names `null`. An empty list names a removal this study does not hold - refused, no row made.
    await refusedByGate(uid, () => put(uid, base(0, { drawingIds: [], drawing: breast })), 'a first attach naming an empty list');
    await refusedByGate(uid, () => put(uid, base(0, { drawingIds: [], findings: texts.findings })), 'a first write naming an empty list');
    await refusedByGate(uid, () => put(uid, base(0, { drawingIds: [] })), 'no text and an empty list on no draft');
    for (const wrong of [{ drawingIds: 'x' }, { drawingIds: [1] }, { expectedEffectiveDrawingIds: null }])
      assert.equal((await put(uid, base(0, { findings: texts.findings, ...wrong }))).status, 400, JSON.stringify(wrong));
    // Naming no list with no text makes no draft (on another study, so this one's revisions stay as counted below).
    const nothing = await put(other.uid, { ...base(0, { drawingIds: null }), expectedRevision: other.draftEpoch + ':0' });
    assert.equal(nothing.status, 200, JSON.stringify(nothing.body));
    assert.equal(nothing.body.present, false); assert.equal(nothing.body.snapshot, null);

    // ── attach on an empty report: the drawing alone is a draft ──
    const first = await put(uid, base(0, { drawingIds: null, drawing: breast }));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const breastId = first.body.drawn.added;
    assert.equal(first.body.present, true);
    assert.deepEqual(first.body.snapshot.drawings, [breastId]);
    assert.deepEqual(first.body.drawn.ids, [breastId]);
    const stored = await witness.reportDrawing.findUnique({ where: { id: breastId } });
    assert.equal(stored.studyUid, uid); assert.equal(stored.authorSub, sub);
    assert.equal(stored.width, 640); assert.equal(stored.height, 440);
    assert.equal(stored.sha256, drawingRules.drawingHash({ background: 'breast', source: null, strokes, png: Buffer.from(breast.png, 'base64') }));
    // It belongs to the work its attach started (the draft's own unit), the one CD-09-P destroys it with.
    const work = (await witness.reportDraft.findUnique({ where: { uid_authorSub: { uid, authorSub: sub } } })).workUnit;
    assert.match(work, /^disposal:/); assert.equal(stored.workUnit, work);

    // ── a PNG that is not a whole picture is refused before anything is read or written ──
    const truncated = await put(uid, base(1, { drawingIds: [breastId], drawing: { ...breast, background: 'thyroid',
      png: Buffer.from(breast.png, 'base64').subarray(0, 40).toString('base64') } }));
    assert.equal(truncated.status, 400, JSON.stringify(truncated.body));
    assert.equal(await drawingRows(uid), 1);
    assert.equal((await witness.reportDraft.findUnique({ where: { uid_authorSub: { uid, authorSub: sub } } })).revision, 1);
    // An unknown critical chunk (its CRC right) is one a viewer must understand: refused, nothing written.
    {
      const good = Buffer.from(breast.png, 'base64'), type = Buffer.from('ABCD'), len = Buffer.alloc(4), sum = Buffer.alloc(4);
      sum.writeUInt32BE(zlib.crc32 ? zlib.crc32(type) : 0);
      const odd = await put(uid, base(1, { drawingIds: [breastId], drawing: { ...breast, background: 'thyroid',
        png: Buffer.concat([good.subarray(0, 33), len, type, sum, good.subarray(33)]).toString('base64') } }));
      assert.equal(odd.status, 400, JSON.stringify(odd.body));
      assert.equal(await drawingRows(uid), 1);
    }    // ── a late attach (the revision before the first one): refused, nothing written ──
    const late = await put(uid, base(0, { drawingIds: null, drawing: { ...breast, background: 'thyroid' } }));
    assert.equal(late.status, 409); assert.equal(late.body.code, 'REPORT_DRAFT_CONFLICT');
    assert.equal(await drawingRows(uid), 1);
    // ── a screen that did not see the drawing (another tab attached it): refused, whatever it names instead ──
    for (const [label, named] of [['an empty list', { drawingIds: [] }], ['no list', { drawingIds: null }], ['nothing (an older page)', {}],
      ['another drawing', { drawingIds: [randomUUID()] }]])
      await refusedByGate(uid, () => put(uid, base(1, { findings: texts.findings, ...named })), 'a write naming ' + label);
    // ── the same diagram again without naming the drawing it replaces: refused; naming it replaces it ──
    const again = await put(uid, base(1, { drawingIds: [breastId], drawing: breast }));
    assert.equal(again.status, 409); assert.equal(again.body.code, 'REPORT_DRAWING_STALE');
    const replaced = await put(uid, base(1, { drawingIds: [breastId], drawing: { ...breast, replaces: breastId } }));
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    const breast2 = replaced.body.drawn.added;
    assert.equal(replaced.body.drawn.replaced, breastId);
    assert.deepEqual(replaced.body.snapshot.drawings, [breast2]);
    // ── a saved image is the study's own key image at its revision and frame ──
    const keyId = randomUUID(), otherKey = randomUUID();
    await witness.viewerItem.create({ data: { id: keyId, studyUid: uid, authorSub: sub, authorActor: author, revision: 1,
      snapshot: { kind: 'key', seriesUid: '1.2.840.9999.137.1', sopUid: '1.2.840.9999.137.1.7', frame: 2, title: 'SYN key' }, updatedAt: new Date() } });
    await witness.viewerItem.create({ data: { id: otherKey, studyUid: other.uid, authorSub: sub, authorActor: author, revision: 1,
      snapshot: { kind: 'key', seriesUid: '1.2.840.9999.138.1', sopUid: '1.2.840.9999.138.1.1', frame: 1, title: 'SYN other' }, updatedAt: new Date() } });
    const onImage = (source, revision) => base(revision, { drawingIds: [breast2],
      drawing: { background: 'image', source, strokes: [{ tool: 'line', color: '#1565c0', points: [[0.9, 0.1], [0.5, 0.8]] }], png: png(320, 220, 0x40).toString('base64') } });
    for (const wrong of [{ keyImageId: keyId, keyImageRevision: 1, frame: 1 }, { keyImageId: keyId, keyImageRevision: 2, frame: 2 },
      { keyImageId: otherKey, keyImageRevision: 1, frame: 1 }]) {
      const refused = await put(uid, onImage(wrong, 2));
      assert.equal(refused.status, 409, JSON.stringify(wrong)); assert.equal(refused.body.code, 'REPORT_DRAWING_SOURCE');
    }
    const image = await put(uid, onImage({ keyImageId: keyId, keyImageRevision: 1, frame: 2 }, 2));
    assert.equal(image.status, 200, JSON.stringify(image.body));
    const imageId = image.body.drawn.added;
    assert.deepEqual((await witness.reportDrawing.findUnique({ where: { id: imageId } })).source,
      { keyImageId: keyId, keyImageRevision: 1, seriesUid: '1.2.840.9999.137.1', sopUid: '1.2.840.9999.137.1.7', frame: 2 });
    // ── three per report ──
    // A real-sized picture (incompressible pixels, well over the default 100 KB JSON body) goes through the draft write.
    const large = png(320, 220, 0, true).toString('base64');
    assert.ok(large.length > 150000);
    const thyroid = await put(uid, base(3, { drawingIds: [breast2, imageId], drawing: { ...breast, background: 'thyroid', png: large } }));
    assert.equal(thyroid.status, 200, JSON.stringify(thyroid.body));
    const thyroidId = thyroid.body.drawn.added;
    assert.equal((await read(uid, '/' + thyroidId)).body.png, large);
    const sameFrame = await put(uid, base(4, { drawingIds: [breast2, imageId, thyroidId],
      drawing: { ...onImage({ keyImageId: keyId, keyImageRevision: 1, frame: 2 }, 4).drawing, replaces: undefined } }));
    assert.equal(sameFrame.status, 409); assert.equal(sameFrame.body.code, 'REPORT_DRAWING_STALE');   // same frame: names the one it replaces
    // A fourth drawing (another key image) is over the three a report holds.
    const secondKey = randomUUID();
    await witness.viewerItem.create({ data: { id: secondKey, studyUid: uid, authorSub: sub, authorActor: author, revision: 1,
      snapshot: { kind: 'key', seriesUid: '1.2.840.9999.137.2', sopUid: '1.2.840.9999.137.2.1', frame: 1, title: 'SYN key 2' }, updatedAt: new Date() } });
    const fourth = await put(uid, base(4, { drawingIds: [breast2, imageId, thyroidId],
      drawing: onImage({ keyImageId: secondKey, keyImageRevision: 1, frame: 1 }, 4).drawing }));
    assert.equal(fourth.status, 409); assert.equal(fourth.body.code, 'REPORT_DRAWING_LIMIT');
    assert.equal(await drawingRows(uid), 4, 'no row for a refused attach');
    // Remove the thyroid drawing; the text is written with it.
    const removed = await put(uid, base(4, { ...texts, drawingIds: [breast2, imageId, thyroidId], removeDrawing: thyroidId }));
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(removed.body.snapshot.drawings, [breast2, imageId]);
    assert.equal(removed.body.drawn.removed, thyroidId);

    // ── the gate at one revision: every entry that changes my draft or makes a version compares the named lists ──
    const held = [breast2, imageId], at5 = { expectedOwner: owner, expectedRevision: epoch + ':5' };
    for (const [label, send] of [
      ['a write naming no list', () => put(uid, base(5, { ...texts, drawingIds: null }))],
      ['a write naming an empty list', () => put(uid, base(5, { ...texts, drawingIds: [] }))],
      ['a write naming one of the two', () => put(uid, base(5, { ...texts, drawingIds: [breast2] }))],
      ['a write of an older page', () => put(uid, base(5, texts))],
      ['emptying the text without naming the list', () => put(uid, base(5))],
      ['an attach naming another list', () => put(uid, base(5, { ...texts, drawingIds: [breast2], drawing: { ...breast, background: 'thyroid' } }))],
      ['a remove naming another list', () => put(uid, base(5, { ...texts, drawingIds: [imageId], removeDrawing: imageId }))],
      ['a discard naming no list', () => discard(uid, { ...at5, drawingIds: null })],
      ['a discard naming an empty list', () => discard(uid, { ...at5, drawingIds: [] })],
      ['a discard of an older page', () => discard(uid, at5)],
      ['a save naming another draft list', () => commit(uid, { ...base(5, texts), drawingIds: [breast2], expectedEffectiveDrawingIds: held, action: 'save' })],
      // The draft's list is the one named, the list the version would hold is not: the same revision, another final list.
      ['a save naming another final list', () => commit(uid, { ...base(5, texts), drawingIds: held, expectedEffectiveDrawingIds: [breast2], action: 'save' })],
      ['a save naming an empty final list', () => commit(uid, { ...base(5, texts), drawingIds: held, expectedEffectiveDrawingIds: [], action: 'save' })],
      ['a save naming no final list', () => commit(uid, { ...base(5, texts), drawingIds: held, action: 'save' })],
      ['a save of an older page', () => commit(uid, { ...base(5, texts), action: 'save' })],
      ['a defer naming another final list', () => commit(uid, { ...base(5, texts), drawingIds: held, expectedEffectiveDrawingIds: [imageId], action: 'defer', reason: '' })],
      ['an approval naming no final list', () => commit(uid, { ...base(5, texts), drawingIds: held, action: 'approve' })],
      ['a reset naming another draft list', () => commit(uid, { ...base(5), drawingIds: [breast2], action: 'reset', reason: '합성 정정' })],
      ['a reset of an older page', () => commit(uid, { ...base(5), action: 'reset', reason: '합성 정정' })],
    ]) await refusedByGate(uid, send, label);

    // ── reads before any version: my draft's drawings for me; a drawing removed before a version for nobody ──
    const mine = await read(uid);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.deepEqual(mine.body.head, []);
    assert.deepEqual(mine.body.draft.drawings.map(d => d.id), [breast2, imageId]);
    assert.deepEqual(mine.body.draft.ids, [breast2, imageId]);
    assert.equal((await read(uid, '/' + breast2)).status, 200);
    assert.equal((await read(uid, '/' + breast2)).body.png, breast.png);
    assert.equal((await read(uid, '/' + thyroidId)).status, 404, 'removed before any version: not served to its author');
    assert.equal((await read(uid, '/' + breastId)).status, 404, 'replaced before any version: not served');
    assert.equal((await read(uid, '/' + breast2, second.token)).status, 404, 'another reader does not read my draft');
    assert.equal((await read(other.uid, '/' + breast2)).status, 404, 'never through another study');

    // ── a failed signing keeps no version and the draft with its drawings ──
    const approve = { ...base(5, texts), drawingIds: held, expectedEffectiveDrawingIds: held, action: 'approve' };
    await witness.$executeRaw`UPDATE emr_signing.doctor_key SET status='suspended'`;
    try { assert.equal((await commit(uid, approve)).status, 503); }
    finally { await witness.$executeRaw`UPDATE emr_signing.doctor_key SET status='active'`; }
    assert.equal(await witness.reportVersion.count({ where: { uid } }), 0);
    const kept = await witness.reportDraft.findUnique({ where: { uid_authorSub: { uid, authorSub: sub } } });
    assert.equal(kept.present, true); assert.deepEqual(kept.drawings.ids, [breast2, imageId]);

    // ── approve: the version holds them, the signature names each by the server's hash ──
    const approved = await commit(uid, approve);
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    const v1 = await witness.reportVersion.findUnique({ where: { uid_version: { uid, version: approved.body.state.version } } });
    const hashes = Object.fromEntries((await witness.reportDrawing.findMany({ where: { id: { in: [breast2, imageId] } } })).map(r => [r.id, r.sha256]));
    assert.deepEqual(v1.drawings.map(d => [d.id, d.sha256]), [[breast2, hashes[breast2]], [imageId, hashes[imageId]]]);
    const verify = product('emr-signature/server-verification').verifyRegisteredServerEnvelope;
    const signed = verify(approved.body.signature.envelope, approved.body.signature.keyAtSigning).payload;
    assert.deepEqual(signed.attachments, [breast2, imageId].map(id => ({ kind: 'report-evidence', recordId: id, versionId: '1', sha256: hashes[id] })));
    assert.deepEqual(JSON.parse(signed.text.body).drawings.map(d => d.id), [breast2, imageId]);
    // The signed result ended the work: its destruction took the drawings the work replaced and removed (no version or
    // draft names them) and left the version's two, which go with the report.
    await purpose.drained();
    assert.equal(await witness.reportDraftPurposeEnd.count({ where: { uid } }), 0, 'the ended work was destroyed');
    const drawingIds = async study => (await witness.reportDrawing.findMany({ where: { studyUid: study }, select: { id: true } })).map(r => r.id).sort();
    assert.deepEqual(await drawingIds(uid), [breast2, imageId].sort());
    // Another reader of the report reads a version's drawing; History names them.
    assert.equal((await read(uid, '/' + imageId, second.token)).status, 200);
    const history = await call('GET', uid, '/report/versions', undefined, second.token);
    assert.deepEqual(history.body[0].drawings.map(d => d.id), [breast2, imageId]);

    // ── no draft, and the head holds drawings: "my draft holds no list" is true and is not enough - the version to be made
    //    would hold the head's drawings, so the list the screen shows must be those ──
    const more = { ...base(6, { ...texts, findings: texts.findings + '\n합성 추가기재' }), baseVersion: v1.version, action: 'addendum' };
    for (const [label, named] of [['no final list', { drawingIds: null }], ['an empty final list', { drawingIds: null, expectedEffectiveDrawingIds: [] }],
      ['one of the two', { drawingIds: null, expectedEffectiveDrawingIds: [breast2] }], ['nothing (an older page)', {}]])
      await refusedByGate(uid, () => commit(uid, { ...more, ...named }), 'an addendum naming ' + label);

    // ── an amendment that only removes a drawing is a change; the same again is not ──
    // My draft holds no list before this remove: the screen names `null`, not an empty list.
    await refusedByGate(uid, () => put(uid, { ...base(6, texts), baseVersion: v1.version, drawingIds: [], removeDrawing: imageId }), 'a first remove naming an empty list');
    const draftAgain = await put(uid, { ...base(6, texts), baseVersion: v1.version, drawingIds: null, removeDrawing: imageId });
    assert.equal(draftAgain.status, 200, JSON.stringify(draftAgain.body));
    assert.deepEqual(draftAgain.body.snapshot.drawings, [breast2]);
    // The screen still showing the removed drawing does not make the version: the final list is compared, not only the draft's.
    await refusedByGate(uid, () => commit(uid, { ...base(7, texts), baseVersion: v1.version, drawingIds: [breast2], expectedEffectiveDrawingIds: held, action: 'amend' }),
      'an amendment naming the list before the removal');
    const amended = await commit(uid, { ...base(7, texts), baseVersion: v1.version, drawingIds: [breast2], expectedEffectiveDrawingIds: [breast2], action: 'amend' });
    assert.equal(amended.status, 201, JSON.stringify(amended.body));
    const v2 = await witness.reportVersion.findUnique({ where: { uid_version: { uid, version: amended.body.state.version } } });
    assert.deepEqual(v2.drawings.map(d => d.id), [breast2]);
    const amendSigned = verify(amended.body.signature.envelope, amended.body.signature.keyAtSigning).payload;
    assert.deepEqual(amendSigned.attachments.map(a => a.recordId), [breast2]);
    await refusedByGate(uid, () => commit(uid, { ...base(8, texts), baseVersion: v2.version, action: 'amend' }), 'an amendment of an older page on a report that holds a drawing');
    const unchanged = await commit(uid, { ...base(8, texts), baseVersion: v2.version, drawingIds: null, expectedEffectiveDrawingIds: [breast2], action: 'amend' });
    assert.equal(unchanged.status, 400); assert.match(unchanged.body.message, /고친 내용이 없습니다/);
    // The removed drawing does not come back: an Addendum carries the head's drawings only.
    const addendum = await commit(uid, { ...base(8, { ...texts, findings: texts.findings + '\n합성 추가기재' }), baseVersion: v2.version,
      drawingIds: null, expectedEffectiveDrawingIds: [breast2], action: 'addendum' });
    assert.equal(addendum.status, 201, JSON.stringify(addendum.body));
    const v3 = await witness.reportVersion.findUnique({ where: { uid_version: { uid, version: addendum.body.state.version } } });
    assert.deepEqual(v3.drawings.map(d => d.id), [breast2]);
    // A version held it, so it is still read (History of v1), by its author and others.
    assert.equal((await read(uid, '/' + imageId, second.token)).status, 200);

    // ── reset: the head holds none, the discarded copy keeps them; a later save does not revive them ──
    // Reset is an explicit cancellation: it names no final list (the new head holds none whatever the screen showed).
    const reset = await commit(uid, { ...base(9), baseVersion: v3.version, action: 'reset', reason: '합성 정정' });
    assert.equal(reset.status, 201, JSON.stringify(reset.body));
    const after = await witness.reportVersion.findMany({ where: { uid }, orderBy: { version: 'asc' } });
    const [copy, head] = after.slice(-2);
    assert.equal(copy.action, 'discarded'); assert.deepEqual(copy.drawings.map(d => d.id), [breast2]);
    assert.equal(head.action, 'reset'); assert.equal(head.drawings, null);
    assert.deepEqual((await read(uid)).body.head, []);
    const saved = await commit(uid, { ...base(10, texts), baseVersion: head.version, action: 'save' });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal((await witness.reportVersion.findUnique({ where: { uid_version: { uid, version: saved.body.state.version } } })).drawings, null);

    // ── a report whose head holds a drawing and no text: removing its last drawing is kept as the draft and amended ──
    const lone = await witness.studyState.create({ data: { uid: '1.2.840.9999.140', institutionId: institution, ss: 'Verified' } });
    const loneBase = (revision, extra = {}) => ({ ...base(revision, extra), expectedRevision: lone.draftEpoch + ':' + revision });
    const loneAttach = await put(lone.uid, loneBase(0, { drawing: breast }));
    assert.equal(loneAttach.status, 200, JSON.stringify(loneAttach.body));
    const loneId = loneAttach.body.drawn.added;
    const loneApproved = await commit(lone.uid, { ...loneBase(1), drawingIds: [loneId], expectedEffectiveDrawingIds: [loneId], action: 'approve' });
    assert.equal(loneApproved.status, 201, JSON.stringify(loneApproved.body));
    const loneRemoved = await put(lone.uid, { ...loneBase(2), baseVersion: loneApproved.body.state.version, drawingIds: null, removeDrawing: loneId });
    assert.equal(loneRemoved.status, 200, JSON.stringify(loneRemoved.body));
    assert.equal(loneRemoved.body.present, true, 'the removal is the draft');
    assert.deepEqual(loneRemoved.body.snapshot.drawings, []);
    assert.deepEqual((await read(lone.uid)).body.draft.drawings, []);
    // The removal is an empty list of the draft's own, by the draft read and by the drawings read: not "no list".
    assert.deepEqual((await read(lone.uid)).body.draft.ids, []);
    const loneDraft = await call('GET', lone.uid, '/draft');
    assert.equal(loneDraft.status, 200, JSON.stringify(loneDraft.body));
    assert.deepEqual(loneDraft.body.snapshot.drawings, []);
    // An ordinary write keeps that empty list with the new text (the screen names it); the answer holds it still.
    const loneText = await put(lone.uid, { ...loneBase(3, { findings: '합성 문장', drawingIds: [] }), baseVersion: loneApproved.body.state.version });
    assert.equal(loneText.status, 200, JSON.stringify(loneText.body));
    assert.deepEqual(loneText.body.snapshot.drawings, []);
    const loneBack = await put(lone.uid, { ...loneBase(4, { drawingIds: [] }), baseVersion: loneApproved.body.state.version });
    assert.equal(loneBack.status, 200, JSON.stringify(loneBack.body));
    assert.equal(loneBack.body.present, true, 'no text and an empty list of its own is still the draft');
    assert.deepEqual(loneBack.body.snapshot.drawings, []);
    // A write of the same empty text naming that empty list keeps it; one naming no list, or nothing at all (an older
    // page), would end a removal it does not hold: refused - as its discard and its commit are. The server never fills
    // the list in for a request that names none.
    const loneOld = { ...loneBase(5), baseVersion: loneApproved.body.state.version };
    for (const [label, send] of [
      ['a write of an older page', () => put(lone.uid, loneOld)],
      ['a write naming no list', () => put(lone.uid, { ...loneOld, drawingIds: null })],
      ['a discard of an older page', () => discard(lone.uid, { expectedOwner: owner, expectedRevision: loneOld.expectedRevision })],
      ['an amendment of an older page', () => commit(lone.uid, { ...loneOld, action: 'amend' })],
      ['an amendment naming the removal and the drawing it removed', () => commit(lone.uid, { ...loneOld, drawingIds: [], expectedEffectiveDrawingIds: [loneId], action: 'amend' })],
    ]) await refusedByGate(lone.uid, send, 'the removal draft: ' + label);
    const loneAmended = await commit(lone.uid, { ...loneBase(5), baseVersion: loneApproved.body.state.version, drawingIds: [], expectedEffectiveDrawingIds: [], action: 'amend' });
    assert.equal(loneAmended.status, 201, JSON.stringify(loneAmended.body));
    const loneRows = await witness.reportVersion.findMany({ where: { uid: lone.uid }, orderBy: { version: 'asc' } });
    assert.deepEqual(loneRows.map(r => [r.action, (r.drawings || []).map(d => d.id)]), [['approve', [loneId]], ['amend', []]]);
    // The amendment ended the removal's work; the drawing it removed is the first version's, so its destruction keeps it.
    await purpose.drained();
    assert.equal(await witness.reportDraftPurposeEnd.count({ where: { uid: lone.uid } }), 0);
    assert.deepEqual(await drawingIds(lone.uid), [loneId]);
    // ── the fixed version chain (versions with and without drawings) still verifies ──
    const { loadFixedVersions } = product('emr-audit/fixed-versions');
    const listing = await witness.$transaction(tx => loadFixedVersions(tx, uid, 'report'));
    assert.ok(listing, 'the chain loads');

    // ── a study without drawings signs exactly as before (no drawings key in the signed body) ──
    const plain = await witness.studyState.create({ data: { uid: '1.2.840.9999.139', institutionId: institution, ss: 'Verified' } });
    const plainDraft = await put(plain.uid, { ...base(0, texts), expectedRevision: plain.draftEpoch + ':0' });
    assert.equal(plainDraft.status, 200, JSON.stringify(plainDraft.body));
    assert.equal('drawings' in plainDraft.body.snapshot, false);
    // A text draft holds no drawing list of its own: the drawings read names none (not an empty one), and a request that
    // names an empty one is refused. The page names `null` and an empty final list; an older page names nothing (below).
    assert.equal('ids' in (await read(plain.uid)).body.draft, false);
    await refusedByGate(plain.uid, () => put(plain.uid, { ...base(1, texts), expectedRevision: plainDraft.body.revision, drawingIds: [] }), 'a text draft named with an empty list');
    await refusedByGate(plain.uid, () => commit(plain.uid, { ...base(1, texts), expectedRevision: plainDraft.body.revision, drawingIds: null,
      expectedEffectiveDrawingIds: [randomUUID()], action: 'approve' }), 'an approval naming a drawing the report does not hold');
    const plainApproved = await commit(plain.uid, { ...base(1, texts), expectedRevision: plainDraft.body.revision, drawingIds: null,
      expectedEffectiveDrawingIds: [], action: 'approve' });
    assert.equal(plainApproved.status, 201, JSON.stringify(plainApproved.body));
    const plainSigned = verify(plainApproved.body.signature.envelope, plainApproved.body.signature.keyAtSigning).payload;
    assert.deepEqual(plainSigned.attachments, []);
    assert.equal('drawings' in JSON.parse(plainSigned.text.body), false);
    // Its next version names the previous one by the hash of the row as it was signed (no drawings key), and the fixed
    // version listing of that chain verifies.
    const plainAmended = await commit(plain.uid, { ...base(2, { ...texts, conclusion: texts.conclusion + ' 수정' }),
      expectedRevision: plainApproved.body.revision, baseVersion: plainApproved.body.state.version, action: 'amend' });
    assert.equal(plainAmended.status, 201, JSON.stringify(plainAmended.body));
    const plainFirst = await witness.reportVersion.findUnique({ where: { uid_version: { uid: plain.uid, version: plainApproved.body.state.version } } });
    const asSigned = product('emr-report/native-snapshot').nativeReportSnapshot(plainFirst);
    assert.deepEqual(JSON.parse(plainSigned.text.body), JSON.parse(asSigned));
    const plainAmendSigned = verify(plainAmended.body.signature.envelope, plainAmended.body.signature.keyAtSigning).payload;
    assert.equal(plainAmendSigned.previousVersion.sha256, require('node:crypto').createHash('sha256').update(asSigned).digest('hex'));
    assert.ok(await witness.$transaction(tx => loadFixedVersions(tx, plain.uid, 'report')));

    // ── a discard that names the list the draft holds ends it; the drawing it alone held is then served to nobody ──
    const gone = await witness.studyState.create({ data: { uid: '1.2.840.9999.141', institutionId: institution, ss: 'Verified' } });
    const goneAt = revision => ({ expectedOwner: owner, expectedRevision: gone.draftEpoch + ':' + revision });
    const goneAttach = await put(gone.uid, { ...base(0, { drawingIds: null, drawing: breast }), ...goneAt(0) });
    assert.equal(goneAttach.status, 200, JSON.stringify(goneAttach.body));
    const goneId = goneAttach.body.drawn.added;
    const goneWork = (await witness.reportDraft.findUnique({ where: { uid_authorSub: { uid: gone.uid, authorSub: sub } } })).workUnit;
    const goneRow = await witness.reportDrawing.findUnique({ where: { id: goneId } });
    const discarded = await discard(gone.uid, { ...goneAt(1), drawingIds: [goneId] });
    assert.equal(discarded.status, 200, JSON.stringify(discarded.body));
    assert.equal(discarded.body.present, false);
    assert.equal((await witness.reportDraft.findUnique({ where: { uid_authorSub: { uid: gone.uid, authorSub: sub } } })).drawings, null);
    assert.equal((await read(gone.uid, '/' + goneId)).status, 404);
    // CD-09-P destroyed the discarded work, and the drawing only it held with it.
    await purpose.drained();
    assert.equal(await witness.reportDraftPurposeEnd.count({ where: { uid: gone.uid } }), 0);
    assert.deepEqual(await drawingIds(gone.uid), []);
    // A restored older copy that holds that drawing again (nothing else of the work): the ledger completed the work, so its
    // destruction is re-applied - the drawing goes, no new ledger record - and a second run finds nothing.
    const ledgerBefore = require('node:fs').readFileSync(purpose.ledger.file);
    const { source: _noSource, ...goneCopy } = goneRow;   // a NULL JSON column is left out of the row written back
    await witness.reportDrawing.create({ data: goneCopy });
    assert.equal((await purpose.destroy(goneWork)).outcome, 'reapplied');
    assert.deepEqual(await drawingIds(gone.uid), []);
    assert.equal((await purpose.destroy(goneWork)).outcome, 'absent');
    // A copy taken while the work was still live: the author's draft holds the drawing again. The re-application empties
    // that draft with its drawing list, and the drawing goes with it.
    await witness.reportDrawing.create({ data: goneCopy });
    const goneDraft = await witness.reportDraft.findUnique({ where: { uid_authorSub: { uid: gone.uid, authorSub: sub } } });
    await witness.reportDraft.update({ where: { uid_authorSub: { uid: gone.uid, authorSub: sub } }, data: { present: true, findings: 'copy',
      workUnit: goneWork, workSince: new Date(), workIntent: 'approve', drawings: { seed: [], ids: [goneId] } } });
    assert.equal((await purpose.destroy(goneWork)).outcome, 'reapplied');
    const goneEmptied = await witness.reportDraft.findUnique({ where: { uid_authorSub: { uid: gone.uid, authorSub: sub } } });
    assert.deepEqual([goneEmptied.present, goneEmptied.workUnit, goneEmptied.drawings, goneEmptied.revision],
      [false, null, null, goneDraft.revision + 1]);
    assert.deepEqual(await drawingIds(gone.uid), []);
    assert.equal((await purpose.destroy(goneWork)).outcome, 'absent');
    assert.deepEqual(require('node:fs').readFileSync(purpose.ledger.file), ledgerBefore);

    // ── a work that ends without a purpose end (Save) keeps the drawing it replaced until the report's retention ends ──
    const saving = await witness.studyState.create({ data: { uid: '1.2.840.9999.142', institutionId: institution, ss: 'Verified' } });
    const keptAt = (revision, extra = {}) => ({ ...base(revision, extra), expectedRevision: saving.draftEpoch + ':' + revision });
    const keptFirst = await put(saving.uid, keptAt(0, { drawingIds: null, drawing: breast }));
    assert.equal(keptFirst.status, 200, JSON.stringify(keptFirst.body));
    const keptOld = keptFirst.body.drawn.added;
    const keptNew = (await put(saving.uid, keptAt(1, { drawingIds: [keptOld], drawing: { ...breast, replaces: keptOld } }))).body.drawn.added;
    const keptSaved = await commit(saving.uid, { ...keptAt(2, texts), drawingIds: [keptNew], expectedEffectiveDrawingIds: [keptNew], action: 'save' });
    assert.equal(keptSaved.status, 201, JSON.stringify(keptSaved.body));
    await purpose.drained();
    assert.equal(await witness.reportDraftPurposeEnd.count({ where: { uid: saving.uid } }), 0, 'a save is no purpose end');
    assert.deepEqual(await drawingIds(saving.uid), [keptNew, keptOld].sort(), 'the replaced drawing stays (CD-09-D removes it with the report)');
    assert.equal((await read(saving.uid, '/' + keptOld)).status, 404, 'kept, never served');

    // ── the migration gives a drawing attached before the column the work that names it now, and no other ──
    const keptThyroid = await put(saving.uid, { ...keptAt(3, { drawingIds: null, drawing: { ...breast, background: 'thyroid' } }), baseVersion: keptSaved.body.state.version });
    assert.equal(keptThyroid.status, 200, JSON.stringify(keptThyroid.body));
    const keptLive = keptThyroid.body.drawn.added;
    const keptWork = (await witness.reportDraft.findUnique({ where: { uid_authorSub: { uid: saving.uid, authorSub: sub } } })).workUnit;
    await witness.reportDrawing.updateMany({ where: { studyUid: saving.uid }, data: { workUnit: null } });
    const migration = require('node:fs').readFileSync(path.join(api, 'prisma/migrations/20261115120000_report_drawing_work/migration.sql'), 'utf8');
    const backfill = migration.split(';').map(s => s.replace(/^\s*--.*$/gm, '').trim()).filter(s => /^UPDATE /.test(s));
    assert.equal(backfill.length, 2);
    for (const statement of backfill) await witness.$executeRawUnsafe(statement);
    const attributed = Object.fromEntries((await witness.reportDrawing.findMany({ where: { studyUid: saving.uid } })).map(r => [r.id, r.workUnit]));
    assert.deepEqual(attributed, { [keptOld]: null, [keptNew]: null, [keptLive]: keptWork },
      'only the drawing the live draft alone holds: the version\'s may come from an earlier work, the replaced one no work names');

    // ── two authors on one study: a work's destruction takes its own drawings only ──
    const pair = await witness.studyState.create({ data: { uid: '1.2.840.9999.143', institutionId: institution, ss: 'Verified' } });
    const pairAt = (revision, extra = {}, who = owner) => ({ ...base(revision, extra), expectedOwner: who, expectedRevision: pair.draftEpoch + ':' + revision });
    const secondOwner = { institution, sub: second.sub, author: second.author };
    const theirs = await put(pair.uid, pairAt(0, { drawingIds: null, drawing: breast }, secondOwner), second.token);
    assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
    const theirId = theirs.body.drawn.added;
    const mineFirst = await put(pair.uid, pairAt(0, { drawingIds: null, drawing: breast }));
    assert.equal(mineFirst.status, 200, JSON.stringify(mineFirst.body));
    const myId = mineFirst.body.drawn.added;
    // Removing my only drawing with no text ends my draft (an explicit discard of the work): destroyed with its drawing.
    const cleared = await put(pair.uid, pairAt(1, { drawingIds: [myId], removeDrawing: myId }));
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.present, false);
    await purpose.drained();
    assert.deepEqual(await drawingIds(pair.uid), [theirId], 'the other author\'s live draft keeps theirs');
    const theirDiscard = await discard(pair.uid, { expectedOwner: secondOwner, expectedRevision: pair.draftEpoch + ':1', drawingIds: [theirId] }, second.token);
    assert.equal(theirDiscard.status, 200, JSON.stringify(theirDiscard.body));
    await purpose.drained();
    assert.deepEqual(await drawingIds(pair.uid), []);
    assert.equal(await witness.reportDraftPurposeEnd.count({ where: { uid: pair.uid } }), 0);

    // ── Merge Exam: a drawing belongs to the work it was attached in, and a work to the one exam it was written on ──
    // Merge and Unmerge label the rows of the base study (groupId) and move none, so one study holds the drawings of
    // several exams over time. A work's destruction takes that work's own drawings - whatever the grouping is when it
    // runs - and never one of another exam, and no regrouping leaves a destroyed work's drawing behind.
    const { ExamMergeService } = product('exam-merge.service');
    const grouping = new ExamMergeService(app.get(PrismaService), app.get(StudyAccessService));
    const technician = { sub: 'synthetic-drawing-technician', actor: 'drawing-technician@example.test', roles: ['technician'], institution, kind: 'member' };
    const exam = await witness.studyState.create({ data: { uid: '1.2.840.9999.144', institutionId: institution, ss: 'Verified' } });
    const part = await witness.studyState.create({ data: { uid: '1.2.840.9999.145', institutionId: institution, ss: 'Verified' } });
    for (const study of [exam, part]) patients.set(study.uid, 'SYN-DRAWING-PATIENT');
    const examDraft = () => witness.reportDraft.findUnique({ where: { uid_authorSub: { uid: exam.uid, authorSub: sub } } });
    // A request of the screen as it is now: the study's epoch (every Merge and Unmerge draws a new one) and my row's revision.
    const now = async (extra = {}, uid = exam.uid) => ({ ...base(0, extra), expectedRevision:
      (await witness.studyState.findUnique({ where: { uid } })).draftEpoch + ':' + (uid === exam.uid ? (await examDraft())?.revision ?? 0 : 0) });
    const drawing = id => witness.reportDrawing.findUnique({ where: { id }, select: { studyUid: true, groupId: true, workUnit: true } });
    const ends = async () => (await witness.reportDraftPurposeEnd.findMany({ where: { uid: exam.uid }, select: { disposalUnitId: true } }))
      .map(r => r.disposalUnitId).sort();
    // An end whose destruction is still to come (a server that stopped after the end committed leaves it to a later run).
    const endedOnly = async send => {
      purpose.scheduleDestruction = () => {};
      try { return await send(); } finally { delete purpose.scheduleDestruction; }
    };
    const destroyNow = async unit => { purpose.scheduleDestruction(unit, author); await purpose.drained(); };
    const attach = async (background, extra = {}) => {
      const answer = await put(exam.uid, await now({ drawingIds: null, drawing: { ...breast, background }, ...extra }));
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      return answer.body.drawn.added;
    };

    // The study alone: a work with one drawing, ended by Discard; its destruction is still to come.
    const alone = await attach('breast');
    const aloneWork = (await examDraft()).workUnit;
    assert.deepEqual(await drawing(alone), { studyUid: exam.uid, groupId: null, workUnit: aloneWork });
    assert.equal((await endedOnly(async () => discard(exam.uid, { ...await now(), drawingIds: [alone] }))).status, 200);
    assert.deepEqual(await ends(), [aloneWork]);

    // Merged (the first group): the member takes no report write; on the base a new work, its drawing of this exam.
    const groupOne = (await grouping.merge(technician, { baseUid: exam.uid, uids: [exam.uid, part.uid] })).group.id;
    const onMember = await put(part.uid, await now({ drawingIds: null, drawing: breast }, part.uid));
    assert.equal(onMember.status, 409, JSON.stringify(onMember.body)); assert.equal(onMember.body.code, 'STUDY_MERGED');
    assert.deepEqual(await drawingIds(part.uid), []);
    const merged = await attach('breast');
    const mergedWork = (await examDraft()).workUnit;
    assert.notEqual(mergedWork, aloneWork);
    assert.equal((await examDraft()).groupId, groupOne);
    assert.deepEqual(await drawing(merged), { studyUid: exam.uid, groupId: groupOne, workUnit: mergedWork });
    assert.equal((await endedOnly(async () => discard(exam.uid, { ...await now(), drawingIds: [merged] }))).status, 200);
    assert.deepEqual(await ends(), [aloneWork, mergedWork].sort());
    assert.equal((await examDraft()).groupId, null, 'an emptied draft carries no exam');

    // Unmerged and merged again (a second group): two more works. One saves a version with its drawing; the next
    // attaches, replaces and is discarded - destroyed at once.
    await grouping.dissolve(technician, groupOne);
    const groupTwo = (await grouping.merge(technician, { baseUid: exam.uid, uids: [exam.uid, part.uid] })).group.id;
    assert.notEqual(groupTwo, groupOne);
    const versioned = await attach('thyroid');
    const versionedWork = (await examDraft()).workUnit;
    const savedMerged = await commit(exam.uid, { ...await now(texts), drawingIds: [versioned], expectedEffectiveDrawingIds: [versioned], action: 'save' });
    assert.equal(savedMerged.status, 201, JSON.stringify(savedMerged.body));
    const examHead = savedMerged.body.state.version;
    assert.equal((await witness.reportVersion.findUnique({ where: { uid_version: { uid: exam.uid, version: examHead } } })).groupId, groupTwo);
    const swapped = await attach('breast', { baseVersion: examHead });
    const lastWork = (await examDraft()).workUnit;
    const latest = (await put(exam.uid, { ...await now({ drawingIds: [versioned, swapped], drawing: { ...breast, replaces: swapped } }), baseVersion: examHead })).body.drawn.added;
    assert.deepEqual([await drawing(versioned), await drawing(swapped), await drawing(latest)], [versionedWork, lastWork, lastWork]
      .map(workUnit => ({ studyUid: exam.uid, groupId: groupTwo, workUnit })));
    assert.equal(new Set([aloneWork, mergedWork, versionedWork, lastWork]).size, 4, 'a work of its own each time');
    const latestRow = await witness.reportDrawing.findUnique({ where: { id: latest } });
    const lastDraft = await examDraft();
    assert.equal((await discard(exam.uid, { ...await now(), drawingIds: [versioned, latest] })).status, 200);
    await purpose.drained();
    // That destruction took its own two. The version's drawing stays with the report; the drawings of the two works
    // still to be destroyed - written on the study alone and on the first group - were not its to take.
    assert.deepEqual(await drawingIds(exam.uid), [alone, merged, versioned].sort());
    assert.deepEqual(await ends(), [aloneWork, mergedWork].sort());

    // The earlier works are destroyed now, under a grouping that is neither's: each takes exactly its own drawing.
    await destroyNow(mergedWork);
    assert.deepEqual(await drawingIds(exam.uid), [alone, versioned].sort());
    assert.deepEqual(await ends(), [aloneWork]);
    await destroyNow(aloneWork);
    assert.deepEqual(await drawingIds(exam.uid), [versioned]);
    assert.deepEqual(await ends(), []);

    // A restored older copy in which the last work is still live (its row, of the second group, and its drawing): the
    // re-application empties that row - no text, no drawing list, no work, no exam - and takes the drawing; the version's
    // stays, and the ledger is not written.
    const mergedLedger = require('node:fs').readFileSync(purpose.ledger.file);
    const { source: _mergedSource, ...latestCopy } = latestRow;
    await witness.reportDrawing.create({ data: latestCopy });
    await witness.reportDraft.update({ where: { uid_authorSub: { uid: exam.uid, authorSub: sub } }, data: { present: true, findings: 'copy',
      baseVersion: examHead, groupId: groupTwo, workUnit: lastWork, workSince: lastDraft.workSince, workIntent: 'approve', drawings: lastDraft.drawings } });
    const copyRevision = (await examDraft()).revision;
    assert.equal((await purpose.destroy(lastWork)).outcome, 'reapplied');
    const emptied = await examDraft();
    assert.deepEqual([emptied.present, emptied.workUnit, emptied.drawings, emptied.groupId, emptied.revision], [false, null, null, null, copyRevision + 1]);
    assert.deepEqual(await drawingIds(exam.uid), [versioned]);
    assert.equal((await purpose.destroy(lastWork)).outcome, 'absent');
    assert.deepEqual(require('node:fs').readFileSync(purpose.ledger.file), mergedLedger);

    // Unmerged for good: the version's drawing is still the report's (read by the exam it was saved on), and a draft of
    // the study alone cannot take a drawing of that exam into its list - refused, nothing written.
    assert.equal((await read(exam.uid, '/' + versioned)).status, 200);
    await grouping.dissolve(technician, groupTwo);
    assert.equal((await read(exam.uid, '/' + versioned)).status, 200);
    const untouched = await facts(exam.uid);
    const across = await put(exam.uid, { ...await now({ drawingIds: null, drawing: breast }), baseVersion: examHead });
    assert.equal(across.status, 409, JSON.stringify(across.body)); assert.equal(across.body.code, 'EXAM_SCOPE_CHANGED');
    assert.equal(await facts(exam.uid), untouched);
    assert.deepEqual(await drawingIds(exam.uid), [versioned]);

    // ── Split Exam: the two parts are two report uids (the study's own, a new logical one) of one group ──
    // A work written on the study before the split, and one on each part after it. Each work also holds a drawing it
    // replaced, which no draft, end or version names any more - only its work keeps it. Each destruction takes its own
    // drawings and none of the other part's or of the study before the split, whichever order the destructions run in.
    const whole = await witness.studyState.create({ data: { uid: '1.2.840.9999.146', institutionId: institution, ss: 'Verified' } });
    patients.set(whole.uid, 'SYN-DRAWING-PATIENT');
    const draftOn = uid => witness.reportDraft.findUnique({ where: { uid_authorSub: { uid, authorSub: sub } } });
    const nowOn = async (uid, extra = {}) => ({ ...base(0, extra), expectedRevision:
      (await witness.studyState.findUnique({ where: { uid } })).draftEpoch + ':' + ((await draftOn(uid))?.revision ?? 0) });
    const endsOn = async uid => (await witness.reportDraftPurposeEnd.findMany({ where: { uid }, select: { disposalUnitId: true } }))
      .map(r => r.disposalUnitId).sort();
    /** Attach a drawing on `uid` (to a new list, or replacing `replaces` in `list`); its id. */
    const attachOn = async (uid, list = null, replaces = undefined) => {
      const answer = await put(uid, await nowOn(uid, { drawingIds: list, drawing: { ...breast, ...(replaces ? { replaces } : {}) } }));
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      return answer.body.drawn.added;
    };
    const discardOn = async (uid, ids) => {
      const answer = await discard(uid, { ...await nowOn(uid), drawingIds: ids });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
    };
    const listed = async uid => (await draftOn(uid))?.drawings?.ids ?? [];
    // The study before the split: a work that attached a drawing and replaced it, ended by Discard; its destruction is
    // still to come. The replaced drawing is named by nothing but its work.
    const unsplitOld = await attachOn(whole.uid);
    const unsplitWork = (await draftOn(whole.uid)).workUnit;
    const unsplit = await attachOn(whole.uid, [unsplitOld], unsplitOld);
    assert.deepEqual(await listed(whole.uid), [unsplit]);
    assert.deepEqual([await drawing(unsplitOld), await drawing(unsplit)],
      [unsplitWork, unsplitWork].map(workUnit => ({ studyUid: whole.uid, groupId: null, workUnit })));
    await endedOnly(() => discardOn(whole.uid, [unsplit]));
    assert.deepEqual(await endsOn(whole.uid), [unsplitWork]);
    // Split: the second part takes one of the two series and is a new logical report uid.
    orthanc.filmStudy = async uid => ({ series: ['2.25.14601', '2.25.14602'].map((seriesUid, i) => ({ id: uid + '.' + i,
      uid: seriesUid, number: i + 1, description: 'SYN', modality: 'CT', instances: ['SYN-instance-' + i] })) });
    const made = (await grouping.split(technician, { uid: whole.uid, seriesUids: ['2.25.14602'] })).group;
    const [partOne, partTwo] = [0, 1].map(n => made.members.find(m => m.part === n).logicalUid);
    assert.equal(partOne, whole.uid);
    assert.notEqual(partTwo, whole.uid);
    // Each part: a new work of its own, its drawings on that part's uid in the split's group. The first part's work
    // replaces its first drawing; the replaced one stays its work's until that work is destroyed.
    const oneOld = await attachOn(partOne);
    const oneWork = (await draftOn(partOne)).workUnit;
    const onOne = await attachOn(partOne, [oneOld], oneOld);
    const onTwo = await attachOn(partTwo);
    const twoWork = (await draftOn(partTwo)).workUnit;
    assert.equal(new Set([unsplitWork, oneWork, twoWork]).size, 3, 'a work of its own on each part');
    assert.deepEqual([await drawing(oneOld), await drawing(onOne), await drawing(onTwo)],
      [{ studyUid: partOne, groupId: made.id, workUnit: oneWork }, { studyUid: partOne, groupId: made.id, workUnit: oneWork },
        { studyUid: partTwo, groupId: made.id, workUnit: twoWork }]);
    // The second part's work is discarded and destroyed at once: its drawing only. The first part's work (live, with a
    // drawing only it holds) and the work from before the split (still to be destroyed) keep theirs.
    await discardOn(partTwo, [onTwo]);
    await purpose.drained();
    assert.deepEqual(await drawingIds(partTwo), []);
    assert.deepEqual(await drawingIds(partOne), [unsplitOld, unsplit, oneOld, onOne].sort());
    assert.deepEqual(await endsOn(partTwo), []);
    // The work from before the split is destroyed now, under the split: its two drawings only.
    await destroyNow(unsplitWork);
    assert.deepEqual(await drawingIds(partOne), [oneOld, onOne].sort());
    assert.deepEqual(await endsOn(whole.uid), []);
    // A new work on the second part while the first part's work ends: the first part's destruction takes its own two.
    const againTwo = await attachOn(partTwo);
    await discardOn(partOne, [onOne]);
    await purpose.drained();
    assert.deepEqual(await drawingIds(partOne), []);
    assert.deepEqual(await drawingIds(partTwo), [againTwo]);
    await discardOn(partTwo, [againTwo]);
    await purpose.drained();
    assert.deepEqual(await drawingIds(partTwo), []);
  } finally {
    await purpose.drained();
    await purposeDb.$disconnect();
    if (app) await app.close();
    if (ready) await runtime.stop(Date.now() + 10000);
    await witness.$disconnect(); await new Promise(resolve => provider.close(resolve));
  }
});
