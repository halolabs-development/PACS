'use strict';
// Use the installer on a disposable PostgreSQL witness. Each case owns a new database,
// deploys the actual predecessor migrations, seeds legacy rows, and runs migrate deploy.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const api = process.env.KIN_D_API || path.resolve(__dirname, '../../../api');
const { PrismaClient, Prisma } = require(path.join(api, 'node_modules/@prisma/client'));
const migration = '20261120150000_owner_account_keys';
// The database here stops at this migration; a version is read by the columns it has then (a later column is not there yet).
const VERSION_COLUMNS = Object.fromEntries(['id', 'uid', 'version', 'action', 'findings', 'conclusion', 'recommendation', 'reason',
  'author', 'authorSub', 'citations', 'structured', 'drawings', 'at', 'groupId', 'snapshotFormat'].map(key => [key, true]));
// The StudyState columns there then: every scalar column of the model but the reading request's, which a later migration adds.
const STATE_COLUMNS = Object.fromEntries(Prisma.dmmf.datamodel.models.find(model => model.name === 'StudyState').fields
  .filter(field => field.kind === 'scalar' && !field.name.startsWith('readingRequest')).map(field => [field.name, true]));
const { PacsFilters } = require(path.join(api, 'dist/pacs/filters'));
const { PacsPreferences } = require(path.join(api, 'dist/pacs/preferences'));
const { draftOf } = require(path.join(api, 'dist/owner-identity'));
const { reportBodyLock, storedVersionReadable } = require(path.join(api, 'dist/report-visibility'));
const client = url => new PrismaClient({ datasources: { db: { url } } });
const hash = login => createHash('sha256').update(login).digest('hex');

