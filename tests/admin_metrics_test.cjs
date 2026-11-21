'use strict';
/* TEST-S5-U6b-PURE: the admin Operations metric model.
 * REQ-S5-U6b-OPS-METRICS -> RISK-S5-U6b-UNKNOWN-AS-ZERO / INVENTED-THRESHOLD / TENANT-AGGREGATE.
 *
 * Two halves over one answer fixture (ANSWER below):
 *  - page: the <script id="admin-metrics-model"> block of worklist-v0/hpacs-lite/admin.html, run as shipped in a vm
 *    context (no copy, no DOM). Every read, failure, missing-source and zero-denominator vector; wording; no threshold.
 *  - server: the compiled api/src/pacs.service.ts (adminMetricRows, orthancDiskBytes, PacsService.adminMetrics) and its
 *    metrics concern api/src/pacs/metrics.ts (S9-U0b: the owner of the clock and wait seams) over a
 *    fake store. It runs only when KIN_ADMIN_METRICS_SERVER names the compiled module (kin-api:ci: /app/dist/pacs.service);
 *    when the variable is set a missing module fails the run. Without it these cases are reported as skipped, never passed.
 * The server half proves the fixture is what the compiled rows produce, so the page half reads the real shape.
 * Synthetic data only; no network, database, credentials or clinical data.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = readFileSync(path.join(__dirname, '..', 'worklist-v0', 'hpacs-lite', 'admin.html'), 'utf8');
const OPEN = '<script id="admin-metrics-model">';

function modelSource() {
  const start = HTML.indexOf(OPEN);
  assert.ok(start >= 0, 'the model block is gone from admin.html');
  assert.equal(HTML.indexOf(OPEN, start + 1), -1, 'exactly one model block');
  return HTML.slice(start + OPEN.length, HTML.indexOf('</script>', start));
}
const context = vm.createContext({});
vm.runInContext(modelSource(), context, { filename: 'admin.html#admin-metrics-model' });
const M = context.KinAdminMetrics;
// Objects made in the vm realm carry its prototypes; compare them as JSON values.
const json = value => JSON.parse(JSON.stringify(value));
const F = iso => `<${iso}>`;

const SERVER = process.env.KIN_ADMIN_METRICS_SERVER || '';
const S = SERVER ? require(SERVER) : null;
const { StudyAccessService } = SERVER ? require(path.join(path.dirname(SERVER), 'study-access.service')) : {};
// S9-U0b: the metrics concern owns the observation clock and the source wait (its protected seams); the facade forwards to it.
const { PacsMetrics } = SERVER ? require(path.join(path.dirname(SERVER), 'pacs', 'metrics')) : {};
const { OrthancService } = SERVER ? require(path.join(path.dirname(SERVER), 'orthanc.service')) : {};
const { PacsAccess } = SERVER ? require(path.join(path.dirname(SERVER), 'pacs', 'access')) : {};
const hosted = S ? false : 'KIN_ADMIN_METRICS_SERVER is not set: the compiled PacsService runs in kin-api:ci only (/app/dist)';

const KEYS = ['storage.server', 'storage.institution', 'studies.own', 'studies.tele', 'studies.flag_unreadable',
  'studies.registered_24h', 'studies.registered_7d', 'tat.emergency', 'tat.normal', 'waiting.emergency', 'waiting.normal',
  'server.api_uptime', 'server.api_started'];
const NOW = '2026-09-26T00:00:00.000Z';
const DAY_FROM = '2026-09-25T00:00:00.000Z';
const WEEK_FROM = '2026-09-19T00:00:00.000Z';
const DISK_AT = '2026-09-25T23:59:59.500Z';
const GENERATED = '2026-09-26T00:00:01.000Z';
const BYTES = 13421772800;   // 12.5 GiB
// The API process: started 3 d 04 h 05 min before NOW.
const UPTIME = 3 * 86400 + 4 * 3600 + 5 * 60, STARTED = '2026-09-22T19:55:00.000Z';
const SRC = {
  disk: 'Orthanc GET /statistics TotalDiskSize', studies: 'HALO PACS DB StudyState', registered: 'HALO PACS DB StudyState.createdAt',
  tat: 'HALO PACS DB StudyState.createdAt, ReportVersion(action=approve).at, StudyState.em',
  waiting: 'HALO PACS DB StudyState.createdAt, StudyState.rs, StudyState.em',
  uptime: 'HALO PACS API process (performance.now)', started: 'HALO PACS API process (performance.timeOrigin)',
};
const base = { reason: null, max: null, denominator: null, excluded: null, window: null };
const ROWS = [
  { ...base, key: 'storage.server', state: 'observed', scope: 'server', source: SRC.disk, observedAt: DISK_AT, unit: 'byte',
    value: BYTES, denominator: { unit: 'byte', value: null } },
  { ...base, key: 'storage.institution', state: 'unobservable', reason: 'no_source', scope: 'institution', source: null,
    observedAt: null, unit: 'byte', value: null, denominator: { unit: 'byte', value: null } },
  { ...base, key: 'studies.own', state: 'observed', scope: 'institution', source: SRC.studies, observedAt: NOW, unit: 'study', value: 10 },
  { ...base, key: 'studies.tele', state: 'observed', scope: 'institution', source: SRC.studies, observedAt: NOW, unit: 'study', value: 1 },
  { ...base, key: 'studies.flag_unreadable', state: 'observed', scope: 'institution', source: SRC.studies, observedAt: NOW,
    unit: 'study', value: 1 },
  { ...base, key: 'studies.registered_24h', state: 'observed', scope: 'institution', source: SRC.registered, observedAt: NOW,
    unit: 'study', value: 7, excluded: 0, window: { from: DAY_FROM, to: NOW } },
  { ...base, key: 'studies.registered_7d', state: 'observed', scope: 'institution', source: SRC.registered, observedAt: NOW,
    unit: 'study', value: 9, excluded: 0, window: { from: WEEK_FROM, to: NOW } },
  { ...base, key: 'tat.emergency', state: 'observed', scope: 'institution', source: SRC.tat, observedAt: NOW, unit: 'second',
    value: 14400, max: 86400, denominator: { unit: 'study', value: 3 }, excluded: 0, window: { from: WEEK_FROM, to: NOW } },
  { ...base, key: 'tat.normal', state: 'observed', scope: 'institution', source: SRC.tat, observedAt: NOW, unit: 'second',
    value: 86400, max: 86400, denominator: { unit: 'study', value: 1 }, excluded: 1, window: { from: WEEK_FROM, to: NOW } },
  { ...base, key: 'waiting.emergency', state: 'observed', scope: 'institution', source: SRC.waiting, observedAt: NOW,
    unit: 'second', value: 3600, max: 3600, denominator: { unit: 'study', value: 1 }, excluded: 0 },
  { ...base, key: 'waiting.normal', state: 'observed', scope: 'institution', source: SRC.waiting, observedAt: NOW,
    unit: 'second', value: 12600, max: 18000, denominator: { unit: 'study', value: 2 }, excluded: 1 },
  { ...base, key: 'server.api_uptime', state: 'observed', scope: 'server', source: SRC.uptime, observedAt: NOW,
    unit: 'duration_seconds', value: UPTIME },
  { ...base, key: 'server.api_started', state: 'observed', scope: 'server', source: SRC.started, observedAt: NOW,
    unit: 'timestamp', value: STARTED },
];
const PROCESS = { uptimeSeconds: UPTIME, startedAt: Date.parse(STARTED), observedAt: Date.parse(NOW) };
const ANSWER = { institutionId: 'hallym', generatedAt: GENERATED, metrics: ROWS };
const clone = value => JSON.parse(JSON.stringify(value));
const withRow = (key, change) => {
  const answer = clone(ANSWER);
  answer.metrics = answer.metrics.map(row => row.key === key ? (typeof change === 'function' ? change(row) : { ...row, ...change }) : row);
  return answer;
};
const read = answer => json(M.readAnswer(answer));
const rowOf = (answer, key) => read(answer).rows.find(row => row.key === key);

// ── page model ──

test('the page table is the fixed thirteen rows in the server order, frozen', () => {
  assert.deepEqual(json(M.METRICS.map(item => item.key)), KEYS);
  assert.ok(Object.isFrozen(M.METRICS) && M.METRICS.every(Object.isFrozen));
  assert.ok(Object.isFrozen(M.ROW_STATES) && Object.values(M.ROW_STATES).every(Object.isFrozen));
  assert.ok(Object.isFrozen(M.REASONS) && Object.isFrozen(M.UNITS));
  assert.deepEqual(json(Object.keys(M.REASONS)).sort(), ['invalid_answer', 'no_source', 'source_failed', 'timeout', 'unattributed']);
});

test('a server answer is read row by row and every row keeps its source, time, unit, denominator and scope', () => {
  const result = read(ANSWER);
  assert.equal(result.institutionId, 'hallym');
  assert.equal(result.generatedAt, GENERATED);
  assert.deepEqual(result.rows.map(row => [row.key, row.state, row.value, row.max, row.denominator, row.excluded]), [
    ['storage.server', 'observed', BYTES, null, null, null],
    ['storage.institution', 'unobservable', null, null, null, null],
    ['studies.own', 'observed', 10, null, null, null],
    ['studies.tele', 'observed', 1, null, null, null],
    ['studies.flag_unreadable', 'observed', 1, null, null, null],
    ['studies.registered_24h', 'observed', 7, null, null, 0],
    ['studies.registered_7d', 'observed', 9, null, null, 0],
    ['tat.emergency', 'observed', 14400, 86400, 3, 0],
    ['tat.normal', 'observed', 86400, 86400, 1, 1],
    ['waiting.emergency', 'observed', 3600, 3600, 1, 0],
    ['waiting.normal', 'observed', 12600, 18000, 2, 1],
    ['server.api_uptime', 'observed', UPTIME, null, null, null],
    ['server.api_started', 'observed', STARTED, null, null, null],
  ]);
  const shown = result.rows.map(row => json(M.display(row, result.institutionId, F)));
  assert.deepEqual(shown.map(s => [s.label, s.stateText, s.value, s.unit, s.denominator, s.scope, s.source, s.observed]), [
    ['Storage Used (Server-wide)', 'Observed', '12.50 GiB', 'Bytes (1 GiB = 1024³ B)', 'Capacity Unobservable', 'Server-wide', SRC.disk, `<${DISK_AT}>`],
    ['Storage Used (This Institution)', 'Unobservable', 'Unobservable', 'Bytes (1 GiB = 1024³ B)', 'Capacity Unobservable', 'Institution hallym', 'No Source', 'Not Observed'],
    ['Studies Owned', 'Observed', '10', 'Studies', 'Not a Ratio', 'Institution hallym', SRC.studies, `<${NOW}>`],
    ['Studies Received for Tele-reading', 'Observed', '1', 'Studies', 'Not a Ratio', 'Institution hallym', SRC.studies, `<${NOW}>`],
    ['Emergency Flag Unreadable', 'Observed', '1', 'Studies', 'Not a Ratio', 'Institution hallym', SRC.studies, `<${NOW}>`],
    ['Registered in HALO PACS (Last 24 h)', 'Observed', '7', 'Studies', 'Not a Ratio', 'Institution hallym', SRC.registered, `<${NOW}>`],
    ['Registered in HALO PACS (Last 7 d)', 'Observed', '9', 'Studies', 'Not a Ratio', 'Institution hallym', SRC.registered, `<${NOW}>`],
    ['Report TAT (Emergency)', 'Observed', 'Median 4 h 00 min · Max 24 h 00 min', 'Elapsed Time (Median · Max)', '3 Studies', 'Institution hallym', SRC.tat, `<${NOW}>`],
    ['Report TAT (Normal)', 'Observed', 'Median 24 h 00 min · Max 24 h 00 min', 'Elapsed Time (Median · Max)', '1 Study · 1 Excluded', 'Institution hallym', SRC.tat, `<${NOW}>`],
    ['Waiting (Emergency)', 'Observed', 'Median 1 h 00 min · Max 1 h 00 min', 'Elapsed Time (Median · Max)', '1 Study', 'Institution hallym', SRC.waiting, `<${NOW}>`],
    ['Waiting (Normal)', 'Observed', 'Median 3 h 30 min · Max 5 h 00 min', 'Elapsed Time (Median · Max)', '2 Studies · 1 Excluded', 'Institution hallym', SRC.waiting, `<${NOW}>`],
    ['API Uptime (since start)', 'Observed', '3 d 04 h 05 min', 'Elapsed Time', 'Not a Ratio', 'Server-wide', SRC.uptime, `<${NOW}>`],
    ['Last Restart', 'Observed', `<${STARTED}>`, 'Date and Time', 'Not a Ratio', 'Server-wide', SRC.started, `<${NOW}>`],
  ]);
  // A server-wide row says whose value it is: storage is the Orthanc server, the process rows are the API process.
  assert.match(shown[0].scopeTitle, /Orthanc/);
  for (const index of [11, 12]) {
    assert.match(shown[index].scopeTitle, /API 프로세스/);
    assert.doesNotMatch(shown[index].scopeTitle, /Orthanc/);
  }
  assert.equal(shown[11].valueTitle, `원천 값 ${UPTIME}초`);
  assert.equal(shown[12].valueTitle, `서버 시각 ${STARTED}`);
  assert.equal(shown[0].valueTitle, `원천 값 ${BYTES}바이트`);
  assert.equal(shown[7].valueTitle, '중앙값 14400초 · 최댓값 86400초');
  assert.ok(shown[5].labelTitle.endsWith(` 기간: <${DAY_FROM}> ~ <${NOW}>.`), shown[5].labelTitle);
  assert.ok(shown[7].observedTitle.includes(`기간: <${WEEK_FROM}> ~ <${NOW}>.`), shown[7].observedTitle);
  assert.equal(shown[1].stateTitle, '값을 관측하지 못했습니다. 0으로 두지 않습니다. 제품에 이 값을 잴 원천이 없습니다.');
});

// Unknown is never a number: every cell of an unobservable row is a word, and only a known zero denominator says 0.
const DIGIT = /\d/;
function assertUnknownCells(shown) {
  for (const field of ['value', 'observed']) assert.doesNotMatch(shown[field], DIGIT, `${shown.key} ${field}: ${shown[field]}`);
  assert.doesNotMatch(shown.denominator, DIGIT, `${shown.key} denominator: ${shown.denominator}`);
  assert.equal(shown.value, 'Unobservable');
  assert.equal(shown.stateText, 'Unobservable');
}

test('every source failure reads Unobservable with its reason, never 0, on every row', () => {
  for (const reason of ['source_failed', 'invalid_answer', 'timeout', 'no_source']) {
    for (const key of KEYS) {
      const answer = withRow(key, row => ({ ...row, state: 'unobservable', reason, value: null, max: null, observedAt: null,
        excluded: null, window: null, denominator: row.unit === 'second' ? { unit: 'study', value: null } : row.denominator }));
      const row = rowOf(answer, key);
      assert.deepEqual([row.state, row.reason, row.value, row.observedAt], ['unobservable', reason, null, null], `${key} ${reason}`);
      const shown = json(M.display(row, 'hallym', F));
      assertUnknownCells(shown);
      assert.ok(shown.stateTitle.endsWith(M.REASONS[reason]), shown.stateTitle);
    }
  }
});

test('a zero denominator reads No Studies with a known 0 count, never 0 min', () => {
  for (const key of ['tat.emergency', 'tat.normal', 'waiting.emergency', 'waiting.normal']) {
    const answer = withRow(key, { state: 'empty', value: null, max: null, denominator: { unit: 'study', value: 0 }, excluded: 2 });
    const row = rowOf(answer, key);
    assert.deepEqual([row.state, row.value, row.max, row.denominator, row.excluded], ['empty', null, null, 0, 2], key);
    const shown = json(M.display(row, 'hallym', F));
    assert.deepEqual([shown.stateText, shown.value, shown.denominator], ['No Studies', 'No Studies', '0 Studies · 2 Excluded'], key);
    assert.doesNotMatch(shown.value, DIGIT);
    assert.match(shown.stateTitle, /0분이 아닙니다/);
  }
});

test('rows that do not prove their value read Unobservable (invalid_answer), including every disguised zero', () => {
  const cases = [
    ['studies.own', { value: null }, 'observed without a value'],
    ['studies.own', { value: '0' }, 'a string zero'],
    ['studies.own', { value: -1 }, 'a negative count'],
    ['studies.own', { value: 1.5 }, 'a fraction'],
    ['studies.own', { value: 2 ** 53 }, 'beyond safe integers'],
    ['studies.own', { observedAt: null }, 'no observation time'],
    ['studies.own', { observedAt: '2026-09-26 00:00:00' }, 'not an ISO UTC time'],
    ['studies.own', { source: '' }, 'no source'],
    ['studies.own', { source: null }, 'null source'],
    ['studies.own', { unit: 'second' }, 'another unit'],
    ['studies.own', { scope: 'server' }, 'another scope'],
    ['studies.own', { reason: 'source_failed' }, 'a reason on an observed row'],
    ['studies.own', { denominator: { unit: 'study', value: 10 } }, 'a denominator on a count'],
    ['studies.own', { state: 'empty' }, 'empty on a count'],
    ['studies.own', { state: 'fine' }, 'an unknown state'],
    ['studies.registered_24h', { window: null }, 'a windowed count without its window'],
    ['studies.registered_24h', { window: { from: WEEK_FROM, to: NOW } }, 'the wrong window length'],
    ['studies.registered_7d', { excluded: -1 }, 'a negative excluded count'],
    ['storage.server', { denominator: { unit: 'byte', value: 2 ** 40 } }, 'an invented capacity'],
    ['storage.server', { denominator: null }, 'storage without the capacity slot'],
    ['storage.server', { value: 0.5 }, 'fractional bytes'],
    ['tat.emergency', { denominator: { unit: 'study', value: 0 } }, 'observed with a zero denominator'],
    ['tat.emergency', { max: 100 }, 'a max below the median'],
    ['tat.emergency', { max: null }, 'no max'],
    ['tat.emergency', { excluded: null }, 'no excluded count'],
    ['tat.emergency', { window: null }, 'TAT without its window'],
    ['tat.emergency', { state: 'empty', value: 0, max: 0, denominator: { unit: 'study', value: 0 } }, 'empty carrying 0 min'],
    ['tat.emergency', { state: 'empty', value: null, max: null, denominator: { unit: 'study', value: 1 } }, 'empty with studies'],
    ['waiting.normal', { denominator: { unit: 'byte', value: 2 } }, 'a denominator in another unit'],
    ['waiting.normal', { state: 'unobservable', reason: 'source_failed', value: 0 }, 'unobservable carrying 0'],
    ['waiting.normal', { state: 'unobservable', reason: 'SYN', value: null, max: null }, 'an unknown reason'],
    ['server.api_uptime', { value: -1 }, 'a negative uptime'],
    ['server.api_uptime', { value: 1.5 }, 'a fractional uptime'],
    ['server.api_uptime', { value: '600' }, 'an uptime as text'],
    ['server.api_uptime', { value: null }, 'an observed uptime without a value'],
    ['server.api_uptime', { max: 5 }, 'a max on the uptime'],
    ['server.api_uptime', { denominator: { unit: 'study', value: 1 } }, 'a denominator on the uptime'],
    ['server.api_uptime', { excluded: 0 }, 'an excluded count on the uptime'],
    ['server.api_uptime', { window: { from: DAY_FROM, to: NOW } }, 'a window on the uptime'],
    ['server.api_uptime', { state: 'empty' }, 'empty on the uptime'],
    ['server.api_uptime', { scope: 'institution' }, 'the uptime as an institution value'],
    ['server.api_uptime', { unit: 'second' }, 'the uptime as a median'],
    ['server.api_started', { value: 'yesterday' }, 'a start that is not a time'],
    ['server.api_started', { value: Date.parse(STARTED) }, 'a start as milliseconds'],
    ['server.api_started', { value: '2026-09-22 19:55:00' }, 'a start that is not ISO UTC'],
    ['server.api_started', { observedAt: null }, 'no observation time on the start'],
    ['server.api_started', { source: '' }, 'no source on the start'],
  ];
  for (const [key, change, what] of cases) {
    const row = rowOf(withRow(key, change), key);
    assert.deepEqual([row.state, row.reason, row.value, row.max, row.observedAt], ['unobservable', 'invalid_answer', null, null, null],
      `${key}: ${what}`);
    const shown = json(M.display(row, 'hallym', F));
    assertUnknownCells(shown);
    assert.equal(shown.source, 'Unknown', what);
  }
  // A row the answer leaves out is unknown too, and the other rows still read.
  const missing = clone(ANSWER);
  missing.metrics = missing.metrics.filter(row => row.key !== 'tat.normal');
  const rows = read(missing).rows;
  assert.deepEqual([rows[8].key, rows[8].state, rows[8].reason], ['tat.normal', 'unobservable', 'invalid_answer']);
  assert.equal(rows.filter(row => row.state === 'observed').length, 11);
  // An extra, unknown row is not shown.
  const extra = clone(ANSWER);
  extra.metrics.push({ ...ROWS[2], key: 'studies.unknown', value: 5 });
  assert.deepEqual(read(extra).rows.map(row => row.key), KEYS);
});

test('an answer that cannot be read at all is null (the page keeps its last reading)', () => {
  const bad = [null, undefined, 'SYN', 7, [], {}, { ...ANSWER, institutionId: '' }, { ...ANSWER, institutionId: 3 },
    { ...ANSWER, generatedAt: 'soon' }, { ...ANSWER, generatedAt: null }, { ...ANSWER, metrics: 'SYN' },
    { ...ANSWER, metrics: undefined }, { ...ANSWER, metrics: [...ROWS, ROWS[2]] }, { ...ANSWER, metrics: [...ROWS, { value: 1 }] },
    { ...ANSWER, metrics: [...ROWS, null] }];
  bad.forEach((answer, index) => assert.equal(M.readAnswer(answer), null, `case ${index}`));
  assert.equal(read({ ...ANSWER, metrics: [] }).rows.every(row => row.state === 'unobservable'), true, 'no rows: all unknown');
});

test('units are stated and formatted without rounding a nonzero value to 0', () => {
  assert.deepEqual([0, 1023, 1024, 1536, 2 ** 20, BYTES, 2 ** 40 * 3].map(M.formatBytes),
    ['0 B', '1023 B', '1.00 KiB', '1.50 KiB', '1.00 MiB', '12.50 GiB', '3.00 TiB']);
  assert.deepEqual([0, 1, 59, 60, 119, 3599, 3600, 3660, 12600, 100 * 3600 + 7 * 60].map(M.formatDuration),
    ['0 s', '1 s', '59 s', '1 min', '1 min', '59 min', '1 h 00 min', '1 h 01 min', '3 h 30 min', '100 h 07 min']);
  assert.deepEqual(json(Object.fromEntries(Object.entries(M.UNITS).map(([key, [text]]) => [key, text]))),
    { byte: 'Bytes (1 GiB = 1024³ B)', study: 'Studies', second: 'Elapsed Time (Median · Max)', duration_seconds: 'Elapsed Time',
      timestamp: 'Date and Time' });
  // A process uptime: as the durations below a day, then days, hours and minutes.
  assert.deepEqual([0, 59, 3600, 86399, 86400, 86400 + 3660, UPTIME, 400 * 86400 + 59].map(M.formatUptime),
    ['0 s', '59 s', '1 h 00 min', '23 h 59 min', '1 d 00 h 00 min', '1 d 01 h 01 min', '3 d 04 h 05 min', '400 d 00 h 00 min']);
});

test('no threshold: a long wait and a short one differ only in their numbers', () => {
  const short = json(M.display(rowOf(withRow('waiting.normal', { value: 60, max: 120 }), 'waiting.normal'), 'hallym', F));
  const long = json(M.display(rowOf(withRow('waiting.normal', { value: 900000, max: 3600000 }), 'waiting.normal'), 'hallym', F));
  const differ = Object.keys(short).filter(key => short[key] !== long[key]);
  assert.deepEqual(differ, ['value', 'valueTitle']);
  assert.deepEqual(Object.keys(short), ['key', 'state', 'label', 'labelTitle', 'stateText', 'stateTitle', 'value', 'valueTitle',
    'unit', 'unitTitle', 'denominator', 'denominatorTitle', 'scope', 'scopeTitle', 'source', 'sourceTitle', 'observed', 'observedTitle'],
  'no level, colour, severity or limit field exists');
  // The mockup limits (30 and 240 minutes) are absent from the model code, as is any level or severity word.
  const code = modelSource().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // 30/240 min as minutes, seconds or milliseconds (2 ** 30 in the byte units is not a limit).
  assert.doesNotMatch(code, /\b(240|1800|14400|1800000|14400000)\b|\b30\s*\*|threshold|severity|warning|danger|alert/i);
});

test('the panel line: Not Loaded, Observed, and Query Failed with and without a last reading', () => {
  assert.deepEqual(json([M.summary(null, F), M.summary({ observedAt: null, failed: false }, F),
    M.summary({ observedAt: GENERATED, failed: false }, F), M.summary({ observedAt: GENERATED, failed: true }, F),
    M.summary({ observedAt: null, failed: true }, F)].map(s => [s.key, s.text])), [
    ['not_loaded', 'Not Loaded'], ['not_loaded', 'Not Loaded'], ['observed', `Observed <${GENERATED}>`],
    ['query_failed', `Query Failed · 마지막 관측 기준 <${GENERATED}>`], ['query_failed', 'Query Failed · 아직 성공한 조회가 없습니다']]);
});

const HANGUL = /[가-힣]/;
// UXR-SP-34 / UXR-G-18, the same pattern as tests/admin_member_roles_dom_test.py.
const AVOIDED = /진단|검출|판정|우선순위|diagnos|detect|priorit|\bAI\b/i;
test('wording: English labels, states and units; Korean explanations; no avoided word', () => {
  const english = [...M.METRICS.map(item => item.label), ...Object.values(M.ROW_STATES).map(state => state.text),
    ...Object.values(M.UNITS).map(([text]) => text)];
  assert.deepEqual(english.filter(text => HANGUL.test(text)), []);
  const korean = [...M.METRICS.map(item => item.title), ...Object.values(M.ROW_STATES).map(state => state.title),
    ...Object.values(M.REASONS), ...Object.values(M.UNITS).map(([, title]) => title)];
  assert.deepEqual(korean.filter(text => !HANGUL.test(text)), []);
  const every = [...english, ...korean];
  for (const row of read(ANSWER).rows) every.push(...Object.values(json(M.display(row, 'hallym', F))).filter(v => typeof v === 'string'));
  assert.deepEqual(every.filter(text => AVOIDED.test(text)), []);
});

// ── compiled server ──

const H = 3600 * 1000, now = Date.parse(NOW);
const ago = ms => new Date(now - ms);
const state = (uid, institutionId, em, rs, createdAgo, tele = null) =>
  ({ uid, institutionId, teleInstitutionId: tele, em, rs, createdAt: ago(createdAgo) });
// The ANSWER fixture, as study rows: see the comment on each line for where it lands.
const STATES = [
  state('1.2.1', 'hallym', 'E', 'A', 10 * H),          // TAT E 2 h
  state('1.2.2', 'hallym', 'E', 'A', 30 * H),          // TAT E 4 h (registered 7 d, not 24 h)
  state('1.2.3', 'hallym', 'N', 'A', 72 * H),          // TAT N 24 h
  state('1.2.4', 'hallym', 'N', 'W', 5 * H),           // waiting N 5 h
  state('1.2.5', 'kin-center', 'N', 'T', 2 * H, 'hallym'),   // tele-received: waiting N 2 h
  state('1.2.6', 'hallym', 'E', 'P', 1 * H),           // waiting E 1 h
  state('1.2.7', 'hallym', 'N', 'A', 20 * 24 * H),     // first approval 10 d ago: outside the TAT window
  state('1.2.8', 'hallym', 'X', 'W', 1 * H),           // flag unreadable: in no TAT/waiting row
  state('1.2.9', 'kin-center', 'E', 'W', 1 * H),       // another institution: counted nowhere
  state('1.2.10', 'hallym', 'N', 'A', 1 * H),          // approved before registered: TAT N excluded
  state('1.2.11', 'hallym', 'N', 'Z', 3 * H),          // unknown RS: waiting N excluded
  state('1.2.12', 'hallym', 'E', 'A', 8 * 24 * H),     // first approval exactly 7 d ago: in the window, TAT E 24 h
];
const APPROVED = [['1.2.1', 8 * H], ['1.2.2', 26 * H], ['1.2.3', 48 * H], ['1.2.7', 10 * 24 * H], ['1.2.9', 0.5 * H],
  ['1.2.10', 2 * H], ['1.2.12', 7 * 24 * H], ['9.9.9', 1 * H]];
const STATISTICS = { TotalDiskSize: String(BYTES), TotalDiskSizeMB: 12800, CountStudies: 987654, CountInstances: 876543,
  CountPatients: 765432, CountSeries: 654321, TotalUncompressedSize: '999999999999' };
// Institution storage: the Orthanc Study resources (id, StudyInstanceUID, DiskSize). hallym owns ten originals; 1.2.11 has no
// resource (0 bytes); 1.2.5 (kin-center's, tele-read by hallym), 1.2.9 (kin-center's) and 7.7.7 (registered nowhere) are
// stored on the same server and never counted for hallym.
const oid = n => Array.from({ length: 5 }, (_, i) => (n * 7919 + i).toString(16).padStart(8, '0')).join('-');
const RESOURCES = [['1.2.1', 1000], ['1.2.2', 2000], ['1.2.3', 4000], ['1.2.4', 8000], ['1.2.5', 900000], ['1.2.6', 16000],
  ['1.2.7', 32000], ['1.2.8', 64000], ['1.2.9', 800000], ['1.2.10', 128000], ['1.2.12', 256000], ['7.7.7', 700000]]
  .map(([uid, bytes], n) => ({ id: oid(n + 1), uid, bytes }));
const OWN_BYTES = 1000 + 2000 + 4000 + 8000 + 16000 + 32000 + 64000 + 128000 + 256000;
const SRC_OWN = 'Orthanc GET /studies/{id}/statistics DiskSize (studies this institution owns)';
const METRICS_TEXT = '# HELP orthanc_up_time_s Up time\n# TYPE orthanc_up_time_s gauge\northanc_up_time_s 3600 1790000000000\n' +
  'orthanc_count_studies 987654 1790000000000\n';
const DB_UP = 7200;
/** The fake Orthanc service the metrics read: statistics plus the institution storage and uptime reads. */
function fakeOrthanc(calls, { statistics, resources = RESOURCES, metricsText = METRICS_TEXT, studyStatistics = null } = {}) {
  return {
    statistics,
    metricsText: async () => { calls.push(['metrics-text']); return metricsText; },
    studyResources: async () => { calls.push(['find']); return resources.map(({ id, uid }) => ({ id, uid })); },
    studyStatistics: async (id, signal) => {
      calls.push(['study-stats', id]);
      if (studyStatistics) return studyStatistics(id, signal);
      const found = resources.find(r => r.id === id);
      return { DiskSize: String(found.bytes), UncompressedSize: '1', CountInstances: 3 };
    },
  };
}

