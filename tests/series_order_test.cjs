// FB-064: the Studies panel lists a study's series by Series Number (then series date and time) on every opening.
// The shipped config/ohif/series-order.js runs against a display set service with the pinned OHIF 3.9.1 behaviour:
// display sets are appended in the order their metadata arrives, DISPLAY_SETS_ADDED follows, and sortDisplaySets
// sorts the same array in place and broadcasts DISPLAY_SETS_CHANGED (the event the stock Studies panel redraws on).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function load() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync('config/ohif/series-order.js', 'utf8'), context, { filename: 'series-order.js' });
  return context;
}
function service() {
  const listeners = new Map(), events = [];
  const s = { EVENTS: { DISPLAY_SETS_ADDED: 'added', DISPLAY_SETS_CHANGED: 'changed' }, activeDisplaySets: [], events,
    getActiveDisplaySets() { return this.activeDisplaySets; },
    subscribe(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn);
      return { unsubscribe: () => listeners.get(event).delete(fn) }; },
    broadcast(event, data) { events.push(event); for (const fn of [...(listeners.get(event) || [])]) fn(data); },
    // As the pinned service: append, CHANGED, then ADDED.
    add(...sets) { this.activeDisplaySets.push(...sets); this.broadcast('changed', this.activeDisplaySets); this.broadcast('added', { displaySetsAdded: sets }); },
    sortDisplaySets(fn, direction, suppressEvent = false) {
      this.activeDisplaySets.sort(fn); if (direction === 'descending') this.activeDisplaySets.reverse();
      if (!suppressEvent) this.broadcast('changed', this.activeDisplaySets);
    },
    listeners: () => [...listeners.values()].reduce((n, set) => n + set.size, 0) };
  return s;
}
const ds = (id, SeriesNumber, extra = {}) => ({ displaySetInstanceUID: id, SeriesInstanceUID: 'S-' + id, SeriesNumber, SeriesDate: '20261111', SeriesTime: '081500', ...extra });
const ids = s => s.activeDisplaySets.map(set => set.displaySetInstanceUID);

test('series arriving out of order are listed by Series Number, after every arrival', () => {
  const { kinCreateSeriesOrder } = load(), s = service(), extension = kinCreateSeriesOrder();
  extension.onModeEnter({ servicesManager: { services: { displaySetService: s } } });
  // The opening seen on the served viewer: T1 (1), DWI (4), T2 (2), FLAIR (3).
  s.add(ds('T1', 1)); s.add(ds('DWI', 4));
  assert.deepEqual(ids(s), ['T1', 'DWI']);
  s.add(ds('T2', 2));
  assert.deepEqual(ids(s), ['T1', 'T2', 'DWI']);
  s.add(ds('FLAIR', 3));
  assert.deepEqual(ids(s), ['T1', 'T2', 'FLAIR', 'DWI']);
  // The sort's own change event is what the stock panel redraws on; an arrival already in order adds none.
  assert.equal(s.events.filter(e => e === 'changed').length, 4 + 2);
  s.add(ds('ADC', 5));
  assert.equal(s.events.filter(e => e === 'changed').length, 5 + 2);
  extension.onModeExit();
  assert.equal(s.listeners(), 0);
});

test('the same arrivals in any order give one list', () => {
  const { kinCreateSeriesOrder } = load();
  const sets = () => [ds('a', 3), ds('b', '10'), ds('c', 2), ds('d', 1)];
  const seen = new Set();
  for (const arrival of [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]]) {
    const s = service(), extension = kinCreateSeriesOrder(), all = sets();
    extension.onModeEnter({ servicesManager: { services: { displaySetService: s } } });
    for (const index of arrival) s.add(all[index]);
    seen.add(ids(s).join(','));
    extension.onModeExit();
  }
  assert.deepEqual([...seen], ['d,c,a,b'], 'numbers compare as numbers (10 after 3)');
});

