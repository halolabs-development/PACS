// Run with the same DATABASE_URL (installer role and database) as prisma migrate deploy.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';

const migration = new URL('./migrations/20261120150000_owner_account_keys/migration.sql', import.meta.url);
const plan = readFileSync(migration, 'utf8').split('-- BEGIN owner plan')[1].split('-- END owner plan')[0];
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');

export async function configure(db, unlisted, entries = []) {
  if (!['unknown', 'unchanged'].includes(unlisted) || !Array.isArray(entries)) throw Error('Invalid review format');
  const aliases = {};
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) throw Error('Expected [login, account or null]');
    const [login, sub] = entry;
    if (typeof login !== 'string' || !login || (sub !== null && (typeof sub !== 'string' || !sub)))
      throw Error('Empty login or invalid account');
    const key = digest(login);
    if (Object.hasOwn(aliases, key)) throw Error('Duplicate login');
    aliases[key] = sub;
  }
  // This setting applies to fresh connections of this migration role in this database.
  // The setting stores hashed login keys and the verified subjects.
  const value = JSON.stringify({ unlisted, aliases });
  const [row] = await db.$queryRaw`SELECT format('ALTER ROLE %I IN DATABASE %I SET pacs.owner_history = %L',
    current_user, current_database(), ${value}::text) AS command`;
  await db.$executeRawUnsafe(row.command);
}

export async function report(db, phase) {
  if (!['before', 'after'].includes(phase)) throw Error('Expected before or after');
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const [state] = await tx.$queryRaw`SELECT EXISTS(SELECT FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='ReportDraft' AND column_name='authorSub') AS migrated,
      nullif(current_setting('pacs.owner_history',true),'')::jsonb AS review,
      current_database() AS database, current_schema() AS schema`;
    if (state.migrated !== (phase === 'after')) throw Error('Database schema does not match the requested phase');
    const slots = phase === 'before' ? 'expected' : 'actual';
    const rows = await tx.$queryRawUnsafe(`WITH plan AS (${plan}), records AS (
      SELECT relation, field, id, login, ${slots} AS sub FROM plan
      UNION ALL SELECT 'AuditLog', 'actor', id::text, actor, NULL FROM "AuditLog"
    ), items AS (
      SELECT *, row_number() OVER (PARTITION BY relation ORDER BY id COLLATE "C", field COLLATE "C") AS n,
        encode(sha256(convert_to(jsonb_build_array(field,id,login,sub)::text,'UTF8')),'hex') AS fingerprint
      FROM records
    ), chunks AS (
      SELECT relation, (n-1)/4096 AS chunk,
        encode(sha256(convert_to(string_agg(fingerprint,'' ORDER BY n),'UTF8')),'hex') AS hash
      FROM items GROUP BY relation,(n-1)/4096
    ), signatures AS (
      SELECT relation, encode(sha256(convert_to(string_agg(hash,'' ORDER BY chunk),'UTF8')),'hex') AS signature
      FROM chunks GROUP BY relation
    )
    SELECT relation, count(DISTINCT id)::text AS rows,
      count(DISTINCT id) FILTER (WHERE relation <> 'AuditLog' AND login IS NOT NULL AND sub IS NULL)::text AS unresolved,
      coalesce(array_agg(DISTINCT encode(sha256(convert_to(login,'UTF8')),'hex')
        ORDER BY encode(sha256(convert_to(login,'UTF8')),'hex')) FILTER
        (WHERE relation <> 'AuditLog' AND login IS NOT NULL AND sub IS NULL), ARRAY[]::text[]) AS logins,
      signatures.signature FROM items JOIN signatures USING (relation) GROUP BY relation,signatures.signature`);
    const names = ['AuditLog','ReadingTemplate','Report','ReportDraft','ReportVersion','StudyState','UserFilter','UserFilterCollection'];
    const tables = names.map(relation => rows.find(row => row.relation === relation)
      ?? { relation, rows: '0', unresolved: '0', logins: [], signature: digest('') });
    // AuditLog.actor is append-only display evidence. It has no ownership judgement.
    tables.find(t => t.relation === 'AuditLog').unresolved = null;
    if (phase === 'before' && !state.review && tables.some(t => Number(t.unresolved) > 0))
      throw Error('Missing history review. ' + JSON.stringify(tables));
    return { database: state.database, schema: state.schema, tables };
  }, { timeout: 600000 });
}

export function compare(before, after) {
  if (!isDeepStrictEqual(before, after)) throw Error('Owner migration mismatch: row count, record key, stored login or attribution changed');
}

async function main() {
  const [command, arg, file, ...rest] = process.argv.slice(2);
  const db = new PrismaClient();
  try {
    if (command === 'configure' && !rest.length) {
      await configure(db, arg, file ? JSON.parse(readFileSync(file, 'utf8')) : []);
    } else if (command === 'clear' && !arg) {
      const [row] = await db.$queryRaw`SELECT format('ALTER ROLE %I IN DATABASE %I RESET pacs.owner_history',
        current_user,current_database()) AS command`;
      await db.$executeRawUnsafe(row.command);
    } else if (['before','after'].includes(command) && arg && !file) {
      const snapshot = await report(db, command);
      console.log(JSON.stringify(snapshot, null, 2));
      if (command === 'before') writeFileSync(arg, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 });
      else compare(JSON.parse(readFileSync(arg, 'utf8')), snapshot);
    } else throw Error('Use configure unchanged|unknown [aliases.json], before FILE, after FILE, or clear');
  } finally { await db.$disconnect(); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error.constructor === Error ? error.message : 'Owner upgrade command failed'); process.exitCode = 1; });
}