const ADMIN = { institution: 'hallym', sub: 'SYN-ADMIN-SUB', actor: 'syn-admin', roles: ['admin'], kind: 'member' };
const POLICY = restricted => ({ institution: 'hallym', revision: 1, reason: 'SYN', updatedBy: 'syn-admin', updatedAt: new Date(now),
  policy: { version: 1, restricted, startsAt: null, endsAt: null, rules: restricted ? [{ all: true }] : [] } });

// A StudyState `where` as PostgreSQL applies it (only the OR-of-equalities shape the metrics reads use).
const inScope = (row, where) => !where?.OR || where.OR.some(term => Object.entries(term).every(([key, value]) => row[key] === value));

/* One mutable StudyState table: a change made while the service reads (afterStates, or an orthanc stand-in that gets the
 * table) is what its next read sees. Unfiltered (the default) every row comes back, so the service's own tenant filter is
 * what keeps other institutions out; `filtered` applies the where clause, so a study that left the scope is absent. */
function store({ policies = [[], []], statistics = STATISTICS, orthanc = null, orthancService = null, dbFail = null, approvalsFail = null,
  recheckFail = null, filtered = false, afterStates = null, orthancReads = {}, dbUptime = null, login = async () => true } = {}) {
  const calls = [];
  const db = structuredClone(STATES);
  let policyReads = 0, stateReads = 0;
  const prisma = {
    studyGroupMember: { findMany: async () => [] },
    studyState: { findMany: async arg => {
      calls.push(['states', arg]);
      const read = ++stateReads;
      if (dbFail) throw dbFail;
      if (recheckFail && read > 1) throw recheckFail;
      const rows = structuredClone(db).filter(row => !filtered || inScope(row, arg.where))
        .map(row => arg.select ? Object.fromEntries(Object.keys(arg.select).map(key => [key, row[key]])) : row);
      afterStates?.(db, read);
      return rows;
    } },
    $queryRaw: async (strings, ...values) => {
      const sql = strings.join('?');
      if (sql.includes('"StudyAccessPolicy"')) { calls.push(['policy']); return structuredClone(policies[Math.min(policyReads++, policies.length - 1)]); }
      if (sql.includes('pg_postmaster_start_time()')) {
        calls.push(['db-uptime', sql]);
        if (dbUptime) return dbUptime();
        return [{ up: BigInt(DB_UP), started: new Date(now - DB_UP * 1000) }];
      }
      calls.push(['approvals', sql, values]);
      if (approvalsFail) throw approvalsFail;
      return APPROVED.map(([uid, at]) => ({ uid, firstApprovedAt: ago(at) }));
    },
  };
  const source = orthancService ?? fakeOrthanc(calls, { ...orthancReads,
    statistics: orthanc ? () => orthanc(db, calls) : async () => { calls.push(['orthanc']); return structuredClone(statistics); } });
  const access = new StudyAccessService(prisma, {}, {});
  const service = new PacsMetrics(prisma, source, access, new PacsAccess(prisma, access));
  // The login server check is a seam: these cases answer it here (its own fetch is tested on its own below).
  const loginSeam = signal => { calls.push(['login']); return login(signal); };
  service.metricsLoginServer = loginSeam;
  // The instance clock is the fixture's NOW, so windows and durations are the fixture's to the second.
  service.metricsClock = () => now;
  // The API process facts are the fixture's too (started 3 d 04 h 05 min before NOW).
  service.metricsProcess = () => ({ ...PROCESS });
  // The public facade over the same store: what the admin controller calls.
  const facade = new S.PacsService(prisma, source, {}, access, {});
  facade.metricsConcern.metricsLoginServer = loginSeam;
  return { service, facade, calls };
}
// The fixture as the service stamps it: its one clock also stamps the Orthanc observations, and the institution storage is
// the sum of hallym's own originals' DiskSize.
const OWN_ROW = { ...base, key: 'storage.institution', state: 'observed', scope: 'institution', source: SRC_OWN, observedAt: NOW,
  unit: 'byte', value: OWN_BYTES, denominator: { unit: 'byte', value: null } };
