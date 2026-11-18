'use strict';
/* The work page's five boxes (Worklist, Related Exam, Clinical Information, Related Report, Report Editor): dropping one
 * on another trades their places, and the record of swaps alone decides where every box is and which way each resize
 * handle grows its box. Expected values are written out here, not computed by the module under test. */
const test = require('node:test');
const assert = require('node:assert/strict');
const boxes = require('../worklist-v0/hpacs-lite/box-layout.js');

test('TEST-BOXES-01 a drop trades the smallest pair that holds both boxes; a drop on itself moves nothing', () => {
  const expected = {
    'worklist>relatedExams': 'list', 'relatedExams>worklist': 'list',
    'relatedReports>editor': 'report', 'editor>relatedReports': 'report',
    'clinical>relatedReports': 'side', 'editor>clinical': 'side', 'clinical>editor': 'side', 'relatedReports>clinical': 'side',
  };
  for (const a of boxes.BOXES) for (const b of boxes.BOXES) {
    const across = ['worklist', 'relatedExams'].includes(a) !== ['worklist', 'relatedExams'].includes(b);
    const want = a === b ? null : across ? 'columns' : expected[`${a}>${b}`];
    assert.equal(boxes.swapFor(a, b), want, `${a} on ${b}`);
  }
  for (const [a, b] of [['worklist', 'reportEditor'], ['', 'editor'], [null, 'editor'], ['editor', undefined]])
    assert.equal(boxes.swapFor(a, b), null);
});

test('TEST-BOXES-02 the swaps decide the screen order of all five boxes and the direction of every handle', () => {
  const cases = [
    [[], ['worklist', 'relatedExams', 'clinical', 'relatedReports', 'editor'], { main: 1, prior: -1, top: 1, related: 1 }],
    [['list'], ['relatedExams', 'worklist', 'clinical', 'relatedReports', 'editor'], { main: 1, prior: 1, top: 1, related: 1 }],
    [['report'], ['worklist', 'relatedExams', 'clinical', 'editor', 'relatedReports'], { main: 1, prior: -1, top: 1, related: -1 }],
    [['side'], ['worklist', 'relatedExams', 'relatedReports', 'editor', 'clinical'], { main: 1, prior: -1, top: -1, related: 1 }],
    [['columns'], ['clinical', 'relatedReports', 'editor', 'worklist', 'relatedExams'], { main: -1, prior: -1, top: 1, related: 1 }],
    [['report', 'side', 'list', 'columns'], ['editor', 'relatedReports', 'clinical', 'relatedExams', 'worklist'], { main: -1, prior: 1, top: -1, related: -1 }],
  ];
  for (const [swaps, order, edges] of cases) {
    const a = boxes.arrangement(swaps);
    assert.deepEqual(a.order, order, JSON.stringify(swaps));
    assert.deepEqual(a.edges, edges, JSON.stringify(swaps));
    assert.deepEqual(a.swaps, boxes.SWAPS.filter(k => swaps.includes(k)));
  }
  // Position reading for later work: column, which side of the page, and the place inside the column.
  assert.deepEqual(boxes.arrangement(['columns', 'list']).positions.worklist, { column: 'A', side: 'second', index: 1 });
  assert.deepEqual(boxes.arrangement([]).positions.clinical, { column: 'B', side: 'second', index: 0 });
  assert.deepEqual(boxes.arrangement(['side']).positions.clinical, { column: 'B', side: 'second', index: 2 });
  // Swapping twice returns the default; every one of the sixteen arrangements is reachable by drops.
  assert.deepEqual(boxes.toggled(boxes.toggled([], 'side'), 'side'), []);
  const seen = new Set(), queue = [[]];
  while (queue.length) {
    const swaps = queue.shift(), id = swaps.join(); if (seen.has(id)) continue; seen.add(id);
    for (const a of boxes.BOXES) for (const b of boxes.BOXES) { const pair = boxes.swapFor(a, b); if (pair) queue.push(boxes.toggled(swaps, pair)); }
  }
  assert.equal(seen.size, 16);
});

test('TEST-BOXES-04 only an ordered list of known, distinct swaps is a record', () => {
  assert.deepEqual(boxes.normalize(['report', 'columns']), ['columns', 'report']);
  assert.deepEqual(boxes.normalize([]), []);
  for (const bad of [null, undefined, 'list', {}, ['list', 'list'], ['List'], ['diagonal'], [1]]) assert.equal(boxes.normalize(bad), null);
  assert.equal(boxes.toggled(['list'], 'diagonal'), null);
  assert.equal(boxes.toggled(['nope'], 'list'), null);
  // An unreadable record is drawn as the default arrangement, never half applied.
  assert.deepEqual(boxes.arrangement(['nope']).order, boxes.arrangement([]).order);
});
