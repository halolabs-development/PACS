'use strict';
// DICOM overlay planes (60xx,3000) on the served viewer's Image Overlay tool. Only a plane the archive sends as a bulk data
// address takes a new way, and only in the form the pinned tool draws in the right place (one frame, the mask from the first
// pixel over the whole image, square pixels, the image upright on the screen): its bits are read once from this origin's
// instance bulk path and must be exactly one frame. Anything else is not drawn for that draw, the tool's shared overlay list
// is left as it is (so the cell's measurements still draw), and planes the pinned tool already reads go its own way.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const CONFIG = fs.readFileSync(path.join(__dirname, '..', 'config', 'ohif.js'), 'utf8');
const part = (from, to) => { const start = CONFIG.indexOf(from), end = CONFIG.indexOf(to, start); assert.ok(start >= 0 && end > start, from); return CONFIG.slice(start, end); };
const SOURCE = part('function kinSameOriginBulk(', '\n// The generic comparison protocol') + part('function kinCreateOverlayPlanes(', "\n// The viewer's route");

const STUDY = '1.2.826.0.1.3680043.8.498.1', SERIES = '1.2.826.0.1.3680043.8.498.2', SOP = '1.2.826.0.1.3680043.8.498.3';
const OVERLAY = `/dicom-web/studies/${STUDY}/series/${SERIES}/instances/${SOP}/bulk/60003000`;
const ROWS = 4, COLUMNS = 8, ONE_FRAME = ROWS * COLUMNS / 8;

// The pinned ImageOverlayViewerTool's reading and drawing (extensions/cornerstone ImageOverlayViewerTool, MIT licence), cut to
// what these cases see: the bits from Value, an array, retrieveBulkData or InlineBinary, else nothing (undefined in the list
// it writes back into the metadata), and a decoder that fails on fewer bytes than the mask needs (as its DataView does).
class PinnedOverlayTool {
  constructor() { this.mode = 'Enabled'; this.drawn = []; }
  getReferencedImageId(viewport) { return viewport?.imageId; }
  async _getCachedStat(imageId, overlayMetadata) {
    if (overlayMetadata.overlays.filter(o => o.pixelData && !o.dataUrl).length === 0) return overlayMetadata;
    overlayMetadata.overlays = await Promise.all(overlayMetadata.overlays.filter(o => o.pixelData).map(async o => {
      let bits = null;
      if (o.pixelData.Value) bits = o.pixelData.Value;
      else if (o.pixelData instanceof Array) bits = o.pixelData[0];
      else if (o.pixelData.retrieveBulkData) bits = await o.pixelData.retrieveBulkData();
      if (!bits) return;
      if (bits.byteLength < Math.ceil(o.rows * o.columns / 8)) throw new RangeError('Offset is outside the bounds of the DataView');
      return { ...o, dataUrl: 'bits:' + [...new Uint8Array(bits)].join(',') };
    }));
    return overlayMetadata;
  }
  _renderOverlay(enabledElement, svg, overlay) { this.drawn.push([enabledElement.viewport.imageId, overlay.dataUrl]); return true; }
}

// One page: its tool class, its archive answers, its image headers, and a cell (upright unless turned).
function viewer({ answer = () => new Response(null, { status: 404 }), headers = {} } = {}) {
  const requests = [], Tool = class extends PinnedOverlayTool {};
  const header = { Rows: ROWS, Columns: COLUMNS, PixelSpacing: [0.7, 0.7], ...headers };
  const window = { cornerstoneTools: { state: { tools: { ImageOverlayViewer: { toolClass: Tool } } } },
    cornerstone: { metaData: { get: (type, id) => type === 'instance' && id ? header : undefined },
      utilities: { imageToWorldCoords: (id, p) => [p[0], p[1], 0] } } };
  const fetch = async (url, init) => { requests.push([url, init.headers.Accept, init.credentials]); return answer(url); };
  const api = new Function('window', 'fetch', 'location', SOURCE + '\nreturn { kinCreateOverlayPlanes };')(
    window, fetch, { href: 'https://viewer.example/ohif/viewer?StudyInstanceUIDs=' + STUDY });
  const extension = api.kinCreateOverlayPlanes();
  extension.preRegistration(); extension.onModeEnter();
  return { requests, extension, Tool, header };
}
const multipart = bytes => new Response(Buffer.concat([Buffer.from('--B1\r\nContent-Type: application/octet-stream\r\n\r\n'), Buffer.from(bytes),
  Buffer.from('\r\n--B1--\r\n')]), { headers: { 'Content-Type': 'multipart/related; type="application/octet-stream"; boundary=B1' } });