const AT_CLOCK = () => clone(ROWS).map(row => row.key === 'storage.server' ? { ...row, observedAt: NOW }
  : row.key === 'storage.institution' ? clone(OWN_ROW) : row);
const SRC_SERVER = {
  api: ['HALO PACS API process', 'HALO PACS API process (performance.now, performance.timeOrigin)'],
  image_store: ['Orthanc GET /statistics, GET /tools/metrics-prometheus', 'Orthanc orthanc_up_time_s'],
  database: ['HALO PACS DB', 'PostgreSQL now() - pg_postmaster_start_time()'],
  login_server: ['Keycloak realm discovery (issuer)', null],
};
const serverRow = (component, answer, checkedAt, uptime) => ({ component, answer, checkedAt, source: SRC_SERVER[component][0],
  uptime: { state: 'unobservable', reason: null, seconds: null, startedAt: null, ...uptime, source: SRC_SERVER[component][1] } });
const SERVER_ROWS = [
  serverRow('api', 'answered', NOW, { state: 'observed', seconds: UPTIME, startedAt: STARTED }),
  serverRow('image_store', 'answered', NOW, { state: 'observed', seconds: 3600 }),
  serverRow('database', 'answered', NOW, { state: 'observed', seconds: DB_UP, startedAt: new Date(now - DB_UP * 1000).toISOString() }),
  serverRow('login_server', 'answered', NOW, { reason: 'no_source' }),
];
// The reads the first gates of the aggregate make, in order (the new component and storage reads are checked on their own).
const CORE = ['policy', 'orthanc', 'states', 'approvals'];
const core = (calls, extra = []) => calls.map(call => call[0]).filter(name => CORE.includes(name) || extra.includes(name));