test('equal numbers follow series date and time; a missing number or date goes last; split parts keep their order', () => {
  const { kinSeriesOrder, kinCreateSeriesOrder } = load(), s = service(), extension = kinCreateSeriesOrder();
  // Already present before the mode starts: sorted at once.
  s.activeDisplaySets.push(ds('none', undefined), ds('late', 2, { SeriesTime: '090000' }), ds('nodate', 2, { SeriesDate: '' }),
    ds('early', 2, { SeriesTime: '080000' }), ds('blank', ' '));
  extension.onModeEnter({ servicesManager: { services: { displaySetService: s } } });
  assert.deepEqual(ids(s).slice(0, 3), ['early', 'late', 'nodate']);
  assert.deepEqual(ids(s).slice(3).sort(), ['blank', 'none']);
  // Two parts of one split series (same series, number and time) stay in the order the split made them.
  const part = (id, k) => ({ ...ds(id, 7), SeriesInstanceUID: 'S-split', SeriesDescription: 'DWI · ' + k + '/2' });
  s.add(part('split-2', 2), ds('six', 6));
  s.add(part('split-1', 1));
  assert.deepEqual(ids(s).slice(0, 6), ['early', 'late', 'nodate', 'six', 'split-2', 'split-1']);
  assert.deepEqual(ids(s).slice(6).sort(), ['blank', 'none']);
  assert.equal(kinSeriesOrder(part('x', 1), part('y', 2)), 0);
  extension.onModeExit();
});

test('a series the viewer numbered 0 for want of a Series Number goes last; a real Series Number 0 stays first', () => {
  const { kinCreateSeriesOrder } = load(), s = service(), extension = kinCreateSeriesOrder();
  // As the pinned stack handler builds a display set: SeriesNumber: instance.SeriesNumber || 0, the instances kept.
  const native = (id, instance) => ({ displaySetInstanceUID: id, SeriesInstanceUID: 'S-' + id, SeriesNumber: instance.SeriesNumber || 0,
    SeriesDate: instance.SeriesDate, SeriesTime: instance.SeriesTime, instances: [instance] });
  extension.onModeEnter({ servicesManager: { services: { displaySetService: s } } });
  s.add(native('two', { SeriesNumber: 2, SeriesDate: '20261111', SeriesTime: '081500' }));
  s.add(native('unnumbered', { SeriesDate: '20261111', SeriesTime: '080000' }));
  s.add(native('one', { SeriesNumber: 1, SeriesDate: '20261111', SeriesTime: '081500' }));
  s.add(native('zero', { SeriesNumber: 0, SeriesDate: '20261111', SeriesTime: '090000' }));
  assert.deepEqual(ids(s), ['zero', 'one', 'two', 'unnumbered']);
  extension.onModeExit();
});

test('a service without sortDisplaySets is left as it is', () => {
  const { kinCreateSeriesOrder } = load(), s = service();
  delete s.sortDisplaySets; s.sortDisplaySets = undefined;
  const extension = kinCreateSeriesOrder();
  extension.onModeEnter({ servicesManager: { services: { displaySetService: s } } });
  s.add(ds('b', 2), ds('a', 1));
  assert.deepEqual(ids(s), ['b', 'a']);
  assert.equal(s.listeners(), 0);
});

// ---------------------------------------------------------------------------------------------------------------
// The first display. The pinned HangingProtocolService._matchImages scores every display set against a selector and
// sorts the candidates by score (descending), study (descending), then this._getSeriesSortInfoForDisplaySetSort(set)
// (ascending), whose pinned body is { series: parseInt(displaySet.SeriesNumber) } - a missing number reads 0.
class PinnedHangingProtocols {
  _getSeriesSortInfoForDisplaySetSort(displaySet) {
    return { [this._getSeriesFieldForDisplaySetSort().name]: displaySet.SeriesNumber != null ? parseInt(displaySet.SeriesNumber) : parseInt(displaySet.seriesNumber) };
  }
  _getSeriesFieldForDisplaySetSort() { return { name: 'series' }; }
  /** The stock default selector: images score 10, a series named in the address another 10. */
  first(displaySets) {
    this.displaySets = displaySets;
    const scored = displaySets.map(set => ({ set, info: { score: (set.numImageFrames > 0 ? 10 : 0) + (set.isDisplaySetFromUrl ? 10 : 0),
      study: set.StudyInstanceUID, ...this._getSeriesSortInfoForDisplaySetSort(set) } }));
    const compare = (x, y) => x < y ? -1 : x > y ? 1 : 0;
    scored.sort((a, b) => compare(b.info.score, a.info.score) || compare(b.info.study, a.info.study) || compare(a.info.series, b.info.series));
    return scored[0].set.displaySetInstanceUID;
  }
}
// As the pinned stack handler builds a display set: SeriesNumber: instance.SeriesNumber || 0, the instances kept.
const stack = (id, instance, extra = {}) => ({ displaySetInstanceUID: id, StudyInstanceUID: '2.25.1', SeriesInstanceUID: 'S-' + id,
  SeriesNumber: instance.SeriesNumber || 0, numImageFrames: 1, instances: [{ SeriesDate: '20261111', SeriesTime: '081500', ...instance }], ...extra });