async function fixture(t) {
  const root = client(process.env.KIN_D_WITNESS_URL);
  const url = new URL(process.env.KIN_D_WITNESS_URL);
  const database = 'owner_' + randomUUID().replaceAll('-', '');
  url.pathname = '/' + database;
  const db = client(url.href);
  await root.$executeRawUnsafe('CREATE DATABASE ' + database);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-upgrade-'));
  t.after(async () => {
    await db.$disconnect();
    try { await root.$executeRawUnsafe('DROP DATABASE ' + database); }
    finally { await root.$disconnect(); fs.rmSync(tmp, { recursive: true, force: true }); }
  });
  const prisma = path.join(api, 'prisma');
  fs.copyFileSync(path.join(prisma, 'schema.prisma'), path.join(tmp, 'schema.prisma'));
  const migrations = path.join(prisma, 'migrations');
  fs.cpSync(migrations, path.join(tmp, 'migrations'), { recursive: true,
    filter: src => path.dirname(src) !== migrations || !fs.statSync(src).isDirectory() || path.basename(src) < migration });
  function deploy(folder) {
    return spawnSync(process.execPath, [path.join(api, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy',
      '--schema', path.join(folder, 'schema.prisma')], { env: { ...process.env, DATABASE_URL: url.href },
      encoding: 'utf8', timeout: 120000 });
  }
  const before = deploy(tmp);
  assert.equal(before.status, 0, before.stderr);
  const history = () => db.$queryRaw`SELECT migration_name, checksum, finished_at FROM "_prisma_migrations"
    WHERE rolled_back_at IS NULL ORDER BY migration_name COLLATE "C"`;
  const previous = await history();
  fs.cpSync(path.join(migrations, migration), path.join(tmp, 'migrations', migration), { recursive: true });
  async function migrate() {
    const result = deploy(tmp);
    assert.equal(result.status, 0, result.stderr);
    const after = await history();
    assert.deepEqual(after.slice(0,-1), previous);
    assert.equal(after.at(-1).migration_name, migration);
    assert.ok(after.at(-1).finished_at);
  }
  const tools = await import(pathToFileURL(path.join(prisma, 'owner-upgrade.mjs')).href);
  const reportFile = path.join(tmp, 'report.json');
  function command(...args) {
    return spawnSync(process.execPath, [path.join(prisma, 'owner-upgrade.mjs'), ...args],
      { env: { ...process.env, DATABASE_URL: url.href }, encoding: 'utf8', timeout: 60000 });
  }
  return { db, migrate, tools, deploy: () => deploy(tmp), command, reportFile, tmp };
}

const ordinary = 'normal@example.test', old = 'earlier@example.test', current = 'current@example.test';
const reused = 'reused@example.test', gone = 'deleted@example.test';
const folder = label => [{ path: 'Chest', description: label, ordinal: 1 }];
const shortcut = (name, id) => [{ id: 'chest', name, searchId: 'own:' + id }];
const login = (sub, actor) => ({ kind: 'member', institution: 'SYN', sub, actor, roles: ['radiologist'] });
const uid = index => '2.25.7123.' + index;
async function seed(db) {
  const members = [['ordinary', ordinary], ['changed', current], ['previous', reused], ['next', reused]];
  await db.memberRights.createMany({ data: members.map(([sub,email]) => ({ sub, username: sub+'-login',
    email, suspended: sub === 'previous', name: 'Synthetic', emailVerified: true, approved: true,
    roles: ['radiologist'], institution: 'SYN' })) });
  for (const [index, live, history] of [[1, ordinary, ordinary], [2, current, old], [3, reused, reused], [4, gone, gone]]) {
    await db.studyState.createMany({ data: [{ uid: uid(index), institutionId: 'SYN', rs: 'T', holder: live, heldAt: new Date(),
      preDoc: live, preReviewer: 'ordinary-login', preReviewerSub: index === 3 ? 'ordinary' : null }] });
    await db.reportDraft.createMany({ data: [{ uid: uid(index), author: live, present: true, workUnit: 'disposal:'+randomUUID(), workSince: new Date(), workIntent: 'approve', findings: 'draft '+index }] });
    await db.reportVersion.createMany({ data: [{ uid: uid(index), version: 1, action: 'save', author: history, findings: 'version '+index }] });
    await db.report.createMany({ data: [{ uid: uid(index), version: 1, updatedBy: history, findings: 'saved '+index }] });
    await db.auditLog.createMany({ data: [{ actor: history, action: 'report.save', target: uid(index) }] });
  }
  // A draft collision has no single live editor. Both original record IDs remain available for retention.
  await db.reportDraft.createMany({ data: [current,'changed-login'].map(author => ({ uid: uid(5), author, present: false })) });
  await db.reportDraftPurposeEnd.createMany({ data: [{ uid: uid(1), author: 'account/ordinary', actorId: 'account/ordinary',
    disposalUnitId: 'disposal:'+randomUUID(), workSince: new Date('2025-01-01'), workIntent: 'approve',
    trigger: 'explicit-discard', eventId: randomUUID(), endedAt: new Date(), baseVersion: 0,
    findings: 'retained', conclusion: '', recommendation: '' }] });
  for (const [index,owner] of [ordinary, current, 'changed-login', reused, gone].entries()) {
    const id = index + 101;
    await db.userFilter.createMany({ data: [{ id, owner, name: 'Chest', quick: 'condition '+id, isDefault: true, folder: 'Chest' }] });
    await db.userFilterCollection.createMany({ data: [{ owner, revision: id, folders: folder(owner), shortcuts: shortcut(owner,id) }] });
    await db.readingTemplate.createMany({ data: [{ owner, title: 'Chest', findings: 'template '+id }] });
  }
}

const tables = ['StudyState','Report','ReportDraft','ReportVersion','ReadingTemplate','UserFilter',
  'UserFilterCollection','AuditLog','ReportDraftPurposeEnd','MemberRights'];
async function originalRows(db) {
  const result = {};
  for (const table of tables) {
    // Compare every pre-existing column except the previously nullable designation subjects, which may be filled once.
    result[table] = await db.$queryRawUnsafe(`SELECT (to_jsonb(t) - ARRAY['authorSub','authorLogin','ownerSub',
      'updatedBySub','holderSub','preDocSub','preReviewerSub'])::text AS bytes FROM "${table}" t ORDER BY 1`);
  }
  return result;
}

for (const aliases of [false, true]) {
  test('historical attribution and lossless settings upgrade '+(aliases ? 'with aliases' : 'without aliases'), async t => {
    const { db, tools, migrate, command, reportFile, tmp } = await fixture(t);
    await seed(db);
    const original = await originalRows(db);
    const aliasFile = path.join(tmp, 'aliases.json');
    if (aliases) fs.writeFileSync(aliasFile, JSON.stringify([[old,'changed'],[reused,'previous'],[gone,null]]));
    const configured = command('configure', 'unchanged', ...(aliases ? [aliasFile] : []));
    assert.equal(configured.status, 0, configured.stderr);
    const before = command('before', reportFile);
    assert.equal(before.status, 0, before.stderr);
    await migrate();
    const result = command('after', reportFile);
    assert.equal(result.status, 0, result.stderr);
    const after = JSON.parse(result.stdout);
    assert.deepEqual(after, JSON.parse(before.stdout));
    assert.deepEqual(await originalRows(db), original);
    for (const table of after.tables) {
      const logins = table.relation === 'AuditLog' ? [] : [gone, ...(aliases ? [] : [reused])];
      if (!aliases && ['Report','ReportVersion'].includes(table.relation)) logins.push(old);
      if (table.relation === 'ReportDraft') logins.push(current,'changed-login');
      assert.deepEqual(table.logins, logins.map(hash).sort(), table.relation);
      assert.equal(table.unresolved, table.relation === 'AuditLog' ? null : String(logins.length), table.relation);
    }
    console.log(JSON.stringify({ aliases, tables: after.tables.map(({signature,...row}) => row) }));
    const normal = login('ordinary',ordinary), changed = login('changed',current), successor = login('next',reused);
    for (const [index,account,who] of [[1,'ordinary',normal],[2,'changed',changed],[3,aliases?'previous':null,successor],[4,null,null]]) {
      // A later StudyState column (the reading request's) is not there yet at this migration: read the ones it has then.
      const study = await db.studyState.findUnique({ where: { uid: uid(index) }, select: STATE_COLUMNS });
      assert.deepEqual([study.holderSub,study.preDocSub,study.preReviewerSub],[account,account,'ordinary']);
      const historical = index === 2 && !aliases ? null : account;
      const head = await db.report.findUnique({ where: { uid: study.uid } });
      const version = await db.reportVersion.findFirst({ where: { uid: study.uid }, select: VERSION_COLUMNS });
      assert.equal(head.updatedBySub, historical);
      assert.equal(version.authorSub, historical);
      if (who) {
        assert.equal(reportBodyLock(study, head, who), historical === who.sub ? null : 'in-progress');
        assert.equal(await storedVersionReadable(db, study.uid, version, who), historical === who.sub);
      }
      if (who) assert.equal((await draftOf(db,study.uid,who))?.findings ?? null,index === 3 ? null : 'draft '+index);
    }
    assert.deepEqual((await db.reportDraft.findMany({ where: { uid: uid(5) } })).map(d=>d.authorSub),[null,null]);
    const recordKey = async sub => (await db.$queryRaw`SELECT draft_account_author(${sub}::text) AS author`)[0].author;
    const author = await recordKey(normal.sub);
    assert.notEqual(author,'account/ordinary');
    assert.notEqual(await recordKey(changed.sub),author);
    const retained = await db.reportDraftPurposeEnd.findFirstOrThrow({ where: { uid: uid(1), author: 'account/ordinary' } });
    await db.reportDraftPurposeEnd.delete({ where: { disposalUnitId: retained.disposalUnitId } });
    assert.equal(await recordKey(normal.sub),author);
    await assert.rejects(db.reportDraft.create({ data: { uid: uid(1), author, authorSub: normal.sub, present: false } }),e=>e.code==='P2002');
    const filters = new PacsFilters(db), prefs = new PacsPreferences(db);
    const own = await prefs.prefs(normal);
    assert.deepEqual(own.filters.map(f=>f.quick), ['condition 101']);
    assert.deepEqual(own.templates.map(t=>t.findings), ['template 101']);
    const both = await prefs.prefs(changed);
    assert.deepEqual(both.filters.map(f=>[f.name,f.quick]).sort(), [['Chest','condition 102'],['Chest','condition 103']]);
    assert.deepEqual(both.templates.map(t=>t.findings).sort(), ['template 102','template 103']);
    const snapshot = await filters.readFilterFolders(changed);
    for (const group of snapshot.collections) {
      const f = group.filters[0];
      assert.deepEqual(group.folders,folder(f.owner));
      assert.deepEqual(group.shortcuts,shortcut(f.owner,f.id));
    }
    const b = await prefs.prefs(successor);
    assert.deepEqual(b.filters,[]);
    assert.ok(b.templates.every(t=>t.findings !== 'template 104'));
    if (aliases) {
      const previous = login('previous','previous-login');
      assert.equal((await draftOf(db,uid(3),previous)).findings,'draft 3');
      const saved = await prefs.prefs(previous);
      assert.deepEqual(saved.filters.map(f=>f.quick),['condition 104']);
      assert.deepEqual(saved.templates.map(t=>t.findings),['template 104']);
    }
    await assert.rejects(filters.saveFilter({ collection: reused, name: 'Chest' },successor),e=>e.getStatus()===409);
    const edit = snapshot.collections[1];
    await filters.saveFilter({ collection: edit.collection, name: 'Chest', quick:'edited' },changed);
    const reloaded = await filters.readFilterFolders(changed);
    assert.equal(reloaded.collections[1].filters[0].quick,'edited');
    assert.deepEqual(reloaded.collections[0],snapshot.collections[0]);
    const savedGroup = reloaded.collections[1];
    await filters.writeFilterFolders({ expectedOwner: savedGroup.owner, revision: savedGroup.revision,
      collection: savedGroup.collection, command: { action:'replace-shortcuts', shortcuts:[] } },changed);
    const edited = await filters.readFilterFolders(changed);
    assert.deepEqual(edited.collections[1].shortcuts, []);
    assert.deepEqual(edited.collections[0],snapshot.collections[0]);
    // User operations above may have created templates. Compare each fault with its own baseline.
    fs.writeFileSync(reportFile, JSON.stringify(await tools.report(db, 'after')));
    await db.readingTemplate.updateMany({ where: { ownerSub: normal.sub }, data: { owner: ordinary + 'x' } });
    const rewritten = command('after', reportFile);
    assert.equal(rewritten.status, 1);
    assert.match(rewritten.stderr, /mismatch/);
    fs.writeFileSync(reportFile, rewritten.stdout);
    await db.userFilter.delete({ where: { id: 101 } });
    const deleted = command('after', reportFile);
    assert.equal(deleted.status, 1);
    assert.match(deleted.stderr, /mismatch/);
    console.log('after exit: original=0, rewritten login=1, deleted row=1');
  });
}

test('unreviewed current directory cannot claim a legacy row', async t => {
  const { db, tools, deploy } = await fixture(t);
  await seed(db);
  await assert.rejects(tools.report(db,'before'),/Missing history review/);
  assert.notEqual(deploy().status,0);
  await assert.rejects(tools.report(db,'after'),/schema/);
});

test('without a general history only explicit aliases attribute rows, even with one current directory holder', async t => {
  const { db, tools, migrate } = await fixture(t);
  await seed(db);
  await db.memberRights.update({ where: { sub: 'previous' }, data: { email: '' } });
  await tools.configure(db, 'unknown', [[reused,'previous'],[ordinary,'ordinary']]);
  await db.$disconnect();
  const before = await tools.report(db,'before');
  await migrate();
  tools.compare(before,await tools.report(db,'after'));
  const successor = login('next',reused);
  assert.equal(await draftOf(db,uid(3),successor),null);
  assert.equal((await db.reportDraft.findFirst({ where: { uid:uid(2) } })).authorSub,null);
  assert.deepEqual(await db.userFilter.findMany({ where: { ownerSub:successor.sub } }),[]);
  assert.equal((await db.readingTemplate.findFirst({ where: { owner:reused } })).ownerSub,'previous');
  assert.equal((await db.report.findUnique({ where: { uid:uid(1) } })).updatedBySub,'ordinary');
});

test('a reviewed nobody overrides a single current directory holder', async t => {
  const { db, tools, migrate } = await fixture(t);
  await seed(db);
  await db.memberRights.update({ where: { sub: 'previous' }, data: { email: '', username: 'next' } });
  await db.userFilter.createMany({ data: [{ owner: 'next', name: 'Chest', quick: 'ambiguous username or subject' }] });
  const occupied = 'account//next';
  await db.userFilter.createMany({ data: [{ owner: occupied, name: 'Chest', quick: 'untouched' }] });
  await db.userFilterCollection.createMany({ data: [{ owner: occupied, revision: 7 }] });
  await tools.configure(db,'unchanged',[[reused,null],[gone,'archived-subject']]);
  await db.$disconnect();
  const before = await tools.report(db,'before');
  await migrate();
  tools.compare(before, await tools.report(db,'after'));
  assert.equal((await db.userFilter.findFirstOrThrow({ where: { owner:'next' } })).ownerSub,null);
  assert.equal((await db.userFilter.findFirstOrThrow({ where: { owner:gone } })).ownerSub,'archived-subject');
  assert.equal((await db.userFilter.findFirst({ where: { owner:reused } })).ownerSub,null);
  assert.equal((await db.readingTemplate.findFirst({ where: { owner:reused } })).ownerSub,null);
  assert.equal((await db.reportDraft.findFirst({ where: { author:reused } })).authorSub,null);
  const saved = await new PacsFilters(db).saveFilter({ name: 'Chest', quick: 'new' },login('next',reused));
  assert.notEqual(saved.owner, occupied);
  assert.equal((await db.userFilter.findFirst({ where: { owner: occupied } })).quick,'untouched');
  assert.equal((await db.userFilterCollection.findUnique({ where: { owner: occupied } })).revision,7);
});

test('an administrator replacement whose successor now has the predecessor\'s old email: the successor gets only their own draft', async t => {
  const { db, tools, migrate } = await fixture(t);
  process.env.KC_ISSUER ||= 'https://synthetic.invalid/realms/owner';
  // Before the upgrade: the departed sole administrator wrote a draft and an unsigned version under the email they had;
  // that email was since given to the successor (the departed account's email was changed). No reviewed history.
  const X = 'SYN', mail = 'admin@hospital.example.test';
  await db.memberRights.createMany({ data: [
    { sub: 'departed', username: 'departed-login', email: 'departed-renamed@hospital.example.test', name: 'Synthetic',
      emailVerified: true, approved: true, suspended: false, institution: X, roles: ['admin', 'radiologist'] },
    { sub: 'successor', username: 'successor-login', email: mail, name: 'Synthetic',
      emailVerified: true, approved: true, suspended: false, institution: X, roles: ['radiologist'] }] });
  const study = uid(9);
  await db.reportDraft.createMany({ data: [{ uid: study, author: mail, present: true, workUnit: 'disposal:'+randomUUID(),
    workSince: new Date(), workIntent: 'approve', findings: 'the departed administrator\'s private draft' }] });
  await db.reportVersion.createMany({ data: [{ uid: study, version: 1, action: 'save', author: mail,
    findings: 'the departed administrator\'s unsigned version' }] });
  await tools.configure(db, 'unknown', []);
  await db.$disconnect();
  await migrate();
  // The operator's replacement (the real service on this database; the ledger records stand in as plain effects).
  require(path.join(api, 'node_modules/reflect-metadata'));
  const { AdminService } = require(path.join(api, 'dist/admin.service'));
  const provider = { institutions: async () => [X],
    getUser: async id => ({ id, username: id + '-login', email: id === 'successor' ? mail : id + '@hospital.example.test',
      emailVerified: true, firstName: 'Synthetic', lastName: id, enabled: true, serviceAccountClientId: null, groups: [X], roles: [] }),
    memberStanding: async () => ({ groups: [X], effectiveRoles: [] }) };
  const work = { transactionWithRecords: (body, options) => db.$transaction(tx => body(tx, async (event, effect) => effect()), options),
    resolveIdentity: async () => randomUUID(), resolveRequestIdentity: async () => randomUUID() };
  const replaced = await new AdminService(db, provider, null, { publishCredentials() {} })
    .replaceSoleAdmin('departed', 'successor', X, { name: 'ops', reason: 'synthetic hospital request' }, work);
  assert.deepEqual([replaced.approvalState, [...replaced.roles].sort()], ['APPROVED', ['admin', 'radiologist']]);
  // The successor writes their own draft of the same study and reads it back; the predecessor's never answers to them.
  const successor = { ...login('successor', mail), roles: ['radiologist', 'admin'] };
  const [{ author }] = await db.$queryRaw`SELECT draft_account_author(${'successor'}::text) AS author`;
  await db.reportDraft.create({ data: { uid: study, author, authorSub: 'successor', authorLogin: mail, present: true,
    workUnit: 'disposal:'+randomUUID(), workSince: new Date(), workIntent: 'approve', findings: 'the successor\'s own draft' } });
  assert.equal((await draftOf(db, study, successor)).findings, 'the successor\'s own draft');
  const version = await db.reportVersion.findFirst({ where: { uid: study, version: 1 }, select: VERSION_COLUMNS });
  assert.equal(await storedVersionReadable(db, study, version, successor), false, 'the unsigned version is not the successor\'s');
  // The predecessor's rows are kept as they were, unattributed.
  const kept = await db.reportDraft.findFirst({ where: { uid: study, author: mail } });
  assert.deepEqual([kept.authorSub, kept.findings], [null, 'the departed administrator\'s private draft']);
  assert.deepEqual([version.authorSub, version.findings], [null, 'the departed administrator\'s unsigned version']);
});