// REQ-S9-U0f-ORTHANC-PUBLIC -> RISK-SOURCE-CONTRACT/UNKNOWN-AS-ZERO -> ORTHANC-01..04.
// Exercise the public service at the fetch boundary; no private transport method is replaced.
// The other Orthanc reads of one aggregate (institution storage, uptime) at the fetch boundary, answered from the fixture;
// undefined for /statistics, which each case answers itself.
function otherOrthancRead(url) {
  const path = new URL(String(url)).pathname;
  if (path === '/tools/find') return new Response(JSON.stringify(RESOURCES.map(r => ({ ID: r.id, Type: 'Study',
    RequestedTags: { StudyInstanceUID: r.uid } }))), { status: 200 });
  const stats = /^\/studies\/([^/]+)\/statistics$/.exec(path);
  if (stats) return new Response(JSON.stringify({ DiskSize: String(RESOURCES.find(r => r.id === stats[1]).bytes) }), { status: 200 });
  if (path === '/tools/metrics-prometheus') return new Response(METRICS_TEXT, { status: 200 });
  return undefined;
}
function statisticsService(t) {
  const config = { ORTHANC_URL: 'http://orthanc.synthetic.invalid:8042/', ORTHANC_USER: 'SYN-USER', ORTHANC_PASS: 'SYN-PASS' };
  const previous = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
  Object.assign(process.env, config);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return new OrthancService();
}

