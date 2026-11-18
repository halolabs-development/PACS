/* The work page's five boxes and where each one is. One record decides it: the swaps the reader made, kept in the
 * workspace layout record (workspace-layout.js `workspace.boxSwaps`, sparse like hiddenPanels). The boxes never leave
 * their parent elements: a swap changes only their visual order inside the parents they already have, so the report
 * editor keeps its text, caret and focus while the boxes move, and every script that finds a box by its place in the
 * page keeps finding it.
 *
 *   column A (.left)  : Worklist, Related Exam
 *   column B (.right) : Clinical Information band (.rw), then the report row (.workrow): Related Report, Report Editor
 *
 * Four pairs can trade places: the two columns, the two boxes of column A, the band and the report row of column B,
 * and the two boxes of the report row. Dropping one box on another trades the smallest pair that holds both. */
(function (root) {
  'use strict';
  const BOXES = Object.freeze(['worklist', 'relatedExams', 'clinical', 'relatedReports', 'editor']);
  const SWAPS = Object.freeze(['columns', 'list', 'side', 'report']);
  // Which column and which part of it each box belongs to in the page's structure (never changes).
  const HOME = Object.freeze({
    worklist: Object.freeze({ column: 'A', pair: 'list', first: true }),
    relatedExams: Object.freeze({ column: 'A', pair: 'list', first: false }),
    clinical: Object.freeze({ column: 'B', pair: 'side', first: true }),
    relatedReports: Object.freeze({ column: 'B', pair: 'report', first: true }),
    editor: Object.freeze({ column: 'B', pair: 'report', first: false }),
  });
  // A sparse, ordered list of the swaps that are on. Anything else is not a record this build wrote.
  function normalize(value) {
    if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(k => !SWAPS.includes(k))) return null;
    return SWAPS.filter(k => value.includes(k));
  }
  // The pair a drop of box `a` on box `b` turns over, or null when nothing should move.
  function swapFor(a, b) {
    if (!BOXES.includes(a) || !BOXES.includes(b) || a === b) return null;
    if (HOME[a].column !== HOME[b].column) return 'columns';
    if (HOME[a].column === 'A') return 'list';
    // Column B: the band against either box of the report row moves the band and the row; the two row boxes trade.
    return a === 'clinical' || b === 'clinical' ? 'side' : 'report';
  }
  function toggled(swaps, pair) {
    const clean = normalize(swaps);
    if (!clean || !SWAPS.includes(pair)) return null;
    return normalize(clean.includes(pair) ? clean.filter(k => k !== pair) : [...clean, pair]);
  }
  // The boxes in screen order (reading order: column first, then top to bottom), and for each resize handle whether a
  // drag toward the end of its axis (right / down) makes its own box larger (+1) or smaller (-1).
  function arrangement(swaps) {
    const on = new Set(normalize(swaps) || []);
    const columnA = on.has('list') ? ['relatedExams', 'worklist'] : ['worklist', 'relatedExams'];
    const row = on.has('report') ? ['editor', 'relatedReports'] : ['relatedReports', 'editor'];
    const columnB = on.has('side') ? [...row, 'clinical'] : ['clinical', ...row];
    const order = on.has('columns') ? [...columnB, ...columnA] : [...columnA, ...columnB];
    const positions = {};
    for (const key of BOXES) {
      const inA = HOME[key].column === 'A', column = inA ? columnA : columnB;
      positions[key] = { column: HOME[key].column, side: (inA !== on.has('columns')) ? 'first' : 'second',
        index: column.indexOf(key) };
    }
    // #resize-main sizes column A (.left); #resize-left-split the Related Exam list; #resize-top the band (.rw);
    // #resize-related the Related Report box. Each handle sits between its box and the other one of its pair.
    const edges = {
      main: on.has('columns') ? -1 : 1,
      prior: on.has('list') ? 1 : -1,
      top: on.has('side') ? -1 : 1,
      related: on.has('report') ? -1 : 1,
    };
    return { swaps: SWAPS.filter(k => on.has(k)), order, positions, edges };
  }
  const api = { BOXES, SWAPS, normalize, swapFor, toggled, arrangement };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinBoxLayout = api;
})(globalThis);
