
// FB-064: the Studies panel lists a study's series by Series Number, then series date and time, the same order on every
// opening. The stock panel lists display sets in the order their metadata arrived and sorts them only while its own
// settings dropdown is open. The parts of one split series compare equal, so the stable sort keeps their order.
// worklist-v0/hpacs-lite/viewer-series-strip.js orders the series strip by the same rule, and the viewer's own choosers
// of what a viewport shows (personal layout, prior, exam comparison, Compare list) order series with kinSeriesOrder.
// The viewer's display sets write a missing Series Number as 0; the instance keeps what the object carries. An attached
// document (FC-076) has none, so read as 0 it went before the study's images.
function kinSeriesSource(set) { return set?.instances?.[0] || set?.instance || set || {}; }
/** The series' own Series Number, or null when it has none (blank or not a number). */
function kinSeriesNumber(set) {
  const text = String(kinSeriesSource(set).SeriesNumber ?? '').trim(), n = Number(text);
  return text && Number.isFinite(n) ? n : null;
}
function kinSeriesOrder(a, b) {
  const number = set => kinSeriesNumber(set) ?? Infinity;
  const stamp = set => { const source = kinSeriesSource(set), date = String(source.SeriesDate ?? '').trim();
    return date ? date + String(source.SeriesTime ?? '').trim() : '￿'; };
  const order = (x, y) => x < y ? -1 : x > y ? 1 : 0;
  // A missing number goes last (Infinity - Infinity is NaN, which falls through to the next key).
  return number(a) - number(b) || order(stamp(a), stamp(b)) ||
    order(String(a.SeriesInstanceUID ?? ''), String(b.SeriesInstanceUID ?? ''));
}

function kinCreateSeriesOrder() {
  let subscription = null, restore = null;
  return { id: 'kin.series-order', onModeEnter({ servicesManager }) {
    subscription?.unsubscribe(); subscription = null; restore?.(); restore = null;
    const service = servicesManager.services.displaySetService, hp = servicesManager.services.hangingProtocolService;
    // The pinned hanging protocols break a tie in matching score by the display set's Series Number (a missing one is
    // 0), then take the first. The tie now follows the Studies panel order: the display set's place among the protocol's
    // display sets sorted by kinSeriesOrder. Scores (images first, a series named in the address) still decide first.
    const native = hp?._getSeriesSortInfoForDisplaySetSort;
    if (typeof native === 'function' && typeof hp._getSeriesFieldForDisplaySetSort === 'function') {
      const ordered = function (displaySet) {
        const sets = [...(this.displaySets || [])].sort(kinSeriesOrder), at = sets.indexOf(displaySet);
        return { [this._getSeriesFieldForDisplaySetSort().name]: at < 0 ? sets.length : at };
      };
      const own = Object.prototype.hasOwnProperty.call(hp, '_getSeriesSortInfoForDisplaySetSort');
      hp._getSeriesSortInfoForDisplaySetSort = ordered;
      restore = () => {
        if (hp._getSeriesSortInfoForDisplaySetSort !== ordered) return;
        if (own) hp._getSeriesSortInfoForDisplaySetSort = native; else delete hp._getSeriesSortInfoForDisplaySetSort;
      };
    }
    if (typeof service?.sortDisplaySets !== 'function') return;
    // Sorted only when a series arrives out of order; the sort's own change event redraws the panel.
    const apply = () => {
      const sets = service.getActiveDisplaySets();
      if (sets.some((set, index) => index && kinSeriesOrder(sets[index - 1], set) > 0)) service.sortDisplaySets(kinSeriesOrder, 'ascending');
    };
    subscription = service.subscribe(service.EVENTS.DISPLAY_SETS_ADDED, apply);
    apply();
  }, onModeExit() { subscription?.unsubscribe(); subscription = null; restore?.(); restore = null; } };
}
