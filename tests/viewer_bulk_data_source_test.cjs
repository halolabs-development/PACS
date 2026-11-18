'use strict';
// The viewer's DICOMweb data source as the Orthanc viewer plugin sets it after config/ohif.js: bulk data addresses (DICOM
// overlay planes among them) are turned on, bulk data is no longer asked for as single part (PDF and video still are), and an
// address of this archive's instance bulk data resolves under the data source's own root, on this origin.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const CONFIG = fs.readFileSync(path.join(__dirname, '..', 'config', 'ohif.js'), 'utf8');
// What the Orthanc viewer plugin appends to the configured app-config (captured from the synthetic stack, kept with the studio).
const { OHIF_DATASOURCE_SUFFIX } = require('../tools/minhoon-studio/server/static.js');

// The part of config/ohif.js that sets window.config.dataSources, run on its own beside a stand-in window.config.
const START = CONFIG.indexOf('function kinBulkDataSources(');
const END = CONFIG.indexOf('})(window.config);', START) + '})(window.config);'.length;
function served(suffix = OHIF_DATASOURCE_SUFFIX) {
  const window = { config: { extensions: [], modes: [] } };
  new Function('window', CONFIG.slice(START, END) + '\n' + suffix)(window);
  return window.config;
}

// fixBulkDataURI of the pinned OHIF default extension (extensions/default/src/DicomWebDataSource/utils/fixBulkDataURI.ts,
// MIT licence), as the data source runs it on every element with a bulk data address once bulkDataURI.enabled is set.
function fixBulkDataURI(value, instance, dicomWebConfig) {
  let { BulkDataURI } = value;
  const { bulkDataURI: uriConfig = {} } = dicomWebConfig;
  BulkDataURI = uriConfig.transform?.(BulkDataURI) || BulkDataURI;
  const { startsWith, prefixWith = '' } = uriConfig;
  if (startsWith && BulkDataURI.startsWith(startsWith)) {
    BulkDataURI = prefixWith + BulkDataURI.substring(startsWith.length);
    value.BulkDataURI = BulkDataURI;
  }
  if (!BulkDataURI.startsWith('http') && !value.BulkDataURI.startsWith('/')) {
    const { StudyInstanceUID, SeriesInstanceUID } = instance;
    const isInstanceStart = BulkDataURI.startsWith('instances/') || BulkDataURI.startsWith('../');
    if (BulkDataURI.startsWith('series/') || BulkDataURI.startsWith('bulkdata/') || uriConfig.relativeResolution === 'studies' && !isInstanceStart) {
      value.BulkDataURI = `${dicomWebConfig.wadoRoot}/studies/${StudyInstanceUID}/${BulkDataURI}`;
    } else if (isInstanceStart || uriConfig.relativeResolution === 'series' || !uriConfig.relativeResolution) {
      value.BulkDataURI = `${dicomWebConfig.wadoRoot}/studies/${StudyInstanceUID}/series/${SeriesInstanceUID}/${BulkDataURI}`;
    }
    return;
  }
  if (BulkDataURI[0] === '/') {
    if (dicomWebConfig.wadoRoot.startsWith('http')) value.BulkDataURI = `${new URL(dicomWebConfig.wadoRoot).origin}${BulkDataURI}`;
  }
}

const STUDY = '1.2.826.0.1.3680043.8.498.1', SERIES = '1.2.826.0.1.3680043.8.498.2', SOP = '1.2.826.0.1.3680043.8.498.3';
const OVERLAY = `/dicom-web/studies/${STUDY}/series/${SERIES}/instances/${SOP}/bulk/60003000`;
// Where the viewer page is (/ohif/viewer): the data source root '../dicom-web' is this origin's /dicom-web.
const resolved = uri => new URL(uri, 'https://viewer.example/ohif/viewer?StudyInstanceUIDs=' + STUDY).href;

test('the plugin block is taken with bulk data addresses on and bulk data read multipart', () => {
  const [source] = served().dataSources;
  const c = source.configuration;
  assert.equal(c.bulkDataURI.enabled, true);
  assert.equal(c.singlepart, 'pdf,video');
  assert.equal(typeof c.bulkDataURI.transform, 'function');
  // Everything else of the plugin's block is as it sent it.
  for (const [key, value] of Object.entries({ name: 'orthanc', wadoUriRoot: '../dicom-web', qidoRoot: '../dicom-web', wadoRoot: '../dicom-web',
    imageRendering: 'wadors', thumbnailRendering: 'wadors', enableStudyLazyLoad: true, staticWado: true }))
    assert.deepEqual(c[key], value, key);
  assert.equal(source.sourceName, 'dicomweb');
  assert.equal(source.namespace, '@ohif/extension-default.dataSourcesModule.dicomweb');
});

test('an overlay plane address of this archive resolves on this origin, whatever origin the archive wrote', () => {
  const { configuration } = served().dataSources[0];
  for (const written of ['https://localhost:9443' + OVERLAY, 'https://pacs.example:443' + OVERLAY, 'http://orthanc:8042' + OVERLAY, OVERLAY]) {
    const value = { vr: 'OW', BulkDataURI: written };
    fixBulkDataURI(value, { StudyInstanceUID: STUDY, SeriesInstanceUID: SERIES }, configuration);
    assert.equal(resolved(value.BulkDataURI), 'https://viewer.example' + OVERLAY, written);
  }
});

test('an address of another shape is left as the archive wrote it', () => {
  const { transform } = served().dataSources[0].configuration.bulkDataURI;
  for (const other of [`https://elsewhere.example/other/studies/${STUDY}/bulk/60003000`, `${OVERLAY}?x=1`, 'series/1/instances/2/bulk/7fe00010',
    `https://localhost:9443/dicom-web/studies/${STUDY}/series/${SERIES}/instances/${SOP}/frames/1`, '', undefined])
    assert.equal(transform(other), other);
});

test('another assignment of the data sources is taken the same way, and a source of another kind is left alone', () => {
  const config = served();
  const dicomJson = { namespace: '@ohif/extension-default.dataSourcesModule.dicomjson', sourceName: 'dicomjson', configuration: { singlepart: 'bulkdata' } };
  config.dataSources = [dicomJson, { namespace: '@ohif/extension-default.dataSourcesModule.dicomweb', sourceName: 'second',
    configuration: { wadoRoot: '/dicom-web', singlepart: 'bulkdata', bulkDataURI: { relativeResolution: 'series' } } }];
  assert.equal(config.dataSources[0], dicomJson);
  assert.deepEqual(config.dataSources[1].configuration.singlepart, '');
  assert.equal(config.dataSources[1].configuration.bulkDataURI.enabled, true);
  assert.equal(config.dataSources[1].configuration.bulkDataURI.relativeResolution, 'series');
  // The page's copy of the configuration (OHIF spreads window.config) keeps the adjusted sources.
  assert.equal({ ...config }.dataSources, config.dataSources);
});

test('without the plugin block nothing is invented', () => {
  assert.equal(served('').dataSources, undefined);
});
