
// One MR series that holds several time points at the same positions (b values, temporal positions, trigger or echo
// times, echo numbers) opens as one display set per time point, so each can sit in its own cell and Image Slice Sync
// can match positions. A classic series (one file per image) is grouped by the viewer's own 4D detection; an enhanced
// series (one multi-frame file) by the same rule applied to its frames' functional groups. Anything not recognised,
// and every other series, keeps the display sets the stack handler made.
// The frame an entry of a split part stands for (an own property, so the stored multi-frame instance it is made from,
// which the viewer marks with the frame it last read, never counts as one frame).
function kinSeriesSplitFrame(image) {
  const frame = image && Object.prototype.hasOwnProperty.call(image, 'kinSplitFrame') ? image.kinSplitFrame : null;
  return Number.isSafeInteger(frame) && frame >= 1 ? frame : null;
}
// Whether a display set shows the image `sop` frame `frame`: a whole instance shows all its frames, a split part only
// the frames it was given. Every place that looks for the display set of a saved or cited image asks this.
function kinSeriesSplitHolds(set, sop, frame) {
  const images = Array.isArray(set?.images) ? set.images : Array.isArray(set?.instances) ? set.instances : [];
  return images.some(image => {
    if (image?.SOPInstanceUID !== sop) return false;
    const own = kinSeriesSplitFrame(image);
    return own === null || own === frame;
  });
}
// The identity of one entry of a display set: its SOP Instance UID, and for an entry of a split part also its frame
// (several entries of one part share a SOP). Checks that an entry appears once compare these keys.
function kinSeriesSplitKey(image) {
  const frame = kinSeriesSplitFrame(image);
  return frame === null ? image?.SOPInstanceUID : image?.SOPInstanceUID + ':' + frame;
}
// Whether a display set is a split part of one multi-frame file: an ordinary stack of single frames, not a multi-frame
// image to fold or unfold, even though each frame's metadata still names the whole file's frame count.
function kinSeriesSplitPart(set) {
  const images = Array.isArray(set?.images) ? set.images : [];
  return images.length > 0 && images.every(image => kinSeriesSplitFrame(image) !== null);
}

// The frames of one enhanced (multi-frame) MR instance grouped by time point, on the viewer's 4D rule
// (cornerstone splitImageIdsBy4DTags): frames grouped by position, the same count (more than one) at every position,
// then the first value, in the viewer's order, that differs between the frames of each position and forms the same
// set at every position; a frame without the value counts as 0; groups in ascending value order. The value of a frame
// is read from its per-frame functional group, else the shared one (DICOM PS3.3 C.7.6.16.2.2 Frame Content: Temporal
// Position Index; C.8.13.5.9 MR Diffusion: Diffusion b-value; C.7.6.16.2.7 Cardiac Synchronization: Nominal Cardiac
// Trigger Delay Time; C.8.13.5.4 MR Echo: Effective Echo Time; C.7.6.16.2.3/4 Plane Position/Orientation). The stored
// instance's own top-level values are not used: the viewer overwrites them with whichever frame it read last.
// Returns null when the frames do not form such groups.
function kinEnhancedTimePoints(instance) {
  const TAGS = [['FrameContentSequence', 'TemporalPositionIndex'], ['MRDiffusionSequence', 'DiffusionBValue'],
    ['CardiacSynchronizationSequence', 'NominalCardiacTriggerDelayTime'], ['MREchoSequence', 'EffectiveEchoTime']];
  const count = Number(instance?.NumberOfFrames), perFrame = instance?.PerFrameFunctionalGroupsSequence;
  if (!Number.isSafeInteger(count) || count < 2 || !Array.isArray(perFrame) || perFrame.length !== count) return null;
  const item = sequence => Array.isArray(sequence) ? sequence[0] : sequence && typeof sequence === 'object' ? sequence : undefined;
  const shared = item(instance.SharedFunctionalGroupsSequence);
  const read = (frame, group, key) => {
    for (const groups of [perFrame[frame], shared]) {
      const found = item(groups?.[group]);
      if (found && found[key] !== undefined) return found[key];
    }
    return undefined;
  };
  const vector = (value, length) => {
    const list = Array.isArray(value) ? value.map(Number) : [];
    return list.length === length && list.every(Number.isFinite) ? list : null;
  };
  const frames = [];
  for (let k = 0; k < count; k++) {
    const position = vector(read(k, 'PlanePositionSequence', 'ImagePositionPatient'), 3);
    if (!position) return null;
    frames.push({ frame: k + 1, position, orientation: vector(read(k, 'PlaneOrientationSequence', 'ImageOrientationPatient'), 6) });
  }
  const positions = new Map();
  for (const f of frames) {
    const key = f.position.join(',');
    positions.set(key, [...(positions.get(key) || []), f]);
  }
  const atPosition = [...positions.values()], size = atPosition[0].length;
  if (size < 2 || !atPosition.every(list => list.length === size)) return null;
  for (const [group, tag] of TAGS) {
    const of = f => { const raw = read(f.frame - 1, group, tag); const n = parseFloat(Array.isArray(raw) ? raw[0] : raw); return { raw, n: n || 0 }; };
    let first = null, valid = true;
    for (const list of atPosition) {
      const values = new Set(list.map(f => of(f).n));
      if (values.size !== list.length || first && (first.size !== values.size || ![...first].every(v => values.has(v)))) { valid = false; break; }
      first = first || values;
    }
    if (!valid) continue;
    const groups = new Map();
    for (const f of frames) {
      const { raw, n } = of(f);
      groups.set(n, [...(groups.get(n) || []), { ...f, tag, value: raw }]);
    }
    return { splittingTag: tag, timePoints: [...groups.keys()].sort((a, b) => a - b).map(n => groups.get(n)) };
  }
  return null;
}

