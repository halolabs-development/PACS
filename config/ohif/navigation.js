
// Study/series/SOP/frame identity of a stack image id; frame is 1-based like the saved items.
function kinViewerImageReference(imageId) {
  const m = typeof imageId === 'string' && imageId.match(/\/studies\/([0-9.]+)\/series\/([0-9.]+)\/instances\/([0-9.]+)\/frames\/([1-9][0-9]*)(?:$|[?#])/);
  return m ? { study: m[1], seriesUid: m[2], sopUid: m[3], frame: Number(m[4]) } : null;
}
// The cell's image number ("I: n (k/N)") and scroll bar follow STACK_VIEWPORT_SCROLL, which the renderer sends from its own
// scroll but not from a direct setImageIdIndex() (that sends STACK_NEW_IMAGE only), so a cell moved here kept the old number.
// The same event is sent on the cell's element in the renderer's own order: once the request is issued, before its image
// arrives (the viewer raises its Loading cover on this event and lowers it on the STACK_NEW_IMAGE that follows). Nothing is
// sent when the index did not change (the renderer then loads nothing), the move is no longer the live one of this cell, or
// the request left the cell on another index or image.
function kinViewerAnnounceScroll(v, index, from, imageId, live) {
  try {
    const name = window.cornerstone?.Enums?.Events?.STACK_VIEWPORT_SCROLL, element = v.element;
    if (!name || !element || typeof element.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
    if (from === index || !live() || typeof v.getCurrentImageIdIndex !== 'function' || v.getCurrentImageIdIndex() !== index
        || v.getImageIds()[index] !== imageId) return;
    element.dispatchEvent(new CustomEvent(name, { cancelable: true, detail: { newImageIdIndex: index,
      imageId, direction: Number.isInteger(from) ? index - from : 0 } }));
    return true;
  } catch (_) {}
  return false;
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
  const identity = { seriesUid: target.seriesUid, sopUid: target.sopUid, frame: target.frame };
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
  if (!(first ? first.getImageIds() : []).some(id => env.matches(env.reference(id), identity))) {
    if (!live()) return refusal('superseded');
    env.services.viewportGridService.setDisplaySetsForViewport({ viewportId, displaySetInstanceUIDs: [sets[0].displaySetInstanceUID] });
  }
  for (let n = 0; n < 100; n++) {
    if (!live()) return refusal('superseded');
    const v = env.services.cornerstoneViewportService.getCornerstoneViewport(viewportId);
    if (v && !stack(v)) return refusal('viewport-unsupported');
    const index = (v ? v.getImageIds() : []).findIndex(id => env.matches(env.reference(id), identity));
    if (index >= 0) {
      const cell = () => live() && env.services.viewportGridService.getActiveViewportId() === viewportId;
      let from = null, announced = false;
      try {
        // The pinned setter preserves its load Promise but leaves the scroll target
        // and an older wheel debounce untouched. Retarget before starting the load;
        // doing this after await would rewind a newer user scroll.
        from = typeof v.getCurrentImageIdIndex === 'function' ? v.getCurrentImageIdIndex() : null;
        const imageId = v.getImageIds()[index];
        clearTimeout(v.debouncedTimeout);
        v.targetImageIdIndex = index;
        const loading = v.setImageIdIndex(index);
        announced = kinViewerAnnounceScroll(v, index, from, imageId, cell);
        await loading;
      } catch (_) {
        // The image never came and the cell still shows the one it showed (the setter has already moved its index): put
        // the number and the index back the renderer's way, a scroll to that image and its load, so neither the number nor
        // the Loading cover stays on the frame that did not arrive. Not when the user moved the cell meanwhile.
        if (announced && cell() && Number.isInteger(from) && v.getCurrentImageIdIndex?.() === index && v.targetImageIdIndex === index) {
          try {
            v.targetImageIdIndex = from;
            const back = v.setImageIdIndex(from);
            kinViewerAnnounceScroll(v, from, index, v.getImageIds()[from], cell);
            Promise.resolve(back).catch(() => {});
          } catch (_) {}
        }
        return live() ? refusal('frame-missing') : refusal('superseded');
      }
      if (!cell()) return refusal('superseded');
      // A wheel or key that moved the cell on while this frame loaded is the newer choice: this move does not report arrival.
      if (typeof v.targetImageIdIndex === 'number' && v.targetImageIdIndex !== index) return refusal('superseded');
      // The frame actually shown after the await is the only proof; a user scroll or a
      // display-set change during the load must not be reported as arrival.
      if (!env.matches(env.reference(v.getCurrentImageId?.()), identity)) return refusal('frame-missing');
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
