window.KinViewerUXShortcuts = (() => {
  // D1821: initial single keys are editable; null explicitly clears a binding.
  // F8 (2026-10-26): flips and turns take Shift so L and R stay Length and Rectangle.
  const defaults = { WindowLevel: 'w', Pan: 'p', Zoom: 'z', StackScroll: 's',
    Length: 'l', Angle: 'a', EllipticalROI: 'e', RectangleROI: 'r',
    ArrowAnnotate: 't', invert: 'i', Cine: 'c', Crosshairs: 'x',
    flipHorizontal: 'shift+h', flipVertical: 'shift+v', 'rotate-left': 'shift+l', 'rotate-right': 'shift+r' };
  const editable = node => !!node?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
  // A stored binding is one letter or digit, or Shift with one letter.
  const parse = text => {
    const value = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '');
    return /^(?:[a-z0-9]|shift\+[a-z])$/.test(value) ? value : null;
  };
  const display = key => key ? key.split('+').map(part => part === 'shift' ? 'Shift' : part.toUpperCase()).join('+') : '';
  // The binding a press stands for, or null for presses this layer leaves alone.
  // Shift is read from the modifier and the letter from the key, so Caps Lock
  // changes neither.
  function pressed(event) {
    if (event.ctrlKey || event.altKey || event.metaKey) return null;
    const character = event.key?.toLowerCase() || '';
    if (event.shiftKey) return /^[a-z]$/.test(character) ? 'shift+' + character : null;
    return /^[a-z0-9]$/.test(character) ? character : null;
  }
  // Every tool and function a Viewer window offers a key for, with its name, for the places outside the viewer (the
  // Keyboard Shortcuts summary and the Viewer tab of Edit Shortcuts on the work page); the viewer buttons keep their own
  // names. They are the pinned viewer's tools (config/ohif/toolbar-labels.js), the ones this product adds beside them
  // (viewer-ux-toolbar.js: the second flip and turn, Pointer, the exports after Capture) and the feature keys
  // (viewer-features*.js ui.shortcut). The first sixteen have a key by default (defaults above).
  const names = { WindowLevel: 'Window / Level', Pan: 'Pan', Zoom: 'Zoom', StackScroll: 'Stack Scroll',
    Length: 'Length', Angle: 'Angle', EllipticalROI: 'Ellipse ROI', RectangleROI: 'Rectangle ROI',
    ArrowAnnotate: 'Arrow', invert: 'Invert', Cine: 'Cine', Crosshairs: 'Crosshairs',
    flipHorizontal: 'Flip Horizontal', flipVertical: 'Flip Vertical', 'rotate-left': 'Rotate Left', 'rotate-right': 'Rotate Right',
    Pointer: 'Pointer', Bidirectional: 'Bidirectional', CircleROI: 'Circle ROI', PlanarFreehandROI: 'Freehand ROI',
    SplineROI: 'Spline ROI', LivewireContour: 'Livewire Contour', Probe: 'Probe', CobbAngle: 'Cobb Angle',
    CalibrationLine: 'Calibration Line', UltrasoundDirectionalTool: 'Ultrasound Directional', TrackballRotate: '3D Rotate',
    Reset: 'Reset', ImageSliceSync: 'Image Slice Sync', ReferenceLines: 'Reference Lines', ImageOverlayViewer: 'Image Overlay',
    Magnify: 'Magnify', AdvancedMagnify: 'Magnify Probe', WindowLevelRegion: 'Window Level Region', TagBrowser: 'Tag Browser',
    Capture: 'Capture', CopyImage: 'Copy Image', CopyScreen: 'Copy Screen', SaveJPEG: 'Save JPEG', SaveSeriesJPEG: 'Save Series JPEG',
    SaveVideo: 'Save Video', AddToCaptures: 'Add to Captures', Captures: 'Captures',
    mgNextPatient: 'Next Patient', compareMatchRatioNow: 'Match Ratio' };
  // The tools shown on the toolbar of an account that never arranged it (viewer-ux-toolbar.js); a viewer-settings record
  // made outside the viewer (the work page's Edit Shortcuts) starts from it, so the viewer shows the same bar.
  const defaultBar = ['WindowLevel', 'Pan', 'Zoom', 'StackScroll', 'Length', 'Angle', 'EllipticalROI', 'Pointer'];
  const turns = ['flipHorizontal', 'flipVertical', 'rotate-left', 'rotate-right'];
  // The keys a Viewer window opens with for the saved viewer settings of an account, as viewer-ux-toolbar.js reads them:
  // nothing saved is the defaults; version 1 offered no flip/turn keys, so its nulls there are the defaults.
  function current(settings) {
    const saved = settings && typeof settings === 'object' && settings.shortcuts && typeof settings.shortcuts === 'object'
      ? settings.shortcuts : null;
    if (!saved) return { ...defaults };
    const map = { ...saved };
    if (settings.version === 1) for (const id of turns) if (map[id] == null) map[id] = defaults[id];
    return map;
  }
  // A key panel (F.Leader, viewer-features-input.js) takes keys before this layer's tool keys: lead(fn) installs it,
  // fn(event, refused) returns true for a key it used, and refused() says whether a closed panel may open now (the
  // same refusals as a tool key). A used key runs nothing else; its keypress and keyup go nowhere either.
  // fn(event, refused, true) only asks: whether a closed panel would take this key, with nothing opened.
  let leader = null;
  function lead(fn) { leader = fn; return () => { if (leader === fn) leader = null; }; }
  // A key binding as the pinned viewer's own hotkeys write it (User Preferences: the keys joined with '+', modifiers
  // first, e.g. 'shift+h', 'ctrl+alt+1', 'space', '+').
  function hotkey(text) {
    const value = String(text ?? '').trim().toLowerCase();
    if (!value) return null;
    const parts = value === '+' ? ['+'] : value.endsWith('++') ? [...value.slice(0, -2).split('+'), '+'] : value.split('+');
    const key = parts.pop(), held = new Set(parts);
    return { key, ctrl: held.has('ctrl'), alt: held.has('alt'), shift: held.has('shift'), meta: held.has('meta') || held.has('command') };
  }
  const codeOf = key => /^[a-z]$/.test(key) ? 'Key' + key.toUpperCase() : /^[0-9]$/.test(key) ? 'Digit' + key
    : ({ left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown' })[key] || null;
  // What a mounted layer takes in this window before the pinned viewer's hotkeys, given as a reason; null when the
  // viewer's hotkey gets the key. One answer for a press and for a binding the User Preferences table shows.
  let claimant = () => null;
  const claims = binding => { const parts = hotkey(binding); return parts ? claimant(parts) : null; };
  // The reason in the reader's screen language when it is written (English only; otherwise as written).
  const kinText = text => window.KinLanguage?.text ? window.KinLanguage.text(text) : text;
  const reasons = {
    tool: () => kinText('이 창에서 사용 불가 — 영상 도구 키가 먼저 받습니다(Viewer Settings · Edit Shortcuts › Viewer에서 정함). 다른 키를 지정하세요.'),
    leader: () => kinText('이 창에서 사용 불가 — Space는 F.Leader가 받습니다(Viewer Settings › Space opens F.Leader). 다른 키를 지정하세요.'),
    workspace: () => kinText('이 창에서 사용 불가 — 작업 화면 단축키가 받습니다(Edit Shortcuts). 다른 키를 지정하세요.') };
  function mount({ getBindings, invoke, allowed, workspace = () => null }) {
    const blocked = event => event.isComposing || event.keyCode === 229 || event.repeat ||
      editable(event.target) || editable(document.activeElement) ||
      document.body.classList.contains('kin-viewer-empty') || document.body.classList.contains('kin-patient-switching') ||
      document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal.show');
    // The existing CT preset extension owns its numbered mode hotkeys. A user
    // tool binding overrides one; otherwise keep that published preset action.
    const nativePreset = (event, key) => !blocked(event) && allowed() &&
      !Object.values(getBindings()).includes(key) && !!window.kinCTPresets?.names?.[Number(key) - 1];
    const held = new Set();
    function led(event) {
      if (!leader || event.isComposing || event.keyCode === 229) return false;
      // A key the panel used stays its own until it is let go: its repeats run nothing, also after the panel closed.
      if (event.repeat && held.has(event.code || event.key)) { event.stopImmediatePropagation(); event.preventDefault(); return true; }
      let used = false;
      try { used = leader(event, () => !!blocked(event) || !allowed()) === true; } catch (error) { console.error(error); }
      if (!used) { held.delete(event.code || event.key); return false; }
      event.stopImmediatePropagation(); event.preventDefault(); held.add(event.code || event.key);
      return true;
    }
    function key(event) {
      if (led(event)) return;
      if (editable(event.target) || editable(document.activeElement)) return;
      const binding = pressed(event);
      if (!binding) return;
      // Own these keys before the stock document handler so a cleared or
      // reassigned key cannot also run the old OHIF binding.
      if (nativePreset(event, binding)) return;
      event.stopImmediatePropagation();
      if (blocked(event)) return;
      if (event.defaultPrevented || !allowed()) return;
      const bindings = getBindings();
      const id = Object.keys(bindings).find(id => bindings[id] === binding);
      if (id && invoke(id)) event.preventDefault();
    }
    const stopNativeCharacter = event => {
      const code = event.code || event.key;
      if (held.has(code)) {
        if (event.type === 'keyup') held.delete(code);
        event.stopImmediatePropagation(); event.preventDefault(); return;
      }
      if (editable(event.target) || editable(document.activeElement)) return;
      const binding = pressed(event);
      if (binding && !nativePreset(event, binding)) event.stopImmediatePropagation();
    };
    // The same decisions as key() above, for a key that is not being pressed: the panel's Space, a tool key (a CT preset
    // digit no tool key uses goes on to the viewer), and the work page's chords this window acts on.
    claimant = ({ key: name, ctrl, alt, shift, meta }) => {
      if (ctrl || alt || meta) return !shift && !meta && workspace({ ctrlKey: ctrl, altKey: alt, code: codeOf(name) }) ? 'workspace' : null;
      if (name === 'space') return !shift && leader?.({ key: ' ' }, () => false, true) === true ? 'leader' : null;
      const binding = shift ? (/^[a-z]$/.test(name) ? 'shift+' + name : null) : /^[a-z0-9]$/.test(name) ? name : null;
      if (!binding) return null;
      if (!Object.values(getBindings()).includes(binding) && !!window.kinCTPresets?.names?.[Number(binding) - 1]) return null;
      return 'tool';
    };
    // F56: the pinned viewer's User Preferences lists its own hotkeys. A binding there that this layer takes first does
    // nothing in this window, so its row says so (and why), and a new press this layer takes is not recorded there; every
    // other binding stays as the viewer shows and edits it. The rows are the table's key fields (HotkeysPreferences:
    // a read-only field in a w-32 column of the modal), whatever the language of their names.
    const fields = () => [...document.querySelectorAll('.ReactModal__Content .w-32 input[readonly]')];
    let notes = 0;
    // The row's note under its field: shown with the reason, hidden when the binding reaches the viewer.
    function say(field, reason) {
      let note = field.dataset.kinHotkeyNote && document.getElementById(field.dataset.kinHotkeyNote);
      if (!reason) { if (note) note.hidden = true; field.removeAttribute('aria-invalid'); return; }
      if (!note) {
        note = document.createElement('span'); note.id = 'kin-hotkey-note-' + ++notes; note.className = 'kin-hotkey-note';
        note.style.cssText = 'display:block;padding:4px 0;text-align:left;font-size:12px;line-height:1.3;color:var(--kin-accent);white-space:normal';
        field.dataset.kinHotkeyNote = note.id; field.setAttribute('aria-describedby', note.id); field.after(note);
      }
      const words = reasons[reason]();
      if (note.textContent !== words) note.textContent = words;
      note.hidden = false; field.setAttribute('aria-invalid', 'true');
    }
    // A refused press keeps its reason shown until the field holds another binding.
    const mark = () => { for (const field of fields()) say(field, claims(field.value) || (field.dataset.kinRefusedAt === field.value ? field.dataset.kinRefused : null)); };
    let marking = 0;
    const remark = () => { clearTimeout(marking); marking = setTimeout(mark, 150); };
    // The viewer's modals open in portals added to the body; only those are watched, not the images' busy DOM.
    const watched = new WeakSet();
    const portals = () => {
      for (const portal of document.querySelectorAll('body > .ReactModal__Portal')) {
        if (watched.has(portal)) continue;
        watched.add(portal); table.observe(portal, { childList: true, subtree: true, attributes: true, attributeFilter: ['value'] });
      }
    };
    const table = new MutationObserver(() => { portals(); remark(); });
    table.observe(document.body, { childList: true }); portals();
    // A press in a key field as the viewer's recorder names it (a letter, a digit, space, an arrow).
    const named = event => event.key === ' ' ? 'space' : /^Digit\d$/.test(event.code || '') ? event.code.slice(5)
      : /^Arrow/.test(event.key || '') ? event.key.slice(5).toLowerCase() : String(event.key || '').toLowerCase();
    const refuse = event => {
      if (!fields().includes(event.target)) return;
      remark();
      if (event.type !== 'keydown') return;
      // A modifier pressed alone is never recorded by itself: the recorder takes the modifiers with the key pressed with
      // them, so a refused Shift+H leaves the binding as it was rather than "shift".
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) { event.stopImmediatePropagation(); return; }
      const reason = claimant({ key: named(event), ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey });
      if (!reason) return;
      // Before the viewer's recorder (a document listener) hears it: the field keeps its binding.
      event.preventDefault(); event.stopImmediatePropagation();
      event.target.dataset.kinRefused = reason; event.target.dataset.kinRefusedAt = event.target.value;
      say(event.target, reason);
    };
    window.addEventListener('keydown', refuse, true);
    window.addEventListener('keyup', refuse, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('keypress', stopNativeCharacter, true);
    window.addEventListener('keyup', stopNativeCharacter, true);
    mark();
    return { dispose() {
      claimant = () => null; table.disconnect(); clearTimeout(marking);
      window.removeEventListener('keydown', refuse, true);
      window.removeEventListener('keyup', refuse, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('keypress', stopNativeCharacter, true);
      window.removeEventListener('keyup', stopNativeCharacter, true);
    } };
  }
  return { defaults, names, defaultBar, current, parse, display, pressed, claims, mount, lead };
})();