// `frameImageId(instance, frame)` is the data source's own imageId for one frame of an instance; without it an enhanced
// series is not split.
function kinSeriesSplitModel(sets, rebuild, frameImageId) {
  // The label of a part names the value it was split by (a classic image's element, or an enhanced frame's).
  const LABELS = { DiffusionBValue: 'b', TemporalPositionIdentifier: 'Phase ', TemporalPositionIndex: 'Phase ',
    EchoTime: 'TE ', EffectiveEchoTime: 'TE ', EchoNumber: 'Echo ', TriggerTime: 'TT ', NominalCardiacTriggerDelayTime: 'TT ' };
  if (!Array.isArray(sets) || sets.length !== 1) return sets;
  const set = sets[0], images = set?.images;
  if (set?.Modality !== 'MR' || !Array.isArray(images)) return sets;
  let groups, tag;
  if (set.isMultiFrame === true) {
    // One enhanced file: each frame becomes an entry of its own, the instance's values with that frame's functional
    // groups laid over them (shared, then per-frame, as the viewer's own frame metadata does), named by the data
    // source's imageId of that frame.
    if (images.length !== 1 || typeof frameImageId !== 'function') return sets;
    const instance = images[0], found = kinEnhancedTimePoints(instance);
    if (!found || found.timePoints.length < 2) return sets;
    tag = found.splittingTag;
    const items = groups => Object.values(groups || {}).map(v => Array.isArray(v) ? v[0] : v).filter(v => v && typeof v === 'object');
    const sharedItems = items(Array.isArray(instance.SharedFunctionalGroupsSequence) ? instance.SharedFunctionalGroupsSequence[0] : null);
    try {
      groups = found.timePoints.map(list => list.map(f => {
        const imageId = frameImageId(instance, f.frame);
        if (typeof imageId !== 'string' || !imageId) throw new Error('no frame image');
        const entry = Object.assign({}, instance);
        for (const values of [...sharedItems, ...items(instance.PerFrameFunctionalGroupsSequence[f.frame - 1])]) Object.assign(entry, values);
        Object.assign(entry, { imageId, NumberOfFrames: 1, frameNumber: f.frame, kinSplitFrame: f.frame,
          ImagePositionPatient: f.position, ...(f.orientation ? { ImageOrientationPatient: f.orientation } : {}) });
        // The label reads the value the frame really carries; a frame without it shows no value, as a classic image.
        entry[tag] = f.value;
        return entry;
      }));
    } catch (_) {
      return sets;
    }
    if (new Set(groups.flat().map(e => e.imageId)).size !== instance.NumberOfFrames) return sets;
  } else {
    const info = set.dynamicVolumeInfo, timePoints = info?.timePoints;
    if (set.isDynamicVolume !== true || !Array.isArray(timePoints) || timePoints.length < 2) return sets;
    // Every group must name images of this set, each image exactly once, and the groups must be equally long.
    const byId = new Map(images.map(image => [image?.imageId, image])), seen = new Set();
    if (byId.size !== images.length || byId.has(undefined)) return sets;
    const size = Array.isArray(timePoints[0]) ? timePoints[0].length : 0;
    groups = [];
    for (const group of timePoints) {
      if (!Array.isArray(group) || group.length !== size || size < 1) return sets;
      const list = [];
      for (const id of group) {
        if (!byId.has(id) || seen.has(id)) return sets;
        seen.add(id); list.push(byId.get(id));
      }
      groups.push(list);
    }
    if (seen.size !== images.length) return sets;
    tag = info.splittingTag;
  }
  const value = instance => {
    const prefix = LABELS[tag];
    if (prefix === undefined || !instance) return '';
    let raw = instance[tag];
    if (raw === undefined && tag === 'EchoNumber') raw = instance.EchoNumbers;
    if (Array.isArray(raw)) raw = raw[0];
    const number = typeof raw === 'number' || typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    return Number.isFinite(number) ? ' ' + prefix + number : '';
  };
  const description = String(set.SeriesDescription ?? '').trim();
  const split = [];
  try {
    for (let k = 0; k < groups.length; k++) {
      const made = rebuild(groups[k].slice());
      if (!Array.isArray(made) || made.length !== 1 || made[0]?.images?.length !== groups[k].length) return sets;
      // A rebuilt part shows exactly the entries it was given (an enhanced part: its frames, in frame order).
      if (set.isMultiFrame === true && !groups[k].every((entry, i) => made[0].images[i] === entry)) return sets;
      const part = made[0], label = `${k + 1}/${groups.length}` + value(part.images[0]);
      const text = description ? `${description} · ${label}` : label;
      if (typeof part.setAttribute === 'function') part.setAttribute('SeriesDescription', text);
      else part.SeriesDescription = text;
      split.push(part);
    }
  } catch (_) {
    return sets;
  }
  return split;
}

