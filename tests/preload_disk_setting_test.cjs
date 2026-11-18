// REQ-MG-PRELOAD-CACHE: the site's preload disk cap (KIN_PRELOAD_DISK_GB) is one rule, read by /api/me, the API's
// startup log and the installation check. A stack built without it keeps preload off; the operator must be able to see why.
const test = require('node:test'), assert = require('node:assert/strict');
require('./service_test_loader.cjs');
const { preloadDiskGb, preloadDiskStartupNotice } = require('../api/src/preload-disk-setting.ts');

test('a positive GiB number is the cap; empty, missing, zero, negative, text and too large are no cap', () => {
  assert.equal(preloadDiskGb({ KIN_PRELOAD_DISK_GB: '20' }), 20);
  assert.equal(preloadDiskGb({ KIN_PRELOAD_DISK_GB: ' 0.25 ' }), 0.25);
  for (const raw of [undefined, '', '   ', '0', '-1', 'change-me', 'NaN', 'Infinity', '1e400', String(2 ** 53), '1e-12'])
    assert.equal(preloadDiskGb({ KIN_PRELOAD_DISK_GB: raw }), null, String(raw));
});

test('the server accepts exactly the caps the reading PC turns into a budget', () => {
  const { budgetFor } = require('../worklist-v0/hpacs-lite/preload-store.js');
  for (const raw of ['20', '0.25', '1e-9', '1e-10', '1e-12', '0', '-1', '1e400', String(2 ** 23), String(2 ** 24)]) {
    const gb = preloadDiskGb({ KIN_PRELOAD_DISK_GB: raw });
    assert.equal(gb !== null, budgetFor(Number(raw)) !== null, raw);
  }
});

test('the startup log says nothing when the cap is set', () => {
  assert.equal(preloadDiskStartupNotice({ KIN_PRELOAD_DISK_GB: '20' }), null);
});

test('the startup log names the missing setting, its effect and the guide, and never echoes a value', () => {
  const unset = preloadDiskStartupNotice({});
  assert.equal(preloadDiskStartupNotice({ KIN_PRELOAD_DISK_GB: '' }), unset);
  const invalid = preloadDiskStartupNotice({ KIN_PRELOAD_DISK_GB: 'change-me' });
  for (const line of [unset, invalid]) {
    assert.match(line, /KIN_PRELOAD_DISK_GB/);
    assert.match(line, /Preload/);
    assert.match(line, /docs\/ops\/preload-cache\.md/);
    assert.doesNotMatch(line, /change-me/);
  }
  assert.notEqual(unset, invalid, 'a wrong value and a missing value are told apart');
});

test('the env example lists the cap as a value the site must replace, so a copied example keeps preload off and says so', () => {
  const fs = require('node:fs'), path = require('node:path');
  const lines = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8').split(/\r?\n/);
  const entries = lines.map(line => line.trim()).filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => line.split('=', 2)).filter(([name]) => name.trim() === 'KIN_PRELOAD_DISK_GB');
  assert.equal(entries.length, 1, 'one uncommented KIN_PRELOAD_DISK_GB line');
  const env = { KIN_PRELOAD_DISK_GB: entries[0][1] };
  assert.match(entries[0][1], /^change-me/);
  assert.equal(preloadDiskGb(env), null);
  assert.notEqual(preloadDiskStartupNotice(env), null);
});
