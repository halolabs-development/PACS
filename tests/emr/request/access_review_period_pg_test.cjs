'use strict';
// Access Review over practical periods: the real Nest GET and the migrated PG function on a synthetic ledger of
// about 170,000 and then about 1,020,000 entries (about 34,000 a day). Checks that
//  - the function answers exactly what the previous definition answered (rows, order, ceiling, page boundaries),
//    where the previous definition still answers (half-hour and 90-minute windows);
//  - a day, five days and a week answer through HTTP, first page and continuation, at both ledger sizes;
//  - the previous definition does not answer a day within 20 s (the defect this replaces);
//  - a request the browser abandons ends in PostgreSQL by the 30 s limit, while an unbounded read would stay.
// Synthetic rows only; the bulk rows copy entries this test appends through the normal writer.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const { Module } = require('@nestjs/common'), { NestFactory } = require('@nestjs/core');
const { PrismaClient } = require('@prisma/client');
const build = process.env.KIN_ACCESS_REVIEW_BUILD;
const compiled = name => require(path.join(build, name));
const { AdminController } = compiled('admin.controller.js');
const { AdminAccessReview } = compiled('admin-access-review.js');
const { AdminService } = compiled('admin.service.js'), { PacsService } = compiled('pacs.service.js');
const { PrismaService } = compiled('prisma.service.js'), { StudyAccessService } = compiled('study-access.service.js');
const { createRecordPort } = compiled('emr-runtime/record-port.js');
const { createRequestContext, REQUEST_CONTEXT_SOURCE } = compiled('emr-runtime/request-context.js');
const { AccessLedgerStore } = compiled('emr-runtime/store.js');
const { FailureJournal, FailureSpool } = compiled('emr-runtime/failure-journal.js');
const known = value => ({ status: 'known', value });
const na = { status: 'not-applicable', reason: 'non-record-target' };
const DAY = 86400000, PER_DAY = 34000;
// Whole milliseconds, the form the route accepts. Every synthetic row is before `until`; this test's own
// Access Review reads are recorded after it, so the reviewed windows do not change between reads.
const until = new Date(Math.floor(Date.now() / 1000) * 1000 - 60000);
const iso = ms => new Date(ms).toISOString();
const ago = ms => iso(until.getTime() - ms);
const UNTIL = until.toISOString();
const target = kind => ({ kind, patientLinkSnapshot: known({ linkId: 'SYN-LINK', patientId: 'SYN-PATIENT', assigningAuthority: 'SYN-A' }),
  studyId: known('SYN-STUDY'), recordId: known('SYN-RECORD'), versionId: known('SYN-VERSION') });
