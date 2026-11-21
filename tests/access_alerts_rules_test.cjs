'use strict';
/* Access Alerts time rule over synthetic counted rows (one row per counted event and study, as the ledger function
 * returns them). Which ledger entries count is the PostgreSQL function; see the access review period suite. */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MODULE = process.env.KIN_ACCESS_ALERTS_MODULE || 'api/src/access-alerts.ts';
if (MODULE.endsWith('.ts')) require('./service_test_loader.cjs');
const A = require(path.isAbsolute(MODULE) ? MODULE : path.resolve(ROOT, MODULE));

const T0 = Date.parse('2026-11-01T09:00:00.000Z'), MIN = 60000;
let sequence = 0;
const row = (account, study, at, extra = {}) => ({ entryId: `entry-${++sequence}`, sequence: BigInt(sequence),
  eventId: `event-${sequence}`, occurredAt: new Date(T0 + at), account, studyId: study, ...extra });
const studies = (account, count, step, from = 0, prefix = 'S') =>
  Array.from({ length: count }, (_, i) => row(account, `${prefix}${i}`, from + i * step));
const small = { studies: 3, minutes: 10 };

test('threshold: unset or empty is the default, a valid value is used, anything else refuses', () => {
  assert.deepEqual(A.alertThreshold(undefined), { studies: 50, minutes: 10 });
  assert.deepEqual(A.alertThreshold(''), { studies: 50, minutes: 10 });
  assert.deepEqual(A.alertThreshold(' 20/5 '), { studies: 20, minutes: 5 });
  for (const bad of ['50', '0/10', '50/0', '-1/10', '50/10m', 'a/b', '1.5/10', '50/20000', '50 / 10'])
    assert.equal(A.alertThreshold(bad), null, bad);
});

test('N-1 different studies is no alert, N is one; same-patient comparisons count as studies', () => {
  assert.deepEqual(A.accessAlerts(studies('A', 2, MIN), small), []);
  const rows = studies('A', 3, MIN);
  const alerts = A.accessAlerts(rows, small);
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0], { account: 'A', firstAt: rows[0].occurredAt.toISOString(), lastAt: rows[2].occurredAt.toISOString(),
    studies: 3, events: 3, evidenceEntryId: rows[2].entryId });
});

test('exactly W minutes apart is inside, W minutes and 1 ms is outside', () => {
  const inside = [row('A', 'S1', 0), row('A', 'S2', 5 * MIN), row('A', 'S3', 10 * MIN)];
  assert.equal(A.accessAlerts(inside, small).length, 1);
  const outside = [row('A', 'S1', 0), row('A', 'S2', 5 * MIN), row('A', 'S3', 10 * MIN + 1)];
  assert.deepEqual(A.accessAlerts(outside, small), []);
});

test('reopening the same study, several targets of one event and input order do not change the counts', () => {
  const rows = [row('A', 'S1', 0), row('A', 'S1', MIN), row('A', 'S2', 2 * MIN)];
  const multi = { entryId: 'entry-m', sequence: 900n, eventId: 'event-m', occurredAt: new Date(T0 + 3 * MIN), account: 'A' };
  rows.push({ ...multi, studyId: 'S3' }, { ...multi, studyId: 'S4' });
  const alerts = A.accessAlerts([...rows].reverse(), small);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].studies, 4);
  assert.equal(alerts[0].events, 4);
  assert.equal(alerts[0].evidenceEntryId, 'entry-m', 'the entry that first reached the threshold');
});

test('overlapping qualifying windows of one account are one alert, separate ones are two', () => {
  // One minute apart for 30 minutes: every 10-minute window qualifies and each shares entries with the next.
  const steady = studies('A', 31, MIN);
  const one = A.accessAlerts(steady, small);
  assert.equal(one.length, 1);
  assert.equal(one[0].studies, 31);
  assert.equal(one[0].firstAt, steady[0].occurredAt.toISOString());
  assert.equal(one[0].lastAt, steady[30].occurredAt.toISOString());
  const two = A.accessAlerts([...studies('A', 3, MIN), ...studies('A', 3, MIN, 120 * MIN, 'T')], small);
  assert.equal(two.length, 2);
  assert.deepEqual(two.map(alert => alert.studies), [3, 3]);
});

test('two accounts below the threshold are not added together; each account is judged alone', () => {
  assert.deepEqual(A.accessAlerts([...studies('A', 2, MIN), ...studies('B', 2, MIN, 30000, 'T')], small), []);
  const alerts = A.accessAlerts([...studies('A', 3, MIN), ...studies('B', 2, MIN)], small);
  assert.deepEqual(alerts.map(alert => alert.account), ['A']);
});

test('the default threshold: 49 different studies in ten minutes is none, 50 is one', () => {
  const D = A.ALERT_THRESHOLD_DEFAULT;
  assert.deepEqual(A.accessAlerts(studies('A', 49, 12000), D), []);
  assert.equal(A.accessAlerts(studies('A', 50, 12000), D).length, 1);
});