const frame = Array.from({ length: ONE_FRAME }, (_, i) => i + 1);
const plane = (over = {}) => ({ rows: ROWS, columns: COLUMNS, x: 1, y: 1, pixelData: { vr: 'OW', BulkDataURI: 'https://localhost:9443' + OVERLAY }, ...over });
const cell = (imageId, at = p => [p[0] * 2, p[1] * 2]) => ({ viewport: { imageId, worldToCanvas: at } });

test('the tool is wrapped once, however often the viewer enters', () => {
  const { extension, Tool } = viewer();
  const read = Tool.prototype._getCachedStat;
  assert.notEqual(read, PinnedOverlayTool.prototype._getCachedStat);
  extension.onModeEnter(); extension.preRegistration();
  assert.equal(Tool.prototype._getCachedStat, read);
});

test('a bulk plane in the allowed form is read once from this origin and drawn; the shared list is left as it is', async () => {
  const { requests, Tool } = viewer({ answer: () => multipart(frame) });
  const tool = new Tool(), metadata = { overlays: [plane()] }, shared = metadata.overlays[0];
  const [first, second] = await Promise.all([tool._getCachedStat('wadors:A', metadata, [255, 0, 0, 255]),
    tool._getCachedStat('wadors:A', metadata, [255, 0, 0, 255])]);
  for (const answer of [first, second, await tool._getCachedStat('wadors:A', metadata, [255, 0, 0, 255])])
    assert.deepEqual(answer.overlays.map(o => [o.dataUrl, o.kinImageId]), [['bits:' + frame.join(','), 'wadors:A']]);
  assert.equal(metadata.overlays[0], shared); assert.equal(shared.dataUrl, undefined); assert.equal(shared.pixelData.Value, undefined);
  assert.deepEqual(requests, [[OVERLAY, 'multipart/related; type="application/octet-stream"', 'same-origin']], 'one read for overlapping draws');
  // A frame of an odd byte count (3 rows of 8) padded to an even length is still one frame.
  const padded = viewer({ answer: () => multipart([1, 2, 3, 0]), headers: { Rows: 3 } });
  assert.equal((await new padded.Tool()._getCachedStat('wadors:A', { overlays: [plane({ rows: 3 })] }, [255, 0, 0, 255])).overlays.length, 1);
});

test('a bulk plane outside the allowed form is not read and not drawn; the shared list stays as it was', async () => {
  const cases = [
    ['multi-frame image', { NumberOfFrames: 2 }, {}],
    ['origin not at the first pixel', {}, { x: 3, y: 3 }],
    ['mask smaller than the image', {}, { rows: 2 }],
    ['pixels not square', { PixelSpacing: [0.7, 1.3] }, {}],
    ['imager spacing not square', { PixelSpacing: undefined, ImagerPixelSpacing: [0.2, 0.1] }, {}],
    ['aspect ratio not square', { PixelSpacing: undefined, PixelAspectRatio: [1, 2] }, {}],
    ['another address shape', {}, { pixelData: { vr: 'OW', BulkDataURI: 'https://elsewhere.example/files/60003000' } }],
  ];
  for (const [name, headers, over] of cases) {
    const { requests, Tool } = viewer({ answer: () => multipart(frame), headers });
    const metadata = { overlays: [plane(over)] }, shared = metadata.overlays[0];
    const answer = await new Tool()._getCachedStat('wadors:A', metadata, [255, 0, 0, 255]);
    assert.deepEqual([answer.overlays, requests], [[], []], name);
    assert.equal(metadata.overlays[0], shared, name);
  }
});