const attached = id => stack(id, { SeriesDate: '', SeriesTime: '' }, { Modality: 'OT', SeriesDescription: 'Attached Document' });
function entered(hp) {
  const { kinCreateSeriesOrder } = load(), s = service(), extension = kinCreateSeriesOrder();
  extension.onModeEnter({ servicesManager: { services: { displaySetService: s, hangingProtocolService: hp } } });
  return extension;
}

test('the pinned tie-break opened an attached picture before the images; the panel order now breaks the tie', () => {
  const sets = () => [stack('ct', { SeriesNumber: 1 }, { numImageFrames: 8 }), attached('picture')];
  assert.equal(new PinnedHangingProtocols().first(sets()), 'picture', 'the defect: the attachment reads as number 0');
  const hp = new PinnedHangingProtocols(), extension = entered(hp);
  assert.equal(hp.first(sets()), 'ct');
  assert.equal(hp.first(sets().reverse()), 'ct', 'whatever the arrival order');
  // Several attachments, a numbered Secondary Capture, a real number 0, equal numbers by date: the panel order.
  assert.equal(hp.first([attached('a'), attached('b'), stack('sc', { SeriesNumber: 5 }, { Modality: 'OT' }), stack('ct', { SeriesNumber: 3 })]), 'ct');
  assert.equal(hp.first([stack('ct', { SeriesNumber: 1 }), stack('zero', { SeriesNumber: 0 }), attached('a')]), 'zero');
  assert.equal(hp.first([stack('late', { SeriesNumber: 2, SeriesTime: '090000' }), stack('early', { SeriesNumber: 2, SeriesTime: '080000' })]), 'early');
  // A study with nothing but the attached picture opens on it; a series named in the address still wins on score.
  assert.equal(hp.first([attached('only')]), 'only');
  assert.equal(hp.first([stack('ct', { SeriesNumber: 1 }), attached('asked', ), { ...attached('named'), isDisplaySetFromUrl: true }]), 'named');
  // A non-image set (a PDF or SR: no image frames) loses on score as before.
  assert.equal(hp.first([{ ...attached('pdf'), numImageFrames: 0, Modality: 'DOC' }, attached('picture')]), 'picture');
  extension.onModeExit();
});

test('the tie-break is installed once per mode and taken back on exit', () => {
  const hp = new PinnedHangingProtocols(), { kinCreateSeriesOrder } = load(), s = service(), extension = kinCreateSeriesOrder();
  const services = { displaySetService: s, hangingProtocolService: hp };
  extension.onModeEnter({ servicesManager: { services } });
  const installed = hp._getSeriesSortInfoForDisplaySetSort;
  assert.ok(Object.prototype.hasOwnProperty.call(hp, '_getSeriesSortInfoForDisplaySetSort'));
  extension.onModeEnter({ servicesManager: { services } });
  assert.notEqual(hp._getSeriesSortInfoForDisplaySetSort, installed, 're-entry replaces its own wrapper');
  hp.first([stack('ct', { SeriesNumber: 1 }), attached('a')]);
  assert.equal(hp.first([stack('ct', { SeriesNumber: 1 }), attached('a')]), 'ct', 'not wrapped twice');
  extension.onModeExit();
  assert.ok(!Object.prototype.hasOwnProperty.call(hp, '_getSeriesSortInfoForDisplaySetSort'), 'the pinned method is back');
  assert.equal(hp.first([stack('ct', { SeriesNumber: 1 }), attached('a')]), 'a');
  // Someone else's later wrapper is not undone.
  extension.onModeEnter({ servicesManager: { services } });
  const other = function (set) { return { series: 0 }; };
  hp._getSeriesSortInfoForDisplaySetSort = other;
  extension.onModeExit();
  assert.equal(hp._getSeriesSortInfoForDisplaySetSort, other);
});
