'use strict';
// Exercise the complete transactional migration on isolated copies of its input tables, including DDL and rollback.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const api = process.env.KIN_D_API || path.resolve(__dirname, '../../../api');
const dependency = name => require(path.join(api, 'node_modules', name));
const { PrismaClient } = dependency('@prisma/client');

const MIGRATION = path.join(api, 'prisma', 'migrations', '20261119120000_owner_account_keys', 'migration.sql');

const { spawnSync } = require('node:child_process');
const witness = process.env.KIN_D_WITNESS_URL;
function client(url) { return new PrismaClient({ datasources: { db: { url } } }); }

async function fixture(t) {
  assert.ok(witness, 'the disposable PostgreSQL witness URL is required');
  const root = client(witness), schema = 'owner_' + randomUUID().replaceAll('-', '');
  const url = new URL(witness);
  url.searchParams.set('schema', schema);
  const db = client(url.href);
  await root.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  t.after(async () => {
    await db.$disconnect();
    try { await root.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); } finally { await root.$disconnect(); }
  });
  for (const table of ['MemberRights', 'StudyState', 'ReportDraft', 'Report', 'ReportVersion', 'UserFilter',
    'UserFilterCollection', 'ReadingTemplate', 'ReportDraftPurposeEnd']) {
    await root.$executeRawUnsafe(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
  }
  async function migrate() {
    for (const [table, columns] of [['ReportDraft', ['authorSub', 'authorLogin']], ['ReportVersion', ['authorSub']],
      ['Report', ['updatedBySub']], ['StudyState', ['holderSub']]]) {
      for (const col of columns) await db.$executeRawUnsafe(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${col}"`);
    }
    // Prisma's db execute sends the file as one PostgreSQL script (including BEGIN, DO blocks and COMMIT).
    return spawnSync(process.execPath, [path.join(api, 'node_modules/prisma/build/index.js'), 'db', 'execute',
      '--stdin', '--url', url.href], { input: `SET search_path TO "${schema}", public;\n` + fs.readFileSync(MIGRATION, 'utf8'),
      encoding: 'utf8', timeout: 30000 });
  }
  return { db, migrate };
}

test('owner keys resolve only unique accounts and preserve their settings across old logins', async t => {
  const { db, migrate } = await fixture(t);
  const tag = randomUUID().slice(0, 8);
  const id = name => `syn-owner-${tag}-${name}`;
  const X = { sub: id('x'), username: id('x-user'), email: id('x') + '@example.test' };
  const U = { sub: id('u'), username: id('u-user'), email: '' };   // a token without an email: its login was the username
  const shared = id('shared') + '@example.test';                   // two members with one email: nobody's
  const uid = n => `2.25.99${Date.now() % 100000}${n}${Math.floor(Math.random() * 1000)}`;
  const [s1, s2, s3] = [uid(1), uid(2), uid(3)];
  const empty = { findings: '', conclusion: '', recommendation: '', baseVersion: 0, present: false, revision: 1 };
  for (const [m, email] of [[X, X.email], [U, U.email], [{ sub: id('d1'), username: id('d1') }, shared], [{ sub: id('d2'), username: id('d2') }, shared]])
    await db.memberRights.create({ data: { sub: m.sub, username: m.username, email, name: 'SYN', emailVerified: true, approved: true, institution: id('inst'), roles: ['radiologist'] } });
  await db.studyState.createMany({ data: [s1, s2, s3].map(u => ({ uid: u, institutionId: id('inst'), ss: 'Verified' })) });
  await db.studyState.update({ where: { uid: s1 }, data: { rs: 'P', preDoc: X.email, preReviewer: U.username, holder: X.email, heldAt: new Date() } });
  await db.studyState.update({ where: { uid: s3 }, data: { holder: id('gone') + '@example.test', heldAt: new Date() } });
  await db.reportDraft.createMany({ data: [
    { uid: s1, author: X.email, ...empty }, { uid: s1, author: id('gone') + '@example.test', ...empty }, { uid: s1, author: shared, ...empty },
    // one account under two logins on one study: neither row is filled (one account has at most one draft row per study)
    { uid: s2, author: X.email, ...empty }, { uid: s2, author: X.username, ...empty },
    { uid: s3, author: U.username, ...empty }] });
  await db.report.create({ data: { uid: s1, version: 1, findings: 'SYN', updatedBy: X.email } });
  await db.reportVersion.create({ data: { uid: s1, version: 1, action: 'save', findings: 'SYN', author: X.email } });
  await db.userFilter.create({ data: { owner: X.email, name: 'SYN search' } });
  await db.userFilterCollection.create({ data: { owner: X.email } });
  await db.readingTemplate.create({ data: { owner: X.email, title: 'SYN template' } });
  // Both old logins and an already-account-owned row compete for the same name. An id breaks a timestamp tie.
  const createSearch = (owner, name, date, quick, isDefault = false) => db.userFilter.create({ data: {
    owner, name, createdAt: new Date(date), quick, isDefault } });
  const old = await createSearch(X.username, 'Chest', '2024-01-01', 'old', true);
  const tied = await createSearch(X.email, 'Chest', '2025-01-01', 'tie');
  const winner = await createSearch(X.sub, 'Chest', '2025-01-01', 'winner', true);
  const newestDefault = await createSearch(X.username, 'Spine', '2026-01-01', 'spine', true);
  const folder = path => ({ path, description: path, ordinal: 1 });
  const link = (id, searchId) => ({ id, name: id, searchId });
  await db.userFilterCollection.update({ where: { owner: X.email }, data: { revision: 2, folders: [folder('B')],
    shortcuts: [link('tie', 'own:' + tied.id), link('library', 'shared:7')] } });
  await db.userFilterCollection.create({ data: { owner: X.username, revision: 3, folders: [folder('A')],
    shortcuts: [link('old', 'own:' + old.id)] } });
  await db.userFilterCollection.create({ data: { owner: X.sub, revision: 1, folders: [folder('A')],
    shortcuts: [link('winner', 'own:' + winner.id)] } });
  await createSearch(U.sub, 'Solo', '2024-01-01', 'selected', true);
  const solo = await createSearch(U.username, 'Solo', '2025-01-01', 'updated');
  const template = await db.readingTemplate.create({ data: { owner: X.username, title: 'SYN template', findings: 'SYN preserved' } });
  // A historical key may exist only in retained work. Its later destruction must not change
  // the account-only ID that an empty view will already have recorded.
  const historicalKey = 'account/' + X.sub;
  const held = await db.reportDraftPurposeEnd.create({ data: { disposalUnitId: 'disposal:' + randomUUID(),
    uid: s1, author: historicalKey, actorId: historicalKey, workSince: new Date('2026-01-01'), workIntent: 'approve',
    trigger: 'explicit-discard', eventId: randomUUID(), endedAt: new Date('2026-01-02'), findings: 'SYN held', conclusion: '',
    recommendation: '', baseVersion: 0 } });
  const result = await migrate();
  assert.equal(result.status, 0, result.stderr);
  const key = async sub => (await db.$queryRaw`SELECT draft_account_author(${sub}::text) AS author`)[0].author;
  const firstKey = await key(X.sub);
  assert.notEqual(firstKey, historicalKey);
  assert.notEqual(await key(U.sub), firstKey);
  await db.reportDraftPurposeEnd.delete({ where: { disposalUnitId: held.disposalUnitId } });
  assert.equal(await key(X.sub), firstKey);

  const draftSub = async (u, author) => (await db.reportDraft.findUnique({ where: { uid_author: { uid: u, author } } })).authorSub;
  assert.equal(await draftSub(s1, X.email), X.sub);
  assert.equal(await draftSub(s1, id('gone') + '@example.test'), null, 'no member: kept, nobody\'s');
  assert.equal(await draftSub(s1, shared), null, 'two members with that email: nobody\'s');
  assert.equal(await draftSub(s2, X.email), null);
  assert.equal(await draftSub(s2, X.username), null);
  assert.equal(await draftSub(s3, U.username), U.sub, 'a login that was the username');
  assert.equal((await db.report.findUnique({ where: { uid: s1 } })).updatedBySub, X.sub);
  assert.equal((await db.reportVersion.findUnique({ where: { uid_version: { uid: s1, version: 1 } } })).authorSub, X.sub);
  const first = await db.studyState.findUnique({ where: { uid: s1 } });
  assert.deepEqual([first.holderSub, first.preDocSub, first.preReviewerSub], [X.sub, X.sub, U.sub]);
  const third = await db.studyState.findUnique({ where: { uid: s3 } });
  assert.deepEqual([third.holder, third.holderSub], [id('gone') + '@example.test', null], 'an unresolved live hold stays until it expires, nobody\'s');
  assert.deepEqual((await db.userFilter.findMany({ where: { name: 'SYN search' } })).map(f => f.owner), [X.sub]);
  assert.ok(await db.userFilterCollection.findUnique({ where: { owner: X.sub } }));
  assert.equal(await db.userFilterCollection.findUnique({ where: { owner: X.email } }), null);
  assert.deepEqual(await db.readingTemplate.findUnique({ where: { id: template.id } }), { ...template, owner: X.sub });
  assert.equal(await db.readingTemplate.count({ where: { owner: X.sub } }), 2);
  const searches = await db.userFilter.findMany({ where: { owner: X.sub }, orderBy: { name: 'asc' } });
  assert.deepEqual(searches.map(f => f.name), ['Chest', 'SYN search', 'Spine']);
  assert.deepEqual([searches[0].id, searches[0].quick], [winner.id, 'winner']);
  assert.deepEqual(searches.filter(f => f.isDefault).map(f => f.id), [newestDefault.id]);
  assert.equal((await db.userFilter.findUnique({ where: { id: solo.id } })).isDefault, true);
  const caller = { sub: X.sub, actor: X.email, kind: 'member', institution: id('inst'), roles: ['radiologist'] };
  const { PacsFilters } = require(path.join(api, 'dist/pacs/filters'));
  const { PacsPreferences } = require(path.join(api, 'dist/pacs/preferences'));
  const collection = await new PacsFilters(db).readFilterFolders(caller);
  assert.deepEqual(collection.filters.map(f => f.id).sort(), searches.map(f => f.id).sort());
  const prefs = await new PacsPreferences(db).prefs(caller);
  assert.equal(prefs.templates.find(t => t.id === template.id).findings, 'SYN preserved');
  assert.deepEqual(collection.folders.sort((a,b) => a.path.localeCompare(b.path)), [folder('A'), folder('B')]);
  assert.deepEqual(collection.shortcuts.sort((a,b) => a.id.localeCompare(b.id)), [
    link('library', 'shared:7'), ...['old', 'tie', 'winner'].map(id => link(id, 'own:' + winner.id))]);
  assert.ok(collection.revision > 3, 'an editor holding any pre-merge revision must reload');
  // The index: one account, one draft row per study.
  await assert.rejects(db.reportDraft.create({ data: { uid: s1, author: id('x-again'), authorSub: X.sub, ...empty } }), e => e?.code === 'P2002');
});

for (const conflict of ['username/sub', 'folder', 'shortcut']) {
  test(`owner keys count and roll back a ${conflict} conflict`, async t => {
    const { db, migrate } = await fixture(t);
    for (const sub of ['A', 'B']) await db.memberRights.create({ data: { sub, username:
      conflict === 'username/sub' && sub === 'A' ? 'B' : sub + '-login', email: sub + '@example.test',
      name: 'SYN', emailVerified: true, approved: true, institution: 'SYN', roles: ['radiologist'] } });
    for (const owner of ['A@example.test', 'A-login']) {
      const id = 'collision';
      await db.userFilterCollection.create({ data: { owner,
        folders: conflict === 'folder' ? [{ path: id, description: owner, ordinal: 0 }] : [],
        shortcuts: conflict === 'shortcut' ? [{ id, name: owner, searchId: 'shared:1' }] : [] } });
    }
    const before = await db.userFilterCollection.findMany({ orderBy: { owner: 'asc' } });
    const result = await migrate();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, conflict === 'username/sub' ? /username.*sub.*: 1/i : /collection.*: 1/i);
    assert.deepEqual(await db.userFilterCollection.findMany({ orderBy: { owner: 'asc' } }), before);
    const columns = await db.$queryRaw`SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'ReportDraft' AND column_name = 'authorSub'`;
    assert.equal(columns.length, 0, 'the first DDL of the migration rolled back too');
  });
}
