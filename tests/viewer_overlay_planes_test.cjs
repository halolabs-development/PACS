'use strict';
// DICOM overlay planes (60xx,3000) on the served viewer's Image Overlay tool: the bits the archive sends as a bulk data address
// are read from this origin's instance bulk path (the viewer's one bulk read, kinFetchBulk), an overlay whose bits cannot be
// read is left out instead of cached empty, and an overlay is drawn only on its own image while Image Overlay is on.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const CONFIG = fs.readFileSync(path.join(__dirname, '..', 'config', 'ohif.js'), 'utf8');
const part = (from, to) => { const start = CONFIG.indexOf(from), end = CONFIG.indexOf(to, start); assert.ok(start >= 0 && end > start, from); return CONFIG.slice(start, end); };
const SOURCE = part('function kinSameOriginBulk(', '\n// The generic comparison protocol') + part('function kinCreateOverlayPlanes(', "\n// The viewer's route");

const STUDY = '1.2.826.0.1.3680043.8.498.1', SERIES = '1.2.826.0.1.3680043.8.498.2', SOP = '1.2.826.0.1.3680043.8.498.3';
const OVERLAY = `/dicom-web/studies/${STUDY}/series/${SERIES}/instances/${SOP}/bulk/60003000`;

// The pinned ImageOverlayViewerTool's reading and drawing (extensions/cornerstone ImageOverlayViewerTool, MIT licence), cut to
// what these cases see: the bits from Value, an array, retrieveBulkData or InlineBinary, else nothing (undefined in the list).
class PinnedOverlayTool {
  constructor(current) { this.mode = 'Enabled'; this.current = current; this.drawn = []; }
  getReferencedImageId(viewport) { return viewport?.imageId; }
  async _getCachedStat(imageId, overlayMetadata) {
    if (overlayMetadata.overlays.filter(o => o.pixelData && !o.dataUrl).length === 0) return overlayMetadata;
    overlayMetadata.overlays = await Promise.all(overlayMetadata.overlays.filter(o => o.pixelData).map(async o => {
      let bits = null;
      if (o.pixelData.Value) bits = o.pixelData.Value;
      else if (o.pixelData instanceof Array) bits = o.pixelData[0];
      else if (o.pixelData.retrieveBulkData) bits = await o.pixelData.retrieveBulkData();
      if (!bits) return;
      return { ...o, dataUrl: 'bits:' + [...new Uint8Array(bits)].join(',') };
    }));
    return overlayMetadata;
  }
  _renderOverlay(enabledElement, svg, overlay) { this.drawn.push([enabledElement.viewport.imageId, overlay.dataUrl]); return true; }
}

function viewer({ answer = () => new Response(null, { status: 404 }) } = {}) {
  // A fresh tool class per viewer, as each page registers its own.
  const requests = [], Tool = class extends PinnedOverlayTool {};
  const window = { cornerstoneTools: { state: { tools: { ImageOverlayViewer: { toolClass: Tool } } } } };
  const fetch = async (url, init) => { requests.push([url, init.headers.Accept, init.credentials]); return answer(url); };
  const api = new Function('window', 'fetch', 'location', SOURCE + '\nreturn { kinCreateOverlayPlanes, kinFetchBulk };')(
    window, fetch, { href: 'https://viewer.example/ohif/viewer?StudyInstanceUIDs=' + STUDY });
  const extension = api.kinCreateOverlayPlanes();
  extension.preRegistration(); extension.onModeEnter();
  return { requests, extension, api, Tool };
}
// The archive's multipart answer for one element.
const multipart = bytes => new Response(Buffer.concat([Buffer.from('--B1\r\nContent-Type: application/octet-stream\r\n\r\n'), Buffer.from(bytes),
  Buffer.from('\r\n--B1--\r\n')]), { headers: { 'Content-Type': 'multipart/related; type="application/octet-stream"; boundary=B1' } });
const overlayOf = uri => ({ overlays: [{ rows: 2, columns: 4, x: 1, y: 1, pixelData: { vr: 'OW', BulkDataURI: uri } }] });

