
// Study/series/SOP/frame identity of a stack image id; frame is 1-based like the saved items.
function kinViewerImageReference(imageId) {
  const m = typeof imageId === 'string' && imageId.match(/\/studies\/([0-9.]+)\/series\/([0-9.]+)\/instances\/([0-9.]+)\/frames\/([1-9][0-9]*)(?:$|[?#])/);
  return m ? { study: m[1], seriesUid: m[2], sopUid: m[3], frame: Number(m[4]) } : null;
}
// The image the cell shows. The renderer's own index is not that: it moves to the requested frame when a load starts and
// stays there when the load fails or is overtaken, while the image before stays on screen. Every decision of the
// exact-frame move below (already there, arrived, the cell's number, the mark) reads this and never that index.
function kinViewerShownImageId(v) {
  try { return v.getCornerstoneImage?.()?.imageId ?? null; } catch (_) { return null; }
}
// The cell's image number ("I: n (k/N)") and scroll bar follow STACK_VIEWPORT_SCROLL, which the renderer sends from its own
// scroll but not from a direct setImageIdIndex() (that sends STACK_NEW_IMAGE only), so a cell moved here kept the old number.
// The viewer raises its Loading cover on that scroll event and lowers it on STACK_NEW_IMAGE, so the event is sent from a
// capture listener on the cell's STACK_NEW_IMAGE, which runs before the viewer's own handling of the same event lowers the
// cover: once, and only when `arrived` says the cell now shows the requested image and it is still the frame asked of it.
// A load that fails sends no STACK_NEW_IMAGE, so neither the number nor the cover moves. One arrival is numbered once: a
// later move to the same frame watches the same event, which carries the note. Returns the function that stops it.
function kinViewerNumberOnArrival(v, index, from, arrived) {
  const none = () => {};
  try {
    const events = typeof window === 'undefined' ? null : window.cornerstone?.Enums?.Events, element = v.element;
    if (!events?.STACK_NEW_IMAGE || !events.STACK_VIEWPORT_SCROLL || typeof element?.addEventListener !== 'function' ||
        typeof element.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return none;
    const stop = () => { try { element.removeEventListener(events.STACK_NEW_IMAGE, seen, true); } catch (_) {} };
    const seen = event => {
      if (!arrived()) return;
      stop();
      if (event.kinNumbered) return;
      event.kinNumbered = true;
      try {
        element.dispatchEvent(new CustomEvent(events.STACK_VIEWPORT_SCROLL, { cancelable: true, detail: { newImageIdIndex: index,
          imageId: v.getImageIds()[index], direction: from < 0 ? 0 : index - from } }));
      } catch (_) {}
    };
    element.addEventListener(events.STACK_NEW_IMAGE, seen, true);
    return stop;
  } catch (_) { return none; }
}
// Exact-frame navigation shared by the Saved Items "Go to Image" button and the Findings section.
// `env` exposes the live closure state of kinCreateViewerHistory through getters, so every decision
// after an await is re-taken against the current session and never against a copy. The result is
// { ok: true, highlighted, annotation } or { ok: false, reason }; it never throws, never changes the
// URL study set and never reslices a volume viewport (3D cursor stays off).
const KIN_NAVIGATION_REASONS = ['invalid', 'ended', 'scope', 'busy', 'series-missing', 'viewport-unsupported', 'frame-missing', 'superseded', 'tool-missing'];
async function kinViewerNavigateTo(env, target) {
  const refusal = reason => ({ ok: false, reason });
  const uid = s => typeof s === 'string' && s.length <= 64 && /^[0-9]+(?:\.[0-9]+)+$/.test(s);
  if (!target || typeof target !== 'object' || !uid(target.studyUid) || !uid(target.seriesUid) || !uid(target.sopUid) ||
      !Number.isSafeInteger(target.frame) || target.frame < 1) return refusal('invalid');
  if (env.ended()) return refusal('ended');
  const scope = env.scope();
  if (!scope || target.studyUid !== scope) return refusal('scope');
  if (env.busy()) return refusal('busy');
  const ticket = env.generation(), nav = env.beginNavigation();
  const live = () => !env.ended() && env.valid(ticket) && nav === env.navigation() && env.scope() === scope;
  // The requested frame, by the study this move started in (the panel's own study may change while an image loads).
  const same = id => { const r = env.reference(id);
    return !!r && r.study === scope && r.seriesUid === target.seriesUid && r.sopUid === target.sopUid && r.frame === target.frame; };
  let sets;
  try {
    sets = env.services.displaySetService.getActiveDisplaySets().filter(d => d.StudyInstanceUID === scope && d.SeriesInstanceUID === target.seriesUid && kinSeriesSplitHolds(d, target.sopUid, target.frame));
  } catch (_) { return refusal('tool-missing'); }
  if (sets.length !== 1) return refusal('series-missing');
  const viewportId = env.services.viewportGridService.getActiveViewportId();
  const stack = v => v && v.type === 'stack' && typeof v.getImageIds === 'function' && typeof v.setImageIdIndex === 'function';
  const first = env.viewport();
  // A volume/MPR viewport has no stack image list to index: refuse instead of reslicing or retargeting.
  if (first && !stack(first)) return refusal('viewport-unsupported');
  if (!(first ? first.getImageIds() : []).some(same)) {
    if (!live()) return refusal('superseded');
    env.services.viewportGridService.setDisplaySetsForViewport({ viewportId, displaySetInstanceUIDs: [sets[0].displaySetInstanceUID] });
  }
  for (let n = 0; n < 100; n++) {
    if (!live()) return refusal('superseded');
    const v = env.services.cornerstoneViewportService.getCornerstoneViewport(viewportId);
    if (v && !stack(v)) return refusal('viewport-unsupported');
    const index = (v ? v.getImageIds() : []).findIndex(same);
    if (index >= 0) {
      const shows = () => same(kinViewerShownImageId(v));
      // Still the frame asked of this cell, by the cell's own state: it holds this viewport (the viewer puts a new one in
      // it with every series it is given) and no wheel, key or later move has put its scroll target elsewhere.
      const kept = () => env.services.cornerstoneViewportService.getCornerstoneViewport(viewportId) === v &&
        !(typeof v.targetImageIdIndex === 'number' && v.targetImageIdIndex !== index);
      let stop = () => {};
      try {
        // The pinned setter preserves its load Promise but leaves the scroll target
        // and an older wheel debounce untouched. Retarget before starting the load;
        // doing this after await would rewind a newer user scroll.
        const from = v.getImageIds().indexOf(kinViewerShownImageId(v));
        clearTimeout(v.debouncedTimeout);
        v.targetImageIdIndex = index;
        // The pinned setter loads nothing when its index is already on the frame, which it also is while an earlier load
        // of that frame still runs and after one failed. A frame the cell does not show is loaded by this move: the
        // renderer's index goes back to the image shown (-1: none of this stack), and the setter's Promise is then this
        // move's own load from start to end.
        if (!shows() && typeof v.currentImageIdIndex === 'number') v.currentImageIdIndex = from;
        // The number is the cell's own and follows its image: it reads nothing of the panel, which has moved to another
        // cell or another study (and counted that as a new navigation) when the reader made another cell the active one.
        stop = kinViewerNumberOnArrival(v, index, from, () => !env.ended() && kept() && shows());
        await v.setImageIdIndex(index);
      } catch (_) {
        return live() ? refusal('frame-missing') : refusal('superseded');
      } finally { stop(); }
      // Another study or active cell, a new viewport in the cell, a later move, or a wheel or key that moved the cell on
      // while this frame loaded is the newer choice: this move does not report arrival.
      if (!live() || env.services.viewportGridService.getActiveViewportId() !== viewportId || !kept()) return refusal('superseded');
      // The image shown after the await is the only proof: the pinned GPU loader settles the setter normally after a failed
      // load, and the index it leaves on the requested frame says nothing of the image on screen.
      if (!shows()) return refusal('frame-missing');
      try { v.render(); } catch (_) {}
      env.hydrate();
      return { ok: true, ...env.highlight(target.itemId) };
    }
    await env.delay();
  }
  return live() ? refusal('frame-missing') : refusal('superseded');
}
// Go to Image for the other study of this viewer (S2-B2): exactly one viewport may show that study and
// only that viewport becomes active; the history scan then loads the study. No display set, layout,
// camera or URL changes, and a refused request changes nothing. The caller waits for the history and
// navigates only afterwards; `changed` tells it whether the active viewport really moved.
const KIN_ACTIVATION_REASONS = ['invalid', 'ended', 'viewport-missing', 'viewport-ambiguous', 'viewport-unsupported', 'tool-missing'];
function kinViewerActivateStudy(env, study) {
  const refusal = reason => ({ ok: false, reason });
  if (typeof study !== 'string' || study.length > 64 || !/^[0-9]+(?:\.[0-9]+)+$/.test(study)) return refusal('invalid');
  if (env.ended()) return refusal('ended');
  try {
    const grid = env.services.viewportGridService, sets = env.services.displaySetService;
    const shown = [...grid.getState().viewports].filter(([, view]) =>
      (view?.displaySetInstanceUIDs || []).some(id => sets.getDisplaySetByUID(id)?.StudyInstanceUID === study)).map(([id]) => id);
    if (shown.length > 1) return refusal('viewport-ambiguous');
    const v = shown.length ? env.services.cornerstoneViewportService.getCornerstoneViewport(shown[0]) : null;
    if (!v) return refusal('viewport-missing');
    if (v.type !== 'stack' || typeof v.getImageIds !== 'function') return refusal('viewport-unsupported');
    if (grid.getActiveViewportId() === shown[0]) return { ok: true, viewportId: shown[0], changed: false };
    // From here the grid may have moved even if the service throws.
    try { grid.setActiveViewportId(shown[0]); } catch (_) { return { ok: false, reason: 'tool-missing', changed: true }; }
    return { ok: true, viewportId: shown[0], changed: true };
  } catch (_) { return refusal('tool-missing'); }
}