function event(extra = {}) {
  return { formatVersion: 1, eventId: randomUUID(), surface: 'GET admin/users',
    userId: known({ id: 'SYN-ACTOR', issuer: 'SYN-ISSUER', subject: 'SYN-SUB' }), rolesAtTime: known(['admin']),
    actingInstitution: known('SYN-A'), managingInstitution: known('SYN-A'), occurredAt: ago(DAY / 2),
    trustedProxyIp: { status: 'unresolved', reason: 'not-observed' }, cause: 'user-view', executor: 'member',
    context: { basis: 'out-of-context', studyId: null, relatedStudyId: null, reason: null },
    targets: [{ kind: 'identity-access', patientLinkSnapshot: na, studyId: na, recordId: known('SYN-MEMBER'), versionId: na }],
    action: 'provide-prepared', result: 'prepared', requestId: randomUUID(),
    auditLinkId: `audit:${randomUUID()}`, relatedEventId: null, ...extra };
}
const elapsed = async work => { const start = Date.now(); const value = await work(); return { value, ms: Date.now() - start }; };
(async () => {
  const db = new PrismaClient(), witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_B2R_WITNESS_URL } } });
  const locker = new PrismaClient({ datasources: { db: { url: process.env.KIN_B2R_WITNESS_URL } } });
  const store = new AccessLedgerStore(db, new FailureJournal(db, new FailureSpool(process.env.KIN_B2R_SPOOL)));
  const requests = createRequestContext({ resolve: async () => ({ status: 'unresolved', reason: 'not-observed' }) }, createRecordPort(store).port);
  const access = { snapshot: async () => ({ policy: { restricted: false } }), unchanged: async () => {} };
  const measured = {};
  let app;
  try {
    await db.$connect(); await witness.$connect(); await locker.$connect();
    // Templates through the normal writer: a member read, a written record (both streams: a pair is one event)
    // and the two stages of a file download. The bulk copies vary institution, its status and the action.
    const download = event({ surface: 'GET studies/:uid/original-downloads/:operationId/archive', targets: [target('download')] });
    const templates = [event(),
      event({ surface: 'POST studies/:uid/report/commit', action: 'write', result: 'succeeded',
        targets: [target('report-version'), { ...target('report-version'), recordId: known('SYN-SECOND') }] }),
      download, event({ surface: download.surface, targets: download.targets, action: 'transfer-aborted', result: 'aborted',
        relatedEventId: download.eventId })];
    for (const e of templates) await store.append(e);
    const streams = await witness.$queryRawUnsafe(`SELECT stream, count(*)::int AS n FROM emr_access.access_entry GROUP BY stream ORDER BY stream`);
    console.log('template entries', JSON.stringify(streams));
    assert.ok(streams.length === 2, 'templates cover both streams');
    // Bulk copies of the templates, oldest first; occurredAt in the payload follows the column.
    const fill = async (first, count, start, step) => {
      const { ms } = await elapsed(() => witness.$transaction([
        // The receipt and operation rows of real appends are not part of what Access Review reads.
        witness.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
        witness.$executeRawUnsafe(`
          WITH tpl AS (SELECT (row_number() OVER (ORDER BY event_id) - 1)::int AS i, event_id
                       FROM (SELECT DISTINCT event_id FROM emr_access.access_entry WHERE event_id = ANY($1::text[])) d)
          INSERT INTO emr_access.access_entry(entry_id, operation_id, stream, event_id, payload, occurred_at, statutory_act, retention_class)
          SELECT gen_random_uuid(), gen_random_uuid(), e.stream, 'SYN-PERIOD-' || g, v.p::text,
            t.ts, e.statutory_act, e.retention_class
          FROM generate_series($2::bigint, $2::bigint + $3::bigint - 1) g
          CROSS JOIN LATERAL (SELECT date_trunc('milliseconds', $4::timestamptz + (g - $2::bigint) * ($5::double precision * interval '1 millisecond')) AS ts) t
          JOIN tpl ON tpl.i = g % $6::int
          JOIN emr_access.access_entry e ON e.event_id = tpl.event_id
          CROSS JOIN LATERAL (SELECT jsonb_set(jsonb_set(e.payload::jsonb, '{eventId}', to_jsonb('SYN-PERIOD-' || g)), '{occurredAt}',
            to_jsonb(to_char(t.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) AS a) a
          -- Another institution (1 in 50), an unknown managing institution (1 in 97), a PDF export action (1 in 7).
          CROSS JOIN LATERAL (SELECT CASE WHEN g % 97 = 0 THEN jsonb_set(a.a, '{managingInstitution}', '{"status":"unresolved","reason":"not-observed"}')
            WHEN g % 50 = 0 THEN jsonb_set(a.a, '{managingInstitution,value}', '"SYN-B"') ELSE a.a END AS b) b
          CROSS JOIN LATERAL (SELECT CASE WHEN g % 7 = 0 AND e.stream = 'viewing' THEN jsonb_set(b.b, '{action}', '"pdf"') ELSE b.b END AS p) v
          ORDER BY g, e.stream DESC`, templates.map(e => e.eventId), first, count, start, step, templates.length)]));
      await witness.$executeRawUnsafe('ANALYZE emr_access.access_entry');
      const [{ n }] = await witness.$queryRawUnsafe(`SELECT count(*)::int AS n FROM emr_access.access_entry`);
      return { ms, n };
    };
    // Events, not entries: about 1.4 entries per event over the templates.
    const perEvent = streams.reduce((sum, row) => sum + row.n, 0) / templates.length;
    const events = days => Math.round(days * PER_DAY / perEvent);
    let filled = await fill(1, events(5), ago(5 * DAY), 5 * DAY / events(5));
    console.log(`ledger ${filled.n} entries (5 days) filled in ${filled.ms} ms`);
    measured.small = filled.n;

    // The previous definition, installed under another name as the reference answer.
    const previous = fs.readFileSync(process.env.KIN_ACCESS_REVIEW_PREVIOUS, 'utf8');
    const body = previous.slice(previous.indexOf('CREATE FUNCTION'), previous.indexOf('$$;', previous.indexOf('$$') + 2) + 3)
      .replace('emr_access.review_entries(', 'emr_access.review_entries_previous(');
    assert.ok(body.includes('ceiling AS (') && body.endsWith('$$;'), 'reference definition extracted');
    await witness.$executeRawUnsafe(body);
    const direct = async (name, from, files, top, before, limit, client = witness) => client.$queryRawUnsafe(
      `SELECT entry_id::text, sequence::text, event_id, occurred_at, recorded_at, statutory_act, payload, snapshot_top::text
       FROM emr_access.${name}('SYN-A', $1::timestamptz, $2::timestamptz, $3::boolean, $4::bigint, $5::bigint, $6::integer)`,
      from, UNTIL, files, top, before, limit);
    let compared = 0;
    for (const span of [30 * 60000, 90 * 60000]) {
      for (const files of [false, true]) {
        const all = await direct('review_entries', ago(span), files, null, null, 1000000);
        assert.ok(all.length > 100, `window ${span / 60000} min has rows (${all.length})`);
        const mid = all[Math.floor(all.length / 2)];
        const cases = [[null, null, 26], [null, null, 1000000], [all[0].snapshot_top, mid.sequence, 26], [mid.sequence, null, 1000000],
          [null, null, 0], [all[0].snapshot_top, all[all.length - 2].sequence, 26]];
        for (const [top, before, limit] of span > 30 * 60000 ? cases.slice(0, 3) : cases) {
          const was = await direct('review_entries_previous', ago(span), files, top, before, limit);
          const now = await direct('review_entries', ago(span), files, top, before, limit);
          assert.deepEqual(now, was, `same answer: ${span / 60000} min, files ${files}, top ${top}, before ${before}, limit ${limit}`);
          compared++;
        }
      }
    }
    console.log(`previous and current definition: ${compared} answers identical (rows, order, ceiling)`);

    // The previous definition on a day: the defect. It does not finish in 20 s.
    const stalled = await elapsed(() => witness.$transaction([witness.$executeRawUnsafe(`SET LOCAL statement_timeout = '20s'`),
      witness.$queryRawUnsafe(`SELECT count(*) FROM emr_access.review_entries_previous('SYN-A', $1::timestamptz, $2::timestamptz, false, NULL, NULL, 26)`,
        ago(DAY), UNTIL)]).then(() => 'answered', error => String(error.message).includes('statement timeout') ? 'timed out' : 'failed: ' + error.message));
    assert.equal(stalled.value, 'timed out', 'the previous definition answers a day within 20 s');
    console.log(`previous definition, one day: timed out after ${stalled.ms} ms`);

    class Fixture {}
    Module({ controllers: [AdminController], providers: [AdminAccessReview,
      { provide: PrismaService, useValue: db }, { provide: StudyAccessService, useValue: access },
      { provide: AdminService, useValue: { auditEvents: () => ({ legacy: true }) } },
      { provide: PacsService, useValue: {} }, { provide: REQUEST_CONTEXT_SOURCE, useValue: requests.source }] })(Fixture);
    app = await NestFactory.create(Fixture, { logger: false });
    app.setGlobalPrefix('api');
    app.use((req, res, next) => { Object.assign(req, { sub: 'admin', actor: 'SYN-ADMIN', institution: 'SYN-A', roles: ['admin'], kind: 'member' });
      requests.capture.capture(req, res, { issuer: 'SYN-ISSUER', subject: req.sub, roles: req.roles,
        institution: req.institution, rightsVersion: 1, binding: { method: 'bearer', sessionRef: null } },
        { method: 'GET', route: 'admin/audit', purpose: 'clinical' }, async () => {});
      next(); });
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()).replace('0.0.0.0', '127.0.0.1');
    const review = async (span, options = {}, signal) => {
      const query = new URLSearchParams({ report: 'access', from: ago(span), until: UNTIL, downloads: 'all', ...options });
      const r = await fetch(`${base}/api/admin/audit?${query}`, { signal: signal ?? AbortSignal.timeout(90000) });
      return { status: r.status, body: await r.json() };
    };
    const pages = async (label, span, files) => {
      const downloads = files ? 'files' : 'all';
      const first = await elapsed(() => review(span, { downloads }));
      assert.equal(first.value.status, 200, `${label}: first page ${JSON.stringify(first.value.body).slice(0, 300)}`);
      assert.equal(first.value.body.rows.length, 25, `${label}: a full first page`);
      assert.ok(first.value.body.next, `${label}: a continuation`);
      const second = await elapsed(() => review(span, { downloads, after: first.value.body.next }));
      assert.equal(second.value.status, 200, `${label}: continuation`);
      const shown = [...first.value.body.rows, ...second.value.body.rows].map(r => r.eventId);
      assert.equal(new Set(shown).size, shown.length, `${label}: pages do not repeat an event`);
      // The two pages are exactly the function's first 50 events in sequence order.
      const truth = await direct('review_entries', ago(span), files, null, null, 50, db);
      assert.deepEqual(shown, truth.map(r => r.event_id), `${label}: page boundary`);
      measured[label] = { first: first.ms, second: second.ms };
      console.log(`${label}: first page ${first.ms} ms, continuation ${second.ms} ms`);
      return first.value.body.rows.map(r => r.eventId);
    };
    const dayBefore = await pages('170k: one day', DAY, false);
    await pages('170k: one day, file events', DAY, true);
    await pages('170k: five days', 5 * DAY, false);

    // An abandoned request ends in PostgreSQL by the limit. A lock holds the read so it cannot finish first.
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const locked = locker.$transaction(async tx => {
      await tx.$executeRawUnsafe('LOCK TABLE emr_access.access_entry IN ACCESS EXCLUSIVE MODE');
      await held;
    }, { maxWait: 10000, timeout: 180000 });
    await new Promise(resolve => setTimeout(resolve, 500));
    const running = async marker => (await witness.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND usename = 'kin_runtime' AND state = 'active' AND query LIKE $1`, marker))[0].n;
    const started = Date.now();
    const abandon = new AbortController();
    const abandoned = review(DAY, {}, abandon.signal).then(() => 'answered', error => error.name);
    const waited = review(DAY);
    // The read as the previous code issued it: outside a transaction, no limit.
    const unbounded = db.$queryRawUnsafe(`/* unbounded probe */ SELECT count(*) FROM emr_access.review_entries('SYN-A', $1::timestamptz, $2::timestamptz, false, NULL, NULL, 26)`,
      ago(DAY), UNTIL);
    let seen = 0;
    for (let i = 0; i < 50 && seen < 2; i++) { await new Promise(resolve => setTimeout(resolve, 100)); seen = await running('%SELECT * FROM emr_access.review_entries(%'); }
    assert.equal(seen, 2, 'both Access Review reads wait in PostgreSQL');
    abandon.abort();
    assert.equal(await abandoned, 'AbortError');
    await new Promise(resolve => setTimeout(resolve, 5000));
    assert.equal(await running('%SELECT * FROM emr_access.review_entries(%'), 2, 'closing the browser request does not end the read');
    const answered = await waited;
    const ended = Date.now() - started;
    assert.equal(answered.status, 503, 'the waiting read is refused at the limit');
    assert.equal(answered.body.rows, undefined);
    for (let i = 0; i < 50 && await running('%SELECT * FROM emr_access.review_entries(%'); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await running('%SELECT * FROM emr_access.review_entries(%'), 0, 'no Access Review read is left in PostgreSQL');
    assert.ok(ended >= 29000 && ended < 45000, `ended by the 30 s limit (${ended} ms)`);
    assert.equal(await running('%unbounded probe%'), 1, 'an unbounded read would still be waiting');
    release(); await locked; await unbounded;
    measured.abandoned = ended;
    console.log(`abandoned and waiting reads ended in PostgreSQL after ${ended} ms (503); the unbounded read was still waiting`);
    // The limit stays inside its transaction: the pooled connections keep the server default.
    for (let i = 0; i < 12; i++) assert.equal((await db.$queryRawUnsafe('SHOW statement_timeout'))[0].statement_timeout, '0');
    const after = await review(DAY);
    assert.equal(after.status, 200, 'the next read answers');

    // A thirty-day ledger: older entries outside the reviewed day do not change its answer.
    const before = filled.n;
    filled = await fill(10000000, events(25), ago(30 * DAY), 25 * DAY / events(25));
    console.log(`ledger ${filled.n} entries (30 days) filled in ${filled.ms} ms`);
    measured.large = filled.n;
    assert.ok(filled.n - before > 800000);
    const dayAfter = await pages('1.02M: one day', DAY, false);
    assert.deepEqual(dayAfter, dayBefore, 'the reviewed day answers the same on the larger ledger');
    await pages('1.02M: one week', 7 * DAY, false);
    await pages('1.02M: one week, file events', 7 * DAY, true);
    const month = await elapsed(() => review(30 * DAY));
    measured.month = { status: month.value.status, ms: month.ms };
    console.log(`1.02M: thirty days (not required) answered ${month.value.status} in ${month.ms} ms`);
    console.log('MEASURED ' + JSON.stringify(measured));
    console.log('PASS: Access Review over a day, five days and a week on 170k and 1.02M entries; same answers as before; abandoned reads end in PostgreSQL');
  } finally {
    if (app) await app.close();
    await db.$disconnect(); await witness.$disconnect(); await locker.$disconnect();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