function kinCreateSeriesSplit() {
  let extensions, dispose;
  function mount() {
    dispose?.();
    dispose = null;
    const handler = extensions.getModuleEntry('@ohif/extension-default.sopClassHandlerModule.stack');
    const previous = typeof handler?.getDisplaySetsFromSeries === 'function' ? handler.getDisplaySetsFromSeries : null;
    if (!previous) return;
    let ended = false;
    // The imageId the active data source gives one frame: the same one the unsplit file's display set uses.
    const frameImageId = (instance, frame) => {
      const source = extensions.getActiveDataSource?.()?.[0];
      return typeof source?.getImageIdsForInstance === 'function' ? source.getImageIdsForInstance({ instance, frame }) : undefined;
    };
    const createDisplaySets = function (instances, ...rest) {
      const sets = previous.call(this, instances, ...rest);
      // A hook left inside the chain after its mode ended passes the sets on unchanged.
      if (ended) return sets;
      return kinSeriesSplitModel(sets, members => previous.call(this, members, ...rest), frameImageId);
    };
    handler.getDisplaySetsFromSeries = createDisplaySets;
    dispose = () => {
      ended = true;
      if (handler.getDisplaySetsFromSeries === createDisplaySets) handler.getDisplaySetsFromSeries = previous;
    };
  }
  return { id: 'kin.series-split', preRegistration({ extensionManager }) { extensions = extensionManager; },
    onModeEnter: mount, onModeExit() { dispose?.(); dispose = null; } };
}