test('ORTHANC-01: public statistics reads authenticated GET /statistics once and preserves the JSON answer', { skip: hosted }, async t => {
  const service = statisticsService(t);
  let answer;
  const requests = [];
  // The request fetch would send, as fetch itself reads its arguments: the init's spelling (plain object or Headers,
  // explicit or default GET) is not the contract.
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(new Request(url, options));
    return { ok: true, json: async () => answer };
  });
  for (answer of [STATISTICS, { TotalDiskSize: '0' }, {}, null, [], { TotalDiskSize: 'bad' }]) {
    const before = requests.length;
    assert.deepEqual(await service.statistics(), answer);
    assert.equal(requests.length - before, 1);
    const request = requests[before];
    assert.equal(request.url, 'http://orthanc.synthetic.invalid:8042/statistics');
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.get('authorization'), 'Basic ' + Buffer.from('SYN-USER:SYN-PASS').toString('base64'));
    assert.equal(request.body, null);
  }
});

test('ORTHANC-02: public statistics rejects transport, HTTP and JSON failures without retry or a zero fallback', { skip: hosted }, async t => {
  const service = statisticsService(t);
  let respond, calls = 0;
  t.mock.method(globalThis, 'fetch', async url => otherOrthancRead(url) ?? (calls++, respond()));
  const decode = new SyntaxError('SYN invalid JSON');
  const cases = [
    [() => { throw new TypeError('SYN connection refused'); }, e => e.getStatus() === 503],
    ...[401, 404, 503].map(status => [() => ({ ok: false, status }), e => e.getStatus() === 503]),
    [() => ({ ok: true, json: async () => { throw decode; } }), e => e === decode],
  ];
  for (const [response, rejected] of cases) {
    respond = response;
    const before = calls;
    await assert.rejects(service.statistics(), rejected);
    assert.equal(calls - before, 1, 'no automatic retry');
  }
});

test('ORTHANC-03: the real public service feeds storage observations, missing data, failure and recovery to metrics', { skip: hosted }, async t => {
  const orthancService = statisticsService(t);
  let respond, calls = 0;
  t.mock.method(globalThis, 'fetch', async url => otherOrthancRead(url) ?? (calls++, respond()));
  const { service } = store({ orthancService });
  const ok = answer => () => ({ ok: true, json: async () => answer });
  for (const [response, expected] of [
    [ok(STATISTICS), ['observed', null, BYTES]],
    [() => { throw new TypeError('SYN private source address'); }, ['unobservable', 'source_failed', null]],
    [() => ({ ok: false, status: 503 }), ['unobservable', 'source_failed', null]],
    [() => ({ ok: true, json: async () => { throw new SyntaxError('SYN invalid JSON'); } }), ['unobservable', 'source_failed', null]],
    [ok({}), ['unobservable', 'invalid_answer', null]],
    [ok(null), ['unobservable', 'invalid_answer', null]],
    [ok({ TotalDiskSize: '0' }), ['observed', null, 0]],
    [ok(STATISTICS), ['observed', null, BYTES]],
  ]) {
    respond = response;
    const before = calls;
    const answer = await service.adminMetrics(ADMIN), disk = answer.metrics[0];
    assert.deepEqual([disk.state, disk.reason, disk.value], expected);
    assert.equal(disk.observedAt, expected[0] === 'observed' ? NOW : null);
    assert.deepEqual(answer.metrics.slice(2), AT_CLOCK().slice(2), 'Orthanc failure leaves DB observations intact');
    assert.equal(calls - before, 1);
    assert.ok(!JSON.stringify(answer).includes('SYN'), 'source errors do not escape in the response');
  }
});

test('ORTHANC-04: an unanswered real source cannot become a success or outlive the metrics wait bound', { skip: hosted, timeout: 10000 }, async t => {
  const orthancService = statisticsService(t);
  const releases = [];
  let responding = false;
  const sourceAnswer = { ...STATISTICS, diagnostic: 'SYN private late source wording' };
  t.mock.method(globalThis, 'fetch', url => otherOrthancRead(url) ? Promise.resolve(otherOrthancRead(url)) : responding
    ? Promise.resolve({ ok: true, json: async () => sourceAnswer })
    : new Promise(resolve => releases.push(() => resolve({ ok: true, json: async () => sourceAnswer }))));
  // The clock is mocked, so the silent source is held far past every wait (60 s) without sleeping or racing real time.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); };
  const STEP = 100, HELD = 60000, WAIT = 1000;
  // production: the wait as shipped (no seam written). bounded: a caller wait set through the seam, which must end the
  // wait by its own bound while the source is still silent.
  const production = store({ orthancService }).service;
  const bounded = store({ orthancService }).service;
  bounded.metricsTimeoutMs = WAIT;
  // A future service deadline may reject. Only a successful answer while the source is silent is forbidden.
  let boundaryState = 'pending';
  const boundary = orthancService.statistics().then(
    () => { boundaryState = 'fulfilled'; }, () => { boundaryState = 'rejected'; });
  const runs = [production, bounded].map(service => {
    const run = { answer: null, failure: null, at: null };
    run.settled = service.adminMetrics(ADMIN).then(value => { run.answer = value; }, error => { run.failure = error; });
    return run;
  });
  const [atProduction, atBounded] = runs;
  let snapshots;
  try {
    for (let ms = 0; ms <= HELD; ms += STEP) {
      await settle();
      for (const run of runs) if ((run.answer || run.failure) && run.at === null) run.at = ms;
      assert.notEqual(boundaryState, 'fulfilled', `statistics() succeeded at ${ms} ms while fetch was unanswered`);
      if (ms < HELD) t.mock.timers.tick(STEP);
    }
    t.diagnostic(`mocked ms held ${HELD}; shipped wait returned at ${atProduction.at}; caller wait ${WAIT} returned at ${atBounded.at}; statistics() ${boundaryState}`);
    assert.ok(atBounded.at !== null && atBounded.at <= WAIT + STEP, 'the caller wait bound returns metrics while the source is silent');
    assert.ok(atProduction.at !== null, 'the shipped wait returns metrics while the source is silent');
    for (const run of runs) {
      assert.equal(run.failure, null);
      const disk = run.answer.metrics[0];
      assert.deepEqual([disk.state, disk.value, disk.observedAt], ['unobservable', null, null]);
      // timeout, or source_failed if a future own service deadline rejects first; never a value.
      assert.ok(['timeout', 'source_failed'].includes(disk.reason), disk.reason);
      assert.deepEqual(run.answer.metrics.slice(1), AT_CLOCK().slice(1), 'the unanswered source leaves other rows intact');
      assert.ok(!JSON.stringify(run.answer).includes('SYN'), 'source wording does not escape in the response');
    }
    snapshots = runs.map(run => clone(run.answer));
  } finally {
    responding = true;
    for (const release of releases) release();
    await settle();
    await Promise.allSettled([boundary, ...runs.map(run => run.settled)]);
  }
  assert.deepEqual(runs.map(run => run.answer), snapshots, 'a late source answer cannot overwrite the timed-out observation');
  for (const service of [production, bounded]) {
    const recovered = await service.adminMetrics(ADMIN);
    assert.deepEqual(recovered.metrics, AT_CLOCK(), 'a later request can observe the source again');
  }
});

test('server: the compiled rows are exactly the page fixture (tenant filter, windows, median, exclusions)', { skip: hosted }, () => {
  assert.deepEqual([...S.ADMIN_METRIC_KEYS], KEYS);
  const approvals = new Map(APPROVED.map(([uid, at]) => [uid, ago(at)]));
  const rows = S.adminMetricRows('hallym', { bytes: BYTES, observedAt: DISK_AT }, { observedAt: NOW, states: STATES, firstApproved: approvals }, PROCESS);
  assert.deepEqual(clone(rows), ROWS);
  // Rows of another institution never count, whoever passes them in.
  const foreign = STATES.map(s => ({ ...s, institutionId: 'kin-center', teleInstitutionId: null }));
  const none = clone(S.adminMetricRows('hallym', { bytes: 0, observedAt: DISK_AT }, { observedAt: NOW, states: foreign, firstApproved: approvals }, PROCESS));
  assert.deepEqual(none.slice(2, 11).map(row => [row.key, row.state, row.value]), [
    ['studies.own', 'observed', 0], ['studies.tele', 'observed', 0], ['studies.flag_unreadable', 'observed', 0],
    ['studies.registered_24h', 'observed', 0], ['studies.registered_7d', 'observed', 0],
    ['tat.emergency', 'empty', null], ['tat.normal', 'empty', null], ['waiting.emergency', 'empty', null], ['waiting.normal', 'empty', null]]);
  assert.deepEqual([none[0].state, none[0].value], ['observed', 0], 'a disk the source reports as 0 bytes is a known 0');
  // DB facts missing: every DB row is unknown, and storage still reads.
  // DB facts missing: every DB row is unknown, and storage and the API process rows still read.
  const failed = clone(S.adminMetricRows('hallym', { bytes: BYTES, observedAt: DISK_AT }, null, PROCESS));
  assert.deepEqual(failed.map(row => [row.key, row.state, row.reason, row.value, row.observedAt]), [
    ['storage.server', 'observed', null, BYTES, DISK_AT], ['storage.institution', 'unobservable', 'no_source', null, null],
    ...KEYS.slice(2, 11).map(key => [key, 'unobservable', 'source_failed', null, null]),
    ['server.api_uptime', 'observed', null, UPTIME, NOW], ['server.api_started', 'observed', null, STARTED, NOW]]);
  assert.deepEqual(failed.slice(7, 11).map(row => row.denominator), Array(4).fill({ unit: 'study', value: null }));
  assert.deepEqual(failed.slice(2, 7).map(row => row.denominator), Array(5).fill(null));
  for (const failure of ['source_failed', 'invalid_answer', 'timeout']) {
    const disk = clone(S.adminMetricRows('hallym', { failure }, null, PROCESS))[0];
    assert.deepEqual([disk.state, disk.reason, disk.value, disk.observedAt], ['unobservable', failure, null, null]);
  }
  assert.deepEqual(read({ ...ANSWER, metrics: failed }).rows.map(row => row.reason === 'invalid_answer'), Array(13).fill(false),
    'the page reads every compiled failure row as its own reason');
  // Process facts that do not prove themselves are unknown, never 0 s or a made-up time; the other rows are untouched.
  for (const bad of [undefined, null, { ...PROCESS, uptimeSeconds: -1 }, { ...PROCESS, uptimeSeconds: 1.5 },
    { ...PROCESS, startedAt: NaN }, { ...PROCESS, startedAt: 0 }, { ...PROCESS, observedAt: NaN }]) {
    const unknown = clone(S.adminMetricRows('hallym', { bytes: BYTES, observedAt: DISK_AT }, null, bad));
    assert.deepEqual(unknown.slice(11).map(row => [row.key, row.state, row.reason, row.value, row.observedAt, row.source]), [
      ['server.api_uptime', 'unobservable', 'invalid_answer', null, null, SRC.uptime],
      ['server.api_started', 'unobservable', 'invalid_answer', null, null, SRC.started]], JSON.stringify(bad));
    assert.deepEqual(read({ ...ANSWER, metrics: unknown }).rows.slice(11).map(row => [row.state, row.reason]),
      [['unobservable', 'invalid_answer'], ['unobservable', 'invalid_answer']]);
  }
});