test('the tool is wrapped once, however often the viewer enters', () => {
  const { extension, Tool } = viewer();
  const read = Tool.prototype._getCachedStat;
  assert.notEqual(read, PinnedOverlayTool.prototype._getCachedStat);
  extension.onModeEnter(); extension.preRegistration();
  assert.equal(Tool.prototype._getCachedStat, read);
});

test('the overlay bits sent as an address are read from this origin and drawn', async () => {
  const { requests, Tool } = viewer({ answer: () => multipart([0x0f, 0x33]) });
  const tool = new Tool();
  for (const written of ['https://localhost:9443' + OVERLAY, 'http://orthanc:8042' + OVERLAY, OVERLAY]) {
    const metadata = overlayOf(written);
    const answer = await tool._getCachedStat('wadors:A', metadata, [255, 0, 0, 255]);
    assert.deepEqual(answer.overlays.map(o => [o.dataUrl, o.kinImageId]), [['bits:15,51', 'wadors:A']]);
    // Kept with the element: the next draw does not read it again.
    assert.ok(metadata.overlays[0].pixelData.Value instanceof ArrayBuffer || answer.overlays[0].pixelData.Value instanceof ArrayBuffer);
  }
  assert.deepEqual(requests.map(r => r[0]), [OVERLAY, OVERLAY, OVERLAY]);
  assert.deepEqual([...new Set(requests.map(r => r[1]))], ['multipart/related; type="application/octet-stream"']);
  assert.deepEqual([...new Set(requests.map(r => r[2]))], ['same-origin']);
});

test('bits that cannot be read leave the overlay out instead of an empty one in the list', async () => {
  const cases = [
    ['refused', () => new Response('no', { status: 403 })],
    ['network', () => { throw new TypeError('Failed to fetch'); }],
    ['empty', () => multipart([])],
  ];
  for (const [name, answer] of cases) {
    const { Tool } = viewer({ answer });
    const answered = await new Tool()._getCachedStat('wadors:A', overlayOf('https://localhost:9443' + OVERLAY), [255, 0, 0, 255]);
    assert.deepEqual(answered.overlays, [], name);
  }
  // Another address shape (not this archive's instance bulk path) is not requested at all.
  const { requests, Tool } = viewer({ answer: () => multipart([1]) });
  const other = await new Tool()._getCachedStat('wadors:A', overlayOf('https://elsewhere.example/files/60003000'), [255, 0, 0, 255]);
  assert.deepEqual([other.overlays, requests], [[], []]);
});

test('bits already in the metadata are used as they are, without a request', async () => {
  const { requests, Tool } = viewer({ answer: () => multipart([9]) });
  const metadata = { overlays: [{ rows: 1, columns: 8, pixelData: { Value: new Uint8Array([7]).buffer } }] };
  const answer = await new Tool()._getCachedStat('wadors:A', metadata, [255, 0, 0, 255]);
  assert.deepEqual([answer.overlays.map(o => o.dataUrl), requests], [['bits:7'], []]);
});

test('an overlay is drawn only on its own image and only while Image Overlay is on', async () => {
  const { Tool } = viewer({ answer: () => multipart([1, 2]) });
  const tool = new Tool();
  const [overlay] = (await tool._getCachedStat('wadors:A', overlayOf(OVERLAY), [255, 0, 0, 255])).overlays;
  // The cell has moved on to image B by the time A's bits arrive: nothing of A is drawn there.
  assert.equal(tool._renderOverlay({ viewport: { imageId: 'wadors:B' } }, {}, overlay), false);
  assert.equal(tool._renderOverlay({ viewport: { imageId: 'wadors:A' } }, {}, overlay), true);
  tool.mode = 'Disabled';
  assert.equal(tool._renderOverlay({ viewport: { imageId: 'wadors:A' } }, {}, overlay), false);
  assert.deepEqual(tool.drawn, [['wadors:A', 'bits:1,2']]);
});
