// The pinned viewer's stack SOP class handler (OHIF 3.9.1 extension-default getSopClassHandlerModule) with the
// cornerstone 4D detection it attaches to each display set (getDynamicVolumeInfo -> splitImageIdsBy4DTags):
// positions grouped by ImagePositionPatient, equal image count per position, then the first tag whose K values
// differ within every position and form the same set at every position. Groups are in ascending tag value order.
'use strict';
const STACK = '@ohif/extension-default.sopClassHandlerModule.stack';
const TAGS = ['TemporalPositionIdentifier', 'DiffusionBValue', 'TriggerTime', 'EchoTime', 'EchoNumber'];

class ImageSet {
  constructor(images) {
    Object.defineProperty(this, 'images', { enumerable: false, configurable: false, writable: false, value: images });
    this.instances = images; this.instance = images[0];
  }
  setAttribute(key, value) { this[key] = value; }
  setAttributes(attributes) { Object.assign(this, attributes); }
}

function dynamicVolumeInfo(instances) {
  const single = { isDynamicVolume: false, timePoints: [instances.map(i => i.imageId)], splittingTag: null };
  if (!instances.every(i => Array.isArray(i.ImagePositionPatient))) return single;
  const positions = new Map();
  for (const i of instances) {
    const key = String(i.ImagePositionPatient);
    positions.set(key, [...(positions.get(key) || []), i]);
  }
  const groups = [...positions.values()], count = groups[0].length;
  if (count === 1 || !groups.every(g => g.length === count)) return single;
  for (const tag of TAGS) {
    const frames = new Map();
    let first = null, valid = true;
    for (const group of groups) {
      const values = new Set();
      for (const instance of group) {
        const value = parseFloat(instance[tag]) || 0;
        frames.set(value, [...(frames.get(value) || []), instance.imageId]);
        values.add(value);
      }
      if (values.size !== group.length) { valid = false; break; }
      if (!first) first = values;
      else if (first.size !== values.size || ![...first].every(v => values.has(v))) { valid = false; break; }
    }
    if (!valid) continue;
    const timePoints = [...frames.keys()].sort((a, b) => a - b).map(k => frames.get(k));
    return { isDynamicVolume: timePoints.length > 1, timePoints, splittingTag: tag };
  }
  return single;
}

let uid = 0;
function makeDisplaySet(instances) {
  const set = new ImageSet(instances), instance = instances[0], info = dynamicVolumeInfo(instances);
  set.setAttributes({ displaySetInstanceUID: 'ds-' + ++uid, SeriesInstanceUID: instance.SeriesInstanceUID,
    StudyInstanceUID: instance.StudyInstanceUID, SeriesNumber: instance.SeriesNumber || 0, FrameRate: instance.FrameTime,
    SeriesDescription: instance.SeriesDescription || '', Modality: instance.Modality, isMultiFrame: instance.NumberOfFrames > 1,
    numImageFrames: instances.length, SOPClassHandlerId: STACK, isDynamicVolume: info.isDynamicVolume, dynamicVolumeInfo: info });
  set.images.sort((a, b) => (parseInt(a.InstanceNumber) || 0) - (parseInt(b.InstanceNumber) || 0));
  return set;
}

function createStackHandler() {
  return {
    sopClassUids: [],
    getDisplaySetsFromSeries(instances) {
      if (!instances || !instances.length) throw new Error('No instances were provided');
      const sets = [], stackable = [];
      for (const instance of instances) {
        if (instance.NumberOfFrames > 1 || ['CR', 'MG', 'DX'].includes(instance.Modality)) sets.push(makeDisplaySet([instance]));
        else stackable.push(instance);
      }
      if (stackable.length) sets.push(makeDisplaySet(stackable));
      return sets;
    },
  };
}

// One MR series holding `values.length` time points of `positions` axial slices, stored position by position.
function mixedSeries({ tag = 'DiffusionBValue', values = [0, 1000], positions = 12, modality = 'MR', description = 'AX DWI',
  series = '2.25.7001', patch = () => {} } = {}) {
  const instances = [];
  let number = 0;
  for (let p = 0; p < positions; p++) for (const value of values) {
    number++;
    const instance = { imageId: `wadors:/series/${series}/instances/${series}.${number}/frames/1`,
      SOPInstanceUID: `${series}.${number}`, SeriesInstanceUID: series, StudyInstanceUID: '2.25.7000',
      SOPClassUID: '1.2.840.10008.5.1.4.1.1.4', Modality: modality, SeriesNumber: 5, SeriesDescription: description,
      InstanceNumber: number, ImagePositionPatient: [0, 0, p * 4], ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
      FrameOfReferenceUID: '2.25.7002', [tag]: value };
    patch(instance, p, value);
    instances.push(instance);
  }
  return instances;
}

// One enhanced (multi-frame) MR instance as the pinned DICOMweb data source stores it (naturalized): `values.length`
// time points of `positions` axial frames in one file, the value of each frame in `group`'s per-frame functional group
// (Frame Content Sequence's Temporal Position Index by default), the frame's position in its Plane Position Sequence and
// the orientation shared. Frames are stored time point by time point unless `order` gives another frame order.
function enhancedSeries({ values = [1, 2], positions = 4, group = 'FrameContentSequence', tag = 'TemporalPositionIndex',
  shared = false, sop = '2.25.8001.1', series = '2.25.8001', description = 'DYN T1 ENH', modality = 'MR',
  sopClass = '1.2.840.10008.5.1.4.1.1.4.1', order = null, patch = () => {} } = {}) {
  let frames = [];
  for (const value of values) for (let p = 0; p < positions; p++) frames.push({ value, p });
  if (order) frames = order(frames);
  const PerFrameFunctionalGroupsSequence = frames.map(({ value, p }) => {
    const item = { PlanePositionSequence: [{ ImagePositionPatient: [0, 0, p * 4] }],
      FrameContentSequence: [{ InStackPositionNumber: p + 1, StackID: '1' }] };
    if (!shared) item[group] = [{ ...(item[group]?.[0] || {}), [tag]: value }];
    return item;
  });
  const SharedFunctionalGroupsSequence = [{ PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
    PixelMeasuresSequence: [{ PixelSpacing: [1, 1], SliceThickness: 4 }], ...(shared ? { [group]: [{ [tag]: values[0] }] } : {}) }];
  const instance = { imageId: `wadors:/studies/2.25.7000/series/${series}/instances/${sop}/frames/1`,
    SOPInstanceUID: sop, SeriesInstanceUID: series, StudyInstanceUID: '2.25.7000', SOPClassUID: sopClass, Modality: modality,
    SeriesNumber: 9, SeriesDescription: description, InstanceNumber: 1, NumberOfFrames: frames.length, Rows: 64, Columns: 64,
    FrameOfReferenceUID: '2.25.7002', PerFrameFunctionalGroupsSequence, SharedFunctionalGroupsSequence };
  patch(instance, frames);
  return [instance];
}
// The imageId the pinned DICOMweb data source gives frame `frame` of an instance (getImageIdsForInstance({ instance, frame })).
const frameImageId = (instance, frame) => instance.imageId.replace(/\/frames\/\d+$/, '/frames/' + frame);

module.exports = { STACK, ImageSet, createStackHandler, mixedSeries, enhancedSeries, frameImageId };