test('server: TotalDiskSize is the only value read from /statistics; anything else is unknown', { skip: hosted }, () => {
  const cases = [[{ TotalDiskSize: '0' }, 0], [{ TotalDiskSize: ' 42 ' }, 42], [{ TotalDiskSize: 42 }, 42],
    [{ TotalDiskSize: '-1' }, null], [{ TotalDiskSize: '1e3' }, null], [{ TotalDiskSize: '1.5' }, null],
    [{ TotalDiskSize: '12.0' }, null], [{ TotalDiskSize: '1.' }, null], [{ TotalDiskSize: '0x10' }, null],
    [{ TotalDiskSize: '99999999999999999999' }, null], [{ TotalDiskSizeMB: 12 }, null], [{}, null], [[], null],
    ['12', null], [null, null], [{ TotalDiskSize: null }, null], [{ TotalDiskSize: NaN }, null]];
  for (const [answer, bytes] of cases) assert.equal(S.orthancDiskBytes(answer), bytes, JSON.stringify(answer));
});

test('server: an admin reads the own-institution aggregate; filters sit in both queries; no study or server count leaves', { skip: hosted }, async () => {
  const { service, calls } = store();
  const answer = await service.adminMetrics(ADMIN);
  assert.deepEqual(Object.keys(answer), ['institutionId', 'generatedAt', 'metrics', 'server']);
  assert.deepEqual([answer.institutionId, answer.generatedAt], ['hallym', NOW]);
  assert.deepEqual(clone(answer.metrics), AT_CLOCK());
  const states = calls.find(call => call[0] === 'states')[1];
  assert.deepEqual(states.where, { OR: [{ institutionId: 'hallym' }, { teleInstitutionId: 'hallym' }] });
  assert.deepEqual(Object.keys(states.select).sort(), ['createdAt', 'em', 'institutionId', 'rs', 'teleInstitutionId', 'uid']);
  const [, sql, values] = calls.find(call => call[0] === 'approvals');
  assert.match(sql, /v\.action = 'approve'/);
  assert.match(sql, /JOIN "StudyState" s ON s\.uid = v\.uid/);
  assert.match(sql, /\(s\."institutionId" = \? OR s\."teleInstitutionId" = \?\)/);
  assert.deepEqual(values, ['hallym', 'hallym']);
  assert.deepEqual(calls.filter(call => call[0] === 'orthanc'), [['orthanc']]);
  assert.equal(calls.filter(call => call[0] === 'policy').length, 2, 'the access check runs before and after the reads');
  // S5-U6b-F01: the scope is read again after every source answered, on the same institution condition, then the policy.
  assert.deepEqual(core(calls), ['policy', 'orthanc', 'states', 'approvals', 'states', 'policy']);
  // The institution storage is read from the counted originals before the scope is read again (one find, one statistics
  // read per Study resource of an owned original; never another institution's or an unregistered resource).
  const names = calls.map(call => call[0]), recheckAt = names.lastIndexOf('states');
  assert.ok(names.indexOf('find') > names.indexOf('approvals') && names.lastIndexOf('study-stats') < recheckAt, names.join(','));
  assert.deepEqual(calls.filter(call => call[0] === 'study-stats').map(call => call[1]).sort(),
    RESOURCES.filter(r => !['1.2.5', '1.2.9', '7.7.7'].includes(r.uid)).map(r => r.id).sort());
  assert.deepEqual(names.filter(name => ['metrics-text', 'db-uptime', 'login'].includes(name)).sort(), ['db-uptime', 'login', 'metrics-text']);
  const recheck = calls.filter(call => call[0] === 'states')[1][1];
  assert.deepEqual(recheck.where, { OR: [{ institutionId: 'hallym' }, { teleInstitutionId: 'hallym' }] });
  assert.deepEqual(Object.keys(recheck.select).sort(), ['institutionId', 'teleInstitutionId', 'uid']);
  const text = JSON.stringify(answer);
  for (const leak of ['987654', '876543', '765432', '654321', '999999999999', 'Count', '1.2.', '9.9.9', 'kin-center', 'SYN-ADMIN',
    '7.7.7', '900000', '800000', '700000', oid(1), '1790000000000', 'HELP'])
    assert.ok(!text.includes(leak), `the answer carries ${leak}`);
  const page = M.readAnswer(JSON.parse(text));
  assert.equal(page.rows.filter(row => row.reason === 'invalid_answer').length, 0, 'the page reads every compiled row');
  // Server Status: four components, each from its own answer in this request, uptime only as the component reports it.
  assert.deepEqual(clone(answer.server), SERVER_ROWS);
  assert.deepEqual(json(page.server), json(M.readServer(SERVER_ROWS)), 'the page reads the compiled server rows');
  assert.equal(page.server.filter(row => row.answer === 'invalid_answer').length, 0);
});

test('server: only admin, only with an institution, never for a restricted study scope; nothing is read first', { skip: hosted }, async () => {
  for (const [who, caller] of [['radiologist', { ...ADMIN, roles: ['radiologist'] }], ['technician', { ...ADMIN, roles: ['technician'] }],
    ['clinician-only', { ...ADMIN, roles: ['clinician'] }], ['no roles', { ...ADMIN, roles: [] }],
    ['gateway', { ...ADMIN, kind: 'gateway', roles: ['gateway'] }], ['no institution', { ...ADMIN, institution: null }]]) {
    for (const via of ['facade', 'service']) {
      const built = store();
      await assert.rejects(built[via].adminMetrics(caller), e => e.getStatus() === 403, `${who} (${via})`);
      assert.deepEqual(built.calls, [], `${who} (${via}): no read before the refusal`);
    }
  }
  const { facade: service, calls } = store({ policies: [[POLICY(true)]] });
  await assert.rejects(service.adminMetrics(ADMIN),
    e => e.getStatus() === 403 && e.getResponse().code === 'ADMIN_METRICS_RESTRICTED');
  assert.deepEqual(calls.map(call => call[0]), ['policy'], 'restricted: no study, approval or Orthanc read');
  // A mixed admin+clinician account is an admin (the clinician-only gate never applies to it).
  const mixed = store();
  assert.equal((await mixed.facade.adminMetrics({ ...ADMIN, roles: ['clinician', 'admin'] })).institutionId, 'hallym');
});

test('server: a change of the study access policy during the read refuses the aggregate (409)', { skip: hosted }, async () => {
  const { facade: service } = store({ policies: [[], [POLICY(false)]] });
  await assert.rejects(service.adminMetrics(ADMIN), e => e.getStatus() === 409 && e.getResponse().code === 'STUDY_ACCESS_CHANGED');
});

// S5-U6b-F01. 1.2.5 is kin-center's study that hallym receives for tele-reading; closing it sets teleInstitutionId to null.
const TELE_UID = '1.2.5';
const closeTele = db => { db.find(s => s.uid === TELE_UID).teleInstitutionId = null; };
const scopeChanged = e => e.getStatus() === 409 && e.getResponse().code === 'STUDY_LIST_CHANGED';

test('server: a tele-reading closed while the aggregate is read refuses it (409), never an old-scope count', { skip: hosted }, async () => {
  for (const filtered of [false, true]) {
    // Between the first StudyState read and the approvals read.
    const between = store({ filtered, afterStates: (db, read) => { if (read === 1) closeTele(db); } });
    await assert.rejects(between.service.adminMetrics(ADMIN), scopeChanged, `between the DB reads (filtered ${filtered})`);
    assert.deepEqual(core(between.calls), ['policy', 'orthanc', 'states', 'approvals', 'states'],
      'refused at the scope read; the policy read after it never runs');
    // After both DB reads, while Orthanc is still out: the scope is read only once every source has answered.
    const late = store({ filtered, orthanc: async (db, calls) => {
      calls.push(['orthanc']);
      await new Promise(resolve => setTimeout(resolve, 5));
      closeTele(db);
      calls.push(['closed']);
      return structuredClone(STATISTICS);
    } });
    await assert.rejects(late.service.adminMetrics(ADMIN), scopeChanged, `during the Orthanc wait (filtered ${filtered})`);
    assert.deepEqual(core(late.calls, ['closed']), ['policy', 'orthanc', 'states', 'approvals', 'closed', 'states']);
  }
  // An owned study moved out of the scope is a change too (institutionId), as is one that vanished.
  const moved = store({ afterStates: (db, read) => { if (read === 1) db.find(s => s.uid === '1.2.1').institutionId = 'kin-center'; } });
  await assert.rejects(moved.service.adminMetrics(ADMIN), scopeChanged, 'an owned study moved away');
  const gone = store({ filtered: true, afterStates: (db, read) => { if (read === 1) db.splice(db.findIndex(s => s.uid === '1.2.4'), 1); } });
  await assert.rejects(gone.service.adminMetrics(ADMIN), scopeChanged, 'a counted study vanished');
});

