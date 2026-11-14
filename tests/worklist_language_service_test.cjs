'use strict';
// Screen language in the account appearance (version 12): the service checks the stored form, keeps it, and an older
// client cannot erase it. Runs on the TypeScript sources (service_test_loader) or /app/dist in the API image.
const test = require('node:test'), assert = require('node:assert/strict');
if (!require('node:fs').existsSync('/app/dist/pacs')) require('./service_test_loader.cjs');
const { PacsService } = require('/app/dist/pacs.service');

const clone = v => structuredClone(v);
function appearanceFixture() {
  let rows = new Map();
  const key = o => JSON.stringify([o.institution, o.subject]);
  const table = store => ({
    async findUnique({ where }) { return clone(store.get(key(where.institution_subject)) ?? null); },
    async create({ data }) { if (store.has(key(data))) throw Object.assign(Error('unique'), { code: 'P2002' }); store.set(key(data), clone(data)); return clone(data); },
    async updateMany({ where, data }) {
      const row = store.get(key(where));
      const stored = where.OR.some(c => c.sizes.path.join() === 'version' && row?.sizes?.version === c.sizes.equals);
      if (!row || row.revision !== where.revision || !stored) return { count: 0 };
      store.set(key(where), { ...row, sizes: clone(data.sizes), revision: row.revision + data.revision.increment }); return { count: 1 };
    },
  });
  const prisma = { readingAppearance: { findUnique: a => table(rows).findUnique(a) },
    async $transaction(run) { const pending = clone(rows); const result = await run({ readingAppearance: table(pending) }); rows = pending; return result; } };
  return { service: new PacsService(prisma, {}, {}, {}, {}), snapshot: () => clone(rows) };
}
const caller = { kind: 'member', institution: 'synthetic-a', sub: 'reader-a', actor: 'reader@synthetic.test', roles: ['radiologist'] };
const owner = [caller.institution, caller.sub];
const profile = color => ({ size: 12, font: 'default', color, name: true, date: true, description: false, position: 'top-right',
  fieldPositions: { name: 'top-right', date: 'top-right', description: 'top-right' }, overrides: {} });
const v11 = () => ({ version: 11, list: 12, current: 14, prior: 12, fonts: { version: 1, list: 'default', current: 'sans', prior: 'default' },
  colors: { version: 1, list: 'default', current: 'default', prior: 'warm' }, dock: { version: 2, placement: 'bottom', panel: -1, autoHide: false },
  viewer: { version: 3, current: profile('default'), prior: profile('warm') },
  toolbar: { version: 1, order: ['MeasurementTools', 'Zoom', 'Pan', 'TrackballRotate', 'WindowLevel', 'Capture', 'Layout', 'Crosshairs', 'MoreTools'], hidden: [] },
  mpr: { version: 1, progressive: false, display: { autoHideCrosshair: false, cube: true, demographics: true, orientation: true, sample: true, scale: true, thickness: true, windowing: true, zoom: true },
    mouse: { left: 'WindowLevel', middle: 'Pan', right: 'Zoom' }, sync: { windowing: true, zoom: false } },
  markers: { version: 2, color: 'default', width: 'standard', line: 'default', arrowheads: 'on', font: 'default' } });
const v12 = (language = { version: 1, worklist: 'ko', reading: null }) => ({ ...v11(), version: 12, language });
const status = code => e => e.getStatus?.() === code;
const save = (f, sizes, revision) => f.service.saveReadingAppearance({ expectedOwner: owner, revision, sizes }, caller);

test('version 12 keeps each screen language (or none) and gives it back', async () => {
  const f = appearanceFixture();
  const first = await save(f, v12(), 0);
  assert.deepEqual(first.sizes.language, { version: 1, worklist: 'ko', reading: null });
  assert.deepEqual((await f.service.readingAppearance(caller)).sizes, v12());
  const both = await save(f, v12({ version: 1, worklist: 'en', reading: 'en' }), first.revision);
  assert.deepEqual(both.sizes.language, { version: 1, worklist: 'en', reading: 'en' });
  const none = await save(f, v12({ version: 1, worklist: null, reading: null }), both.revision);
  assert.deepEqual(none.sizes.language, { version: 1, worklist: null, reading: null }, 'Revert of an account that never chose stores no language');
});

test('a wrong language form is refused and changes nothing', async () => {
  const f = appearanceFixture();
  const first = await save(f, v12(), 0);
  const before = f.snapshot();
  for (const language of [undefined, null, { version: 1, worklist: 'ja', reading: null }, { version: 2, worklist: 'ko', reading: 'ko' },
    { version: 1, worklist: 'ko' }, { version: 1, worklist: 'ko', reading: 'ko', extra: 1 }, { version: 1, worklist: '', reading: 'ko' }, 'ko'])
    await assert.rejects(save(f, { ...v11(), version: 12, language }, first.revision), status(400), JSON.stringify(language));
  await assert.rejects(save(f, { ...v11(), language: { version: 1, worklist: 'ko', reading: 'ko' } }, first.revision), status(400), 'version 11 has no language');
  assert.deepEqual(f.snapshot(), before);
});

test('a version 11 client cannot erase the language; a version 11 account upgrades to 12', async () => {
  const f = appearanceFixture();
  const first = await save(f, v12(), 0);
  await assert.rejects(save(f, v11(), first.revision), status(409));
  assert.equal((await f.service.readingAppearance(caller)).sizes.language.worklist, 'ko');
  const g = appearanceFixture();
  const old = await save(g, v11(), 0);
  const upgraded = await save(g, v12({ version: 1, worklist: null, reading: 'en' }), old.revision);
  assert.equal(upgraded.sizes.version, 12);
  assert.deepEqual(upgraded.sizes.fonts, v11().fonts, 'the other display choices stay');
});
