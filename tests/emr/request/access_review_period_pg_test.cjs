'use strict';
// Access Review over practical periods: the real Nest GET and the migrated PG function on a synthetic ledger of
// about 170,000 and then about 1,020,000 entries (about 34,000 a day). Checks that
//  - the function answers exactly what the previous definition answered (rows, order, ceiling, page boundaries),
//    where the previous definition still answers (half-hour and 90-minute windows), and for a day and a week exactly
//    what the previous definition answers with only its ceiling computed once (the reference: same SQL otherwise);
//  - a day, five days and a week answer through HTTP within the screen's 60 s, first page and continuation equal
//    the reference field by field, and the reader's own access record names the served rows;
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
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const db = new PrismaClient(), witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_B2R_WITNESS_URL } } });
  const store = new AccessLedgerStore(db, new FailureJournal(db, new FailureSpool(process.env.KIN_B2R_SPOOL)));
  const requests = createRequestContext({ resolve: async () => ({ status: 'unresolved', reason: 'not-observed' }) }, createRecordPort(store).port);
  const access = { snapshot: async () => ({ policy: { restricted: false } }), unchanged: async () => {} };
  const measured = {};
  let app;
  try {
    await db.$connect(); await witness.$connect();
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
    // Bulk copies of templates[g % 4], oldest first; occurredAt in the payload follows the column. A pair's two
    // entries alternate which stream is inserted first (has the smaller sequence): viewing for even g / 4, history for odd.
    // One transaction per 100,000 events and no parallel workers: a single 850,000-row statement lost the fixture's
    // server connection (its container has 1 GB and Docker's 64 MB /dev/shm).
    const fill = async (first, count, start, step) => {
      const began = Date.now();
      for (let done = 0; done < count; done += 100000) await fillChunk(first + done, Math.min(100000, count - done),
        iso(Date.parse(start) + done * step), step);
      await witness.$executeRawUnsafe('ANALYZE emr_access.access_entry');
      const [{ n }] = await witness.$queryRawUnsafe(`SELECT count(*)::int AS n FROM emr_access.access_entry`);
      return { ms: Date.now() - began, n };
    };
    const fillChunk = (first, count, start, step) => witness.$transaction([
        // The receipt and operation rows of real appends are not part of what Access Review reads.
        witness.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
        witness.$executeRawUnsafe(`SET LOCAL max_parallel_workers_per_gather = 0`),
        witness.$executeRawUnsafe(`
          WITH tpl AS (SELECT (u.i - 1)::int AS i, u.id AS event_id FROM unnest($1::text[]) WITH ORDINALITY AS u(id, i))
          INSERT INTO emr_access.access_entry(entry_id, operation_id, stream, event_id, payload, occurred_at, statutory_act, retention_class)
          SELECT gen_random_uuid(), gen_random_uuid(), e.stream, 'SYN-PERIOD-' || g, v.p::text,
            t.ts, e.statutory_act, e.retention_class
          FROM generate_series($2::bigint, $2::bigint + $3::bigint - 1) g
          CROSS JOIN LATERAL (SELECT date_trunc('milliseconds', $4::timestamptz + (g - $2::bigint) * ($5::double precision * interval '1 millisecond')) AS ts) t
          JOIN tpl ON tpl.i = g % $6::int
          JOIN emr_access.access_entry e ON e.event_id = tpl.event_id
          CROSS JOIN LATERAL (SELECT jsonb_set(jsonb_set(e.payload::jsonb, '{eventId}', to_jsonb('SYN-PERIOD-' || g)), '{occurredAt}',
            to_jsonb(to_char(t.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) AS a) a
          -- Another institution (1 in 50), an unknown managing institution (1 in 97), a PDF export on the viewing entry (1 in 7).
          CROSS JOIN LATERAL (SELECT CASE WHEN g % 97 = 0 THEN jsonb_set(a.a, '{managingInstitution}', '{"status":"unresolved","reason":"not-observed"}')
            WHEN g % 50 = 0 THEN jsonb_set(a.a, '{managingInstitution,value}', '"SYN-B"') ELSE a.a END AS b) b
          CROSS JOIN LATERAL (SELECT CASE WHEN g % 7 = 0 AND e.stream = 'viewing' THEN jsonb_set(b.b, '{action}', '"pdf"') ELSE b.b END AS c) c
          -- Values in the optional authentication fields (1 in 11), which the screen shows when present.
          CROSS JOIN LATERAL (SELECT CASE WHEN g % 11 = 0 THEN c.c || '{"auth":{"method":"session","sessionRef":"SYN-SESSION"},
            "affectedIdentity":{"status":"known","value":{"id":"SYN-MEMBER","issuer":"SYN-ISSUER","subject":"SYN-MEMBER-SUB"}},
            "rightsVersion":3}'::jsonb ELSE c.c END AS p) v
          ORDER BY g, CASE WHEN (g / $6::int) % 2 = 0 THEN e.stream END DESC, e.stream`, templates.map(e => e.eventId), first, count, start, step, templates.length)]);
    const perEvent = streams.reduce((sum, row) => sum + row.n, 0) / templates.length;
    const events = days => Math.round(days * PER_DAY / perEvent);
    let filled = await fill(1, events(5), ago(5 * DAY), 5 * DAY / events(5));
    console.log(`ledger ${filled.n} entries (5 days) filled in ${filled.ms} ms`);
    measured.small = filled.n;
    // One entry whose targets is not an array, alone in its institution: both definitions must treat it alike.
    await witness.$transaction([witness.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      witness.$executeRawUnsafe(`INSERT INTO emr_access.access_entry(entry_id, operation_id, stream, event_id, payload, occurred_at, statutory_act, retention_class)
        SELECT gen_random_uuid(), gen_random_uuid(), stream, 'SYN-MALFORMED',
          jsonb_set(jsonb_set(payload::jsonb, '{managingInstitution,value}', '"SYN-C"'), '{targets}', '{}')::text, $2::timestamptz, statutory_act, retention_class
        FROM emr_access.access_entry WHERE event_id = $1`, templates[0].eventId, ago(20 * 60000))]);

    // The previous definition, installed under other names: exactly (the defect) and with only its ceiling computed
    // once (the reference for windows the previous one cannot answer — MATERIALIZED changes the plan, not the answer).
    const previous = fs.readFileSync(process.env.KIN_ACCESS_REVIEW_PREVIOUS, 'utf8');
    const body = previous.slice(previous.indexOf('CREATE FUNCTION'), previous.indexOf('$$;', previous.indexOf('$$') + 2) + 3);
    assert.ok(body.includes('ceiling AS (') && body.endsWith('$$;'), 'previous definition extracted');
    await witness.$executeRawUnsafe(body.replace('emr_access.review_entries(', 'emr_access.review_entries_previous('));
    await witness.$executeRawUnsafe(body.replace('emr_access.review_entries(', 'emr_access.review_entries_reference(')
      .replace('ceiling AS (', 'ceiling AS MATERIALIZED ('));
    const direct = async (name, from, files, top, before, limit, { client = witness, inst = 'SYN-A' } = {}) => client.$queryRawUnsafe(
      `SELECT entry_id::text, sequence::text, event_id, occurred_at, recorded_at, statutory_act, payload, snapshot_top::text
       FROM emr_access.${name}($7::text, $1::timestamptz, $2::timestamptz, $3::boolean, $4::bigint, $5::bigint, $6::integer)`,
      from, UNTIL, files, top, before, limit, inst);
    const same = async (reference, from, files, top, before, limit, label) => {
      const was = await direct(reference, from, files, top, before, limit);
      const now = await direct('review_entries', from, files, top, before, limit);
      assert.deepEqual(now, was, `same answer as ${reference}: ${label}, files ${files}, top ${top}, before ${before}, limit ${limit}`);
      return now;
    };
    let compared = 0;
    for (const span of [30 * 60000, 90 * 60000]) {
      for (const files of [false, true]) {
        const all = await direct('review_entries', ago(span), files, null, null, 1000000);
        assert.ok(all.length > 100, `window ${span / 60000} min has rows (${all.length})`);
        const top = all[0].snapshot_top, mid = all[Math.floor(all.length / 2)].sequence;
        const cases = [[null, null, 26], [null, null, 1000000], [top, mid, 26], [null, mid, 26], [mid, null, 1000000],
          [top, all[all.length - 2].sequence, 26], [null, null, 0], [null, null, -1], [null, null, null]];
        for (const [t, b, limit] of span > 30 * 60000 ? cases.slice(0, 4) : cases) {
          await same('review_entries_previous', ago(span), files, t, b, limit, `${span / 60000} min`); compared++;
        }
      }
    }
    // The reference is the previous answer, where the previous one answers.
    for (const files of [false, true]) {
      const was = await direct('review_entries_previous', ago(90 * 60000), files, null, null, 1000000);
      assert.deepEqual(await direct('review_entries_reference', ago(90 * 60000), files, null, null, 1000000), was, 'reference = previous');
    }
    // An institution with no entries, and one whose only entry has a non-array targets.
    for (const files of [false, true]) {
      const none = await direct('review_entries', ago(DAY), files, null, null, 26, { inst: 'SYN-NONE' });
      assert.deepEqual(none, await direct('review_entries_previous', ago(DAY), files, null, null, 26, { inst: 'SYN-NONE' }));
      assert.deepEqual(none, []);
    }
    const malformed = async (name, files) => direct(name, ago(DAY), files, null, null, 26, { inst: 'SYN-C' })
      .then(rows => rows.map(r => r.event_id), error => `error ${error.meta?.code ?? ''} ${String(error.message).match(/cannot extract elements[^"\n]*/)?.[0]}`);
    for (const files of [false, true]) assert.deepEqual(await malformed('review_entries', files), await malformed('review_entries_previous', files));
    assert.deepEqual(await malformed('review_entries', false), ['SYN-MALFORMED']);
    console.log(`previous and current definition: ${compared} answers identical (rows, order, ceiling); malformed targets alike: ${await malformed('review_entries', true)}`);

    // The previous definition on a day: the defect, measured (not a pass condition — the pass conditions are the
    // current definition's answers and times below).
    const stalled = await elapsed(() => witness.$transaction([witness.$executeRawUnsafe(`SET LOCAL statement_timeout = '20s'`),
      witness.$queryRawUnsafe(`SELECT count(*) FROM emr_access.review_entries_previous('SYN-A', $1::timestamptz, $2::timestamptz, false, NULL, NULL, 26)`,
        ago(DAY), UNTIL)]).then(() => 'answered', error => String(error.message).includes('statement timeout') ? 'not answered within 20 s' : 'failed: ' + error.message));
    measured.previousDay = `${stalled.value} (${stalled.ms} ms)`;
    console.log(`previous definition, one day: ${stalled.value} (${stalled.ms} ms)`);

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
    // The screen gives up at 60 s (session-transport.js DEADLINES.api); an answer after that is not an answer.
    const review = async (span, options = {}, signal) => {
      const query = new URLSearchParams({ report: 'access', from: ago(span), until: UNTIL, downloads: 'all', ...options });
      const r = await fetch(`${base}/api/admin/audit?${query}`, { signal: signal ?? AbortSignal.timeout(60000) });
      return { status: r.status, body: await r.json() };
    };
    // Every field of a served row, from the reference row and its stored event.
    const expected = row => { const e = JSON.parse(row.payload); return { eventId: row.event_id, occurredAt: row.occurred_at.toISOString(),
      recordedAt: row.recorded_at.toISOString(), statutoryAct: row.statutory_act, userId: e.userId, rolesAtTime: e.rolesAtTime,
      actingInstitution: e.actingInstitution, managingInstitution: e.managingInstitution, trustedProxyIp: e.trustedProxyIp,
      executor: e.executor, targets: e.targets, surface: e.surface, action: e.action, result: e.result, cause: e.cause,
      context: e.context, requestId: e.requestId, auditLinkId: e.auditLinkId, relatedEventId: e.relatedEventId,
      affectedIdentity: e.affectedIdentity ?? null, auth: e.auth ?? null, rightsVersion: e.rightsVersion ?? null }; };
    const cursor = next => JSON.parse(Buffer.from(next, 'base64url').toString('utf8'));
    const served = async () => (await witness.$queryRawUnsafe(`SELECT payload::jsonb AS event FROM emr_access.access_entry
      WHERE payload::jsonb->>'surface' = 'GET admin/audit' ORDER BY sequence DESC LIMIT 1`))[0].event;
    // Two pages through HTTP against the reference's first 50 events, every shown field; `late` adds an entry
    // inside the period between the pages: the continuation keeps the first page's ceiling.
    const pages = async (label, span, files, late) => {
      const downloads = files ? 'files' : 'all';
      const truth = await direct('review_entries_reference', ago(span), files, null, null, 51);
      assert.equal(truth.length, 51, `${label}: the period has more than two pages`);
      const first = await elapsed(() => review(span, { downloads }));
      assert.equal(first.value.status, 200, `${label}: first page ${JSON.stringify(first.value.body).slice(0, 300)}`);
      assert.deepEqual(first.value.body.rows, truth.slice(0, 25).map(expected), `${label}: first page`);
      assert.ok(first.value.body.next, `${label}: a continuation`);
      assert.deepEqual([cursor(first.value.body.next).top, cursor(first.value.body.next).before], [truth[0].snapshot_top, truth[24].sequence],
        `${label}: the continuation holds the period's ceiling and the last shown entry`);
      const own = await served();
      assert.deepEqual(own.targets.map(t => t.recordId.value), truth.slice(0, 25).map(r => r.entry_id), `${label}: the reader's access record names the served rows`);
      if (late) await late();
      const second = await elapsed(() => review(span, { downloads, after: first.value.body.next }));
      assert.equal(second.value.status, 200, `${label}: continuation`);
      assert.deepEqual(second.value.body.rows, truth.slice(25, 50).map(expected), `${label}: continuation`);
      if (!files) assert.ok([...first.value.body.rows, ...second.value.body.rows].some(r => r.auth && r.affectedIdentity && r.rightsVersion === 3),
        `${label}: the optional authentication fields are compared with values`);
      assert.deepEqual([cursor(second.value.body.next).top, cursor(second.value.body.next).before], [truth[0].snapshot_top, truth[49].sequence],
        `${label}: the next continuation keeps the first ceiling`);
      measured[label] = { first: first.ms, second: second.ms };
      console.log(`${label}: first page ${first.ms} ms, continuation ${second.ms} ms`);
      return first.value.body.rows.map(r => r.eventId);
    };
    // A day and a week: the current definition equals the reference beyond the first page as well.
    const deep = async (span, label) => { for (const files of [false, true]) {
      const all = await direct('review_entries_reference', ago(span), files, null, null, 2000);
      assert.equal(all.length, 2000, `${label}: files ${files} has 2000 events`);
      assert.deepEqual(await direct('review_entries', ago(span), files, null, null, 2000), all, `same answer as the reference: ${label}, files ${files}, first 2000`);
      await same('review_entries_reference', ago(span), files, all[0].snapshot_top, all[1000].sequence, 26, label);
      compared += 2;
    } };
    await deep(DAY, '170k one day');
    const dayBefore = await pages('170k: one day', DAY, false);
    await pages('170k: one day, file events', DAY, true);
    await pages('170k: five days', 5 * DAY, false);

    // The limit stays inside its transaction: after successful reads every pooled connection keeps the server default.
    const pooled = async when => {
      const settings = await Promise.all(Array.from({ length: 30 }, () =>
        db.$queryRawUnsafe(`SELECT current_setting('statement_timeout') AS t, pg_backend_pid() AS pid FROM pg_sleep(0.3)`)));
      assert.deepEqual([...new Set(settings.map(([row]) => row.t))], ['0'], `no pooled connection keeps the limit (${when})`);
      console.log(`statement_timeout on ${new Set(settings.map(([row]) => row.pid)).size} pooled connections ${when}: 0`);
    };
    await pooled('after the answered reads');

    // An abandoned request ends in PostgreSQL by the statement limit. A read that is slow by itself (sleeping, not
    // waiting on a lock) stands in for the current definition, which is then put back.
    const signature = 'emr_access.review_entries(text,timestamptz,timestamptz,boolean,bigint,bigint,integer)';
    const [{ sql: current }] = await witness.$queryRawUnsafe(`SELECT pg_get_functiondef('${signature}'::regprocedure) AS sql`);
    const running = async marker => (await witness.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND usename = 'kin_runtime' AND state = 'active' AND query LIKE $1`, marker))[0].n;
    const PRODUCT = '%SELECT * FROM emr_access.review_entries(%', PROBE = '%unbounded probe%';
    await witness.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION emr_access.review_entries(p_institution text, p_from timestamptz,
      p_until timestamptz, p_files boolean, p_top bigint, p_before bigint, p_limit integer)
      RETURNS TABLE(entry_id uuid, sequence bigint, event_id text, occurred_at timestamptz, recorded_at timestamptz,
        statutory_act text, payload text, snapshot_top bigint)
      LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
        WITH nap AS MATERIALIZED (SELECT p_limit AS x FROM pg_sleep(120))
        SELECT NULL::uuid, NULL::bigint, NULL::text, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::text, NULL::bigint
        FROM nap WHERE nap.x < 0
      $$`);
    try {
      // A shorter limit already set for the runtime role is kept (new sessions read it).
      await witness.$executeRawUnsafe(`ALTER ROLE kin_runtime SET statement_timeout = '3s'`);
      await db.$disconnect(); await db.$connect();
      const shorter = await elapsed(() => review(DAY));
      assert.equal(shorter.value.status, 503, 'a slow read under a 3 s role limit is refused');
      assert.ok(shorter.ms >= 2900 && shorter.ms < 9000, `the role's 3 s limit is kept, not raised (${shorter.ms} ms)`);
      await witness.$executeRawUnsafe(`ALTER ROLE kin_runtime RESET statement_timeout`);
      await db.$disconnect(); await db.$connect();
      measured.roleLimit = shorter.ms;
      console.log(`a 3 s role limit was kept: 503 after ${shorter.ms} ms`);

      const started = Date.now();
      const abandon = new AbortController();
      const abandoned = review(DAY, {}, abandon.signal).then(() => 'answered', error => error.name);
      const waited = review(DAY, {}, AbortSignal.timeout(90000));
      // The read as the previous code issued it: outside a transaction, no limit. A Prisma query starts when awaited.
      const unbounded = db.$queryRawUnsafe(`/* unbounded probe */ SELECT count(*) FROM emr_access.review_entries('SYN-A', $1::timestamptz, $2::timestamptz, false, NULL, NULL, 26)`,
        ago(DAY), UNTIL).then(rows => rows, error => error);
      for (let i = 0; i < 100 && (await running(PRODUCT) < 2 || await running(PROBE) < 1); i++) await pause(100);
      assert.equal(await running(PRODUCT), 2, 'both Access Review reads run in PostgreSQL');
      assert.equal(await running(PROBE), 1, 'the unbounded read runs in PostgreSQL');
      abandon.abort();
      assert.equal(await abandoned, 'AbortError');
      await pause(5000);
      assert.equal(await running(PRODUCT), 2, 'closing the browser request alone does not end its read');
      const answered = await waited;
      assert.equal(answered.status, 503, 'the waiting read is refused at the limit');
      assert.equal(answered.body.rows, undefined);
      for (let i = 0; i < 100 && await running(PRODUCT); i++) await pause(100);
      const gone = Date.now() - started;
      assert.equal(await running(PRODUCT), 0, 'no Access Review read is left in PostgreSQL, the abandoned one included');
      assert.ok(gone >= 29000 && gone < 42000, `both reads ended by the 30 s limit (${gone} ms)`);
      assert.equal(await running(PROBE), 1, 'an unbounded read would still be running');
      await witness.$queryRawUnsafe(`SELECT pg_cancel_backend(pid)::text FROM pg_stat_activity WHERE usename = 'kin_runtime' AND query LIKE $1`, PROBE);
      await unbounded;
      measured.abandoned = gone;
      console.log(`abandoned and waiting reads ended in PostgreSQL ${gone} ms after they started (503); the unbounded read was still running`);
    } finally {
      await witness.$executeRawUnsafe(`ALTER ROLE kin_runtime RESET statement_timeout`);
      await witness.$executeRawUnsafe(current);
      await witness.$queryRawUnsafe(`SELECT pg_cancel_backend(pid)::text FROM pg_stat_activity WHERE usename = 'kin_runtime' AND query LIKE $1`, PROBE);
    }
    assert.equal((await witness.$queryRawUnsafe(`SELECT pg_get_functiondef('${signature}'::regprocedure) AS sql`))[0].sql, current,
      'the current definition is back');
    assert.equal((await review(DAY)).status, 200, 'the next read answers');
    await pooled('after the refused and the next answered read');

    // A thirty-day ledger: older entries outside the reviewed day do not change its answer.
    const before = filled.n;
    filled = await fill(10000000, events(25), ago(30 * DAY), 25 * DAY / events(25));
    console.log(`ledger ${filled.n} entries (30 days) filled in ${filled.ms} ms`);
    measured.large = filled.n;
    assert.ok(filled.n - before > 800000);
    const dayAfter = await pages('1.02M: one day', DAY, false);
    assert.deepEqual(dayAfter, dayBefore, 'the reviewed day answers the same on the larger ledger');
    await deep(7 * DAY, '1.02M one week');
    await pages('1.02M: one week', 7 * DAY, false);
    // Last: a file entry arrives inside the period between the two pages (templates[2] is the download).
    await pages('1.02M: one week, file events', 7 * DAY, true, () => fill(20000002, 1, ago(60000), 1));
    const month = await elapsed(() => review(30 * DAY, {}, AbortSignal.timeout(90000)).catch(error => ({ status: error.name })));
    measured.month = { status: month.value.status, ms: month.ms };
    console.log(`1.02M: thirty days (not required) answered ${month.value.status} in ${month.ms} ms`);
    console.log(`compared ${compared} answers in all`);
    console.log('MEASURED ' + JSON.stringify(measured));
    console.log('PASS: Access Review over a day, five days and a week on 170k and 1.02M entries; same answers as before; abandoned reads end in PostgreSQL');
  } finally {
    if (app) await app.close();
    await db.$disconnect(); await witness.$disconnect();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