test('a failed, short or long answer draws nothing, keeps the shared list, and is not read again', async () => {
  const cases = [
    ['refused', () => new Response('no', { status: 403 })],
    ['network', () => { throw new TypeError('Failed to fetch'); }],
    ['short', () => multipart(frame.slice(0, ONE_FRAME - 1))],
    ['two frames', () => multipart([...frame, ...frame])],
    // A frame of an even byte count has no padding: one byte more is not one frame.
    ['one byte more than an even frame', () => multipart([...frame, 0])],
  ];
  for (const [name, answer] of cases) {
    const { requests, Tool } = viewer({ answer });
    const tool = new Tool(), metadata = { overlays: [plane()] }, shared = metadata.overlays[0];
    for (let i = 0; i < 2; i++) assert.deepEqual((await tool._getCachedStat('wadors:A', metadata, [255, 0, 0, 255])).overlays, [], name);
    assert.deepEqual([metadata.overlays.length, metadata.overlays[0]], [1, shared], name);
    assert.equal(requests.length, 1, name + ': one read, none again');
  }
});

test('a plane whose header declares more than one overlay frame is not read, even when its bytes would fit one', async () => {
  // A 2 x 4 mask is one byte a frame: its two declared frames are two bytes, which would pass as one frame and its padding.
  for (const declared of [2, [2], new TextEncoder().encode('2 ').buffer]) {
    const { requests, Tool, header } = viewer({ answer: () => multipart([5, 6]), headers: { Rows: 2, Columns: 4 } });
    const o = plane({ rows: 2, columns: 4 });
    Object.assign(header, { '60003000': o.pixelData, '60000015': declared });
    const answer = await new Tool()._getCachedStat('wadors:A', { overlays: [o] }, [255, 0, 0, 255]);
    assert.deepEqual([answer.overlays, requests], [[], []], String(declared));
  }
  // Declared as one frame: read and drawn.
  const { Tool, header } = viewer({ answer: () => multipart([5, 0]), headers: { Rows: 2, Columns: 4 } });
  const o = plane({ rows: 2, columns: 4 });
  Object.assign(header, { '60003000': o.pixelData, '60000015': 1 });
  assert.equal((await new Tool()._getCachedStat('wadors:A', { overlays: [o] }, [255, 0, 0, 255])).overlays.length, 1);
});

test('planes the pinned tool already reads go its own way, unchanged', async () => {
  const { requests, Tool } = viewer({ answer: () => multipart(frame) });
  const metadata = { overlays: [{ rows: ROWS, columns: COLUMNS, x: 3, y: 3, pixelData: { Value: new Uint8Array(frame).buffer } }] };
  const answer = await new Tool()._getCachedStat('wadors:A', metadata, [255, 0, 0, 255]);
  assert.equal(answer, metadata, "the pinned tool's own answer");
  assert.deepEqual([answer.overlays.map(o => o.dataUrl), requests], [['bits:' + frame.join(',')], []]);
  // Its drawing is the pinned tool's too, whatever the cell.
  const tool = new Tool(); tool.mode = 'Disabled';
  assert.equal(tool._renderOverlay(cell('wadors:B', p => [-p[0], p[1]]), {}, answer.overlays[0]), true);
});

test('a read plane is drawn only on its own image, while Image Overlay is on, with the image upright on the screen', async () => {
  const { Tool } = viewer({ answer: () => multipart(frame) });
  const tool = new Tool();
  const [drawn] = (await tool._getCachedStat('wadors:A', { overlays: [plane()] }, [255, 0, 0, 255])).overlays;
  assert.equal(tool._renderOverlay(cell('wadors:B'), {}, drawn), false, 'the cell has moved on to another image');
  assert.equal(tool._renderOverlay(cell('wadors:A', p => [-p[0], p[1]]), {}, drawn), false, 'flipped left to right');
  assert.equal(tool._renderOverlay(cell('wadors:A', p => [p[0], -p[1]]), {}, drawn), false, 'flipped top to bottom');
  assert.equal(tool._renderOverlay(cell('wadors:A', p => [p[1], -p[0]]), {}, drawn), false, 'turned a quarter');
  assert.equal(tool._renderOverlay(cell('wadors:A'), {}, drawn), true);
  tool.mode = 'Disabled';
  assert.equal(tool._renderOverlay(cell('wadors:A'), {}, drawn), false, 'Image Overlay turned off');
  assert.deepEqual(tool.drawn, [['wadors:A', 'bits:' + frame.join(',')]]);
});