test('server: a scope that held keeps the aggregate; a study entering during the read is not counted and refuses nothing', { skip: hosted }, async () => {
  const held = [
    ['nothing changes', () => {}],
    // A new own arrival and a tele-reading received during the read: neither was counted, so nothing outside the scope was.
    ['a new own study arrives', db => db.push(state('1.2.99', 'hallym', 'E', 'W', 0))],
    ['a tele-reading is received', db => { db.find(s => s.uid === '1.2.9').teleInstitutionId = 'hallym'; }],
    // Closed and requested again before the answer: the scope at the answer is the scope that was counted.
    ['closed and re-requested', db => { closeTele(db); db.find(s => s.uid === TELE_UID).teleInstitutionId = 'hallym'; }],
    // Not a scope field: the aggregate is still the one first read.
    ['a report state changes', db => { db.find(s => s.uid === '1.2.4').rs = 'A'; }],
  ];
  for (const filtered of [false, true]) {
    for (const [what, change] of held) {
      const { service } = store({ filtered, afterStates: (db, read) => { if (read === 1) change(db); } });
      const answer = clone(await service.adminMetrics(ADMIN));
      assert.deepEqual(answer.metrics, AT_CLOCK(), `${what} (filtered ${filtered})`);
    }
  }
});

test('server: Orthanc down, malformed or late is Unobservable storage; the DB rows still read', { skip: hosted }, async () => {
  const outcomes = [
    ['source_failed', async () => { throw Object.assign(new Error('SYN-ORTHANC-URL http://orthanc:8042 refused'), { status: 503 }); }],
    ['invalid_answer', async () => ({ TotalDiskSizeMB: 12800, CountStudies: 987654 })],
    ['invalid_answer', async () => ['SYN']],
    ['timeout', () => new Promise(() => {})],
  ];
  for (const [reason, get] of outcomes) {
    const { service } = store({ orthanc: get });
    service.metricsTimeoutMs = 20;
    const answer = clone(await service.adminMetrics(ADMIN));
    assert.deepEqual([answer.metrics[0].state, answer.metrics[0].reason, answer.metrics[0].value, answer.metrics[0].observedAt],
      ['unobservable', reason, null, null], reason);
    assert.deepEqual(answer.metrics.slice(2).map(row => row.state), [...Array(5).fill('observed'), ...Array(4).fill('observed'),
      'observed', 'observed'], 'the DB rows and the API process rows still read');
    assert.ok(!JSON.stringify(answer).includes('SYN-ORTHANC') && !JSON.stringify(answer).includes('987654'), 'no source wording or count');
  }
});

test('server: a failed DB read is Unobservable on every DB row, never 0, and logs only a code', { skip: hosted }, async () => {
  const warn = console.warn, warned = [];
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    // recheckFail: the first reads answered but the scope could not be read again, so nothing proves the scope held.
    for (const option of ['dbFail', 'approvalsFail', 'recheckFail']) {
      const { service } = store({ [option]: Object.assign(new Error('SYN-SECRET-DATABASE-URL'), { code: 'P1001' }) });
      const answer = clone(await service.adminMetrics(ADMIN));
      assert.deepEqual([answer.metrics[0].state, answer.metrics[0].value], ['observed', BYTES], option);
      assert.deepEqual(answer.metrics.slice(2, 11).map(row => [row.state, row.reason, row.value]),
        Array(9).fill(['unobservable', 'source_failed', null]), option);
      // The API process rows are their own source: a failed DB read leaves them observed.
      assert.deepEqual(answer.metrics.slice(11).map(row => [row.key, row.state, row.value]),
        [['server.api_uptime', 'observed', UPTIME], ['server.api_started', 'observed', STARTED]], option);
    }
  } finally { console.warn = warn; }
  assert.equal(warned.length, 3);
  assert.ok(warned.every(line => line.includes('P1001') && !line.includes('SYN-SECRET')), warned.join('\n'));
});

// ── institution storage and Server Status ──

const SS = SERVER ? require(path.join(path.dirname(SERVER), 'pacs', 'server-status')) : null;
const MX = SERVER ? require(path.join(path.dirname(SERVER), 'pacs', 'metrics')) : null;
const KIN_CENTER = { ...ADMIN, institution: 'kin-center', sub: 'SYN-ADMIN-B' };
const KIN_CENTER_BYTES = 900000 + 800000;   // its own 1.2.5 (tele-read by hallym) and 1.2.9
const ownRow = answer => answer.metrics.find(row => row.key === 'storage.institution');
const serverOf = (answer, component) => answer.server.find(row => row.component === component);

test('server: institution storage is the sum of the own originals only; tele, other and unregistered studies never count', { skip: hosted }, async () => {
  const hallym = clone(await store().service.adminMetrics(ADMIN));
  assert.deepEqual([ownRow(hallym).state, ownRow(hallym).value, ownRow(hallym).source], ['observed', OWN_BYTES, SRC_OWN]);
  // The other institution: its own two studies, the one hallym tele-reads included; none of hallym's.
  const other = clone(await store().service.adminMetrics(KIN_CENTER));
  assert.deepEqual([ownRow(other).state, ownRow(other).value], ['observed', KIN_CENTER_BYTES]);
  // No own original: Orthanc is not asked and the share is a known 0.
  const none = store({ afterStates: () => {} });
  const empty = clone(await none.service.adminMetrics({ ...ADMIN, institution: 'syn-empty', sub: 'SYN-EMPTY' }));
  assert.deepEqual([ownRow(empty).state, ownRow(empty).value], ['observed', 0]);
  assert.equal(none.calls.filter(call => ['find', 'study-stats'].includes(call[0])).length, 0);
  // Pure rule: owned UIDs, every resource of a UID once; two resources on one owned UID cannot be attributed.
  const rs = [{ id: 'a', uid: '1' }, { id: 'b', uid: '2' }, { id: 'c', uid: '3' }, { id: 'c', uid: '3' }];
  assert.equal(MX.institutionStorageBytes(['1', '3', '9'], rs, id => ({ a: 10, c: 5 })[id]), 15, 'a missing resource is 0 bytes');
  assert.equal(MX.institutionStorageBytes(['1', '2'], [...rs, { id: 'd', uid: '2' }], () => 1), 'unattributed');
  assert.equal(MX.institutionStorageBytes(['1'], rs, () => null), null, 'one unknown size: no partial sum');
  assert.equal(MX.institutionStorageBytes(['1', '2'], rs, () => Number.MAX_SAFE_INTEGER), null, 'an unsafe sum is unknown');
  assert.equal(MX.institutionStorageBytes([], rs, () => 1), 0);
  for (const [answer, bytes] of [[{ DiskSize: '12' }, 12], [{ DiskSize: 12 }, 12], [{ DiskSize: '-1' }, null], [{ DiskSize: '1.5' }, null],
    [{}, null], [{ TotalDiskSize: '12' }, null], [null, null], [[], null]])
    assert.equal(MX.orthancStudyDiskBytes(answer), bytes, JSON.stringify(answer));
});

test('server: one unreadable, failed or late study read makes the institution storage Unobservable, never a partial sum', { skip: hosted }, async () => {
  const cases = [
    ['source_failed', { studyStatistics: async id => { if (id === RESOURCES[3].id) throw new Error('SYN-ORTHANC down'); return { DiskSize: '1' }; } }],
    ['invalid_answer', { studyStatistics: async id => ({ DiskSize: id === RESOURCES[3].id ? 'x' : '1' }) }],
    ['unattributed', { resources: [...RESOURCES, { id: oid(99), uid: '1.2.4', bytes: 5 }] }],
    ['source_failed', { resources: null }],
  ];
  for (const [reason, reads] of cases) {
    const options = reads.resources === null
      ? { orthancReads: { ...reads, resources: RESOURCES }, orthancService: null } : { orthancReads: reads };
    const built = store(options);
    if (reads.resources === null) built.service.orthanc.studyResources = async () => { throw new Error('SYN find failed'); };
    const answer = clone(await built.service.adminMetrics(ADMIN));
    assert.deepEqual([ownRow(answer).state, ownRow(answer).reason, ownRow(answer).value, ownRow(answer).observedAt],
      ['unobservable', reason, null, null], reason);
    assert.deepEqual(answer.metrics.slice(2), AT_CLOCK().slice(2), 'the DB rows still read');
    assert.equal(M.readAnswer(answer).rows[1].reason, reason, 'the page reads the reason');
    assert.ok(!JSON.stringify(answer).includes('SYN'), 'no source wording');
  }
  // Late: one study read never answers; the wait ends the whole share, and no further study read is sent after it.
  const sent = [];
  const late = store({ orthancReads: { studyStatistics: (id, signal) => { sent.push(id);
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))); } } });
  late.service.metricsTimeoutMs = 30;
  const answer = clone(await late.service.adminMetrics(ADMIN));
  assert.deepEqual([ownRow(answer).state, ownRow(answer).reason], ['unobservable', 'timeout']);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(sent.length, 8, 'only the first parallel reads were sent; the aborted wait queues nothing more');
  // The scope could not be read again: the bytes are not this institution's either.
  const recheck = clone(await store({ recheckFail: Object.assign(new Error('SYN'), { code: 'P1001' }) }).service.adminMetrics(ADMIN));
  assert.deepEqual([ownRow(recheck).state, ownRow(recheck).reason], ['unobservable', 'source_failed']);
});

