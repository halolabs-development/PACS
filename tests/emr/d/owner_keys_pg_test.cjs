'use strict';
// Whose draft, saved text, version, hold, Preliminary designation, saved search, folder collection and reading template it
// is follows the account id. The migration fills the account of rows written before that from the member table, on
// PostgreSQL: a stored login (email, else username, else the id itself) names an account only when exactly one member has
// it; a row no member can be found for stays as it is (nobody's); one account never gets two draft rows of one study, and
// an owner key never merges into a key that account already has. The fill statements run from the migration file itself,
// over rows shaped as they were before it.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const api = process.env.KIN_D_API || path.resolve(__dirname, '../../../api');
const dependency = name => require(path.join(api, 'node_modules', name));
const { PrismaClient } = dependency('@prisma/client');

const MIGRATION = path.join(api, 'prisma', 'migrations', '20261119120000_owner_account_keys', 'migration.sql');

/** The migration's fill: its temporary login table and its UPDATE statements, as written in the file. */
function fillStatements() {
  const sql = fs.readFileSync(MIGRATION, 'utf8').split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  const statements = sql.split(';').map(s => s.trim()).filter(s => /^(CREATE TEMPORARY TABLE|UPDATE)\b/.test(s));
  assert.ok(statements.length >= 10, 'the migration fills with one login table and its updates');
  return statements;
}

test('owner keys: the migration fills the account only where one member has the stored login; the rest stays nobody\'s', { timeout: 60000 }, async () => {
  const db = new PrismaClient({ datasources: { db: { url: process.env.KIN_D_WITNESS_URL } } });
  const tag = randomUUID().slice(0, 8);
  const id = name => `syn-owner-${tag}-${name}`;
  const X = { sub: id('x'), username: id('x-user'), email: id('x') + '@example.test' };
  const U = { sub: id('u'), username: id('u-user'), email: '' };   // a token without an email: its login was the username
  const shared = id('shared') + '@example.test';                   // two members with one email: nobody's
  const uid = n => `2.25.99${Date.now() % 100000}${n}${Math.floor(Math.random() * 1000)}`;
  const [s1, s2, s3] = [uid(1), uid(2), uid(3)];
  const empty = { findings: '', conclusion: '', recommendation: '', baseVersion: 0, present: false, revision: 1 };
  try {
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
    // An account that already has rows under its id keeps them; its rows under its username are not merged into them.
    await db.userFilter.create({ data: { owner: U.sub, name: 'SYN by id' } });
    await db.userFilter.create({ data: { owner: U.username, name: 'SYN by username' } });
    await db.userFilterCollection.createMany({ data: [{ owner: U.sub }, { owner: U.username }] });

    await db.$transaction(async tx => { for (const statement of fillStatements()) await tx.$executeRawUnsafe(statement); });

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
    assert.deepEqual((await db.readingTemplate.findMany({ where: { title: 'SYN template' } })).map(t => t.owner), [X.sub]);
    assert.deepEqual((await db.userFilter.findMany({ where: { name: { in: ['SYN by id', 'SYN by username'] } }, orderBy: { name: 'asc' } }))
      .map(f => [f.name, f.owner]), [['SYN by id', U.sub], ['SYN by username', U.username]]);
    assert.ok(await db.userFilterCollection.findUnique({ where: { owner: U.username } }), 'two keys of one account never merge');
    // The index: one account, one draft row per study.
    await assert.rejects(db.reportDraft.create({ data: { uid: s1, author: id('x-again'), authorSub: X.sub, ...empty } }), e => e?.code === 'P2002');
  } finally {
    await db.$disconnect();
  }
});