test('server: Server Status answers per component from this request; a silent component has no uptime and leaves the others', { skip: hosted }, async () => {
  // Orthanc down: the image store has no answer (and no uptime); DB, login server and API still answer.
  const down = store({ orthanc: async () => { throw new Error('SYN refused'); },
    orthancReads: { metricsText: null } });
  down.service.orthanc.metricsText = async () => { throw new Error('SYN refused'); };
  down.service.orthanc.studyResources = async () => { throw new Error('SYN refused'); };
  const a = clone(await down.service.adminMetrics(ADMIN));
  assert.deepEqual(serverOf(a, 'image_store'), serverRow('image_store', 'source_failed', NOW, { reason: 'source_failed' }));
  assert.deepEqual(a.server.filter(row => row.component !== 'image_store'), SERVER_ROWS.filter(row => row.component !== 'image_store'));
  assert.deepEqual([ownRow(a).state, ownRow(a).reason], ['unobservable', 'source_failed']);
  // /statistics answers but the metrics text has no uptime sample (metrics disabled): answered, Uptime No Source.
  const noSample = clone(await store({ orthancReads: { metricsText: '# nothing here\n' } }).service.adminMetrics(ADMIN));
  assert.deepEqual(serverOf(noSample, 'image_store'), serverRow('image_store', 'answered', NOW, { reason: 'no_source' }));
  // The metrics text read fails while /statistics answers: answered, its uptime read's reason.
  const textFails = store();
  textFails.service.orthanc.metricsText = async () => { throw new Error('SYN'); };
  assert.deepEqual(serverOf(clone(await textFails.service.adminMetrics(ADMIN)), 'image_store'),
    serverRow('image_store', 'answered', NOW, { reason: 'source_failed' }));
  // The DB uptime query fails or answers nonsense; the login server is refused, disagrees on its issuer, or never answers.
  for (const [dbUptime, reason] of [[async () => { throw new Error('SYN'); }, 'source_failed'], [async () => [{ up: -1n, started: new Date() }], 'invalid_answer'],
    [async () => [], 'invalid_answer']]) {
    const answer = clone(await store({ dbUptime }).service.adminMetrics(ADMIN));
    assert.deepEqual(serverOf(answer, 'database'), serverRow('database', reason, NOW, { reason }), reason);
    assert.deepEqual(answer.metrics, AT_CLOCK(), 'the DB rows are their own reads');
  }
  for (const [login, reason] of [[async () => { throw new Error('SYN'); }, 'source_failed'], [async () => false, 'invalid_answer'],
    [() => new Promise(() => {}), 'timeout']]) {
    const built = store({ login });
    built.service.metricsTimeoutMs = 30;
    const answer = clone(await built.service.adminMetrics(ADMIN));
    assert.deepEqual(serverOf(answer, 'login_server'), serverRow('login_server', reason, NOW, { reason }), reason);
  }
  // Pure rule: nothing reported is nothing answered.
  assert.deepEqual(clone(SS.serverComponentRows({})).map(row => [row.component, row.answer, row.uptime.state]),
    SERVER_ROWS.map(row => [row.component, 'invalid_answer', 'unobservable']));
  for (const [text, sample] of [[METRICS_TEXT, 3600], ['orthanc_up_time_s 12.9\n', 12], ['orthanc_up_time_s{a="b"} 5 17\n', 5],
    ['orthanc_up_time_s -1\n', NaN], ['orthanc_up_time_s 1e3\n', NaN], ['orthanc_up_time_s 1\northanc_up_time_s 2\n', NaN],
    ['orthanc_up_time_seconds 4\n', null], ['', null], [null, undefined], [{}, undefined]])
    assert.ok(Object.is(SS.orthancUptimeSample(text), sample), JSON.stringify(text));
  assert.deepEqual(SS.databaseUptime([{ up: 5n, started: new Date(1000) }]), { uptimeSeconds: 5, startedAt: 1000 });
  for (const bad of [null, [], [{}], [{ up: 5n, started: 'x' }], [{ up: '5', started: new Date(1) }], [{ up: 5n, started: new Date(1) }, {}]])
    assert.equal(SS.databaseUptime(bad), null, String(bad && bad.length));
});

test('server: the login server answers only when its discovery names exactly the issuer the API accepts', { skip: hosted }, async t => {
  const previous = ['KC_ADMIN_URL', 'KC_REALM', 'KC_ISSUER'].map(key => [key, process.env[key]]);
  t.after(() => { for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  Object.assign(process.env, { KC_ADMIN_URL: 'http://keycloak.synthetic.invalid:8080/auth/', KC_REALM: 'kin',
    KC_ISSUER: 'https://pacs.synthetic.invalid/auth/realms/kin' });
  const urls = [];
  const fetcher = body => async url => { urls.push(String(url)); return typeof body === 'function' ? body() : new Response(body, { status: 200 }); };
  const signal = new AbortController().signal;
  assert.equal(await SS.loginServerAnswers(signal, fetcher(JSON.stringify({ issuer: process.env.KC_ISSUER }))), true);
  assert.equal(urls[0], 'http://keycloak.synthetic.invalid:8080/auth/realms/kin/.well-known/openid-configuration');
  for (const body of [JSON.stringify({ issuer: 'https://other.invalid/auth/realms/kin' }), JSON.stringify({}), 'not json', 'null'])
    assert.equal(await SS.loginServerAnswers(signal, fetcher(body)), false, body);
  await assert.rejects(SS.loginServerAnswers(signal, fetcher(() => new Response('', { status: 503 }))));
  delete process.env.KC_ISSUER;
  assert.equal(await SS.loginServerAnswers(signal, fetcher(JSON.stringify({ issuer: '' }))), false, 'no configured issuer: not answered');
});

test('page: Server Status reads four fixed rows; anything unproven is Answer Unreadable, never Answered', () => {
  const rows = json(M.readServer(clone(SERVER_ROWS)));
  assert.deepEqual(rows, clone(SERVER_ROWS));
  assert.deepEqual(json(M.SERVER.map(item => item.key)), ['api', 'image_store', 'database', 'login_server']);
  const unread = component => ({ component, answer: 'invalid_answer', checkedAt: null, source: null,
    uptime: { state: 'unobservable', reason: 'invalid_answer', seconds: null, startedAt: null, source: null } });
  const change = (i, extra) => clone(SERVER_ROWS).map((row, n) => n === i ? { ...row, ...extra } : row);
  const up = (i, extra) => clone(SERVER_ROWS).map((row, n) => n === i ? { ...row, uptime: { ...row.uptime, ...extra } } : row);
  for (const list of [change(1, { answer: 'ok' }), change(1, { checkedAt: 'now' }), change(1, { checkedAt: null }), change(1, { extra: 1 }),
    change(1, { source: '' }), up(1, { state: 'observed', seconds: -1 }), up(1, { seconds: 1.5 }), up(1, { reason: 'no_source' }),
    change(1, { answer: 'source_failed' }), up(3, { reason: 'gone' }), up(3, { seconds: 0 }), up(1, { startedAt: 'today' }),
    [...clone(SERVER_ROWS), clone(SERVER_ROWS)[1]], clone(SERVER_ROWS).filter((_, n) => n !== 1)])
    assert.deepEqual(json(M.readServer(list))[1].answer === 'answered' && json(M.readServer(list))[3].answer === 'answered', false, JSON.stringify(list).slice(0, 200));
  assert.deepEqual(json(M.readServer(undefined)), SERVER_ROWS.map(row => unread(row.component)));
  assert.deepEqual(json(M.readAnswer({ ...ANSWER, server: SERVER_ROWS }).server), clone(SERVER_ROWS));
  const shown = rows.map(row => json(M.displayServer(row, F)));
  assert.deepEqual(shown.map(s => [s.label, s.answer, s.checked, s.uptime, s.started]), [
    ['HALO PACS API', 'Answered', F(NOW), '3 d 04 h 05 min', F(STARTED)],
    ['Image Store (Orthanc)', 'Answered', F(NOW), '1 h 00 min', 'Not Reported'],
    ['Database (PostgreSQL)', 'Answered', F(NOW), '2 h 00 min', F(new Date(now - DB_UP * 1000).toISOString())],
    ['Login Server (Keycloak)', 'Answered', F(NOW), 'Uptime No Source', 'Not Reported']]);
  const silent = json(M.displayServer(json(M.readServer(change(1, { answer: 'timeout', uptime: { state: 'unobservable', reason: 'timeout',
    seconds: null, startedAt: null, source: SRC_SERVER.image_store[1] } })))[1], F));
  assert.deepEqual([silent.answer, silent.uptime, silent.started], ['No Answer in Time', 'Unobservable', 'Not Reported']);
  const hangul = /[\uac00-\ud7a3]/;
  for (const s of shown) {
    assert.deepEqual([s.label, s.answer, s.checked, s.uptime, s.started].filter(text => hangul.test(text)), [], 'words in English');
    assert.deepEqual([s.labelTitle, s.answerTitle, s.checkedTitle, s.uptimeTitle, s.startedTitle].filter(text => !hangul.test(text)), [],
      'every title explains itself in Korean');
  }
});
