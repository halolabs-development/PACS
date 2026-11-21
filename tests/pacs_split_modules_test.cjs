'use strict';
// Read the selected wire body; HTTP/PG publication is covered by emr/a/report_reads_test.cjs.
const readBody = value => JSON.parse(value.json);
const nativeSigning = { sign: async () => ({ fixture: 'native-signature' }) };

// B2 consumer fixture only: these existing pure suites exercise business/CAS rules.
// Real ledger atomicity and HTTP publication are tested against PostgreSQL.
const {withDraftRequestContext} = require('./emr/request/consumer_fixture.cjs');
// `events` keeps the access events of committed transactions only: a rolled-back write leaves no record.
function b2Ledger(prisma, events = []) {
  return { events, begin: () => ({
    resolveRequestIdentity: async () => '00000000-0000-4000-8000-000000000001',
    transactionWithRecords: async (work, options) => {
      const staged = [];
      const value = await prisma.$transaction(tx => work(tx, async (event, effect) => { staged.push(event); return effect(); }), options);
      events.push(...staged);
      return value;
    },
    end() {},
  }) };
}
/* TEST-S9-U0b-MODULES — the PACS concern modules of api/src/pacs/ run directly (S9-U0b round 1, order §6 step 2, §8), and
 * since round 2 also through the PacsService facade that owns them (SPLIT-21..23).
 *
 * What is bound: behaviour and permission contracts (AGENTS §1, §1-B / D73) — who may read or write a study, what a refusal
 * answers (HTTP status, `code`), what is stored, which history rows are appended and which audit rows are written, and that
 * a write and its audit row commit or roll back together. Nothing here reads source text, file layout or private names.
 * No byte pins.
 *
 * How: each concern is a plain object (PacsService builds and owns them; they are not Nest providers). The cases build the
 * same graph the facade builds, or the facade itself, over test-owned value providers: an in-memory Prisma double with transactional
 * rollback that records which client (root or transaction) every write used, StudyAccess / Orthanc / Keycloak / Findings
 * doubles. No Docker, no database, no stack. The compiled service suites over a real PostgreSQL remain the authority for
 * SQL and snapshot semantics; this file proves the moved behaviour of each concern on its own.
 *
 * REQ -> RISK -> TEST (order §8):
 *   REQ-U0B-ACCESS   -> RISK-TENANT-ROLE        -> SPLIT-03, SPLIT-04, SPLIT-05, SPLIT-06, SPLIT-20 (M01, M02, M03)
 *   REQ-U0B-REPORT   -> RISK-HISTORY-STATE      -> SPLIT-07, SPLIT-08 (M04, M05, M06, M07)
 *   REQ-U0B-DRAFT    -> RISK-TEXT-SESSION       -> SPLIT-09, SPLIT-10 (M08, M09, M10)
 *   REQ-U0B-HOLD     -> RISK-LOCK               -> SPLIT-02, SPLIT-11 (M11, M12)
 *   REQ-U0B-QUERY    -> RISK-IDENTITY-LEAK      -> SPLIT-02, SPLIT-12, SPLIT-13, SPLIT-16 (M13, M14)
 *   REQ-U0B-EVIDENCE -> RISK-HIDDEN-CITATION    -> SPLIT-14, SPLIT-15 (M16, M17, M18)
 *   REQ-U0B-NOTE-GW  -> RISK-DUPLICATE-AUDIT    -> SPLIT-17, SPLIT-18 (M19, M20)
 *   REQ-U0B-ACCESS   -> RISK-TENANT-ROLE        -> SPLIT-21 (clinician-only narrowing of the DICOMweb statistics gate)
 *   REQ-U0B-STRUCTURE -> RISK-LOST-WIRING       -> SPLIT-22, SPLIT-23 (the facade's start, forwarding and refusals)
 *   construction: SPLIT-01 (constructors store references only: no IO, no timers, no seeding).
 *
 * Runs as `node --test tests/pacs_split_modules_test.cjs` (the installed TypeScript compiles api/src through
 * tests/service_test_loader.cjs) and unchanged against a compiled /app/dist.
 */
const test = require('node:test');
const { TransactionLocks } = require('./transaction_locks.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
if (!fs.existsSync('/app/dist/pacs')) require('./service_test_loader.cjs');

const { ConflictException, HttpException, NotFoundException } = require('/app/node_modules/@nestjs/common');
const { Prisma } = require('/app/node_modules/@prisma/client');
const values = require('/app/dist/pacs/values');
const accessModule = require('/app/dist/pacs/access');
const { PacsAccess, need, needExact, inst } = accessModule;
const { PacsInstitutions } = require('/app/dist/pacs/institutions');
const { PacsPreferences } = require('/app/dist/pacs/preferences');
const { PacsFilters } = require('/app/dist/pacs/filters');
const { PacsAudit } = require('/app/dist/pacs/audit');
const { PacsMetrics } = require('/app/dist/pacs/metrics');
const { PacsWorklist } = require('/app/dist/pacs/worklist');
const { PacsDicomGateway } = require('/app/dist/pacs/dicom-gateway');
const { PacsStudyState } = require('/app/dist/pacs/study-state');
const { PacsTechNote } = require('/app/dist/pacs/tech-note');
const { PacsHold } = require('/app/dist/pacs/hold');
const { PacsClinician } = require('/app/dist/pacs/clinician');
const { PacsReportEvidence } = require('/app/dist/pacs/report-evidence');
const { PacsReportDraft } = require('/app/dist/pacs/report-draft');
const { PacsReportCommit } = require('/app/dist/pacs/report-commit');
const { STRUCTURE_CATALOG } = require('/app/dist/report-structure');
const { PacsService } = require('/app/dist/pacs.service');
const { parseAccessEvent, STATUTORY_ACT } = require('/app/dist/emr-contract/access-event');
const { ClinicalRoutes } = require('/app/dist/emr-clinical/routes');
/** 의료법 제23조④ access records a route committed, as the ledger contract parses them: [act, action, kind, recordId, versionId]. */
const actsOf = (records, surface) => records.filter(event => event.surface === surface).map(event => parseAccessEvent(event))
  .flatMap(event => event.targets.map(t => [STATUTORY_ACT[event.action], event.action, t.kind, t.recordId.value, t.versionId.value]));

// ── the Prisma double: tables in memory, transactions on a copy, every write recorded with its client ──

const MODEL = name => name[0].toUpperCase() + name.slice(1);
const UNIQUE = {
  studyState: [['uid']], report: [['uid']], reportDraft: [['uid', 'author'], ['uid', 'authorSub']], reportVersion: [['uid', 'version']],
  techNoteRevision: [['studyUid', 'version'], ['attemptId']], gatewayRetryRequest: [['studyUid', 'epoch', 'seq']],
  gatewayReceipt: [['studyUid']], institution: [['id']], order: [['oid']], memberRights: [['sub']], authSession: [['sid']],
  readerAssignment: [['studyUid', 'institutionId']], readingPreferences: [['institution', 'subject']],
  userFilter: [['owner', 'name']], userFilterCollection: [['owner']], sharedFilterLibrary: [['institution']],
};
const AUTO_ID = new Set(['auditLog', 'reportVersion', 'readingTemplate', 'userFilter', 'viewerItem']);
const DEFAULTS = {
  studyState: () => ({ teleInstitutionId: null, rs: 'W', ss: 'Unverified', em: 'N', ts: 'none', matched: 'U', ward: null,
    reqHosp: null, holder: null, heldAt: null, holdReason: null, preDoc: null, preReviewer: null, preDocSub: null,
    preReviewerSub: null, repDoc: null, confirm: null, ov: null, orig: null, orderOid: null, origin: 'device',
    qcReason: null, qcBy: null, qcAt: null, qcRevision: 0,
    // Referred: a row created without the two fields waits for its first Gateway announce (the database default).
    draftEpoch: randomUUID(), createdAt: new Date(), referredAt: null, referredOpen: true }),
  auditLog: () => ({ detail: null, at: new Date() }),
  reportVersion: () => ({ citations: null, structured: null, reason: null, at: new Date() }),
  reportDraft: () => ({ citations: null, structured: null, updatedAt: new Date() }),
  techNoteRevision: () => ({ attemptId: null, createdAt: new Date() }),
  report: () => ({ updatedAt: new Date() }),
  readerAssignment: () => ({ closedAt: null, revision: 0 }),
};
const copy = value => structuredClone(value);
const same = (a, b) => ((a instanceof Date || b instanceof Date) ? +a === +b : (a ?? null) === (b ?? null));
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
function cond(value, filter) {
  if (filter === undefined) return true;
  if (!plain(filter)) return same(value, filter);
  if ('path' in filter) { let at = value; for (const key of filter.path) at = at?.[key]; return !('equals' in filter) || same(at, filter.equals); }
  for (const [op, arg] of Object.entries(filter)) {
    if (op === 'equals') { if (!same(value, arg)) return false; }
    else if (op === 'in') { if (!arg.some(a => same(value, a))) return false; }
    else if (op === 'notIn') { if (arg.some(a => same(value, a))) return false; }
    else if (op === 'not') { if (plain(arg) ? cond(value, arg) : same(value, arg)) return false; }
    else if (op === 'lt') { if (!(value < arg)) return false; }
    else if (op === 'lte') { if (!(value <= arg)) return false; }
    else if (op === 'gt') { if (!(value > arg)) return false; }
    else if (op === 'gte') { if (!(value >= arg)) return false; }
    else if (op === 'has') { if (!(Array.isArray(value) && value.includes(arg))) return false; }
    else throw new Error('double: unsupported filter ' + op);
  }
  return true;
}
function matches(row, where) {
  for (const [key, filter] of Object.entries(where ?? {})) {
    if (key === 'OR') { if (!filter.some(w => matches(row, w))) return false; }
    else if (key === 'AND') { if (![].concat(filter).every(w => matches(row, w))) return false; }
    else if (key.includes('_') && plain(filter)) { if (!matches(row, filter)) return false; }   // compound unique key
    else if (!cond(row[key], filter)) return false;
  }
  return true;
}
const pick = (row, select) => (!select ? copy(row) : Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, copy(row[k] ?? null)])));
function sorted(rows, orderBy) {
  const keys = [].concat(orderBy ?? []).flatMap(o => Object.entries(o));
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = a[k] instanceof Date ? +a[k] : a[k], y = b[k] instanceof Date ? +b[k] : b[k];
      if (x === y) continue;
      return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}
function applyData(row, data) {
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v === undefined) continue;
    if (v === Prisma.DbNull || v === Prisma.JsonNull) row[k] = null;
    else if (plain(v) && Object.keys(v).length === 1 && 'increment' in v) row[k] = (row[k] ?? 0) + v.increment;
    else row[k] = copy(v);
  }
}

function prismaDouble() {
  const store = { tables: {}, writes: [], raw: [], transactions: 0, faults: [], seq: 0, handlers: [] };
  const fault = (model, op, label) => {
    const at = store.faults.findIndex(f => f.model === model && f.op === op && (!f.client || f.client === label));
    if (at >= 0) throw store.faults.splice(at, 1)[0].error;
  };
  const delegate = (ctx, name, label) => {
    const rows = () => (ctx.tables[name] ??= []);
    const wrote = op => store.writes.push({ client: label, model: name, op });
    const unique = row => {
      for (const keys of UNIQUE[name] ?? []) {
        if (keys.some(k => row[k] === null || row[k] === undefined)) continue;
        if (rows().some(other => keys.every(k => same(other[k], row[k]))))
          throw Object.assign(new Error(`Unique constraint failed on ${keys}`), { code: 'P2002', meta: { modelName: MODEL(name), target: keys } });
      }
    };
    const one = where => rows().find(row => matches(row, where));
    return {
      async findUnique({ where, select } = {}) { fault(name, 'findUnique', label); const row = one(where); return row ? pick(row, select) : null; },
      async findUniqueOrThrow(args) { const row = await this.findUnique(args); if (!row) throw Object.assign(new Error('missing'), { code: 'P2025' }); return row; },
      async findFirst({ where, orderBy, select } = {}) { const row = sorted(rows().filter(r => matches(r, where)), orderBy)[0]; return row ? pick(row, select) : null; },
      async findMany({ where, orderBy, select, take } = {}) {
        fault(name, 'findMany', label);
        const found = sorted(rows().filter(r => matches(r, where)), orderBy);
        return (take ? found.slice(0, take) : found).map(r => pick(r, select));
      },
      async count({ where } = {}) { return rows().filter(r => matches(r, where)).length; },
      async groupBy({ by, where } = {}) {
        const groups = new Map();
        for (const row of rows().filter(r => matches(r, where))) {
          const key = JSON.stringify(by.map(k => row[k]));
          if (!groups.has(key)) groups.set(key, { ...Object.fromEntries(by.map(k => [k, row[k]])), _count: { _all: 0 } });
          groups.get(key)._count._all++;
        }
        return [...groups.values()];
      },
      async create({ data, select }) {
        fault(name, 'create', label);
        wrote('create');
        const row = { ...(AUTO_ID.has(name) ? { id: ++store.seq } : {}), ...(DEFAULTS[name]?.() ?? {}) };
        applyData(row, data);
        unique(row);
        rows().push(row);
        return pick(row, select);
      },
      async createMany({ data }) { for (const item of [].concat(data)) await this.create({ data: item }); return { count: [].concat(data).length }; },
      async update({ where, data, select }) {
        fault(name, 'update', label);
        wrote('update');
        const row = one(where);
        if (!row) throw Object.assign(new Error('Record to update not found'), { code: 'P2025' });
        applyData(row, data);
        return pick(row, select);
      },
      async updateMany({ where, data }) {
        fault(name, 'updateMany', label);
        wrote('updateMany');
        const hit = rows().filter(r => matches(r, where));
        hit.forEach(r => applyData(r, data));
        return { count: hit.length };
      },
      async upsert({ where, create, update, select }) {
        wrote('upsert');
        const row = one(where);
        if (row) { applyData(row, update); return pick(row, select); }
        return this.create({ data: create, select });
      },
      async delete({ where }) { wrote('delete'); const at = rows().findIndex(r => matches(r, where)); if (at < 0) throw Object.assign(new Error('missing'), { code: 'P2025' }); return rows().splice(at, 1)[0]; },
      async deleteMany({ where } = {}) { wrote('deleteMany'); const keep = rows().filter(r => !matches(r, where)), n = rows().length - keep.length; ctx.tables[name] = keep; return { count: n }; },
    };
  };
  store.locks = new TransactionLocks();
  const raw = (ctx, label) => async (strings, ...params) => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim();
    store.raw.push({ client: label, sql, params });
    fault('$raw', sql, label);
    if (sql.startsWith('SELECT draft_account_author(')) return [{ author: 'account/' + params[0] }];
    if (sql.includes('pg_advisory_xact_lock') && typeof params[0] === 'string'
        && params[0].startsWith('["emr-fixed-record",')) {
      assert.notEqual(label, 'root');
      await store.locks.acquire(ctx, params[0]);
      return [{ locked: '' }];
    }
    for (const [pattern, answer] of [...store.handlers, ...BUILT_IN]) if (pattern.test(sql)) return answer(params, ctx.tables, label, store);
    throw new Error('double: unhandled SQL ' + sql);
  };
  const client = (ctx, label) => {
    const delegates = new Map();
    const target = {
      $executeRaw: raw(ctx, label), $queryRaw: raw(ctx, label),
      ...(label === 'root' ? { async $transaction(work, options) {
        if (typeof work !== 'function') throw new Error('double: batch transactions are not used by these concerns');
        store.transactions++;
        const scratch = { tables: copy(store.tables) };
        try {
          const out = await work(client(scratch, 'tx'), options);
          store.tables = scratch.tables;
          return out;
        } finally { store.locks.release(scratch); }
      } } : {}),
    };
    return new Proxy(target, { get(t, key) {
      if (key in t) return t[key];
      if (typeof key !== 'string' || key === 'then' || key.startsWith('$')) return undefined;
      if (!delegates.has(key)) delegates.set(key, delegate(ctx, key, label));
      return delegates.get(key);
    } });
  };
  // the root client reads store.tables as it is now (a committed transaction replaces it)
  const rootCtx = { get tables() { return store.tables; }, set tables(v) { store.tables = v; } };
  const root = client(rootCtx, 'root');
  store.root = root;
  store.rows = name => (store.tables[name] ??= []);
  store.seed = (name, row) => { const full = { ...(AUTO_ID.has(name) ? { id: ++store.seq } : {}), ...(DEFAULTS[name]?.() ?? {}), ...row }; store.rows(name).push(full); return full; };
  store.writesBy = client => store.writes.filter(w => w.client === client);
  return store;
}
const BUILT_IN = [
  [/^SELECT \* FROM "StudyState" WHERE uid IN \(\?\) ORDER BY uid FOR UPDATE$/, ([ids], t) => (t.studyState??[]).filter(r=>ids.values.includes(r.uid)).sort((a,b)=>a.uid.localeCompare(b.uid)).map(copy)],
  [/^SET LOCAL /, () => 0],
  [/pg_advisory_xact_lock/, () => [{ locked: 1 }]],
  [/^SELECT \* FROM "StudyState" WHERE uid ?= ?\? FOR (UPDATE|SHARE)$/, ([uid], t) => (t.studyState ?? []).filter(r => r.uid === uid).map(copy)],
  [/^SELECT uid FROM "StudyState" WHERE uid = \? FOR UPDATE$/, ([uid], t) => (t.studyState ?? []).filter(r => r.uid === uid).map(r => ({ uid: r.uid }))],
  [/^SELECT "institutionId", "teleInstitutionId" FROM "StudyState" WHERE uid = \? FOR (SHARE|NO KEY UPDATE)$/,
    ([uid], t) => (t.studyState ?? []).filter(r => r.uid === uid).map(r => ({ institutionId: r.institutionId, teleInstitutionId: r.teleInstitutionId }))],
  [/FROM "AuthSession" WHERE sid = \? FOR KEY SHARE$/, ([sid], t) => (t.authSession ?? []).filter(r => r.sid === sid).map(() => ({ held: 1 }))],
  [/FROM "ReportDraft" WHERE uid = \? AND "authorSub" = \? FOR UPDATE$/, ([uid, sub], t) => (t.reportDraft ?? []).filter(r => r.uid === uid && r.authorSub === sub).map(copy)],
  // CD-09-P: the commit judgement after a transaction that ended a draft work (draft-purpose judgeCommit) re-reads the end
  // row and the author's row from what committed.
  [/^SELECT 1 AS present FROM "ReportDraftPurposeEnd" WHERE "disposalUnitId" = \?$/,
    ([unit], t) => (t.reportDraftPurposeEnd ?? []).filter(r => r.disposalUnitId === unit).map(() => ({ present: 1 }))],
  [/^SELECT revision, present, "workUnit" FROM "ReportDraft" WHERE uid = \? AND author = \?$/,
    ([uid, author], t) => (t.reportDraft ?? []).filter(r => r.uid === uid && r.author === author)
      .map(r => ({ revision: r.revision, present: r.present, workUnit: r.workUnit ?? null }))],
  [/FROM "ReportDraft" WHERE uid = \? AND present ORDER BY author FOR UPDATE$/,
    ([uid], t) => sorted((t.reportDraft ?? []).filter(r => r.uid === uid && r.present), { author: 'asc' }).map(copy)],
  [/FROM "Report" WHERE uid = \? FOR UPDATE$/, ([uid], t) => (t.report ?? []).filter(r => r.uid === uid)
    .map(r => ({ version: r.version, updatedBy: r.updatedBy ?? null, updatedBySub: r.updatedBySub ?? null, findings: r.findings, conclusion: r.conclusion, recommendation: r.recommendation }))],
  [/^SELECT octet_length\(convert_to\(\?::jsonb::text, 'UTF8'\)\) AS bytes$/, ([text]) => [{ bytes: Buffer.byteLength(String(text), 'utf8') }]],
  [/FROM "TechNoteRevision" n JOIN "StudyState" s/, () => []],
  [/FROM "ReportVersion" v JOIN "StudyState" s ON s.uid = v.uid WHERE v.action = 'approve'/, () => []],
  [/^SELECT a\.\*, CASE .* FROM "AuditLog" a LEFT JOIN "StudyState" s/, () => []],
  [/^SELECT id, name, "dicomNames", "dicomAets" FROM "Institution" ORDER BY id FOR UPDATE$/,
    (_p, t) => sorted(t.institution ?? [], { id: 'asc' }).map(r => ({ dicomAets: '', ...copy(r) }))],
  [/^SELECT s\.uid, s\."institutionId", s\."teleInstitutionId", s\.rs, s\."repDoc", s\.confirm, COALESCE\(r\.version, 0\) AS version, v\.action, r\.findings, r\.conclusion, r\.recommendation, r\."groupId", r\."updatedBy", r\."updatedBySub" FROM "StudyState" s/,
    ([uids], t) => uids.values.map(uid => {
      const s = (t.studyState ?? []).find(r => r.uid === uid);
      if (!s) return null;
      const r = (t.report ?? []).find(x => x.uid === uid), v = r && (t.reportVersion ?? []).find(x => x.uid === uid && x.version === r.version);
      return { uid, institutionId: s.institutionId, teleInstitutionId: s.teleInstitutionId, rs: s.rs, repDoc: s.repDoc, confirm: s.confirm,
        version: r?.version ?? 0, action: v?.action ?? null, findings: r?.findings ?? null, conclusion: r?.conclusion ?? null, recommendation: r?.recommendation ?? null, groupId: r?.groupId ?? null, updatedBy: r?.updatedBy ?? null, updatedBySub: r?.updatedBySub ?? null };
    }).filter(Boolean)],
];

// ── the other value providers ──

function studyAccessDouble() {
  const sa = { denied: new Set(), restricted: false, calls: [], onPrepare: null,
    async snapshot(c, tx) { sa.calls.push(['snapshot', tx ? 'tx' : 'root']); return { revision: 1, windowOpen: true, policy: { restricted: sa.restricted, rules: [] } }; },
    async prepare(c, uids) { sa.calls.push(['prepare', uids ?? null]); if (sa.onPrepare) { const hook = sa.onPrepare; sa.onPrepare = null; await hook(); } },
    async require(c, uids, tx) { sa.calls.push(['require', uids, tx ? 'tx' : 'root']); if (uids.some(uid => sa.denied.has(uid))) throw new NotFoundException('검사를 찾을 수 없습니다'); },
    async allowed(c, uids) { return new Set(uids.filter(uid => !sa.denied.has(uid))); },
    matches(_snapshot, uid) { return !sa.denied.has(uid); },
    needsMetadata() { return false; },
    async unchanged(_c, previous) { return previous; },
    // WORKLIST-SPLIT-UID: the request's source observation. `split` names the UIDs two patient resources answer.
    split: new Set(),
    observeSourceIdentities() {},
    assertIdentifiedSource(c,uid) { sa.assertUnsplitSource(c,uid); return {sourcePatientId:'SYN-P',sourceInstitution:'synthetic'}; },
    async prepareSourceIdentity(c, uids) { sa.calls.push(['source', uids]); },
    assertUnsplitSource(c, uid) {
      sa.calls.push(['source:assert', uid]);
      if (sa.split.has(uid)) throw new ConflictException({ code: 'STUDY_IDENTITY_UNRESOLVED', message: 'synthetic split' });
      return { sourcePatientId: null, sourceInstitution: null };
    },
  };
  return sa;
}
const qido = (uid, institutionName, extra = {}) => ({ '0020000D': { Value: [uid] }, '00080080': { Value: [institutionName] },
  '00100020': { Value: ['PID-' + uid.slice(-3)] }, '00100010': { Value: [{ Alphabetic: 'SYN^PATIENT' }] }, ...extra });
function orthancDouble() {
  const o = { rows: [], statisticsAnswer: null,
    async studies() { return copy(o.rows); },
    async studyIdentities() { return copy(o.rows); },
    devices: {},   // D1882: the calling AE title Orthanc recorded per study UID
    async sendingDevice(uid) { return o.devices[uid] ?? null; },
    // An arriving instance changes a study's stamp; a case sets `stamps[uid]` when one arrives.
    stamps: {},
    async studyArrivalStamp(uid) { return o.rows.some(r => r['0020000D'].Value[0] === uid) ? String(o.stamps[uid] ?? 0) : null; },
    async studiesByUid(uids) { return copy(o.rows.filter(r => uids.includes(r['0020000D'].Value[0]))); },
    async statistics() { if (o.statisticsAnswer instanceof Error) throw o.statisticsAnswer; return o.statisticsAnswer; },
    async instanceStudyUid() { throw new Error('double: not used'); },
    async lookupInstance() { return []; },
  };
  return o;
}

const INST_A = 'syn-a', INST_B = 'syn-b';
const member = (name, institution, roles) => ({ kind: 'member', sub: 'syn-sub-' + name, actor: `syn-${name}@synthetic.test`, roles, institution });
const RAD_A = member('rad-a', INST_A, ['radiologist']), RAD_A2 = member('rad-a2', INST_A, ['radiologist']);
const TECH_A = member('tech-a', INST_A, ['technician']), ADMIN_A = member('admin-a', INST_A, ['admin']);
const RAD_B = member('rad-b', INST_B, ['radiologist']), TECH_B = member('tech-b', INST_B, ['technician']), ADMIN_B = member('admin-b', INST_B, ['admin']);
const CLIN_A = member('clin-a', INST_A, ['clinician']);
const GATEWAY_A = { kind: 'gateway', sub: 'syn-gw-a', actor: 'syn-gw-a', roles: ['gateway'], institution: INST_A };
const storedAuthor = (w, uid, c) => w.db.rows('reportDraft').find(row => row.uid === uid && row.authorSub === c.sub).author;
const ownerOf = c => ({ institution: c.institution, sub: c.sub, author: c.actor });
const WRITE_FACTS = { actor: { identity: { id: '00000000-0000-4000-8000-0000000000c1', issuer: 'https://idp.synthetic.test', subject: TECH_A.sub },
  kind: 'member', roles: TECH_A.roles, institutionId: INST_A, signingRegistrationId: null }, requestId: 'syn-request-study',
  ip: { status: 'known', value: { address: '127.0.0.1', source: 'request-peer' } } };
let serial = 0;
const uidOf = () => `1.2.840.99999.${process.pid}.${++serial}`;

/** The concern graph as the facade composes it: every concern gets the one instance of each provider and of its suppliers. */
function world() {
  const db = prismaDouble(), sa = studyAccessDouble(), orthanc = orthancDouble();
  const keycloak = { roster: [], async usersInGroupWithRole() { return copy(keycloak.roster); } };
  const findings = { readable: new Set(), async readableFindings(_tx, _c, _uid, ids) { return ids.filter(id => findings.readable.has(id)).map(id => ({ id })); } };
  const prisma = db.root;
  const access = new PacsAccess(prisma, sa);
  const institutions = new PacsInstitutions(prisma, orthanc, keycloak, sa, access);
  const preferences = new PacsPreferences(prisma);
  const filters = new PacsFilters(prisma);
  const audit = new PacsAudit(prisma, sa, access);
  const metrics = new PacsMetrics(prisma, orthanc, sa, access);
  const worklist = new PacsWorklist(prisma, orthanc, sa, access, institutions, preferences, audit);
  const gateway = new PacsDicomGateway(prisma, orthanc, sa, access, institutions);
  const studyState = new PacsStudyState(prisma, sa, access, institutions, audit);
  const techNote = new PacsTechNote(prisma, sa, access);
  const hold = new PacsHold(prisma, sa, access);
  const clinician = new PacsClinician(prisma, sa, access, worklist);
  const evidence = new PacsReportEvidence(prisma, sa, findings, access);
  const records = [];
  const draft = withDraftRequestContext(new PacsReportDraft(prisma, sa, access, audit, evidence, b2Ledger(prisma)), b2Ledger(prisma, records));
  const commit = withDraftRequestContext(new PacsReportCommit(keycloak, sa, evidence, draft, nativeSigning), b2Ledger(prisma));
  // Study writes run in the real request records transaction (ClinicalRoutes.workflow) over the B2 double: `writes` keeps
  // the access events their committed transactions appended.
  const writes = [];
  const routes = new ClinicalRoutes({ records: b2Ledger(prisma, writes), context: { facts: async () => WRITE_FACTS,
    scope: async (_tx, _request, uid) => ({ studyId: uid, managingInstitutionId: INST_A, teleInstitutionId: null }) } }, null);
  const clinical = {
    read: (_request, _kind, _id, read) => prisma.$transaction(read),
    write: async (_request, _input, write) => ({ ...await prisma.$transaction(write), emr: { replayed: false } }),
    workflow: (request, execute) => routes.workflow(request, execute),
    recorder: request => execute => routes.workflow(request, execute),
  };
  const w = { db, sa, orthanc, keycloak, findings, access, institutions, preferences, filters, audit, metrics, worklist, gateway,
    studyState, techNote, hold, clinician, evidence, draft, commit, records, writes };
  /** The PacsService facade over the same providers: it builds and owns its own concern graph. */
  w.facade = () => withDraftRequestContext(new PacsService(prisma, orthanc, keycloak, sa, findings, b2Ledger(prisma), nativeSigning, clinical), b2Ledger(prisma));
  w.workflow = execute => clinical.workflow({}, execute);
  w.recorder = clinical.recorder({});
  w.study = (fields = {}) => db.seed('studyState', { uid: uidOf(), institutionId: INST_A, ss: 'Verified', ...fields });
  w.audits = (action) => db.rows('auditLog').filter(row => !action || row.action === action);
  /** Starts the institutions concern as the facade's onModuleInit does: two synthetic institutions beside the seeds. */
  w.boot = async () => {
    db.seed('institution', { id: INST_A, name: 'SYN A', type: 'hospital', dicomNames: 'SYN A HOSPITAL' });
    db.seed('institution', { id: INST_B, name: 'SYN B', type: 'center', dicomNames: 'SYN B CENTER' });
    const log = console.log; console.log = () => {};
    try { await institutions.onModuleInit(); } finally { console.log = log; }
  };
  return w;
}

async function refused(work, status, code) {
  let error = null;
  try { await work(); } catch (e) { error = e; }
  assert.ok(error, `expected a ${status} refusal, the call succeeded`);
  assert.ok(error instanceof HttpException, `expected an HTTP refusal, got ${error?.stack ?? error}`);
  assert.equal(error.getStatus(), status, JSON.stringify(error.getResponse()));
  if (code !== undefined) assert.equal(error.getResponse()?.code, code, JSON.stringify(error.getResponse()));
  return error.getResponse();
}
const draftBody = (c, epoch, revision, text = {}) => ({ expectedOwner: ownerOf(c), expectedRevision: `${epoch}:${revision}`,
  findings: '', conclusion: '', recommendation: '', baseVersion: 0, citationIds: [], structureIds: [], ...text });
const commitBody = (c, action, epoch, revision, baseVersion, text = {}) => ({ action, expectedOwner: ownerOf(c),
  expectedRevision: `${epoch}:${revision}`, baseVersion, citationIds: [], removeCitationIds: [], structureIds: [],
  findings: '', conclusion: '', recommendation: '', ...text });

// ── SPLIT-01 construction ──

test('SPLIT-01 every concern is built from references alone: constructing touches no provider, opens no timer and seeds nothing', () => {
  const touched = [];
  const trap = name => new Proxy({}, { get(_t, key) { touched.push(`${name}.${String(key)}`); throw new Error(`${name} touched while constructing`); } });
  const timers = process.getActiveResourcesInfo().filter(kind => kind === 'Timeout').length;
  const [prisma, orthanc, keycloak, sa, findings] = ['prisma', 'orthanc', 'keycloak', 'studyAccess', 'findings'].map(trap);
  const access = new PacsAccess(prisma, sa);
  const institutions = new PacsInstitutions(prisma, orthanc, keycloak, sa, access);
  const preferences = new PacsPreferences(prisma);
  const audit = new PacsAudit(prisma, sa, access);
  const worklist = new PacsWorklist(prisma, orthanc, sa, access, institutions, preferences, audit);
  const evidence = new PacsReportEvidence(prisma, sa, findings, access);
  const draft = withDraftRequestContext(new PacsReportDraft(prisma, sa, access, audit, evidence, b2Ledger(prisma)), b2Ledger(prisma));
  new PacsFilters(prisma); new PacsMetrics(prisma, orthanc, sa, access); new PacsDicomGateway(prisma, orthanc, sa, access, institutions);
  new PacsStudyState(prisma, sa, access, institutions, audit); new PacsTechNote(prisma, sa, access); new PacsHold(prisma, sa, access);
  new PacsClinician(prisma, sa, access, worklist); new PacsReportCommit(keycloak, sa, evidence, draft, nativeSigning);
  assert.deepEqual(touched, []);
  assert.equal(process.getActiveResourcesInfo().filter(kind => kind === 'Timeout').length, timers);
  // the institution cache is empty until the facade's onModuleInit starts it
  assert.equal(institutions.instName(INST_A), '(미배정)');
  assert.equal(institutions.resolveInstitution('SYN A HOSPITAL'), null);
});

// ── SPLIT-02 values ──

test('SPLIT-02 QIDO counts keep unknown apart from zero, and a hold lives five minutes', () => {
  const tag = value => ({ '00201208': { Value: [value] } });
  assert.equal(values.qidoCount({}, '00201208'), null);
  assert.equal(values.qidoCount(tag(''), '00201208'), null);
  for (const bad of ['-1', '1.5', '1e3', 'x', ' ', null]) assert.equal(values.qidoCount(tag(bad), '00201208'), null, String(bad));
  assert.equal(values.qidoCount(tag('0'), '00201208'), 0);
  assert.equal(values.qidoCount(tag(' 12 '), '00201208'), 12);
  assert.equal(values.qidoCount(tag('+3'), '00201208'), 3);
  assert.equal(values.qidoCount(tag(7), '00201208'), 7);
  const at = ms => ({ holder: 'x', heldAt: new Date(Date.now() - ms) });
  assert.ok(values.holdAlive(at(4 * 60_000 + 59_000)));
  assert.ok(!values.holdAlive(at(5 * 60_000 + 1_000)));
  assert.ok(!values.holdAlive({ holder: null, heldAt: new Date() }));
  // a cleared value is sent as null, never left out, and another reader's draft never rides along
  const state = values.toClient({ rs: 'W', draftEpoch: randomUUID(), holder: 'gone', heldAt: new Date(Date.now() - 6 * 60_000) }, null, RAD_A, null);
  for (const key of ['holder', 'preDoc', 'repDoc', 'confirm', 'ov', 'orig', 'oid', 'draft', 'institutionId']) assert.equal(state[key], null, key);
});

// ── SPLIT-03 roles, institution, gateway identity ──

test('SPLIT-03 roles and identity: need admits the role or admin, gateway routes admit only the gateway identity, an account needs an institution', async () => {
  assert.doesNotThrow(() => need(RAD_A.roles, 'radiologist', 'x'));
  assert.doesNotThrow(() => need(ADMIN_A.roles, 'radiologist', 'x'));
  await refused(() => need(TECH_A.roles, 'radiologist', '판독문 확정'), 403);
  assert.doesNotThrow(() => needExact(GATEWAY_A, 'gateway', 'x'));
  await refused(() => needExact({ ...ADMIN_A, roles: ['admin', 'gateway'] }, 'gateway', 'x'), 403);
  assert.equal(inst(RAD_A), INST_A);
  await refused(() => inst({ ...ADMIN_A, institution: null }), 403);
});

// ── SPLIT-04 tenant boundary (M01, M03b) ──

test('SPLIT-04 a study is reachable by its owner and its tele receiver only; admin of another institution gets the same 404 as a stranger', async () => {
  const w = world();
  const own = w.study(), tele = w.study({ teleInstitutionId: INST_B });
  assert.equal((await w.access.gate(own.uid, RAD_A)).uid, own.uid);
  assert.equal((await w.access.gate(tele.uid, RAD_B)).uid, tele.uid, 'the tele receiver reaches the study');
  for (const c of [RAD_B, ADMIN_B]) await refused(() => w.access.gate(own.uid, c), 404);
  assert.equal(await w.access.gate('1.2.3.404', RAD_A), null, 'an unknown study is answered as absent by gate');
  w.sa.denied.add(own.uid);
  await refused(() => w.access.gate(own.uid, RAD_A), 404);
  // the same boundary on reads built on it: history, audit trail, hold
  w.sa.denied.clear();
  await refused(() => w.evidence.versions(own.uid, ADMIN_B), 404);
  await refused(() => w.audit.audits(own.uid, 10, ADMIN_B), 404);
  await refused(() => w.hold.forceRelease(own.uid, ADMIN_B), 404);
  assert.deepEqual(await w.hold.hold(tele.uid, RAD_B), { holder: RAD_B.actor, mine: true, conflict: false });
});

// ── SPLIT-05 the write gate re-checks inside the transaction (M03) ──

test('SPLIT-05 access withdrawn between preparation and the transaction refuses the write; the write and its audit row roll back together', async () => {
  const w = world();
  const s = w.study();
  w.sa.onPrepare = async () => { w.sa.denied.add(s.uid); };
  await refused(() => w.hold.hold(s.uid, RAD_A), 404);
  assert.equal(w.db.rows('studyState')[0].holder, null);
  assert.equal(w.audits().length, 0);
  // scopeWrite: same refusal, then a failing audit row takes the state write back with it
  w.sa.denied.clear();
  w.sa.onPrepare = async () => { w.sa.denied.add(s.uid); };
  await refused(() => w.studyState.patchState(s.uid, { em: 'E' }, TECH_A), 404);
  w.sa.denied.clear();
  const boom = new Error('audit store down');
  w.db.faults.push({ model: 'auditLog', op: 'create', client: 'tx', error: boom });
  await assert.rejects(() => w.studyState.patchState(s.uid, { em: 'E' }, TECH_A), error => error === boom);
  assert.equal(w.db.rows('studyState').find(r => r.uid === s.uid).em, 'N');
  const saved = await w.studyState.patchState(s.uid, { em: 'E' }, TECH_A);
  assert.equal(saved.em, 'E');
  assert.deepEqual(w.audits().map(a => a.action), ['state.patch']);
  assert.deepEqual(w.db.writesBy('root'), [], 'every write went through the transaction');
});

// ── SPLIT-06 PATCH cannot touch the report lifecycle; tele transitions keep their owners (M07) ──

test('SPLIT-06 PATCH refuses report-owned fields without writing anything; technician fields need the technician role and the owning institution', async () => {
  const w = world();
  await w.boot();
  const s = w.study(), booted = w.db.writes.length;
  const since = () => w.db.writes.slice(booted);
  for (const field of ['rs', 'repDoc', 'confirm', 'matched', 'orig', 'holdReason']) {
    await refused(() => w.studyState.patchState(s.uid, { [field]: 'A', ss: 'Verified', em: 'E' }, TECH_A), 400);
  }
  assert.deepEqual(since(), []);
  assert.equal(w.db.rows('studyState').find(r => r.uid === s.uid).em, 'N');
  await refused(() => w.studyState.patchState(s.uid, { ss: 'Verified' }, RAD_A), 403);
  const tele = w.study({ teleInstitutionId: INST_B, ts: 'sent' });
  await refused(() => w.studyState.patchState(tele.uid, { em: 'E' }, TECH_B), 403);
  assert.deepEqual(since(), []);
  // the owner requests tele reading to B, then cancels it: the channel closes and B's reader assignment closes with it
  const out = await w.studyState.patchState(s.uid, { ts: 'wait', teleTo: INST_B }, RAD_A);
  assert.equal(out.teleInstitutionId, INST_B);
  w.db.seed('readerAssignment', { studyUid: s.uid, institutionId: INST_B, revision: 1, readerSub: RAD_B.sub, readerActor: RAD_B.actor, readerName: 'B' });
  await refused(() => w.studyState.patchState(s.uid, { ts: 'wait', teleTo: 'nowhere' }, RAD_A), 400);
  const cancelled = await w.workflow(workflow => w.studyState.patchState(s.uid, { ts: 'cancelled' }, RAD_A, workflow));
  assert.equal(cancelled.teleInstitutionId, null);
  const assignment = w.db.rows('readerAssignment')[0];
  assert.ok(assignment.closedAt instanceof Date);
  assert.equal(assignment.readerSub, null);
  assert.deepEqual(w.audits().map(a => a.action), ['state.patch', 'reader.assignment', 'state.patch']);
});

// ── SPLIT-25 의료법 제23조④ study writes ──

test('SPLIT-25 PATCH, DELETE, match and unmatch each commit one 수정 record of the study, versioned by the audit row that holds the change; a refusal records none', async () => {
  const w = world();
  await w.boot();
  const written = () => w.writes.filter(event => event.surface !== 'server:reader-assignment-close').map(event => parseAccessEvent(event))
    .map(event => [event.surface, event.targets[0].kind, event.targets[0].recordId.value, event.targets[0].versionId.value,
      event.managingInstitution.value, event.action, STATUTORY_ACT[event.action]]);
  const auditId = action => String(w.audits(action).at(-1).id);
  const s = w.study();
  await w.workflow(workflow => w.studyState.patchState(s.uid, { em: 'E' }, TECH_A, workflow));
  const metadata = auditId('state.patch');
  await w.workflow(workflow => w.studyState.patchState(s.uid, { ov: { name: 'SYN NEW' } }, TECH_A, workflow));
  const correction = auditId('state.patch');
  await refused(() => w.workflow(workflow => w.studyState.patchState(s.uid, { rs: 'A' }, TECH_A, workflow)), 400);
  assert.deepEqual(written(), [['PATCH studies/:uid', 'study-metadata', s.uid, metadata, INST_A, 'modify', '수정'],
    ['PATCH studies/:uid', 'study-correction', s.uid, correction, INST_A, 'modify', '수정']]);

  const m = w.study();
  w.db.seed('order', { oid: 'syn-order-1', institutionId: INST_A, matched: 'U', studyUid: null, patientId: 'SYN-PID', name: 'SYN^PATIENT',
    sex: 'O', birth: '19700101', descr: 'SYN CT', ward: '' });
  await w.studyState.match(m.uid, 'syn-order-1', { orig: null }, TECH_A, w.recorder);
  const matched = auditId('match');
  await w.workflow(workflow => w.studyState.unmatch(m.uid, TECH_A, workflow));
  const unmatched = auditId('unmatch');
  await refused(() => w.workflow(workflow => w.studyState.unmatch(m.uid, TECH_A, workflow)), 400);
  const d = w.study();
  await w.workflow(workflow => w.studyState.removeState(d.uid, TECH_A, workflow));
  assert.deepEqual(written().slice(2), [['POST match', 'patient-match', m.uid, matched, INST_A, 'modify', '수정'],
    ['POST unmatch', 'patient-match', m.uid, unmatched, INST_A, 'modify', '수정'],
    ['DELETE studies/:uid', 'study-metadata', d.uid, auditId('state.delete'), INST_A, 'modify', '수정']]);
});

// ── SPLIT-07 commit: append-only history, the approved report's two exits, the role (M02, M04, M06) ──

test('SPLIT-07 commit appends one version per decision; an approved report leaves only by addendum or reset; a technician cannot commit', async () => {
  const w = world();
  const s = w.study();
  const epoch = s.draftEpoch;
  await refused(() => w.commit.commitReport(s.uid, commitBody(TECH_A, 'save', epoch, 0, 0, { findings: 't' }), TECH_A, null), 403);
  assert.deepEqual([w.db.transactions, w.db.writes.length], [0, 0], 'the refused caller opened no transaction and wrote nothing');

  const saved = await w.commit.commitReport(s.uid, commitBody(RAD_A, 'save', epoch, 0, 0, { findings: 'first text' }), RAD_A, null);
  assert.equal(saved.state.rs, 'T');
  const approved = await w.commit.commitReport(s.uid, commitBody(RAD_A, 'approve', epoch, 1, 1, { findings: 'second text' }), RAD_A, null);
  assert.equal(approved.state.rs, 'A');
  assert.equal(approved.state.repDoc, RAD_A.actor.split('@')[0]);
  const history = () => w.db.rows('reportVersion').filter(v => v.uid === s.uid).map(v => [v.version, v.action, v.findings]);
  assert.deepEqual(history(), [[1, 'save', 'first text'], [2, 'approve', 'second text']]);

  for (const action of ['approve', 'save']) {
    await refused(() => w.commit.commitReport(s.uid, commitBody(RAD_A2, action, epoch, 0, 2, { findings: 'quiet change' }), RAD_A2, null), 400);
  }
  assert.deepEqual(history(), [[1, 'save', 'first text'], [2, 'approve', 'second text']]);
  assert.equal(w.db.rows('studyState')[0].rs, 'A');
  const addendum = await w.commit.commitReport(s.uid, commitBody(RAD_A2, 'addendum', epoch, 0, 2, { findings: 'second text + addendum' }), RAD_A2, null);
  assert.equal(addendum.state.rs, 'A');
  await refused(() => w.commit.commitReport(s.uid, commitBody(RAD_A, 'reset', epoch, 2, 3), RAD_A, null), 400);
  const reset = await w.commit.commitReport(s.uid, commitBody(RAD_A, 'reset', epoch, 2, 3, { reason: 'wrong patient' }), RAD_A, null);
  assert.equal(reset.state.rs, 'W');
  assert.deepEqual(history(), [[1, 'save', 'first text'], [2, 'approve', 'second text'], [3, 'addendum', 'second text + addendum'],
    [4, 'discarded', 'second text + addendum'], [5, 'reset', '']]);
  const stored = copy(w.db.rows('reportVersion'));
  for (const caller of [RAD_A, RAD_A2]) {
    const versions = readBody(await w.evidence.versions(s.uid, caller));
    const safety = versions.find(row => row.version === 4);
    assert.equal(safety.author, RAD_A2.actor, 'the signed author remains visible in their Reset copy');
    assert.equal(safety.reason, `판독 취소로 폐기 (취소자: ${RAD_A.actor})`);
    assert.equal(versions.find(row => row.action === 'reset').reason, 'wrong patient');
  }
  assert.deepEqual(w.db.rows('reportVersion'), stored);
  assert.deepEqual(w.audits().map(a => a.action), ['report.save', 'report.approve', 'report.addendum', 'report.reset']);
  assert.deepEqual(w.db.writesBy('root'), []);
});

// ── SPLIT-08 Preliminary: only the designated senior approves (M05) ──

test('SPLIT-08 a preliminary report is approved by its designated senior only; its author cannot approve it, and a save keeps it preliminary', async () => {
  const w = world();
  const s = w.study({ rs: 'P', preDoc: RAD_A.actor, preDocSub: RAD_A.sub, preReviewer: RAD_A2.actor, preReviewerSub: RAD_A2.sub });
  w.db.seed('report', { uid: s.uid, findings: 'prelim', conclusion: '', recommendation: '', version: 1, updatedBy: RAD_A.actor, updatedBySub: RAD_A.sub });
  w.db.seed('reportVersion', { uid: s.uid, version: 1, action: 'preliminary', findings: 'prelim', conclusion: '', recommendation: '', author: RAD_A.actor, authorSub: RAD_A.sub });
  const epoch = s.draftEpoch;
  await refused(() => w.commit.commitReport(s.uid, commitBody(RAD_A, 'approve', epoch, 0, 1, { findings: 'self' }), RAD_A, null), 403);
  assert.equal(w.db.rows('reportVersion').length, 1);
  const kept = await w.commit.commitReport(s.uid, commitBody(RAD_A, 'save', epoch, 0, 1, { findings: 'prelim 2' }), RAD_A, null);
  assert.equal(kept.state.rs, 'P');
  await refused(() => w.commit.commitReport(s.uid, commitBody(RAD_B, 'approve', epoch, 0, 2), RAD_B, null), 404);
  const done = await w.commit.commitReport(s.uid, commitBody(RAD_A2, 'approve', epoch, 0, 2, { findings: 'final' }), RAD_A2, null);
  assert.equal(done.state.rs, 'A');
  assert.deepEqual(w.db.rows('reportVersion').map(v => v.action), ['preliminary', 'save', 'approve']);
});

// ── report state table: a Save is read by the physician who wrote it; others see who is on it (report-visibility.ts) ──

test('report state table: another radiologist sees In Progress by the writer, never the saved text, and cannot write over it; Reset still takes it over', async () => {
  const w = world();
  await w.boot();
  const s = w.study({ teleInstitutionId: INST_B });
  w.orthanc.rows = [qido(s.uid, 'SYN A HOSPITAL')];
  const epoch = s.draftEpoch;
  const saved = await w.commit.commitReport(s.uid, commitBody(RAD_A, 'save', epoch, 0, 0, { findings: 'SYN SAVED TEXT' }), RAD_A, null);
  assert.deepEqual([saved.state.rs, saved.state.findings, saved.state.bodyLock, saved.state.prelimHidden], ['T', 'SYN SAVED TEXT', null, false]);
  const stateOf = async c => (await w.worklist.bootstrap(c)).states[s.uid];
  const listed = async c => (await w.worklist.listStudies(c)).studies.find(r => r.uid === s.uid).state;
  for (const read of [stateOf, listed]) {
    const mine = await read(RAD_A);
    assert.deepEqual([mine.findings, mine.bodyLock, mine.prelimHidden, mine.savedBy], ['SYN SAVED TEXT', null, false, RAD_A.actor]);
    // the same institution, the tele-reading institution, an administrator and a technician: state and writer, no text
    for (const c of [RAD_A2, RAD_B, ADMIN_A, TECH_A]) {
      const other = await read(c);
      assert.deepEqual([other.rs, other.findings, other.bodyLock, other.prelimHidden, other.savedBy, other.draft],
        ['T', '', 'in-progress', true, RAD_A.actor, null], c.actor);
    }
  }
  // the history keeps the row and its writer and withholds the text
  const history = readBody(await w.evidence.versions(s.uid, RAD_A2));
  assert.deepEqual(history.map(v => [v.action, v.author, v.findings, v.bodyHidden]), [['save', RAD_A.actor, '', 'in-progress']]);
  assert.equal(readBody(await w.evidence.versions(s.uid, RAD_A))[0].findings, 'SYN SAVED TEXT');
  // the head's evidence reads, the writes and the hold are refused with one code
  for (const read of [() => w.evidence.reportCitations(s.uid, RAD_A2), () => w.evidence.reportStructure(s.uid, RAD_A2),
    () => w.evidence.reportDrawings(s.uid, RAD_A2)]) await refused(read, 403, 'REPORT_IN_PROGRESS');
  for (const action of ['save', 'approve', 'defer'])
    await refused(() => w.commit.commitReport(s.uid, commitBody(RAD_A2, action, epoch, 0, 1, { findings: 'over it', reason: 'r' }), RAD_A2, null), 403, 'REPORT_IN_PROGRESS');
  await refused(() => w.draft.putReport(s.uid, draftBody(RAD_A2, epoch, 0, { findings: 'beside it', baseVersion: 1 }), RAD_A2, null), 403, 'REPORT_IN_PROGRESS');
  await refused(() => w.hold.hold(s.uid, RAD_A2), 403, 'REPORT_IN_PROGRESS');
  assert.deepEqual(w.db.rows('reportVersion').map(v => [v.action, v.findings]), [['save', 'SYN SAVED TEXT']]);
  // the writer keeps writing; the hold and the heartbeat stay theirs
  assert.deepEqual(await w.hold.hold(s.uid, RAD_A), { holder: RAD_A.actor, mine: true, conflict: false });
  await w.hold.release(s.uid, RAD_A);
  // Reset of an in-progress report (no reason) is still open to the other radiologist: the text goes to its writer's draft
  const reset = await w.commit.commitReport(s.uid, commitBody(RAD_A2, 'reset', epoch, 0, 1), RAD_A2, null);
  assert.deepEqual([reset.state.rs, reset.state.findings, reset.state.bodyLock, reset.released.savedBy], ['W', '', null, RAD_A.actor]);
  const after = await stateOf(RAD_A2);
  assert.deepEqual([after.rs, after.bodyLock, after.prelimHidden], ['W', null, false]);
  assert.equal((await stateOf(RAD_A)).draft.findings, 'SYN SAVED TEXT');
  // the Reset copy of the saved text stays with its writer
  const copies = readBody(await w.evidence.versions(s.uid, RAD_A2)).filter(v => v.action === 'discarded');
  assert.deepEqual(copies.map(v => [v.findings, v.bodyHidden]), [['', 'in-progress']]);
  assert.equal(readBody(await w.evidence.versions(s.uid, RAD_A)).find(v => v.action === 'discarded').findings, 'SYN SAVED TEXT');
});

test('report state table: a Save of drawings alone belongs to its writer too - locked for others, Reset keeps the drawings with the writer', async () => {
  const w = world();
  await w.boot();
  const s = w.study({ rs: 'T' });
  w.orthanc.rows = [qido(s.uid, 'SYN A HOSPITAL')];
  const drawings = [{ id: '00000000-0000-4000-8000-0000000000d1', background: 'blank', source: null }];
  w.db.seed('report', { uid: s.uid, findings: '', conclusion: '', recommendation: '', version: 1, updatedBy: RAD_A.actor, updatedBySub: RAD_A.sub });
  w.db.seed('reportVersion', { uid: s.uid, version: 1, action: 'save', findings: '', conclusion: '', recommendation: '', author: RAD_A.actor, authorSub: RAD_A.sub, drawings });
  const other = (await w.worklist.bootstrap(RAD_A2)).states[s.uid];
  assert.deepEqual([other.bodyLock, other.prelimHidden, other.savedBy], ['in-progress', true, RAD_A.actor]);
  const mine = (await w.worklist.bootstrap(RAD_A)).states[s.uid];
  assert.deepEqual([mine.bodyLock, mine.prelimHidden, mine.savedBy], [null, false, RAD_A.actor]);
  // a clinician as another radiologist: locked, and the detail read carries no saved drawing
  const clin = (await w.worklist.bootstrap(CLIN_A)).states[s.uid];
  assert.deepEqual([clin.bodyLock, clin.prelimHidden, clin.savedBy], ['in-progress', true, RAD_A.actor]);
  const clinRead = readBody(await w.clinician.clinicianReportRead(s.uid, CLIN_A));
  assert.deepEqual([clinRead.report.rs, clinRead.drawings], ['T', undefined]);
  await refused(() => w.commit.commitReport(s.uid, commitBody(RAD_A2, 'save', s.draftEpoch, 0, 1, { findings: 'over it' }), RAD_A2, null), 403, 'REPORT_IN_PROGRESS');
  await refused(() => w.hold.hold(s.uid, RAD_A2), 403, 'REPORT_IN_PROGRESS');
  const reset = await w.commit.commitReport(s.uid, commitBody(RAD_A2, 'reset', s.draftEpoch, 0, 1), RAD_A2, null);
  assert.deepEqual([reset.released.savedBy, reset.released.savedKept], [RAD_A.actor, false]);
  assert.equal(w.db.rows('reportDraft').filter(d => d.uid === s.uid && d.authorSub === RAD_A.sub && d.present).length, 0, 'no empty draft is made for the writer');
  const copy = w.db.rows('reportVersion').find(v => v.uid === s.uid && v.action === 'discarded');
  assert.ok(copy, 'the Reset keeps a copy of the drawings-only Save');
  assert.deepEqual(copy.drawings.map(d => d.id), drawings.map(d => d.id));
  assert.equal(readBody(await w.evidence.versions(s.uid, RAD_A2)).find(v => v.action === 'discarded').bodyHidden, 'in-progress');
  assert.equal(readBody(await w.evidence.versions(s.uid, RAD_A)).find(v => v.action === 'discarded').bodyHidden, undefined);
});
test('report state table: a list or bootstrap that read the heads while commits landed never pairs a state with a head of another moment', async () => {
  // An approved study; while the heads are read, its writer resets and Saves new text (T), then approves again (A) before
  // the answer is checked. The state read before and after is A both times; only the head version moved.
  const setup = async () => {
    const w = world();
    await w.boot();
    const s = w.study({ rs: 'A' });
    w.orthanc.rows = [qido(s.uid, 'SYN A HOSPITAL')];
    w.db.seed('report', { uid: s.uid, findings: 'SYN OLD', conclusion: '', recommendation: '', version: 1, updatedBy: RAD_A.actor, updatedBySub: RAD_A.sub });
    const report = () => w.db.rows('report').find(r => r.uid === s.uid), state = () => w.db.rows('studyState').find(r => r.uid === s.uid);
    const real = w.db.root.report.findMany;
    let calls = 0;
    w.db.root.report.findMany = async function (args) {
      if (++calls === 1) { Object.assign(state(), { rs: 'T' }); Object.assign(report(), { version: 3, findings: 'SYN SECRET SAVE' }); }
      const out = await real.call(this, args);
      if (calls === 1) { Object.assign(state(), { rs: 'A' }); Object.assign(report(), { version: 4, findings: 'SYN FINAL' }); }
      return out;
    };
    return { w, s };
  };
  const listed = await setup();
  await refused(() => listed.w.worklist.listStudies(RAD_A2), 409, 'STUDY_LIST_CHANGED');
  const booted = await setup();
  const st = (await booted.w.worklist.bootstrap(RAD_A2)).states[booted.s.uid];
  assert.deepEqual([st.rs, st.version, st.findings], ['A', 4, 'SYN FINAL']);
});
test('report state table: a tele request cancelled while bootstrap reads the heads takes the row away from the receiver', async () => {
  const w = world();
  await w.boot();
  const s = w.study({ rs: 'A', teleInstitutionId: INST_B });
  w.orthanc.rows = [qido(s.uid, 'SYN A HOSPITAL')];
  w.db.seed('report', { uid: s.uid, findings: 'SYN APPROVED TEXT', conclusion: '', recommendation: '', version: 1, updatedBy: RAD_A.actor, updatedBySub: RAD_A.sub });
  const real = w.db.root.report.findMany;
  let calls = 0;
  w.db.root.report.findMany = async function (args) {
    const out = await real.call(this, args);
    if (++calls === 1) Object.assign(w.db.rows('studyState').find(r => r.uid === s.uid), { teleInstitutionId: null });
    return out;
  };
  const boot = await w.worklist.bootstrap(RAD_B);
  assert.equal(boot.states[s.uid], undefined, 'the fresh row is no longer the receiver\'s: it is left out, not kept from the first read');
  assert.ok(!JSON.stringify(boot).includes('SYN APPROVED TEXT'));
  assert.equal((await w.worklist.bootstrap(RAD_A)).states[s.uid].findings, 'SYN APPROVED TEXT', 'the owner still reads it');
});
test('report state table: approved text and a preliminary reading keep their readers; a clinician-only reader reads as a radiologist who did not write the Save', async () => {
  const w = world();
  await w.boot();
  const s = w.study();
  w.orthanc.rows = [qido(s.uid, 'SYN A HOSPITAL')];
  const epoch = s.draftEpoch;
  await w.commit.commitReport(s.uid, commitBody(RAD_A, 'save', epoch, 0, 0, { findings: 'SYN DRAFT', conclusion: 'SYN DRAFT C' }), RAD_A, null);
  // A Save is read only by the physician who wrote it: the clinician gets the state and who is on it, never the text -
  // in the lists, the clinician's own list, timeline and report read, the history, and the head's evidence reads.
  const leaks = value => JSON.stringify(value).includes('SYN DRAFT');
  for (const read of [async () => (await w.worklist.bootstrap(CLIN_A)).states[s.uid],
    async () => (await w.worklist.listStudies(CLIN_A)).studies.find(r => r.uid === s.uid).state]) {
    const clin = await read();
    assert.deepEqual([clin.rs, clin.findings, clin.conclusion, clin.bodyLock, clin.prelimHidden, clin.savedBy], ['T', '', '', 'in-progress', true, RAD_A.actor]);
  }
  const list = readBody(await w.clinician.clinicianStudies(CLIN_A));
  assert.deepEqual(list.studies.map(r => [r.uid, r.report.rs, r.report.findings, r.report.conclusion]), [[s.uid, 'T', '', '']]);
  const timeline = readBody(await w.clinician.clinicianTimeline(s.uid, CLIN_A, { limit: '10' }));
  assert.ok(!leaks(timeline), 'the timeline carries no saved text');
  const detail = readBody(await w.clinician.clinicianReportRead(s.uid, CLIN_A));
  assert.deepEqual([detail.report.rs, detail.report.final, detail.report.findings, detail.report.conclusion], ['T', false, '', '']);
  assert.ok(!leaks(list) && !leaks(detail));
  const clinHistory = readBody(await w.evidence.versions(s.uid, CLIN_A));
  assert.deepEqual(clinHistory.map(v => [v.action, v.author, v.findings, v.bodyHidden]), [['save', RAD_A.actor, '', 'in-progress']]);
  for (const read of [() => w.evidence.reportCitations(s.uid, CLIN_A), () => w.evidence.reportStructure(s.uid, CLIN_A)])
    await refused(read, 403, 'REPORT_IN_PROGRESS');
  // the writer still reads it
  assert.equal(readBody(await w.evidence.versions(s.uid, RAD_A))[0].findings, 'SYN DRAFT');
  await w.commit.commitReport(s.uid, commitBody(RAD_A, 'approve', epoch, 1, 1, { findings: 'SYN FINAL' }), RAD_A, null);
  const other = (await w.worklist.bootstrap(RAD_A2)).states[s.uid];
  assert.deepEqual([other.rs, other.findings, other.bodyLock], ['A', 'SYN FINAL', null]);
  const history = readBody(await w.evidence.versions(s.uid, RAD_A2));
  assert.deepEqual(history.map(v => [v.action, v.findings, v.bodyHidden]), [['approve', 'SYN FINAL', undefined], ['save', '', 'in-progress']]);
  // approved text is the clinician's to read, in every read; the earlier Save stays with its writer
  assert.deepEqual(readBody(await w.evidence.versions(s.uid, CLIN_A)).map(v => [v.findings, v.bodyHidden]), [['SYN FINAL', undefined], ['', 'in-progress']]);
  assert.deepEqual([(await w.worklist.bootstrap(CLIN_A)).states[s.uid].findings, readBody(await w.clinician.clinicianReportRead(s.uid, CLIN_A)).report.findings,
    readBody(await w.clinician.clinicianStudies(CLIN_A)).studies[0].report.findings], ['SYN FINAL', 'SYN FINAL', 'SYN FINAL']);
});

test('report state table: approved, Reset and Saved again by another radiologist - a clinician-only reader opens the approved version, never the new Save', async () => {
  const w = world();
  await w.boot();
  const s = w.study();
  w.orthanc.rows = [qido(s.uid, 'SYN A HOSPITAL')];
  const epoch = s.draftEpoch;
  await w.commit.commitReport(s.uid, commitBody(RAD_A, 'approve', epoch, 0, 0, { findings: 'SYN APPROVED' }), RAD_A, null);
  await w.commit.commitReport(s.uid, commitBody(RAD_A, 'reset', epoch, 1, 1, { reason: 'SYN reopen' }), RAD_A, null);
  const again = w.db.rows('studyState').find(r => r.uid === s.uid).draftEpoch;
  const saved = await w.commit.commitReport(s.uid, commitBody(RAD_A2, 'save', again, 0, 3, { findings: 'SYN SECOND SAVE' }), RAD_A2, null);
  assert.equal(saved.state.rs, 'T');
  const leaks = value => JSON.stringify(value).includes('SYN SECOND SAVE');
  const detail = readBody(await w.clinician.clinicianReportRead(s.uid, CLIN_A));
  assert.deepEqual([detail.report.rs, detail.report.findings], ['T', '']);
  const history = readBody(await w.evidence.versions(s.uid, CLIN_A));
  assert.deepEqual(history.filter(v => v.action !== 'discarded').map(v => [v.version, v.action, v.findings, v.bodyHidden]),
    [[4, 'save', '', 'in-progress'], [3, 'reset', '', undefined], [1, 'approve', 'SYN APPROVED', undefined]]);
  // the version the screen opens from the history: the approved one is read, the new Save is not
  assert.equal(readBody(await w.clinician.clinicianReportRead(s.uid, CLIN_A, '1')).report.findings, 'SYN APPROVED');
  assert.equal(readBody(await w.clinician.clinicianReportRead(s.uid, CLIN_A, '4')).report.findings, '');
  const lists = [(await w.worklist.bootstrap(CLIN_A)).states[s.uid], readBody(await w.clinician.clinicianStudies(CLIN_A)),
    readBody(await w.clinician.clinicianTimeline(s.uid, CLIN_A, { limit: '10' }))];
  assert.ok(![detail, history, ...lists].some(leaks), 'no clinician read carries the new Save');
  // its writer still reads it
  assert.equal((await w.worklist.bootstrap(RAD_A2)).states[s.uid].findings, 'SYN SECOND SAVE');
});

test('report state table: a Save inside a signed Preliminary stays shared; a Save or Defer outside one is its writer\'s alone, for a clinician too', () => {
  // A Save written inside a Preliminary belongs to the preliminary reading; once it is signed it is shared history.
  const { versionClasses, versionBodyReadable } = require('/app/dist/report-visibility');
  const rows = [{ version: 1, action: 'preliminary', author: 'w' }, { version: 2, action: 'save', author: 'w', authorSub: 'sub-w' }, { version: 3, action: 'approve', author: 's' }];
  const classes = versionClasses(rows);
  assert.equal(versionBodyReadable(rows[1], classes.get(2), CLIN_A), true);
  // A Save or a Defer outside a Preliminary is its writer's alone, for a clinician as for another radiologist.
  for (const action of ['save', 'defer']) {
    const own = [{ version: 1, action, author: 'w', authorSub: 'sub-w' }];
    assert.deepEqual([CLIN_A, RAD_A2].map(c => versionBodyReadable(own[0], versionClasses(own).get(1), c)), [false, false], action);
  }
});

test('report state table: a destroyed report is read-only for everyone and the clinician list names it', async () => {
  const w = world();
  await w.boot();
  const s = w.study({ rs: 'D' });
  w.orthanc.rows = [qido(s.uid, 'SYN A HOSPITAL')];
  for (const c of [RAD_A, RAD_A2, CLIN_A]) {
    const st = (await w.worklist.bootstrap(c)).states[s.uid];
    assert.deepEqual([st.rs, st.bodyLock, st.prelimHidden], ['D', 'destroyed', true], c.actor);
  }
  await refused(() => w.draft.putReport(s.uid, draftBody(RAD_A, s.draftEpoch, 0, { findings: 'x' }), RAD_A, null), 410, 'REPORT_DESTROYED');
  await refused(() => w.hold.hold(s.uid, RAD_A), 410, 'REPORT_DESTROYED');
  const policy = require('/app/dist/clinician-policy');
  assert.deepEqual(policy.clinicianReportStatus({ rs: 'D' }, { version: 3, action: 'approve' }), { final: false, rs: 'D' });
  assert.deepEqual(policy.clinicianReport({ rs: 'D' }, { version: 3, action: 'approve', findings: 'gone' }), { final: false, rs: 'D' });
});

test('report state table: version classes - a Save inside a Preliminary stays with the pair, a Reset copy follows what it preserved, a draft copy is private', () => {
  const { versionClasses, versionBodyReadable } = require('/app/dist/report-visibility');
  const { senderReadsHead } = require('/app/dist/critical-result-policy');
  const reset = (version, by) => ({ version, action: 'reset', author: by });
  const copyOf = (version, by) => ({ version, action: 'discarded', author: 'w', reason: `판독 취소로 폐기 (취소자: ${by})` });
  const classes = versionClasses([
    { version: 1, action: 'preliminary', author: 'w' }, { version: 2, action: 'save', author: 'w' }, { version: 3, action: 'approve', author: 's' },
    { version: 4, action: 'save', author: 'w' }, { version: 5, action: 'discarded', author: 'x', reason: '관리자 강제 초안 해제' },
    copyOf(6, 'o'), reset(7, 'o'), { version: 8, action: 'approve', author: 's' }, copyOf(9, 'o'), reset(10, 'o')]);
  assert.deepEqual([...classes.entries()].sort((a, b) => a[0] - b[0]).map(([, k]) => k),
    ['shared', 'shared', 'shared', 'unsigned', 'private', 'unsigned', 'shared', 'shared', 'shared', 'shared']);
  // Whose work it is follows the account (owner-identity.ts): `reader('w')` is the account sub-w under the email w@...
  const reader = (name, email = `${name}@synthetic.test`) => ({ actor: email, sub: `sub-${name}`, roles: ['radiologist'] });
  // One judgement of "someone's work is here": text, a structured item or a drawing stored by the head version. A Save of
  // drawings alone is locked like a Save of text; an empty head locks nobody.
  const { reportBodyLock, versionExtras } = require('/app/dist/report-visibility');
  const blank = { updatedBy: 'w@synthetic.test', updatedBySub: 'sub-w', findings: '', conclusion: '', recommendation: '' };
  assert.equal(reportBodyLock({ rs: 'T' }, { ...blank, storedExtras: true }, reader('o')), 'in-progress');
  assert.equal(reportBodyLock({ rs: 'T' }, { ...blank, storedExtras: true }, reader('w')), null);
  assert.equal(reportBodyLock({ rs: 'T' }, { ...blank, storedExtras: true }, reader('w', 'w-renamed@synthetic.test')), null, 'the same account under a new email');
  assert.equal(reportBodyLock({ rs: 'T' }, { ...blank, storedExtras: true }, reader('o', 'w@synthetic.test')), 'in-progress', 'another account given the old email');
  assert.equal(reportBodyLock({ rs: 'T' }, { ...blank, updatedBySub: null, storedExtras: true }, reader('w')), 'in-progress', 'a head no account was resolved for stays locked');
  assert.equal(reportBodyLock({ rs: 'T' }, { ...blank, storedExtras: false }, reader('o')), null);
  assert.equal(versionExtras({ drawings: [{ id: 'd1' }] }), true);
  assert.equal(versionExtras({ structured: null, drawings: null }), false);
  const saved = { action: 'save', author: 'w@synthetic.test', authorSub: 'sub-w' };
  assert.equal(versionBodyReadable(saved, 'unsigned', reader('o')), false);
  assert.equal(versionBodyReadable(saved, 'unsigned', reader('w')), true);
  assert.equal(versionBodyReadable(saved, 'unsigned', reader('w', 'w-renamed@synthetic.test')), true);
  assert.equal(versionBodyReadable(saved, 'unsigned', reader('o', 'w@synthetic.test')), false);
  assert.equal(versionBodyReadable(saved, 'unsigned', { actor: 'c', sub: 'sub-c', roles: ['clinician'] }), false, 'a clinician reads as a radiologist who did not write it');
  assert.equal(versionBodyReadable({ action: 'discarded', author: 'x', authorSub: 'sub-x' }, 'private', { actor: 'c', sub: 'sub-c', roles: ['clinician'] }), false);
  assert.equal(versionBodyReadable(saved, 'unsigned', { actor: 'a', sub: 'sub-a', roles: ['admin', 'clinician'] }), false);
  assert.equal(senderReadsHead({ rs: 'T' }, saved, reader('o')), false);
  assert.equal(senderReadsHead({ rs: 'T' }, saved, reader('w')), true);
  assert.equal(senderReadsHead({ rs: 'T' }, saved, reader('w', 'w-renamed@synthetic.test')), true);
  assert.equal(senderReadsHead({ rs: 'T' }, saved, reader('o', 'w@synthetic.test')), false);
  assert.equal(senderReadsHead({ rs: 'P' }, saved, reader('o')), true);
  assert.equal(senderReadsHead({ rs: 'A' }, { ...saved, action: 'approve' }, reader('o')), true);
  // a completely empty head is nobody's work: any eligible sender may send (as on main)
  assert.equal(senderReadsHead({ rs: 'T' }, { ...saved, content: false }, reader('o')), true);});
// ── SPLIT-09 the draft boundary: owner, epoch, revision, session, one transaction (M08, M09, M10) ──

test('SPLIT-09 a draft write is kept only on the boundary it saw, under a live session, inside one transaction with its audit row', async () => {
  const w = world();
  const s = w.study();
  w.db.seed('authSession', { sid: 'sid-a', sub: RAD_A.sub });
  const epoch = s.draftEpoch;
  const mine = () => w.db.rows('reportDraft').find(r => r.uid === s.uid && r.authorSub === RAD_A.sub);
  const first = await w.draft.putReport(s.uid, draftBody(RAD_A, epoch, 0, { findings: 'kept text' }), RAD_A, 'sid-a');
  assert.deepEqual([first.revision, first.present, first.snapshot.findings], [`${epoch}:1`, true, 'kept text']);
  assert.deepEqual(w.audits().map(a => a.action), ['report.draft']);
  assert.deepEqual(w.db.writesBy('root'), [], 'the draft and its audit row went through the transaction');

  // a late write that saw revision 0, a write on another epoch, a write for another owner: refused, nothing changes
  await refused(() => w.draft.putReport(s.uid, draftBody(RAD_A, epoch, 0, { findings: 'late' }), RAD_A, 'sid-a'), 409, 'REPORT_DRAFT_CONFLICT');
  await refused(() => w.draft.putReport(s.uid, draftBody(RAD_A, randomUUID(), 1, { findings: 'old epoch' }), RAD_A, 'sid-a'), 409, 'REPORT_DRAFT_CONFLICT');
  await refused(() => w.draft.putReport(s.uid, { ...draftBody(RAD_A, epoch, 1, { findings: 'x' }), expectedOwner: ownerOf(RAD_A2) }, RAD_A, 'sid-a'), 409, 'REPORT_DRAFT_OWNER_CHANGED');
  // an ended session writes nothing
  await refused(() => w.draft.putReport(s.uid, draftBody(RAD_A, epoch, 1, { findings: 'after logout' }), RAD_A, 'sid-ended'), 401, 'AUTH_SESSION_ENDED');
  // a failing audit row takes the draft write back with it
  const boom = new Error('audit store down');
  w.db.faults.push({ model: 'auditLog', op: 'create', client: 'tx', error: boom });
  await assert.rejects(() => w.draft.putReport(s.uid, draftBody(RAD_A, epoch, 1, { findings: 'lost?' }), RAD_A, 'sid-a'), error => error === boom);
  assert.deepEqual([mine().revision, mine().findings, mine().present], [1, 'kept text', true]);
  assert.deepEqual(w.audits().map(a => a.action), ['report.draft']);
  assert.deepEqual(w.db.writesBy('root'), []);

  // another radiologist's draft is a row of its own; neither answer carries the other's text
  const other = await w.draft.putReport(s.uid, draftBody(RAD_A2, epoch, 0, { findings: 'other text' }), RAD_A2, null);
  assert.equal(other.snapshot.findings, 'other text');
  const read = await w.draft.readDraft(s.uid, RAD_A);
  assert.deepEqual([read.revision, read.snapshot.findings], [`${epoch}:1`, 'kept text']);
  // the boundary moves on: a write on revision 1 is kept and a discard clears the row but keeps its revision
  const second = await w.draft.putReport(s.uid, draftBody(RAD_A, epoch, 1, { findings: 'second' }), RAD_A, 'sid-a');
  assert.equal(second.revision, `${epoch}:2`);
  const discarded = await w.draft.discardDraft(s.uid, { expectedOwner: ownerOf(RAD_A), expectedRevision: `${epoch}:2` }, RAD_A, 'sid-a');
  assert.deepEqual([discarded.revision, discarded.present, discarded.state.draft], [`${epoch}:3`, false, null]);
  assert.equal(mine().revision, 3);
  // 의료법 제23조④: the discard is a 수정 of this author's draft. No report is stored yet, so the answer provides none.
  const row = JSON.stringify([s.uid, storedAuthor(w, s.uid, RAD_A)]);
  assert.deepEqual(actsOf(w.records, 'DELETE studies/:uid/draft'), [['수정', 'discard', 'private-draft', row, `${epoch}:3`]]);
});

test('SPLIT-09b a discard answering a stored report records the 열람 of that report version, unless the preliminary body is withheld', async () => {
  const w = world();
  const s = w.study({ rs: 'A' });
  w.db.seed('report', { uid: s.uid, findings: 'approved text', conclusion: '', recommendation: '', version: 2, updatedBy: RAD_A2.actor, updatedBySub: RAD_A2.sub });
  w.db.seed('reportVersion', { uid: s.uid, version: 2, action: 'approve', findings: 'approved text', conclusion: '', recommendation: '', author: RAD_A2.actor, authorSub: RAD_A2.sub });
  const epoch = s.draftEpoch;
  await w.draft.putReport(s.uid, draftBody(RAD_A, epoch, 0, { findings: 'mine', baseVersion: 2 }), RAD_A, null);
  const out = await w.draft.discardDraft(s.uid, { expectedOwner: ownerOf(RAD_A), expectedRevision: `${epoch}:1` }, RAD_A, null);
  assert.deepEqual([out.state.version, out.state.findings, out.state.draft], [2, 'approved text', null]);
  assert.deepEqual(actsOf(w.records, 'DELETE studies/:uid/draft'), [
    ['수정', 'discard', 'private-draft', JSON.stringify([s.uid, storedAuthor(w, s.uid, RAD_A)]), `${epoch}:2`],
    ['열람', 'provide-prepared', 'report-version', s.uid, '2']]);

  // A preliminary report another radiologist may not read: the answer carries no body, so no report read is recorded.
  const p = w.study({ rs: 'P', preDoc: RAD_A2.actor, preDocSub: RAD_A2.sub, preReviewer: 'syn-senior', preReviewerSub: 'syn-senior' });
  w.db.seed('report', { uid: p.uid, findings: 'prelim text', conclusion: '', recommendation: '', version: 1, updatedBy: RAD_A2.actor, updatedBySub: RAD_A2.sub });
  const before = w.records.length;
  const hidden = await w.draft.discardDraft(p.uid, { expectedOwner: ownerOf(RAD_A), expectedRevision: `${p.draftEpoch}:0` }, RAD_A, null);
  assert.deepEqual([hidden.state.prelimHidden, hidden.state.findings], [true, '']);
  assert.deepEqual(actsOf(w.records.slice(before), 'DELETE studies/:uid/draft'),
    [['수정', 'discard', 'private-draft', JSON.stringify([p.uid, storedAuthor(w, p.uid, RAD_A)]), `${p.draftEpoch}:1`]]);
});

// ── SPLIT-10 the administrator's forced discard ──

test('SPLIT-10 a forced discard is administrator-only, keeps every present draft as a discarded version by its author and rotates the epoch', async () => {
  const w = world();
  const s = w.study();
  w.db.seed('reportDraft', { uid: s.uid, author: RAD_A.actor, authorSub: RAD_A.sub, findings: 'a text', conclusion: '', recommendation: '', baseVersion: 0, revision: 2, present: true });
  w.db.seed('reportDraft', { uid: s.uid, author: RAD_A2.actor, authorSub: RAD_A2.sub, findings: 'b text', conclusion: '', recommendation: '', baseVersion: 0, revision: 1, present: true });
  await refused(() => w.draft.forceDiscardDrafts(s.uid, { expectedOwner: ownerOf(RAD_A), expectedEpoch: s.draftEpoch }, RAD_A, null), 403);
  const out = await w.draft.forceDiscardDrafts(s.uid, { expectedOwner: ownerOf(ADMIN_A), expectedEpoch: s.draftEpoch }, ADMIN_A, null);
  assert.deepEqual([out.count, out.versions], [2, [1, 2]]);
  assert.notEqual(out.epoch, s.draftEpoch);
  const byAuthor = rows => rows.sort((x, y) => (x[1] < y[1] ? -1 : 1));
  assert.deepEqual(byAuthor(w.db.rows('reportVersion').map(v => [v.action, v.author, v.findings])),
    byAuthor([['discarded', RAD_A.actor, 'a text'], ['discarded', RAD_A2.actor, 'b text']]));
  assert.deepEqual(w.db.rows('reportDraft').map(d => [d.present, d.revision]), [[false, 3], [false, 2]]);
  assert.deepEqual(w.audits().map(a => a.action), ['report.draft.force-discard']);
  // 의료법 제23조④: the administrator changed each author's draft; each is a 수정 of that author's row (its new boundary on
  // the rotated epoch), recorded in the discard's commit. The refused attempts below add none.
  // Each discarded draft it keeps is a new (unsigned) ReportVersion: a 기재 of that version.
  const forced = [['수정', 'discard', 'private-draft', JSON.stringify([s.uid, RAD_A.actor]), `${out.epoch}:3`],
    ['수정', 'discard', 'private-draft', JSON.stringify([s.uid, RAD_A2.actor]), `${out.epoch}:2`],
    ['기재', 'write', 'report-version', s.uid, '1'], ['기재', 'write', 'report-version', s.uid, '2']];
  assert.deepEqual(actsOf(w.records, 'DELETE studies/:uid/draft/force').sort(), forced.sort());
  await refused(() => w.draft.forceDiscardDrafts(s.uid, { expectedOwner: ownerOf(ADMIN_A), expectedEpoch: s.draftEpoch }, ADMIN_A, null), 409, 'REPORT_DRAFT_CONFLICT');
  assert.deepEqual(actsOf(w.records, 'DELETE studies/:uid/draft/force').sort(), forced.sort());
});

// ── SPLIT-11 hold (M11, M12) ──

test('writer privacy: every draft mutation and dictation audit records its authenticated institution', async () => {
  const w = world(), s = w.study({ teleInstitutionId: INST_B });
  for (const caller of [RAD_A, RAD_B]) {
    await w.draft.putReport(s.uid, draftBody(caller, s.draftEpoch, 0, { findings: 'SYN draft' }), caller, null);
  }
  w.db.seed('report', { uid: s.uid, version: 1, findings: 'SYN committed', conclusion: '', recommendation: '' });
  for (const caller of [RAD_A, RAD_B]) {
    await w.draft.putReport(s.uid, draftBody(caller, s.draftEpoch, 1, { findings: 'SYN rebased', baseVersion: 1 }), caller, null);
    await w.draft.putReport(s.uid, draftBody(caller, s.draftEpoch, 2, { findings: '' }), caller, null);
    await w.draft.discardDraft(s.uid, { expectedOwner: ownerOf(caller), expectedRevision: `${s.draftEpoch}:3` }, caller, null);
    await w.draft.dictationAudit(s.uid, caller, { outcome: 'success', institution: 'untrusted' });
    const rows = w.audits().filter(row => row.actor === caller.actor);
    assert.deepEqual([...new Set(rows.map(row => row.action))].sort(),
      ['dictation.request', 'report.draft', 'report.draft.clear', 'report.draft.discard', 'report.draft.rebase']);
    assert.ok(rows.every(row => JSON.parse(row.detail).institution === caller.institution));
  }
});

for (const admin of [ADMIN_A, ADMIN_B]) test(`writer privacy: force discard by ${admin.institution} preserves originals but hides unrecorded affiliations in responses and history`, async () => {
  const w = world(), s = w.study({ teleInstitutionId: INST_B });
  // An older row no member could be resolved for has no account (authorSub null): it is nobody's.
  for (const [author, authorSub] of [[RAD_A.actor, RAD_A.sub], [RAD_B.actor, RAD_B.sub], [admin.actor, admin.sub], ['legacy@synthetic.test', null]])
    w.db.seed('reportDraft', { uid: s.uid, author, authorSub, findings: 'SYN text', conclusion: '', recommendation: '', baseVersion: 0, revision: 1, present: true });
  const before = copy(w.db.rows('reportDraft'));
  const out = await w.draft.forceDiscardDrafts(s.uid, { expectedOwner: ownerOf(admin), expectedEpoch: s.draftEpoch }, admin, null);
  assert.equal(out.count, 4);
  assert.deepEqual(out.drafts.map(d => d.author).sort(), [admin.actor, '작성자 비공개', '작성자 비공개', '작성자 비공개'].sort());
  assert.deepEqual(w.db.rows('reportVersion').map(d => d.author).sort(), before.map(d => d.author).sort());
  const recorded = JSON.parse(w.audits('report.draft.force-discard')[0].detail);
  assert.equal(recorded.institution, admin.institution);
  assert.deepEqual(recorded.drafts.map(d => d.author).sort(), before.map(d => d.author).sort());
  for (const caller of [RAD_A, RAD_B]) {
    const versions = readBody(await w.evidence.versions(s.uid, caller));
    assert.deepEqual(versions.map(v => v.author).sort(), [caller.actor, '작성자 비공개', '작성자 비공개', '작성자 비공개'].sort());
    assert.ok(versions.every(v => v.reason === '관리자 강제 초안 해제'));
  }
  assert.ok(w.db.rows('reportVersion').every(v => v.reason.includes(admin.actor)), 'stored provenance is preserved');
  const empty = await w.draft.forceDiscardDrafts(s.uid, { expectedOwner: ownerOf(admin), expectedEpoch: out.epoch }, admin, null);
  assert.equal(empty.count, 0);
  assert.equal(JSON.parse(w.audits('report.draft.force-discard').at(-1).detail).institution, admin.institution);
});

test('writer privacy: deleting a study with a foreign draft refuses without disclosing its author', async () => {
  const w = world(), s = w.study({ teleInstitutionId: INST_B });
  w.db.seed('reportDraft', { uid: s.uid, author: RAD_B.actor, authorSub: RAD_B.sub, present: true });
  const refusal = await refused(() => w.studyState.removeState(s.uid, ADMIN_A), 400);
  assert.ok(!JSON.stringify(refusal).includes(RAD_B.actor));
  assert.equal(w.db.rows('studyState').length, 1);
  assert.equal(w.db.rows('reportDraft').length, 1);
});

test('writer privacy: disclosed signers keep their discarded authorship, but an adjacent reset never reveals a force-discard admin', async () => {
  const w = world(), s = w.study({ teleInstitutionId: INST_B });
  const stored = [
    { version: 1, action: 'save', author: RAD_A2.actor, authorSub: RAD_A2.sub, reason: null },
    { version: 2, action: 'discarded', author: RAD_A2.actor, authorSub: RAD_A2.sub, reason: `관리자 강제 초안 해제 (해제자: ${ADMIN_B.actor})` },
    { version: 3, action: 'reset', author: RAD_A.actor, authorSub: RAD_A.sub, reason: 'SYN cancellation' },
    { version: 4, action: 'discarded', author: RAD_B.actor, authorSub: RAD_B.sub, reason: `관리자 강제 초안 해제 (해제자: ${ADMIN_B.actor})` },
  ];
  for (const row of stored) w.db.seed('reportVersion', { uid: s.uid, findings: 'SYN', conclusion: '', recommendation: '', ...row });
  const before = copy(w.db.rows('reportVersion'));
  for (const caller of [RAD_A, RAD_A2, RAD_B]) {
    const shown = readBody(await w.evidence.versions(s.uid, caller));
    assert.equal(shown.find(row => row.version === 2).author, RAD_A2.actor);
    assert.equal(shown.find(row => row.version === 4).author, caller === RAD_B ? RAD_B.actor : '작성자 비공개');
    assert.ok(shown.filter(row => row.action === 'discarded').every(row => row.reason === '관리자 강제 초안 해제'));
    assert.ok(!JSON.stringify(shown).includes(ADMIN_B.actor));
  }
  assert.deepEqual(w.db.rows('reportVersion'), before);
});

test('writer privacy: discarded citation metadata hides its writer on readable and unavailable sources; committed provenance remains', async () => {
  const w = world(), s = w.study({ teleInstitutionId: INST_B });
  const citations = [{ field: 'findings', findingId: 'readable', insertedText: 'SYN', insertedBy: RAD_B.actor },
    { field: 'findings', findingId: 'unavailable', insertedText: 'OTHER', insertedBy: RAD_B.actor }];
  w.findings.readable.add('readable');
  for (const [version, action] of [[1, 'discarded'], [2, 'save']])
    w.db.seed('reportVersion', { uid: s.uid, version, action, author: RAD_B.actor, authorSub: RAD_B.sub,
      findings: 'SYN\nOTHER', conclusion: '', recommendation: '', citations });
  const before = copy(w.db.rows('reportVersion'));
  // The writer reads both; another reader gets neither: a Save outside a Preliminary and an administrator's discarded copy of
  // a private draft keep their text - and the citations measured on it - with their writer (the report state table).
  for (const version of ['1', '2']) {
    const answer = readBody(await w.evidence.reportVersionCitations(s.uid, version, RAD_B));
    assert.equal(answer.entries.length, 2);
    assert.ok(answer.entries.every(entry => entry.insertedBy === RAD_B.actor));
    await refused(() => w.evidence.reportVersionCitations(s.uid, version, RAD_A), 403, 'REPORT_IN_PROGRESS');
  }
  const versions = readBody(await w.evidence.versions(s.uid, RAD_A));
  assert.equal(versions.find(v => v.action === 'save').author, RAD_B.actor);
  assert.deepEqual(versions.map(v => [v.version, v.findings, v.bodyHidden]), [[2, '', 'in-progress'], [1, '', 'in-progress']]);
  assert.deepEqual(readBody(await w.evidence.versions(s.uid, RAD_B)).map(v => [v.version, v.findings, v.bodyHidden]),
    [[2, 'SYN\nOTHER', undefined], [1, 'SYN\nOTHER', undefined]]);
  assert.deepEqual(w.db.rows('reportVersion'), before);
});

test('SPLIT-11 a live hold of another reader is reported, never overwritten; an expired one is taken over; forced release is audited', async () => {
  const w = world();
  const s = w.study();
  const row = () => w.db.rows('studyState').find(r => r.uid === s.uid);
  assert.deepEqual(await w.hold.hold(s.uid, RAD_A), { holder: RAD_A.actor, mine: true, conflict: false });
  assert.deepEqual(await w.hold.hold(s.uid, RAD_A), { holder: RAD_A.actor, mine: true, conflict: false }, 'heartbeat');
  assert.equal(w.audits('report.hold').length, 1, 'a heartbeat of a live hold is not a new hold');
  assert.deepEqual(await w.hold.hold(s.uid, RAD_A2), { holder: RAD_A.actor, mine: false, conflict: true });
  assert.equal(row().holder, RAD_A.actor);
  // the commit of the other reader is refused while the hold lives
  await refused(() => w.commit.commitReport(s.uid, commitBody(RAD_A2, 'save', s.draftEpoch, 0, 0, { findings: 'x' }), RAD_A2, null), 409, 'REPORT_HELD');
  w.db.tables.studyState.find(r => r.uid === s.uid).heldAt = new Date(Date.now() - (4 * 60_000 + 50_000));
  assert.deepEqual(await w.hold.hold(s.uid, RAD_A2), { holder: RAD_A.actor, mine: false, conflict: true }, 'still alive just under five minutes');
  w.db.tables.studyState.find(r => r.uid === s.uid).heldAt = new Date(Date.now() - (5 * 60_000 + 1_000));
  assert.deepEqual(await w.hold.hold(s.uid, RAD_A2), { holder: RAD_A2.actor, mine: true, conflict: false });
  assert.equal(w.audits('report.hold').length, 2);
  await refused(() => w.hold.hold(s.uid, TECH_A), 403);
  // release: only the holder's own hold is released
  assert.deepEqual(await w.hold.release(s.uid, RAD_A), { ok: true });
  assert.equal(row().holder, RAD_A2.actor);
  // forced release: administrator only, one audit row in the same transaction
  await refused(() => w.hold.forceRelease(s.uid, RAD_A), 403);
  assert.deepEqual(await w.hold.forceRelease(s.uid, ADMIN_A), { ok: true, released: RAD_A2.actor });
  assert.equal(row().holder, null);
  const forcedRows = w.audits('hold.force-release');
  assert.equal(forcedRows.length, 1, 'a forced release leaves one audit row');
  const [forced] = forcedRows;
  assert.deepEqual(JSON.parse(forced.detail).by, INST_A);
  assert.deepEqual([JSON.parse(forced.detail).holder, JSON.parse(forced.detail).alive], [RAD_A2.actor, true]);
  assert.deepEqual(w.db.writesBy('root'), []);
});

// ── SPLIT-12 worklist: the institution boundary of the list and the boot bundle (M13, M14) ──

// #292 N2: a shared study does not make the other institution's current writer a colleague.
for (const [writer, peer, stranger, admin] of [
  [RAD_A, RAD_A2, RAD_B, ADMIN_B], [RAD_B, ADMIN_B, RAD_A, ADMIN_A],
]) test(`writer privacy: ${writer.institution} hold is named only within its institution`, async () => {
  const w = world();
  await w.boot();
  const s = w.study({ teleInstitutionId: INST_B });
  w.orthanc.rows = [qido(s.uid, 'SYN A HOSPITAL')];
  await w.hold.hold(s.uid, writer);
  for (const caller of [writer, peer, stranger, admin]) {
    const expected = caller.institution === writer.institution ? writer.actor : '다른 기관';
    const list = await w.worklist.listStudies(caller);
    const boot = await w.worklist.bootstrap(caller);
    assert.equal(list.studies[0].state.holder, expected);
    assert.equal(boot.states[s.uid].holder, expected);
    assert.deepEqual(await w.hold.hold(s.uid, caller),
      { holder: expected, mine: caller.actor === writer.actor, conflict: caller.actor !== writer.actor });
    if (caller.actor !== writer.actor) {
      const draft = await refused(() => w.draft.putReport(s.uid,
        draftBody(caller, s.draftEpoch, 0, { findings: 'SYN unchanged' }), caller, null), 409, 'REPORT_HELD');
      const commit = await refused(() => w.commit.commitReport(s.uid,
        commitBody(caller, 'save', s.draftEpoch, 0, 0, { findings: 'SYN unchanged' }), caller, null), 409, 'REPORT_HELD');
      for (const response of [draft, commit]) {
        assert.equal(response.holder, expected);
        assert.equal(response.message, expected === '다른 기관'
          ? '다른 기관 판독의가 판독 중입니다' : `${writer.actor} 님이 판독 중입니다`);
        if (caller.institution !== writer.institution)
          assert.ok(!JSON.stringify(response).includes(writer.actor), '409 must not disclose the e-mail');
      }
    }
  }
  assert.equal(w.db.rows('studyState')[0].holder, writer.actor, 'redaction must not change the lock owner');
  assert.equal(w.db.rows('report').length, 0);
  assert.equal(w.db.rows('reportDraft').length, 0);
  await w.hold.release(s.uid, stranger);
  assert.equal((await w.worklist.bootstrap(stranger)).states[s.uid].holder, '다른 기관');
  assert.deepEqual(await w.hold.forceRelease(s.uid, admin), { ok: true, released: '다른 기관' });
  assert.equal((await w.worklist.bootstrap(stranger)).states[s.uid].holder, null);
  assert.equal(JSON.parse(w.audits('hold.force-release')[0].detail).holder, writer.actor, 'audit keeps the real owner');
});

test('writer privacy: legacy holds hide unknown institutions until the writer renews; expiry and takeover keep the new affiliation', async () => {
  const w = world();
  const s = w.study({ teleInstitutionId: INST_B, holder: RAD_A.actor, holderSub: RAD_A.sub, heldAt: new Date() });
  const state = () => w.db.rows('studyState')[0];
  assert.equal(values.toClient(state(), null, RAD_A2).holder, '작성자 비공개');
  assert.equal(values.toClient(state(), null, RAD_A).holder, RAD_A.actor);
  assert.deepEqual(await w.hold.hold(s.uid, RAD_A2), { holder: '작성자 비공개', mine: false, conflict: true });
  const held = await refused(() => w.draft.putReport(s.uid,
    draftBody(RAD_A2, s.draftEpoch, 0, { findings: 'SYN unchanged' }), RAD_A2, null), 409, 'REPORT_HELD');
  assert.equal(held.holder, '작성자 비공개');
  assert.equal(held.message, '비공개 작성자가 판독 중입니다');
  await w.hold.hold(s.uid, RAD_A);
  assert.equal(values.toClient(state(), null, RAD_A2).holder, RAD_A.actor);
  w.db.tables.studyState[0].heldAt = new Date(Date.now() - 6 * 60_000);
  assert.equal(values.toClient(state(), null, RAD_B).holder, null);
  await w.hold.hold(s.uid, RAD_B);
  assert.equal(values.toClient(state(), null, RAD_A2).holder, '다른 기관');
  assert.equal(values.toClient(state(), null, ADMIN_B).holder, RAD_B.actor);
  await w.hold.release(s.uid, RAD_B);
  assert.equal(values.toClient(state(), null, ADMIN_B).holder, null);
});

// The SQL double consumes the bound action scopes. Actual PostgreSQL selection is
// covered by invariants_live's existing two-way tele hold case, including /audit.
for (const singleStudy of [true, false]) test(`writer audit privacy: ${singleStudy ? 'study' : 'aggregate'} reads keep only the recording institution's hold history`, async () => {
  const w = world();
  const s = w.study({ teleInstitutionId: INST_B });
  w.db.handlers.push([/^SELECT a\.\*, CASE .* FROM "AuditLog" a LEFT JOIN "StudyState" s/, (params, tables) => {
    const [ownerActions, institutionActions, target] = params;
    const me = params.at(-2), limit = params.at(-1);
    const uids = Array.isArray(target) ? target : [target];
    return tables.auditLog.filter(row => {
      const study = tables.studyState.find(study => study.uid === row.target);
      if (!study || !uids.includes(row.target) || ![study.institutionId, study.teleInstitutionId].includes(me)) return false;
      const detail = JSON.parse(row.detail ?? 'null');
      const institution = detail?.institution ?? (['hold.force-release', 'report.draft.force-discard'].includes(row.action) ? detail?.by : null);
      return ownerActions.includes(row.action) ? study.institutionId === me && institution === me
        : institutionActions.includes(row.action) ? institution === me : true;
    }).sort((a, b) => +b.at - +a.at || b.id - a.id).slice(0, limit).map(row => ({ ...copy(row),
      managingInstitution: ownerActions.includes(row.action) || institutionActions.includes(row.action)
        ? (JSON.parse(row.detail).institution ?? (['hold.force-release', 'report.draft.force-discard'].includes(row.action) ? JSON.parse(row.detail).by : null))
        : tables.studyState.find(study => study.uid === row.target).institutionId,
    }));
  }]);
  for (const [writer, admin] of [[RAD_A, ADMIN_A], [RAD_B, ADMIN_B]]) {
    await w.hold.hold(s.uid, writer);
    await w.hold.forceRelease(s.uid, admin);
  }
  for (const action of ['report.hold', 'hold.force-release']) {
    w.db.seed('auditLog', { action, target: s.uid, actor: 'legacy@synthetic.example',
      detail: action === 'report.hold' ? null : JSON.stringify({ holder: 'legacy@synthetic.example', by: INST_A }) });
  }
  w.db.seed('auditLog', { action: 'study.verified', target: s.uid, actor: 'SYN shared event' });
  const original = copy(w.db.rows('auditLog'));
  for (const [caller, writer, admin] of [[TECH_A, RAD_A, ADMIN_A], [ADMIN_B, RAD_B, ADMIN_B]]) {
    const result = await w.audit.auditRead(singleStudy ? s.uid : undefined, 500, caller);
    const holds = result.rows.filter(row => row.action === 'report.hold');
    const releases = result.rows.filter(row => row.action === 'hold.force-release');
    assert.deepEqual(holds.map(row => row.actor), [writer.actor]);
    assert.deepEqual(releases.map(row => [row.actor, JSON.parse(row.detail).holder]),
      caller.institution === INST_A ? [['legacy@synthetic.example', '작성자 비공개'], [admin.actor, writer.actor]] : [[admin.actor, writer.actor]]);
    assert.ok(result.rows.some(row => row.action === 'study.verified'), 'unrelated shared events remain visible');
    for (const [index, row] of result.rows.entries()) {
      if (row.action !== 'study.verified') assert.equal(result.managing[index], caller.institution);
    }
  }
  assert.deepEqual(w.db.rows('auditLog'), original, 'reading must preserve the original audit identities');
  for (const institution of [INST_A, INST_B]) {
    w.db.seed('auditLog', { action: 'report.draft.force-discard', target: s.uid, actor: `legacy-${institution}`,
      detail: JSON.stringify({ by: institution, drafts: [{ author: RAD_A.actor, len: [2, 0, 0] }], versions: [7] }) });
  }
  for (const caller of [TECH_A, TECH_B]) {
    const result = await w.audit.auditRead(singleStudy ? s.uid : undefined, 500, caller);
    const legacy = result.rows.filter(row => row.action === 'report.draft.force-discard');
    assert.deepEqual(legacy.map(row => row.actor), [`legacy-${caller.institution}`]);
    assert.equal(JSON.parse(legacy[0].detail).drafts[0].author, '작성자 비공개');
    assert.equal(result.managing[result.rows.indexOf(legacy[0])], caller.institution);
  }
  const privateActions = ['report.draft', 'report.draft.clear', 'report.draft.rebase', 'report.draft.discard',
    'report.draft.force-discard', 'dictation.request', 'viewer-context.event'];
  for (const action of privateActions) for (const institution of [INST_A, INST_B, null]) {
    w.db.seed('auditLog', { action, target: s.uid, actor: `writer-${institution}@synthetic.example`,
      detail: JSON.stringify({ institution, by: institution, drafts: [{ author: 'foreign@synthetic.example', len: [1, 0, 0] }] }) });
  }
  for (const caller of [TECH_A, TECH_B]) {
    const rows = await w.audit.audits(singleStudy ? s.uid : undefined, 500, caller);
    const drafts = rows.filter(row => privateActions.includes(row.action) && !row.actor.startsWith('legacy-'));
    assert.equal(drafts.length, privateActions.length);
    assert.ok(drafts.every(row => row.actor === `writer-${caller.institution}@synthetic.example`));
    assert.equal(JSON.parse(drafts.find(row => row.action === 'report.draft.force-discard').detail).drafts[0].author, '작성자 비공개');
  }
  for (const holderInstitutionId of [INST_B, null]) {
    await w.hold.hold(s.uid, RAD_B);
    w.db.rows('studyState')[0].holderInstitutionId = holderInstitutionId;
    await w.hold.forceRelease(s.uid, ADMIN_A);
    const recorded = copy(w.audits('hold.force-release').at(-1));
    const own = await w.audit.audits(singleStudy ? s.uid : undefined, 500, TECH_A);
    const shown = own.find(row => row.id === recorded.id);
    assert.equal(shown.actor, ADMIN_A.actor);
    assert.equal(JSON.parse(shown.detail).holder, holderInstitutionId ? '다른 기관' : '작성자 비공개', 'a local admin action must not expose a foreign or legacy holder');
    const remote = await w.audit.audits(singleStudy ? s.uid : undefined, 500, TECH_B);
    assert.ok(!remote.some(row => row.id === recorded.id), 'the other institution must not see the releasing admin');
    assert.equal(JSON.parse(recorded.detail).holder, RAD_B.actor, 'the raw audit retains the actual holder');
    assert.deepEqual(w.audits('hold.force-release').at(-1), recorded, 'response redaction must not rewrite the audit');
  }
});

test('SPLIT-12 the list and the boot bundle carry own and tele-received studies only; first sight registers a study; unknown counts stay unknown', async () => {
  const w = world();
  await w.boot();
  const own = w.study(), foreign = w.study({ institutionId: INST_B }), tele = w.study({ institutionId: INST_B, teleInstitutionId: INST_A });
  const fresh = uidOf(), unknown = uidOf();
  w.orthanc.rows = [qido(own.uid, 'SYN A HOSPITAL'), qido(foreign.uid, 'SYN B CENTER'), qido(tele.uid, 'SYN B CENTER'),
    qido(fresh, 'syn a hospital', { '00201208': { Value: ['4'] } }), qido(unknown, 'NOBODY')];
  const list = await w.worklist.listStudies(RAD_A);
  assert.deepEqual(list.studies.map(r => r.uid).sort(), [own.uid, tele.uid, fresh].sort());
  const byUid = Object.fromEntries(list.studies.map(r => [r.uid, r]));
  assert.deepEqual([byUid[own.uid].count, byUid[fresh].count], [null, 4]);
  assert.deepEqual([byUid[tele.uid].tele, byUid[own.uid].tele], [true, false]);
  assert.equal(byUid[own.uid].institutionName, 'SYN A');
  assert.deepEqual(w.db.rows('studyState').filter(r => [fresh, unknown].includes(r.uid)).map(r => [r.uid, r.institutionId, r.ss]),
    [[fresh, INST_A, 'Unverified'], [unknown, null, 'Unverified']]);
  assert.deepEqual(w.audits('study.arrived').map(a => a.target).sort(), [fresh, unknown].sort());
  const boot = await w.worklist.bootstrap(RAD_A);
  assert.deepEqual(Object.keys(boot.states).sort(), [own.uid, tele.uid, fresh].sort());
  assert.deepEqual([boot.me.institution, boot.me.institutionName], [INST_A, 'SYN A']);
  assert.ok(boot.institutions.some(i => i.id === INST_B), 'the boot bundle lists the cached institutions');
  const other = await w.worklist.bootstrap(RAD_B);
  assert.deepEqual(Object.keys(other.states).sort(), [foreign.uid, tele.uid].sort());
});

// ── SPLIT-13 institutions: one cache, the seed at start, the held path (D1882) ──

test('SPLIT-13 one institution cache serves every concern; an unknown sending hospital is held until a registration the admin confirmed attaches it', async () => {
  const w = world();
  await w.boot();
  assert.equal(w.institutions.resolveInstitution(' syn b center '), INST_B);
  assert.equal(w.institutions.resolveInstitution('nobody'), null);
  assert.equal(w.institutions.institutionName(null), '(미배정)');
  assert.ok(w.db.rows('order').length > 0, 'the order seed ran at start');
  // a reload is seen by the other concerns reading the cache (tele target check of PATCH)
  w.db.seed('institution', { id: 'syn-c', name: 'SYN C', type: 'center', dicomNames: '' });
  const s = w.study();
  await refused(() => w.studyState.patchState(s.uid, { ts: 'wait', teleTo: 'syn-c' }, RAD_A), 400);
  const log = console.log; console.log = () => {};
  try { await w.institutions.onModuleInit(); } finally { console.log = log; }
  assert.equal((await w.studyState.patchState(s.uid, { ts: 'wait', teleTo: 'syn-c' }, RAD_A)).teleInstitutionId, 'syn-c');
  // Neither the name nor the device is known: held, in nobody's list, the alert names device and raw text only.
  const byDevice = uidOf(), bySpelling = uidOf();
  w.orthanc.rows = [qido(byDevice, 'SYN UNKNOWN SITE'), qido(bySpelling, 'Syn A Hosp.')];
  w.orthanc.devices = { [byDevice]: 'SYN_CT_7', [bySpelling]: null };
  for (const c of [RAD_A, ADMIN_A, RAD_B]) assert.deepEqual((await w.worklist.listStudies(c)).studies.map(r => r.uid), [], c.actor);
  assert.deepEqual(w.db.rows('studyState').filter(r => [byDevice, bySpelling].includes(r.uid)).map(r => r.institutionId), [null, null]);
  await refused(() => w.worklist.heldSources(RAD_A), 403);
  const alert = await w.worklist.heldSources(ADMIN_B);
  assert.deepEqual(alert.groups.map(g => [g.device, g.institutionText, g.count]).sort(),
    [[null, 'Syn A Hosp.', 1], ['SYN_CT_7', 'SYN UNKNOWN SITE', 1]]);
  assert.ok(!JSON.stringify(alert).includes(byDevice) && !JSON.stringify(alert).includes('PID-'), 'no study or patient fact');
  // Registrations: admin only, own institution only, a confirmation is required, one value names one institution.
  await refused(() => w.worklist.registerSourceDevice({ value: 'SYN_CT_7', confirmation: 'SYN phone' }, RAD_A), 403);
  await refused(() => w.worklist.registerSourceDevice({ value: 'SYN_CT_7', confirmation: '' }, ADMIN_A), 400);
  await refused(() => w.worklist.registerSourceDevice({ value: 'SYN_CT_7_17_CHARS', confirmation: 'SYN phone' }, ADMIN_A), 400);
  const device = await w.worklist.registerSourceDevice({ value: ' SYN_CT_7 ', confirmation: 'SYN phone with A radiology' }, ADMIN_A);
  assert.deepEqual([device.institutionId, device.changed, device.attached], [INST_A, true, 1]);
  await refused(() => w.worklist.registerSourceDevice({ value: 'SYN_CT_7', confirmation: 'SYN' }, ADMIN_B), 409);
  assert.deepEqual((await w.worklist.registerSourceDevice({ value: 'SYN_CT_7', confirmation: 'again' }, ADMIN_A)).changed, false);
  const spelling = await w.worklist.registerInstitutionAlias({ value: 'Syn A Hosp.', confirmation: 'SYN mail from A' }, ADMIN_A);
  assert.deepEqual([spelling.changed, spelling.attached], [true, 1]);
  assert.equal(w.institutions.resolveInstitution('SYN A HOSP.'), INST_A, 'the cache serves the new spelling');
  assert.deepEqual((await w.worklist.listStudies(RAD_A)).studies.map(r => r.uid).sort(), [byDevice, bySpelling].sort());
  assert.deepEqual((await w.worklist.listStudies(RAD_B)).studies, []);
  assert.deepEqual(w.audits('study.attach').map(a => [a.target, JSON.parse(a.detail)]).sort(),
    [[byDevice, { institutionId: INST_A, via: 'device', aet: 'SYN_CT_7' }], [bySpelling, { institutionId: INST_A, via: 'alias' }]].sort());
  assert.deepEqual(w.audits('institution.device.register').map(a => JSON.parse(a.detail)),
    [{ institution: INST_A, value: 'SYN_CT_7', confirmation: 'SYN phone with A radiology' }]);
  assert.deepEqual((await w.worklist.heldSources(ADMIN_B)).groups, []);
  // The next arrival from the registered device is attached at first sight; its arrival row says why.
  const later = uidOf();
  w.orthanc.rows.push(qido(later, ''));
  w.orthanc.devices[later] = 'SYN_CT_7';
  assert.ok((await w.worklist.listStudies(RAD_A)).studies.some(r => r.uid === later));
  assert.deepEqual(JSON.parse(w.audits('study.arrived').find(a => a.target === later).detail), { institutionId: INST_A, via: 'device', aet: 'SYN_CT_7' });
});

test('FA-090 EMR Link: the own institution admin sets and clears it; checked wording; host and placeholders audited; other roles and institutions untouched', async () => {
  const w = world();
  await w.boot();
  assert.deepEqual([w.institutions.emrLink(INST_A), w.institutions.emrLink(INST_B), w.institutions.emrLink(null)], [null, null, null]);
  const template = 'https://emr.synthetic.test/chart?pid={patientId}&acc={accession}';
  // Only an administrator; the radiologist and the technician who open it never set it.
  for (const c of [RAD_A, TECH_A]) await refused(() => w.institutions.saveEmrLink({ template }, c), 403);
  // The two rules from the screen, word for word; a malformed body is refused rather than read as a clear.
  const scheme = await refused(() => w.institutions.saveEmrLink({ template: 'javascript:alert({patientId})' }, ADMIN_A), 400);
  assert.match(String(scheme.message), /EMR 주소는 http:\/\/ 또는 https:\/\/로 시작해야 합니다/);
  await refused(() => w.institutions.saveEmrLink({ template: 'emr.synthetic.test/{patientId}' }, ADMIN_A), 400);
  const none = await refused(() => w.institutions.saveEmrLink({ template: 'https://emr.synthetic.test/chart' }, ADMIN_A), 400);
  assert.match(String(none.message), /\{patientId\}, \{accession\}, \{studyUid\} 중 하나는 있어야 합니다/);
  await refused(() => w.institutions.saveEmrLink({ template: 'https://emr.synthetic.test/' + 'x'.repeat(2000) + '{studyUid}' }, ADMIN_A), 400);
  await refused(() => w.institutions.saveEmrLink({}, ADMIN_A), 400);
  await refused(() => w.institutions.saveEmrLink({ template: 7 }, ADMIN_A), 400);
  assert.deepEqual(w.audits('institution.emr-link.save'), [], 'a refused save writes nothing');
  // Saved for A only: A's members read it, B's do not; the audit row names A as target and keeps host and placeholders only.
  const saved = await w.institutions.saveEmrLink({ template: `  ${template}  ` }, ADMIN_A);
  assert.deepEqual(saved, { emrLink: { template }, changed: true });
  assert.deepEqual([w.institutions.emrLink(INST_A), w.institutions.emrLink(INST_B)], [{ template }, null]);
  assert.equal(w.db.rows('institution').find(r => r.id === INST_A).emrLinkTemplate, template);
  assert.deepEqual(w.audits('institution.emr-link.save').map(a => [a.actor, a.target, JSON.parse(a.detail)]),
    [[ADMIN_A.actor, INST_A, { host: 'emr.synthetic.test', placeholders: ['patientId', 'accession'] }]]);
  assert.equal((await w.institutions.saveEmrLink({ template }, ADMIN_A)).changed, false, 'the same value again changes nothing');
  assert.equal(w.audits('institution.emr-link.save').length, 1);
  // Clearing: null or an empty string; B's admin clears B only.
  assert.deepEqual(await w.institutions.saveEmrLink({ template: null }, ADMIN_B), { emrLink: null, changed: false });
  assert.deepEqual(w.institutions.emrLink(INST_A), { template });
  assert.deepEqual(await w.institutions.saveEmrLink({ template: '  ' }, ADMIN_A), { emrLink: null, changed: true });
  assert.equal(w.institutions.emrLink(INST_A), null);
  assert.deepEqual(JSON.parse(w.audits('institution.emr-link.save')[1].detail), { host: null, placeholders: [] });
});

test('SPLIT-13 a held study is decided on its current instances, and a spelling with a comma or a slash registers as one value', async () => {
  const w = world();
  await w.boot();
  const moved = uidOf(), comma = uidOf(), slash = uidOf();
  w.orthanc.rows = [qido(moved, 'SYN UNKNOWN SITE'), qido(comma, 'SYN Hospital, Main'), qido(slash, 'SYN Clinic / East')];
  w.orthanc.devices = { [moved]: 'SYN_CT_8', [comma]: null, [slash]: null };
  // The spellings travel as a list, so a slash inside one hospital's name is one spelling, not several.
  const groups = async () => (await w.worklist.heldSources(ADMIN_A)).groups.map(g => [g.device, g.institutionNames]).sort();
  assert.deepEqual(await groups(), [[null, ['SYN Clinic / East']], [null, ['SYN Hospital, Main']], ['SYN_CT_8', ['SYN UNKNOWN SITE']]]);
  // An instance from another device arrives after the first answer: the study no longer has one sending device, so the
  // first device's registration does not attach it.
  w.orthanc.devices[moved] = null;
  w.orthanc.stamps[moved] = 'second instance';
  assert.equal((await w.worklist.registerSourceDevice({ value: 'SYN_CT_8', confirmation: 'SYN phone' }, ADMIN_A)).attached, 0);
  assert.equal(w.db.rows('studyState').find(r => r.uid === moved).institutionId, null);
  assert.deepEqual(await groups(), [[null, ['SYN Clinic / East']], [null, ['SYN Hospital, Main']], [null, ['SYN UNKNOWN SITE']]]);
  assert.deepEqual((await w.worklist.listStudies(RAD_A)).studies, []);
  // A spelling the hospital sends with a comma is one registered value, never two fragments, here and in the import gate.
  const spelling = await w.worklist.registerInstitutionAlias({ value: 'SYN Hospital, Main', confirmation: 'SYN mail' }, ADMIN_A);
  assert.deepEqual([spelling.changed, spelling.attached], [true, 1]);
  assert.equal(w.institutions.resolveInstitution('syn hospital, main'), INST_A);
  for (const fragment of ['SYN Hospital', 'Main']) assert.equal(w.institutions.resolveInstitution(fragment), null, fragment);
  assert.equal(w.institutions.resolveInstitution('SYN A HOSPITAL'), INST_A, 'the earlier spelling still resolves');
  assert.deepEqual((await w.worklist.listStudies(RAD_A)).studies.map(r => r.uid), [comma]);
  assert.deepEqual((await w.worklist.registerInstitutionAlias({ value: 'SYN Clinic / East', confirmation: 'SYN mail' }, ADMIN_A)).attached, 1);
  assert.deepEqual((await w.worklist.listStudies(RAD_A)).studies.map(r => r.uid).sort(), [comma, slash].sort());
  const { issuerInstitutions } = require('/app/dist/dicom-import-gate.service');
  const stored = w.db.rows('institution').filter(r => r.id === INST_A);
  assert.deepEqual([...issuerInstitutions('SYN Hospital, Main', stored)], [INST_A]);
  assert.deepEqual([...issuerInstitutions('Main', stored)], []);
});
test('multiple source spellings attach only after each resolves to the confirmed institution', async () => {
  const w = world(); await w.boot();
  const uid = uidOf();
  w.orthanc.rows = [qido(uid, 'SYN North'), qido(uid, 'SYN South')];
  w.orthanc.devices = { [uid]: null };
  await w.worklist.heldSources(ADMIN_A);
  assert.equal((await w.worklist.registerInstitutionAlias({ value: 'SYN North', confirmation: 'SYN phone' }, ADMIN_A)).attached, 0);
  assert.equal(w.db.rows('studyState').find(r => r.uid === uid).institutionId, null);
  assert.equal((await w.worklist.registerInstitutionAlias({ value: 'SYN South', confirmation: 'SYN phone' }, ADMIN_A)).attached, 1);
  assert.equal(w.db.rows('studyState').find(r => r.uid === uid).institutionId, INST_A);
  assert.equal(w.audits('study.attach').filter(a => a.target === uid).length, 1);
});

// ── A-027 (D1881): the institution GET audit records each returned row to ──
test('A-027 GET audit records every returned row to the institution its own statement selected; a row without one refuses the response', async () => {
  const w = world();
  await w.boot();
  const s = w.study();
  // The statement's own projection: a legacy row (no recorded institution) carries the study's current owner, a
  // recorded-institution row its recorded one.
  w.db.handlers.unshift([/^SELECT a\.\*, CASE .* FROM "AuditLog" a LEFT JOIN "StudyState" s/, () => [
    { id: 7, action: 'study.arrived', target: s.uid, detail: '{"institutionId":null}', managingInstitution: INST_A },
    { id: 8, action: 'reader.assignment', target: s.uid, detail: JSON.stringify({ institution: INST_B }), managingInstitution: INST_B }]]);
  const read = await w.audit.auditRead(s.uid, 10, ADMIN_A);
  assert.deepEqual(read.managing, [INST_A, INST_B]);
  assert.deepEqual(read.rows.map(r => Object.keys(r).includes('managingInstitution')), [false, false], 'the response rows are unchanged');
  assert.deepEqual(await w.audit.audits(s.uid, 10, ADMIN_A), read.rows);
  w.db.handlers.shift();
  const { studyAuditRead } = require('/app/dist/emr-viewing/consumer-read');
  const response = studyAuditRead(read);
  assert.equal(response.json, JSON.stringify(read.rows));
  assert.deepEqual(response.sources.map(x => [x.managingInstitution, x.target.kind, x.target.recordId.value, x.target.studyId.value]),
    [[INST_A, 'access-audit', '7', s.uid], [INST_B, 'access-audit', '8', s.uid]]);
  assert.throws(() => studyAuditRead({ rows: read.rows, managing: [INST_A, null] }), e => e.getStatus?.() === 503);
});
// ── SPLIT-14 evidence: readability of citations and the CHECK backstop (M16, M17) ──

test('SPLIT-14 a citation is shown only while its finding is readable; a database CHECK on citations or structure becomes its named 409', async () => {
  const w = world();
  const s = w.study({ rs: 'A' });
  const entry = (cid, findingId, text) => ({ v: 1, cid, field: 'findings', findingId, findingRevision: 1, sourceIndex: 0,
    sourceRef: {}, linkStateAtInsert: 'current', headRevisionAtInsert: 1, insertedText: text, insertedAt: '2026-10-01T00:00:00.000Z', insertedBy: RAD_A.actor });
  w.db.seed('report', { uid: s.uid, findings: 'line one\nline two', conclusion: '', recommendation: '', version: 1, updatedBy: RAD_A.actor, updatedBySub: RAD_A.sub });
  w.db.seed('reportVersion', { uid: s.uid, version: 1, action: 'approve', findings: 'line one\nline two', conclusion: '', recommendation: '',
    author: RAD_A.actor, authorSub: RAD_A.sub, citations: [entry('c-1', 'f-readable', 'line one'), entry('c-2', 'f-hidden', 'line two')] });
  w.findings.readable.add('f-readable');
  const read = readBody(await w.evidence.reportCitations(s.uid, RAD_A));
  assert.equal(read.head.length, 2);
  assert.equal(read.head[0].insertedText, 'line one');
  assert.deepEqual(read.head[1], { cid: 'c-2', field: 'findings', insertedAt: '2026-10-01T00:00:00.000Z', insertedBy: RAD_A.actor, state: 'source-unavailable' });
  w.findings.readable.clear();
  const past = JSON.parse((await w.evidence.reportVersionCitations(s.uid, '1', RAD_A)).json);
  assert.ok(past.entries.every(e => e.state === 'source-unavailable' && !('presence' in e)));

  const check = name => Object.assign(new Error('violates check constraint'), { code: 'P2010', meta: { constraint: name } });
  await refused(() => w.evidence.reportLimitChecked(async () => { throw check('ReportDraft_citations_check'); }), 409, 'REPORT_CITATION_LIMIT');
  await refused(() => w.evidence.reportLimitChecked(async () => { throw check('ReportVersion_structured_check'); }), 409, 'REPORT_STRUCTURE_LIMIT');
  const other = check('Some_other_check');
  await assert.rejects(() => w.evidence.reportLimitChecked(async () => { throw other; }), error => error === other);
  assert.equal(await w.evidence.reportLimitChecked(async () => 'ok'), 'ok');
});

// ── SPLIT-15 the product catalog at the report boundary ──

test('SPLIT-15 a report draft accepts the shipped catalog and rejects an unknown item without writing', async () => {
  const w = world(), uid = uidOf();
  const item = STRUCTURE_CATALOG[0].items.find(i => i.code === 'TECHNIQUE');
  const request = { op: 'apply', field: item.field, templateId: STRUCTURE_CATALOG[0].templateId,
    templateRevision: STRUCTURE_CATALOG[0].revision, itemCode: item.code, valueType: item.valueType,
    value: 'SYN technique', renderedText: 'Technique: SYN technique' };
  const result = await w.evidence.draftStructure(w.db.root, uid, null, { structure: request, structureIds: [] },
    { findings: request.renderedText }, RAD_A, 0);
  assert.equal(result.entries[0].value, 'SYN technique');
  assert.equal(result.entries[0].renderedText, request.renderedText);
  await assert.rejects(() => w.evidence.draftStructure(w.db.root, uid, null,
    { structure: { ...request, itemCode: 'UNKNOWN' }, structureIds: [] }, { findings: request.renderedText }, RAD_A, 0),
    error => error.getStatus() === 400);
});

// ── SPLIT-16 clinician reads ──

test('SPLIT-16 the clinician list is the worklist narrowed; a report state that moved after the list was read refuses the whole answer', async () => {
  const w = world();
  await w.boot();
  const s = w.study({ rs: 'A', repDoc: 'syn-rad-a', confirm: '2026-10-01' });
  w.db.seed('report', { uid: s.uid, findings: 'final', conclusion: '', recommendation: '', version: 1, updatedBy: RAD_A.actor, updatedBySub: RAD_A.sub });
  w.db.seed('reportVersion', { uid: s.uid, version: 1, action: 'approve', findings: 'final', conclusion: '', recommendation: '', author: RAD_A.actor, authorSub: RAD_A.sub });
  w.orthanc.rows = [qido(s.uid, 'SYN A HOSPITAL')];
  await refused(() => w.clinician.clinicianStudies(RAD_A), 403);
  const list = readBody(await w.clinician.clinicianStudies(CLIN_A));
  assert.deepEqual(list.studies.map(r => r.uid), [s.uid]);
  const read = readBody(await w.clinician.clinicianReportRead(s.uid, CLIN_A));
  assert.equal(read.report.final, true);
  assert.equal(await w.clinician.clinicianViewerHead(s.uid, CLIN_A), 1);
  // an addendum by another signer lands between the list and its snapshot statement
  w.db.handlers.push([/^SELECT s\.uid, s\."institutionId"/, (params, tables) => {
    w.db.handlers.pop();
    const state = tables.studyState.find(r => r.uid === s.uid), report = tables.report.find(r => r.uid === s.uid);
    state.repDoc = 'syn-rad-a2'; report.version = 2;
    tables.reportVersion.push({ uid: s.uid, version: 2, action: 'addendum' });
    return [{ uid: s.uid, institutionId: INST_A, teleInstitutionId: null, rs: 'A', repDoc: 'syn-rad-a2', confirm: '2026-10-01', version: 2, action: 'addendum' }];
  }]);
  await refused(() => w.clinician.clinicianStudies(CLIN_A), 409, 'STUDY_LIST_CHANGED');
  const foreign = w.study({ institutionId: INST_B, rs: 'A' });
  await refused(() => w.clinician.clinicianReportRead(foreign.uid, CLIN_A), 404);
});

test('SPLIT-16b a signer is shown by the member name on the account; the approval that opened the cycle is shown at the time the study keeps', async () => {
  const w = world();
  await w.boot();
  const rights = (c, name) => w.db.seed('memberRights', { sub: c.sub, username: c.actor.split('@')[0], email: c.actor, name,
    emailVerified: true, approved: true, suspended: false, institution: c.institution, roles: c.roles, version: 1 });
  rights(RAD_A, 'SYN Kim Reader'); rights(RAD_A2, 'SYN Lee Second');
  const s = w.study();
  const epoch = s.draftEpoch;
  const approved = await w.commit.commitReport(s.uid, commitBody(RAD_A, 'approve', epoch, 0, 0, { findings: 'SYN approved' }), RAD_A, null);
  assert.equal(approved.state.repDoc, 'SYN Kim Reader', 'a new approval writes the member name, not the login');
  const approvedAt = new Date(w.db.rows('studyState').find(r => r.uid === s.uid).approvedAt).toISOString();
  const addendum = await w.commit.commitReport(s.uid, commitBody(RAD_A2, 'addendum', epoch, 0, 1, { findings: 'SYN approved + more' }), RAD_A2, null);
  assert.equal(addendum.state.repDoc, 'SYN Lee Second');
  const addendumAt = new Date(w.db.rows('studyState').find(r => r.uid === s.uid).addendumAt).toISOString();
  // The ledger keeps the login and the account of each version as they were.
  assert.deepEqual(w.db.rows('reportVersion').filter(v => v.uid === s.uid).map(v => [v.version, v.action, v.author, v.authorSub]),
    [[1, 'approve', RAD_A.actor, RAD_A.sub], [2, 'addendum', RAD_A2.actor, RAD_A2.sub]]);

  const versions = readBody(await w.evidence.versions(s.uid, RAD_A2));
  // The current cycle's kept events (the approval, the last addendum) are shown at the times the study keeps for them.
  assert.deepEqual(versions.map(v => [v.version, v.author, v.authorName, v.keptAt, v.keptOn]),
    [[2, RAD_A2.actor, 'SYN Lee Second', addendumAt, undefined], [1, RAD_A.actor, 'SYN Kim Reader', approvedAt, undefined]]);

  // The clinician read names the signer and the time of the version it shows; a version opened by number names its own.
  w.orthanc.rows = [qido(s.uid, 'SYN A HOSPITAL')];
  const head = readBody(await w.clinician.clinicianReportRead(s.uid, CLIN_A)).report;
  assert.deepEqual([head.version, head.signedBy, head.keptAt], [2, 'SYN Lee Second', addendumAt]);
  const first = readBody(await w.clinician.clinicianReportRead(s.uid, CLIN_A, '1')).report;
  assert.deepEqual([first.version, first.signedBy, first.keptAt], [1, 'SYN Kim Reader', approvedAt]);

  // Two amendments: the last one is shown at the study's amendedAt (the editor's "수정됨"), the first at its own time.
  const fixed = w.study();
  await w.commit.commitReport(fixed.uid, commitBody(RAD_A, 'approve', fixed.draftEpoch, 0, 0, { findings: 'SYN one' }), RAD_A, null);
  await w.commit.commitReport(fixed.uid, commitBody(RAD_A, 'amend', fixed.draftEpoch, 1, 1, { findings: 'SYN two' }), RAD_A, null);
  await w.commit.commitReport(fixed.uid, commitBody(RAD_A, 'amend', fixed.draftEpoch, 2, 2, { findings: 'SYN three' }), RAD_A, null);
  const kept = w.db.rows('studyState').find(r => r.uid === fixed.uid);
  const amended = readBody(await w.evidence.versions(fixed.uid, RAD_A)).map(v => [v.version, v.action, v.keptAt]);
  assert.deepEqual(amended, [[3, 'amend', new Date(kept.amendedAt).toISOString()], [2, 'amend', undefined],
    [1, 'approve', new Date(kept.approvedAt).toISOString()]]);

  // An approval stored before its time was kept shows its stored date (no time added) while nothing follows it; with an
  // addendum after it, the stored date belongs to the addendum and each version shows its own time.
  const legacy = w.study({ rs: 'A', repDoc: 'syn-rad-a', confirm: '2026-11-17' });
  w.db.seed('report', { uid: legacy.uid, findings: 'SYN old', conclusion: '', recommendation: '', version: 1, updatedBy: RAD_A.actor, updatedBySub: RAD_A.sub });
  w.db.seed('reportVersion', { uid: legacy.uid, version: 1, action: 'approve', findings: 'SYN old', conclusion: '', recommendation: '',
    author: RAD_A.actor, authorSub: RAD_A.sub, at: new Date('2026-11-17T18:05:00.000Z') });
  assert.deepEqual(readBody(await w.evidence.versions(legacy.uid, RAD_A)).map(v => [v.version, v.keptAt, v.keptOn]), [[1, undefined, '2026-11-17']]);
  w.db.seed('reportVersion', { uid: legacy.uid, version: 2, action: 'addendum', findings: 'SYN old + more', conclusion: '', recommendation: '',
    author: RAD_A.actor, authorSub: RAD_A.sub, at: new Date('2026-11-18T01:00:00.000Z') });
  assert.deepEqual(readBody(await w.evidence.versions(legacy.uid, RAD_A)).map(v => [v.version, v.keptAt, v.keptOn]),
    [[2, undefined, undefined], [1, undefined, undefined]]);

  // An account without a member name keeps the login before the @, as before; a repDoc already written is not rewritten.
  const other = w.study({ institutionId: INST_B });
  const plain = await w.commit.commitReport(other.uid, commitBody(RAD_B, 'approve', other.draftEpoch, 0, 0, { findings: 'SYN b' }), RAD_B, null);
  assert.equal(plain.state.repDoc, RAD_B.actor.split('@')[0]);
  assert.equal(w.db.rows('studyState').find(r => r.uid === s.uid).repDoc, 'SYN Lee Second');

  // A writer the history does not show (a discarded copy of someone's private draft) is not named either, even by a name
  // kept on the row.
  const hidden = w.study();
  w.db.seed('reportVersion', { uid: hidden.uid, version: 1, action: 'discarded', findings: 'SYN private', conclusion: '', recommendation: '',
    author: RAD_A2.actor, authorSub: RAD_A2.sub, authorName: 'SYN Lee Second', reason: '관리자 강제 초안 해제' });
  const [copy] = readBody(await w.evidence.versions(hidden.uid, RAD_A));
  assert.notEqual(copy.author, RAD_A2.actor);
  assert.equal(copy.authorName, undefined);
  assert.equal(readBody(await w.evidence.versions(hidden.uid, RAD_A2))[0].authorName, 'SYN Lee Second');
});

test('SPLIT-16c after the member is renamed, a version already signed keeps the name it was signed with; a new one is signed with the new name', async () => {
  const w = world();
  await w.boot();
  w.db.seed('memberRights', { sub: RAD_A.sub, username: RAD_A.actor.split('@')[0], email: RAD_A.actor, name: 'SYN Kim Reader',
    emailVerified: true, approved: true, suspended: false, institution: RAD_A.institution, roles: RAD_A.roles, version: 1 });
  const rename = name => { w.db.rows('memberRights').find(r => r.sub === RAD_A.sub).name = name; };
  const s = w.study();
  const epoch = s.draftEpoch;
  await w.commit.commitReport(s.uid, commitBody(RAD_A, 'approve', epoch, 0, 0, { findings: 'SYN approved' }), RAD_A, null);
  // The administrator changes the member's name (the member row is what the rename writes).
  rename('SYN Kim Renamed');
  const before = readBody(await w.evidence.versions(s.uid, RAD_A));
  assert.deepEqual(before.map(v => [v.version, v.authorName]), [[1, 'SYN Kim Reader']], 'the signed version keeps its signing name');
  w.orthanc.rows = [qido(s.uid, 'SYN A HOSPITAL')];
  assert.equal(readBody(await w.clinician.clinicianReportRead(s.uid, CLIN_A)).report.signedBy, 'SYN Kim Reader');
  // A version signed after the rename carries the new name; the first keeps the old one.
  const revision = () => w.db.rows('reportDraft').find(d => d.uid === s.uid && d.authorSub === RAD_A.sub)?.revision ?? 0;
  await w.commit.commitReport(s.uid, commitBody(RAD_A, 'addendum', epoch, revision(), 1, { findings: 'SYN approved + more' }), RAD_A, null);
  assert.equal(w.db.rows('studyState').find(r => r.uid === s.uid).repDoc, 'SYN Kim Renamed');
  rename('SYN Kim Third');
  assert.deepEqual(readBody(await w.evidence.versions(s.uid, RAD_A)).map(v => [v.version, v.authorName]),
    [[2, 'SYN Kim Renamed'], [1, 'SYN Kim Reader']]);
  assert.equal(readBody(await w.clinician.clinicianReportRead(s.uid, CLIN_A)).report.signedBy, 'SYN Kim Renamed');
  assert.equal(readBody(await w.clinician.clinicianReportRead(s.uid, CLIN_A, '1')).report.signedBy, 'SYN Kim Reader');
  // A stale draft's answer names the approved head by the name it was signed with too.
  const draft = w.db.rows('reportDraft').find(d => d.uid === s.uid && d.authorSub === RAD_A.sub);
  Object.assign(draft, { present: true, baseVersion: 1, findings: 'SYN stale' });
  const stale = await w.commit.commitReport(s.uid, commitBody(RAD_A, 'addendum', epoch, draft.revision, 2, { findings: 'SYN stale' }), RAD_A, null)
    .then(() => null, error => error);
  assert.equal(stale?.getResponse?.().code, 'REPORT_DRAFT_STALE', String(stale?.message));
  assert.equal(stale.getResponse().head.updatedByName, 'SYN Kim Renamed');
  // A version signed before signing names were kept has none of its own: it names none (the screen shows its login), never
  // the account's current name; the clinician read names its login before the @.
  const legacy = w.study({ rs: 'A', repDoc: 'syn-rad-a', confirm: '2026-11-17' });
  w.db.seed('report', { uid: legacy.uid, findings: 'SYN old', conclusion: '', recommendation: '', version: 1, updatedBy: RAD_A.actor, updatedBySub: RAD_A.sub });
  w.db.seed('reportVersion', { uid: legacy.uid, version: 1, action: 'approve', findings: 'SYN old', conclusion: '', recommendation: '',
    author: RAD_A.actor, authorSub: RAD_A.sub, at: new Date('2026-11-17T18:05:00.000Z') });
  const [old] = readBody(await w.evidence.versions(legacy.uid, RAD_A));
  assert.deepEqual([old.author, old.authorName], [RAD_A.actor, undefined]);
  assert.equal(w.db.rows('reportVersion').find(v => v.uid === s.uid && v.version === 1).authorName, 'SYN Kim Reader',
    'the name is kept on the version row itself');
  // Its writer's stale draft after an email change: the head is named by the login that version stored, not the new one.
  const moved = { ...RAD_A, actor: 'syn-rad-a-new@example.test' };
  w.db.seed('reportDraft', { uid: legacy.uid, author: moved.actor, authorSub: RAD_A.sub, findings: 'SYN stale', conclusion: '',
    recommendation: '', baseVersion: 0, revision: 1, present: true });
  const old409 = await w.commit.commitReport(legacy.uid, commitBody(moved, 'addendum', legacy.draftEpoch, 1, 1, { findings: 'SYN stale' }), moved, null)
    .then(() => null, error => error);
  assert.equal(old409?.getResponse?.().code, 'REPORT_DRAFT_STALE', String(old409?.message));
  assert.equal(old409.getResponse().head.updatedByName, RAD_A.actor);
  // An account without a member name keeps its login before the @ as the name it signed under.
  const plain = w.study({ institutionId: INST_B });
  await w.commit.commitReport(plain.uid, commitBody(RAD_B, 'approve', plain.draftEpoch, 0, 0, { findings: 'SYN b' }), RAD_B, null);
  assert.equal(w.db.rows('reportVersion').find(v => v.uid === plain.uid).authorName, RAD_B.actor.split('@')[0]);
});

// ── SPLIT-17 Tech Note attempts (M19, M20) ──

test('SPLIT-17 a Tech Note attempt sent again answers its revision without a second revision or audit row; permission is judged before the attempt id', async () => {
  const w = world();
  const s = w.study();
  const attemptId = randomUUID();
  const body = { baseVersion: 0, text: 'contrast given', reason: '', attemptId };
  const first = await w.techNote.saveTechNote(s.uid, body, TECH_A);
  assert.deepEqual([first.note.version, first.note.isOwnAttempt, first.writable], [1, true, true]);
  const again = await w.techNote.saveTechNote(s.uid, { ...body }, TECH_A);
  assert.deepEqual([again.note.version, again.note.text, again.latestNote.version], [1, 'contrast given', 1]);
  assert.equal(w.db.rows('techNoteRevision').length, 1);
  assert.equal(w.audits('tech-note.revise').length, 1);
  // the id of that attempt used for another request is refused without showing the earlier revision
  const reused = await refused(() => w.techNote.saveTechNote(s.uid, { ...body, text: 'different text' }, TECH_A), 400);
  assert.ok(!JSON.stringify(reused).includes('contrast given'));
  // callers without the write permission are refused for their permission, whatever the attempt id names
  await refused(() => w.techNote.saveTechNote(s.uid, { ...body }, RAD_A), 403);
  await refused(() => w.techNote.saveTechNote(s.uid, { ...body }, TECH_B), 404);
  const tele = w.study({ teleInstitutionId: INST_B });
  await refused(() => w.techNote.saveTechNote(tele.uid, { baseVersion: 0, text: 'x', reason: '', attemptId: randomUUID() }, TECH_B), 403);
  assert.equal(w.db.rows('techNoteRevision').length, 1);
  assert.equal(w.audits('tech-note.revise').length, 1);
  const history = await w.techNote.techNote(s.uid, RAD_A);
  assert.deepEqual([history.note.version, history.note.isOwnAttempt, history.writable], [1, false, false]);
});

// ── SPLIT-18 gateway: identity and idempotent requests ──

test('SPLIT-18 Gateway surfaces admit only the gateway identity; a repeated announce or retry request writes and audits once', async () => {
  const w = world();
  await w.boot();
  const uid = uidOf();
  await refused(() => w.gateway.announceStudy(uid, 'SYN A HOSPITAL', ADMIN_A), 403);
  const first = await w.gateway.announceStudy(uid, 'SYN A HOSPITAL', GATEWAY_A);
  const again = await w.gateway.announceStudy(uid, 'SYN A HOSPITAL', GATEWAY_A);
  assert.deepEqual([first, again].map(a => [a.institutionId, a.origin]), [[INST_A, 'gateway'], [INST_A, 'gateway']]);
  assert.equal(w.audits('study.announce').length, 1);
  await refused(() => w.gateway.announceStudy(uid, '', { ...GATEWAY_A, institution: INST_B }), 409, 'STUDY_OWNERSHIP_CONFLICT');
  const epoch = randomUUID();
  w.db.seed('gatewayReceipt', { studyUid: uid, institutionId: INST_A, epoch, seq: 5n, phase: 'retry' });
  await refused(() => w.gateway.requestGatewayRetry(uid, {}, RAD_A), 403);
  await refused(() => w.gateway.requestGatewayRetry(uid, {}, TECH_B), 404);
  const asked = await w.gateway.requestGatewayRetry(uid, {}, TECH_A);
  const repeated = await w.gateway.requestGatewayRetry(uid, {}, TECH_A);
  assert.deepEqual([asked.result, repeated.result, repeated.requestedAt], ['requested', 'already_requested', asked.requestedAt]);
  assert.equal(w.db.rows('gatewayRetryRequest').length, 1);
  assert.equal(w.audits('gateway.retry.request').length, 1);
});

// Referred, as a study row stores it: [time or null, still waiting for its first announce].
const referredOf = (w, uid) => { const s = w.db.rows('studyState').find(r => r.uid === uid); return s ? [s.referredAt === null ? null : +s.referredAt, s.referredOpen] : 'no row'; };
const STUDY_LOCK = /^SELECT \* FROM "StudyState" WHERE uid = \? FOR UPDATE$/;
/** What another session commits between this announce's first look and the moment it holds the study row's lock: applied
 *  once, to the committed store and to what the locking statement then reads. */
function beforeLockIsHeld(w, change) {
  const entry = [STUDY_LOCK, ([uid], tables, label, store) => {
    store.handlers.splice(store.handlers.indexOf(entry), 1);
    assert.equal(label, 'tx', 'the row is locked inside a transaction');
    for (const view of [store.tables, tables]) view.studyState = change(view.studyState ?? [], uid);
    return (tables.studyState ?? []).filter(r => r.uid === uid).map(copy);
  }];
  w.db.handlers.push(entry);
}
/** A registration that commits between this announce's first look and its own create: the create loses the unique race. */
function losesCreateRace(w, uid, winner) {
  w.db.faults.push({ model: 'studyState', op: 'create', client: 'tx', get error() {
    if (winner) w.db.seed('studyState', { uid, ss: 'Unverified', ...winner });
    return Object.assign(new Error('Unique constraint failed on uid'), { code: 'P2002', meta: { modelName: 'StudyState', target: ['uid'] } });
  } });
}

test('SPLIT-18b Referred is the first announce time: a new study gets its creation moment, a study registered another way gets it once', async () => {
  const w = world();
  await w.boot();
  const row = uid => w.db.rows('studyState').find(s => s.uid === uid);
  // A study the announce creates: one moment for its creation and its Referred time, recorded and closed from the start.
  const fresh = uidOf();
  await w.gateway.announceStudy(fresh, 'SYN A HOSPITAL', GATEWAY_A);
  assert.ok(row(fresh).referredAt instanceof Date);
  assert.deepEqual(referredOf(w, fresh), [+row(fresh).createdAt, false]);
  const first = referredOf(w, fresh);
  await w.gateway.announceStudy(fresh, 'SYN A HOSPITAL', GATEWAY_A);
  assert.deepEqual(referredOf(w, fresh), first, 'a retry keeps the first time');
  // A study registered first another way (a device sent it and a list registered it; a local import claimed it) is blank
  // and waits; the hospital Gateway's first announce records the time once and closes the row in the same write.
  for (const origin of ['dicom', 'local-import']) {
    const direct = w.study({ origin, createdAt: new Date('2026-11-01T00:00:00.000Z') }).uid;
    assert.deepEqual(referredOf(w, direct), [null, true], origin);
    const before = Date.now(), audits = w.audits().length;
    const answer = await w.gateway.announceStudy(direct, 'SYN A HOSPITAL', GATEWAY_A);
    assert.deepEqual(answer, { studyUid: direct, institutionId: INST_A, origin }, 'the origin stays as registered');
    assert.ok(row(direct).referredAt instanceof Date && +row(direct).referredAt >= before, 'the first announce writes the time');
    assert.equal(row(direct).referredOpen, false, 'and closes the row');
    assert.equal(+row(direct).createdAt, +new Date('2026-11-01T00:00:00.000Z'), 'the registration time is not the Referred time');
    const once = referredOf(w, direct), writes = w.db.writes.length;
    for (let i = 0; i < 2; i++) await w.gateway.announceStudy(direct, 'SYN A HOSPITAL', GATEWAY_A);
    assert.deepEqual(referredOf(w, direct), once, 'later announces keep it');
    assert.equal(w.db.writes.length, writes, 'and write nothing');
    assert.equal(w.audits().length, audits, 'a study that was already registered gets no announce audit');
  }
  assert.equal(w.audits('study.announce').length, 1, 'only the created study is an announce audit');
});

test('SPLIT-18c Referred stays blank where a later announce cannot be known to be the first: rows closed without a time', async () => {
  const w = world();
  await w.boot();
  // As the upgrade leaves them: a directly registered study that may already have been announced before the time was kept,
  // and a Gateway study with the time copied from its creation. And a split exam's second (logical) row, created closed.
  const kept = new Date('2026-10-01T03:04:05.678Z');
  const cases = [
    [w.study({ origin: 'dicom', referredAt: null, referredOpen: false }).uid, 'dicom', [null, false]],
    [w.study({ origin: 'local-import', referredAt: null, referredOpen: false }).uid, 'local-import', [null, false]],
    [w.study({ origin: 'gateway', createdAt: kept, referredAt: kept, referredOpen: false }).uid, 'gateway', [+kept, false]],
    [w.study({ uid: '2.25.' + (10n ** 30n + BigInt(process.pid)), origin: 'logical', referredAt: null, referredOpen: false }).uid, 'logical', [null, false]],
  ];
  const writes = w.db.writes.length, audits = w.audits().length;
  for (const [uid, origin, stored] of cases) {
    // The Gateway retries: every announce of its own institution's study is accepted, and none becomes "the first".
    for (let i = 0; i < 3; i++)
      assert.deepEqual(await w.gateway.announceStudy(uid, 'SYN A HOSPITAL', GATEWAY_A), { studyUid: uid, institutionId: INST_A, origin });
    assert.deepEqual(referredOf(w, uid), stored, origin);
  }
  assert.equal(w.db.writes.length, writes, 'nothing is written');
  assert.equal(w.audits().length, audits, 'and nothing audited');
});

test('SPLIT-18d announce judges the row under its lock: one first time; a study gone, another institution\'s or unassigned is the ownership conflict with nothing written', async () => {
  const w = world();
  await w.boot();
  const conflict = async (uid, caller = GATEWAY_A) => {
    const writes = w.db.writes.length, audits = w.audits().length;
    await refused(() => w.gateway.announceStudy(uid, 'SYN A HOSPITAL', caller), 409, 'STUDY_OWNERSHIP_CONFLICT');
    assert.equal(w.db.writes.length, writes, 'a refused announce writes nothing');
    assert.equal(w.audits().length, audits, 'and audits nothing');
  };

  // ── a study that already has a row when the announce first looks ──
  // Deleted between that look and the lock: there is no row to record on, so not a success (and no time written anywhere).
  for (const fields of [{ origin: 'dicom' }, { origin: 'gateway', referredAt: new Date('2026-11-02T00:00:00.000Z'), referredOpen: false }]) {
    const gone = w.study(fields).uid;
    beforeLockIsHeld(w, (rows, uid) => rows.filter(r => r.uid !== uid));
    await conflict(gone);
    assert.equal(referredOf(w, gone), 'no row');
  }
  // Deleted and registered again by a list between the look and the lock: the row found under the lock is a new, open one
  // of this institution, and this announce is its first.
  const again = w.study({ origin: 'gateway', referredAt: new Date('2026-11-02T00:00:00.000Z'), referredOpen: false }).uid;
  beforeLockIsHeld(w, (rows, uid) => rows.map(r => r.uid === uid ? { ...r, origin: 'dicom', referredAt: null, referredOpen: true } : r));
  const before = Date.now();
  assert.equal((await w.gateway.announceStudy(again, '', GATEWAY_A)).origin, 'dicom', 'the answer is read from the locked row');
  assert.ok(referredOf(w, again)[0] >= before && referredOf(w, again)[1] === false);
  // Two announces of one institution that both looked before either wrote: the one that gets the lock second finds the
  // row recorded and keeps that first time.
  const twice = w.study({ origin: 'dicom' }).uid, firstTime = new Date('2026-11-03T05:06:07.008Z');
  beforeLockIsHeld(w, (rows, uid) => rows.map(r => r.uid === uid ? { ...r, referredAt: firstTime, referredOpen: false } : r));
  const writes = w.db.writes.length;
  assert.equal((await w.gateway.announceStudy(twice, '', GATEWAY_A)).origin, 'dicom');
  assert.deepEqual(referredOf(w, twice), [+firstTime, false], 'one first time');
  assert.equal(w.db.writes.length, writes);
  // No longer this institution's when the lock is held, or never this institution's: another institution's and an
  // unassigned study.
  const moved = w.study({ origin: 'dicom' }).uid;
  beforeLockIsHeld(w, (rows, uid) => rows.map(r => r.uid === uid ? { ...r, institutionId: INST_B } : r));
  await conflict(moved);
  assert.deepEqual(referredOf(w, moved), [null, true]);
  const foreign = w.study({ origin: 'dicom', institutionId: INST_B }).uid, held = w.study({ origin: 'dicom', institutionId: null }).uid;
  // A study this institution only receives for tele-reading is its owner's: the receiver's Gateway cannot announce it.
  const tele = w.study({ origin: 'gateway', teleInstitutionId: INST_B, referredAt: firstTime, referredOpen: false }).uid;
  await conflict(foreign); await conflict(held); await conflict(tele, { ...GATEWAY_A, institution: INST_B });
  assert.deepEqual([foreign, held, tele].map(uid => referredOf(w, uid)), [[null, true], [null, true], [+firstTime, false]]);

  // ── a study with no row at the first look, registered by someone else before this announce's own create commits ──
  const raced = async (winner) => { const uid = uidOf(); losesCreateRace(w, uid, winner); return uid; };
  // A list registered the device's study first: this announce is its first, on the winner's row and with its origin.
  const listed = await raced({ institutionId: INST_A, origin: 'dicom' });
  assert.deepEqual(await w.gateway.announceStudy(listed, 'SYN A HOSPITAL', GATEWAY_A), { studyUid: listed, institutionId: INST_A, origin: 'dicom' });
  assert.ok(referredOf(w, listed)[0] >= before && referredOf(w, listed)[1] === false);
  // Another announce of the same institution won: its time is the first, and the loser writes nothing.
  const announced = await raced({ institutionId: INST_A, origin: 'gateway', referredAt: firstTime, referredOpen: false });
  const settled = w.db.writes.length;
  assert.equal((await w.gateway.announceStudy(announced, 'SYN A HOSPITAL', GATEWAY_A)).origin, 'gateway');
  assert.deepEqual(referredOf(w, announced), [+firstTime, false]);
  assert.equal(w.db.writes.length, settled);
  // The winner is another institution's, unassigned, or already gone again: the ownership conflict, the winner untouched.
  const theirs = await raced({ institutionId: INST_B, origin: 'dicom' }); await conflict(theirs);
  const unassigned = await raced({ institutionId: null, origin: 'dicom' }); await conflict(unassigned);
  const vanished = await raced(null); await conflict(vanished);
  assert.deepEqual([theirs, unassigned, vanished].map(uid => referredOf(w, uid)), [[null, true], [null, true], 'no row']);
  assert.equal(w.audits('study.announce').length, 0, 'no announce created a study here, so none is audited');
  assert.equal(w.db.faults.length, 0, 'every staged race was met');
  assert.equal(w.db.handlers.length, 0, 'every staged wait was met');

  // ── refusals that never reach the store, and a row lock that is not free in time ──
  const open = w.study({ origin: 'dicom' }).uid, raw = w.db.raw.length, transactions = w.db.transactions;
  await refused(() => w.gateway.announceStudy(open, '', ADMIN_A), 403);
  await refused(() => w.gateway.announceStudy(open, '', { ...GATEWAY_A, kind: 'member' }), 403);
  await refused(() => w.gateway.announceStudy(open, '', { ...GATEWAY_A, roles: ['radiologist'] }), 403);
  await refused(() => w.gateway.announceStudy('1.2.x', '', GATEWAY_A), 400);
  await refused(() => w.gateway.announceStudy(open, 7, GATEWAY_A), 400);
  assert.deepEqual([w.db.raw.length, w.db.transactions], [raw, transactions]);
  w.db.faults.push({ model: '$raw', op: 'SELECT * FROM "StudyState" WHERE uid = ? FOR UPDATE',
    error: Object.assign(new Error('synthetic lock timeout'), { code: 'P2010', meta: { code: '55P03' } }) });
  await refused(() => w.gateway.announceStudy(open, '', GATEWAY_A), 503, 'GATEWAY_ANNOUNCE_BUSY');
  assert.deepEqual(referredOf(w, open), [null, true], 'still waiting: the Gateway announces again');
  await w.gateway.announceStudy(open, '', GATEWAY_A);
  assert.equal(referredOf(w, open)[1], false);
});

// ── SPLIT-19 preferences and searches: the CAS writes ──

test('SPLIT-19 account settings and shared searches: a write on a stale revision is a conflict; publishing institution searches is administrator-only', async () => {
  const w = world();
  const owner = [INST_A, RAD_A.sub];
  const saved = await w.preferences.saveReadingPreferences({ autoNote: true, expectedOwner: owner, revision: 0 }, RAD_A);
  assert.deepEqual([saved.revision, saved.autoNote], [1, true]);
  await refused(() => w.preferences.saveReadingPreferences({ autoNote: false, expectedOwner: owner, revision: 0 }, RAD_A), 409);
  await refused(() => w.preferences.saveReadingPreferences({ autoNote: false, expectedOwner: [INST_B, RAD_A.sub], revision: 1 }, RAD_A), 409);
  assert.deepEqual(await w.preferences.readingPreferences(RAD_A), { owner, revision: 1, autoNote: true });
  assert.deepEqual(await w.preferences.readingPreferences(CLIN_A), { owner: [INST_A, CLIN_A.sub], revision: 0, autoNote: null });
  await refused(() => w.filters.writeSharedFilters({ command: { action: 'create-folder', path: 'x' }, expectedOwner: owner, revision: 0 }, RAD_A), 403);
  assert.equal(w.db.writes.filter(x => x.model === 'sharedFilterLibrary').length, 0);
});

// ── SPLIT-20 operations metrics and the audit trail ──

test('SPLIT-20 metrics are administrator-only and refused to a restricted account; an unobservable source is never a zero', async () => {
  const w = world();
  w.study();
  w.orthanc.statisticsAnswer = { TotalDiskSize: '123456' };
  await refused(() => w.metrics.adminMetrics(RAD_A), 403);
  const shown = await w.metrics.adminMetrics(ADMIN_A);
  const row = key => shown.metrics.find(m => m.key === key);
  assert.deepEqual([row('storage.server').state, row('storage.server').value], ['observed', 123456]);
  assert.equal(row('studies.own').value, 1);
  w.orthanc.statisticsAnswer = new Error('down');
  const failed = await w.metrics.adminMetrics(ADMIN_A);
  assert.deepEqual([failed.metrics[0].state, failed.metrics[0].reason, failed.metrics[0].value], ['unobservable', 'source_failed', null]);
  w.sa.restricted = true;
  await refused(() => w.metrics.adminMetrics(ADMIN_A), 403, 'ADMIN_METRICS_RESTRICTED');
  w.sa.restricted = false;
  const own = w.study();
  assert.deepEqual(await w.audit.audits(own.uid, 10, RAD_A), []);
  await refused(() => w.audit.audits(own.uid, 10, RAD_B), 404);
});

// ── SPLIT-21 the clinician-only narrowing of the DICOMweb statistics gate (replaces clinician_policy test_13's statement pin) ──

test('SPLIT-21 the DICOMweb statistics gate refuses a clinician-only account; a clinician with a legacy role and a legacy role pass', async () => {
  const w = world();
  for (const [via, gate] of [['concern', w.gateway], ['facade', w.facade()]]) {
    for (const method of ['GET', 'HEAD']) {
      await refused(() => gate.authzDicom('/statistics', method, CLIN_A), 403);
      for (const roles of [['clinician', 'radiologist'], ['clinician', 'technician'], ['clinician', 'admin'], ['radiologist'], ['technician'], ['admin']])
        assert.equal(await gate.authzDicom('/statistics', method, { ...CLIN_A, roles }), undefined, `${via} ${method} ${roles.join('+')}`);
    }
  }
  // a restricted study scope closes the same server-wide counter for every role
  w.sa.restricted = true;
  await refused(() => w.facade().authzDicom('/statistics', 'GET', RAD_A), 403);
});

// ── SPLIT-22/23 the facade: its start, its forwarding and its refusals over one store ──

test('SPLIT-22 the facade starts its institutions concern and each public call answers what its concern does over one store', async () => {
  const w = world();
  w.db.seed('institution', { id: INST_A, name: 'SYN A', type: 'hospital', dicomNames: 'SYN A HOSPITAL' });
  const facade = w.facade();
  assert.equal(facade.institutionName(INST_A), '(미배정)', 'nothing is loaded before the start');
  const log = console.log; console.log = () => {};
  try { await facade.onModuleInit(); } finally { console.log = log; }
  assert.equal(facade.institutionName(INST_A), 'SYN A');
  const s = w.study();
  w.orthanc.rows = [qido(s.uid, 'SYN A HOSPITAL')];
  assert.deepEqual((await facade.listStudies(RAD_A)).studies.map(r => [r.uid, r.institutionName]), [[s.uid, 'SYN A']]);
  assert.deepEqual(await facade.hold(s.uid, RAD_A), { holder: RAD_A.actor, mine: true, conflict: false });
  const saved = await facade.commitReport(s.uid, commitBody(RAD_A, 'save', s.draftEpoch, 0, 0, { findings: 'via facade' }), RAD_A, null);
  assert.deepEqual([saved.state.rs, saved.state.holder], ['T', null], 'a commit releases the hold');
  assert.deepEqual(JSON.parse((await facade.versions(s.uid, RAD_A)).json).map(v => [v.version, v.action, v.findings]), [[1, 'save', 'via facade']]);
  const draft = await facade.putReport(s.uid, draftBody(RAD_A, s.draftEpoch, 1, { findings: 'next', baseVersion: 1 }), RAD_A, null);
  assert.equal(draft.revision, `${s.draftEpoch}:2`);
  assert.equal((await facade.readDraft(s.uid, RAD_A)).snapshot.findings, 'next');
  assert.equal((await facade.saveTechNote(s.uid, { baseVersion: 0, text: 'facade note', reason: '', attemptId: randomUUID() }, TECH_A)).note.version, 1);
  assert.equal(await facade.clinicianViewerHead(s.uid, CLIN_A), null, 'a saved (not approved) head is not final');
  assert.deepEqual(w.audits().map(a => a.action), ['report.hold', 'report.save', 'report.draft', 'tech-note.revise']);
  assert.deepEqual(w.db.writesBy('root').map(x => x.model).filter(m => m !== 'institution' && m !== 'order'), [],
    'outside the start seed every write went through a transaction');
});

test('SPLIT-23 the facade passes every refusal through unchanged: status, code, and nothing written', async () => {
  const w = world();
  const facade = w.facade(), s = w.study();
  await refused(() => facade.commitReport(s.uid, commitBody(TECH_A, 'save', s.draftEpoch, 0, 0), TECH_A, null), 403);
  await refused(() => facade.patchState(s.uid, { rs: 'A' }, TECH_A), 400);
  await refused(() => facade.putReport(s.uid, draftBody(RAD_A, randomUUID(), 0, { findings: 'x' }), RAD_A, null), 409, 'REPORT_DRAFT_CONFLICT');
  await refused(() => facade.audits(s.uid, 10, RAD_B), 404);
  await refused(() => facade.hold(s.uid, ADMIN_B), 404);
  await refused(() => facade.adminMetrics(RAD_A), 403);
  await refused(() => facade.announceStudy('1.2.3', '', ADMIN_A), 403);
  await refused(() => facade.clinicianStudies(RAD_A), 403);
  await refused(() => facade.saveTechNote(s.uid, { baseVersion: 0, text: 'x', reason: '' }, RAD_A, {}), 403);
  assert.deepEqual(w.db.writes, []);
});

// WORKLIST-SPLIT-UID TEST-WSU-08 (shared consumers): a UID two patient resources answer reaches every report entry through
// the facade as the source contract's own 409, observed before the transaction and asserted inside the scope; the hold
// release paths stay open; another institution still gets its 404 first, and nothing is written.
test('SPLIT-24 a split UID is refused by every report entry with STUDY_IDENTITY_UNRESOLVED and no write; release stays open', async () => {
  const w = world();
  const facade = w.facade(), s = w.study({ em: 'E', holder: RAD_A.actor, holderSub: RAD_A.sub, heldAt: new Date() });
  w.sa.split.add(s.uid);
  const entries = [
    () => facade.putReport(s.uid, draftBody(RAD_A, s.draftEpoch, 0, { findings: 'x' }), RAD_A, null),
    () => facade.discardDraft(s.uid, { expectedOwner: ownerOf(RAD_A), expectedRevision: `${s.draftEpoch}:0` }, RAD_A, null),
    () => facade.forceDiscardDrafts(s.uid, { expectedOwner: ownerOf(ADMIN_A), expectedEpoch: s.draftEpoch }, ADMIN_A, null),
    ...['save', 'approve', 'reset', 'defer'].map(action => () => facade.commitReport(s.uid, commitBody(RAD_A, action, s.draftEpoch, 0, 0, { findings: 'x', reason: 'r' }), RAD_A, null)),
    () => facade.readDraft(s.uid, RAD_A), () => facade.hold(s.uid, RAD_A), () => facade.dictationGate(s.uid, RAD_A),
    () => facade.versions(s.uid, RAD_A), () => facade.reportCitations(s.uid, RAD_A), () => facade.reportStructure(s.uid, RAD_A),
    () => facade.reportVersionCitations(s.uid, '1', RAD_A), () => facade.clinicianReportRead(s.uid, CLIN_A),
  ];
  for (const entry of entries) await refused(entry, 409, 'STUDY_IDENTITY_UNRESOLVED');
  assert.deepEqual(w.db.writes, []);
  assert.ok(w.sa.calls.some(c => c[0] === 'source' && c[1].includes(s.uid)));
  await refused(() => facade.putReport(s.uid, draftBody(RAD_B, s.draftEpoch, 0, { findings: 'x' }), RAD_B, null), 404);
  assert.deepEqual(await facade.release(s.uid, RAD_A), { ok: true });
  assert.equal(w.db.rows('studyState').find(r => r.uid === s.uid).holder, null);
});

// ── CD-09-D D9/D10: a study whose report was destroyed at the end of its retention (rs D) ──

test('SPLIT-26 a destroyed report refuses every report write, read, hold and deletion with 410 REPORT_DESTROYED and no write; another institution still gets 404', async () => {
  const w = world();
  const facade = w.facade(), s = w.study({ rs: 'D', reportUnit: null });
  const entries = [
    () => facade.putReport(s.uid, draftBody(RAD_A, s.draftEpoch, 0, { findings: 'x' }), RAD_A, null),
    () => facade.discardDraft(s.uid, { expectedOwner: ownerOf(RAD_A), expectedRevision: `${s.draftEpoch}:0` }, RAD_A, null),
    () => facade.forceDiscardDrafts(s.uid, { expectedOwner: ownerOf(ADMIN_A), expectedEpoch: s.draftEpoch }, ADMIN_A, null),
    ...['save', 'approve', 'addendum', 'reset', 'defer'].map(action => () => facade.commitReport(s.uid, commitBody(RAD_A, action, s.draftEpoch, 0, 0, { findings: 'x', reason: 'r' }), RAD_A, null)),
    () => facade.hold(s.uid, RAD_A), () => facade.removeState(s.uid, TECH_A),
    () => facade.versions(s.uid, RAD_A), () => facade.reportCitations(s.uid, RAD_A), () => facade.reportStructure(s.uid, RAD_A),
    () => facade.reportVersionCitations(s.uid, '1', RAD_A),
  ];
  for (const entry of entries) await refused(entry, 410, 'REPORT_DESTROYED');
  assert.deepEqual(w.db.writes, []);
  // The study row stays, with no version: nothing can start its numbering again or bring it back as unread.
  assert.equal(w.db.rows('studyState').find(r => r.uid === s.uid).rs, 'D');
  assert.deepEqual(w.db.rows('reportVersion').filter(v => v.uid === s.uid), []);
  await refused(() => facade.versions(s.uid, RAD_B), 404);
  await refused(() => facade.commitReport(s.uid, commitBody(RAD_B, 'approve', s.draftEpoch, 0, 0, { findings: 'x' }), RAD_B, null), 404);
});

test('SPLIT-27 the report preview of a destroyed report: the study access policy answers first (its 404 stays), and only a user it admits gets 410', async () => {
  // Review F3: the institution and Preliminary rules pass for this member; the per-study access policy alone decides.
  const { ReportPreviewController } = require('/app/dist/report-preview.controller');
  const state = { uid: '2.25.990099', rs: 'D', reportUnit: null, institutionId: 'SYN-SITE', teleInstitutionId: null };
  const caller = { kind: 'member', sub: 'syn-member', actor: 'syn-reader', institution: 'SYN-SITE', roles: ['radiologist'] };
  const read = async admits => {
    const calls = { policy: 0, orthanc: 0 };
    const controller = new ReportPreviewController({ studyState: { findUnique: async () => state },studyGroupMember:{findMany:async()=>[]} },
      { reportPreviewStudy: async () => { calls.orthanc++; return {}; } },
      {prepare:async()=>{},prepareSourceIdentity:async()=>{}, require: async () => { calls.policy++; if (!admits) throw new NotFoundException('검사를 찾을 수 없습니다'); } }, {});
    const error = await controller.read(state.uid, caller).then(() => null, e => e);
    return { status: error?.getStatus?.(), code: error?.getResponse?.()?.code ?? null, ...calls };
  };
  assert.deepEqual(await read(false), { status: 404, code: null, policy: 1, orthanc: 0 });
  assert.deepEqual(await read(true), { status: 410, code: 'REPORT_DESTROYED', policy: 1, orthanc: 0 });
});


// ── SPLIT-28 QC Flag: one command on the listed row, its revision and generation, its gates and its audit row ──

test('SPLIT-28 QC Flag marks, changes and clears with a rising revision; refusals write nothing; the history keeps the row', async () => {
  const w = world();
  await w.boot();
  const s = w.study();
  const row = () => w.db.rows('studyState').find(r => r.uid === s.uid);
  const cmd = (qc, extra = {}) => ({ qc, qcRevision: row().qcRevision, epoch: row().draftEpoch, ...extra });
  // mark → change the reason → clear: 0 → 1 → 2 → 3; the server sets who and when
  const marked = await w.workflow(workflow => w.studyState.patchState(s.uid, cmd({ reason: '  SYN motion on series 2 ' }), TECH_A, workflow));
  assert.equal(marked.qc.reason, 'SYN motion on series 2');
  assert.equal(marked.qc.by, TECH_A.actor);
  assert.equal(marked.qc.revision, 1);
  assert.ok(!Number.isNaN(Date.parse(marked.qc.at)));
  const changed = await w.studyState.patchState(s.uid, cmd({ reason: 'SYN repeat requested' }), ADMIN_A);
  assert.deepEqual([changed.qc.reason, changed.qc.by, changed.qc.revision], ['SYN repeat requested', ADMIN_A.actor, 2]);
  const cleared = await w.studyState.patchState(s.uid, cmd(null), TECH_A);
  assert.deepEqual(cleared.qc, { reason: null, by: null, at: null, revision: 3 });
  assert.deepEqual([row().qcReason, row().qcBy, row().qcAt, row().qcRevision], [null, null, null, 3]);
  // every change is one state.patch row holding the revision it stored; the other study fields stay as they were
  assert.deepEqual(w.audits('state.patch').map(a => JSON.parse(a.detail)), [
    { qc: { reason: 'SYN motion on series 2' }, qcRevision: 1, by: INST_A }, { qc: { reason: 'SYN repeat requested' }, qcRevision: 2, by: INST_A },
    { qc: null, qcRevision: 3, by: INST_A }]);
  assert.deepEqual([row().ss, row().rs, row().em, row().matched], ['Verified', 'W', 'N', 'U']);
  assert.equal(w.writes.length, 1, 'the workflow write recorded one 수정 record');
  // clearing a row that is not flagged answers it as it is: same revision, nothing written
  const audits = w.audits().length;
  const again = await w.studyState.patchState(s.uid, cmd(null), TECH_A);
  assert.equal(again.qc.revision, 3);
  assert.equal(w.audits().length, audits);

  // malformed commands: 400 before anything is read or written
  const before = w.db.writes.length;
  for (const body of [cmd({ reason: '' }), cmd({ reason: '   ' }), cmd({ reason: 'x'.repeat(501) }), cmd({ reason: 'SYN\u0007bell' }),
    cmd({ reason: 'SYN first\nsecond line' }), cmd({ reason: 'SYN\ttab' }), cmd({ reason: 'SYN trailing\u000b' }), cmd({ reason: 'SYN\u0085' }),
    cmd({ reason: 1 }), cmd('SYN'), cmd({ reason: 'SYN', extra: 1 }), cmd({ reason: 'SYN' }, { em: 'E' }),
    { qc: { reason: 'SYN' } }, cmd({ reason: 'SYN' }, { qcRevision: -1 }), cmd({ reason: 'SYN' }, { epoch: 'not-an-epoch' })])
    await refused(() => w.studyState.patchState(s.uid, body, TECH_A), 400);
  assert.deepEqual(w.db.writes.slice(before), []);
  // 500 characters is accepted
  const long = await w.studyState.patchState(s.uid, cmd({ reason: 'y'.repeat(500) }), TECH_A);
  assert.equal(long.qc.reason.length, 500);

  // two screens saw revision 4; one changes the reason, the other's clear is refused and the new reason stays
  const seen = cmd(null);
  await w.studyState.patchState(s.uid, cmd({ reason: 'SYN newer reason' }), TECH_A);
  await refused(() => w.studyState.patchState(s.uid, seen, TECH_A), 409, 'QC_REVISION_CHANGED');
  assert.equal(row().qcReason, 'SYN newer reason');
  // a command made for an earlier generation of the row (a forced release, a merge or split since) is refused
  await refused(() => w.studyState.patchState(s.uid, cmd(null, { epoch: randomUUID() }), TECH_A), 409, 'QC_STUDY_CHANGED');
  // an audit row that cannot be written takes the change back with it
  const boom = new Error('audit store down');
  w.db.faults.push({ model: 'auditLog', op: 'create', client: 'tx', error: boom });
  await assert.rejects(() => w.studyState.patchState(s.uid, cmd(null), TECH_A), error => error === boom);
  assert.equal(row().qcReason, 'SYN newer reason');

  // who may: a radiologist alone, the tele receiver's technician and administrator, an undesignated reader of a
  // preliminary report, and a row this caller cannot see are refused, with nothing written
  const writes = w.db.writes.length;
  await refused(() => w.studyState.patchState(s.uid, cmd({ reason: 'SYN' }), RAD_A), 403);
  const tele = w.study({ teleInstitutionId: INST_B, ts: 'sent' });
  const teleCmd = { qc: { reason: 'SYN' }, qcRevision: 0, epoch: w.db.rows('studyState').find(r => r.uid === tele.uid).draftEpoch };
  await refused(() => w.studyState.patchState(tele.uid, teleCmd, TECH_B), 403);
  await refused(() => w.studyState.patchState(tele.uid, teleCmd, ADMIN_B), 403);
  const prelim = w.study({ rs: 'P', preDoc: RAD_A.actor, preDocSub: RAD_A.sub, preReviewer: RAD_A2.actor, preReviewerSub: RAD_A2.sub });
  await refused(() => w.studyState.patchState(prelim.uid, { qc: { reason: 'SYN' }, qcRevision: 0,
    epoch: w.db.rows('studyState').find(r => r.uid === prelim.uid).draftEpoch }, TECH_A), 403);
  const other = w.study({ institutionId: INST_B });
  await refused(() => w.studyState.patchState(other.uid, { qc: { reason: 'SYN' }, qcRevision: 0,
    epoch: w.db.rows('studyState').find(r => r.uid === other.uid).draftEpoch }, TECH_A), 404);
  assert.deepEqual(w.db.writes.slice(writes), []);

  // the tele receiver sees the mark and its reason, not who made it
  await w.studyState.patchState(tele.uid, teleCmd, TECH_A);
  const view = values.toClient(w.db.rows('studyState').find(r => r.uid === tele.uid), null, RAD_B, null);
  assert.deepEqual([view.qc.reason, view.qc.by, view.qc.revision], ['SYN', null, 1]);
  assert.equal(values.toClient(w.db.rows('studyState').find(r => r.uid === tele.uid), null, RAD_A, null).qc.by, TECH_A.actor);
  // a row the server has never marked answers the one shape, revision 0
  assert.deepEqual(values.toClient(w.db.rows('studyState').find(r => r.uid === other.uid), null, RAD_A, null).qc,
    { reason: null, by: null, at: null, revision: 0 });

  // a study whose mark was ever set keeps its row (and its revision): deletion is refused, cleared or not
  await refused(() => w.studyState.removeState(s.uid, TECH_A), 409, 'STUDY_HAS_QC_HISTORY');
  assert.ok(row());
});

// ── owner keys: what is a person's own follows the account id (sub), never the email string ──
// No screen changes an email yet: the cases change the caller's login email (actor) as an administrator's change would.
const NEW_EMAIL = 'syn-rad-a-renamed@synthetic.test';
const renamedAs = (c, actor) => ({ ...c, actor });
const tookOldEmail = () => ({ ...member('took-old-email', INST_A, ['radiologist']), actor: RAD_A.actor });

test('OWNER-01 after its email changes the same account keeps its draft, its saved text, its hold and its unsigned versions; another account given the old email gets none of them', async () => {
  const w = world();
  await w.boot();
  const X = RAD_A, X2 = renamedAs(RAD_A, NEW_EMAIL), Y = tookOldEmail();
  const drafted = w.study(), saved = w.study(), held = w.study(), beside = w.study();
  w.orthanc.rows = [drafted, saved, held, beside].map(s => qido(s.uid, 'SYN A HOSPITAL'));
  const stateOf = async (c, s) => (await w.worklist.bootstrap(c)).states[s.uid];
  await w.draft.putReport(drafted.uid, draftBody(X, drafted.draftEpoch, 0, { findings: 'SYN X DRAFT' }), X, null);
  await w.draft.putReport(beside.uid, draftBody(X, beside.draftEpoch, 0, { findings: 'SYN X BESIDE' }), X, null);
  await w.commit.commitReport(saved.uid, commitBody(X, 'save', saved.draftEpoch, 0, 0, { findings: 'SYN X SAVED' }), X, null);
  await w.hold.hold(held.uid, X);

  // the account that now has the old email: none of it is theirs
  assert.equal((await stateOf(Y, drafted)).draft, null, 'a draft never follows its email to another account');
  assert.equal((await stateOf(Y, drafted)).draftRevision, `${drafted.draftEpoch}:0`);
  assert.equal((await stateOf(X2, held)).holderMine, true);
  assert.equal((await stateOf(Y, held)).holderMine, false);
  assert.equal((await stateOf(X2, saved)).savedByMine, true);
  const theirSaved = await stateOf(Y, saved);
  assert.equal(theirSaved.savedByMine, false);
  assert.deepEqual([theirSaved.findings, theirSaved.bodyLock, theirSaved.savedBy], ['', 'in-progress', '작성자 비공개'],
    'the saved text of the account that had the email is not theirs, and its old email is not shown as theirs');
  const hidden = readBody(await w.evidence.versions(saved.uid, Y))[0];
  assert.deepEqual([hidden.findings, hidden.mine], ['', false]);
  assert.deepEqual(await w.hold.hold(held.uid, Y), { holder: '작성자 비공개', mine: false, conflict: true });
  await refused(() => w.commit.commitReport(held.uid, commitBody(Y, 'save', held.draftEpoch, 0, 0, { findings: 'over it' }), Y, null), 409, 'REPORT_HELD');
  // their own first draft on a study the other account drafted is a row of their own
  await w.draft.putReport(beside.uid, draftBody(Y, beside.draftEpoch, 0, { findings: 'SYN Y DRAFT' }), Y, null);
  const xKey = storedAuthor(w, drafted.uid, X), yKey = storedAuthor(w, beside.uid, Y);
  assert.notEqual(xKey, yKey);
  const besideRows = w.db.rows('reportDraft').filter(d => d.uid === beside.uid).map(d => [d.author, d.authorSub, d.findings]).sort();
  assert.deepEqual(besideRows, [[xKey, X.sub, 'SYN X BESIDE'], [yKey, Y.sub, 'SYN Y DRAFT']].sort());

  // the same account under its new email: its draft (same row, same record id), saved text, hold and versions
  assert.equal((await stateOf(X2, drafted)).draft.findings, 'SYN X DRAFT');
  // the viewing record of that bootstrap names the draft row it read, never [uid, new email]
  const { bootstrapRead } = require('/app/dist/emr-viewing/consumer-read');
  const viewed = bootstrapRead(await w.worklist.bootstrap(X2), X2.actor, INST_A).sources
    .filter(source => source.target.kind === 'private-draft' && source.target.studyId.value === drafted.uid);
  assert.deepEqual(viewed.map(source => source.target.recordId.value), [JSON.stringify([drafted.uid, xKey])]);
  assert.equal((await stateOf(X2, beside)).draft.findings, 'SYN X BESIDE');
  await w.draft.putReport(drafted.uid, draftBody(X2, drafted.draftEpoch, 1, { findings: 'SYN X DRAFT 2' }), X2, null);
  assert.deepEqual(w.db.rows('reportDraft').filter(d => d.uid === drafted.uid).map(d => [d.author, d.authorSub, d.revision, d.findings]),
    [[xKey, X.sub, 2, 'SYN X DRAFT 2']]);
  const mineSaved = await stateOf(X2, saved);
  assert.deepEqual([mineSaved.findings, mineSaved.bodyLock, mineSaved.savedBy], ['SYN X SAVED', null, NEW_EMAIL]);
  const ownVersion = readBody(await w.evidence.versions(saved.uid, X2))[0];
  assert.deepEqual([ownVersion.findings, ownVersion.mine], ['SYN X SAVED', true]);
  assert.deepEqual(await w.hold.hold(held.uid, X2), { holder: NEW_EMAIL, mine: true, conflict: false });
  // its commit ends its own draft; its next Save is its own text again
  const done = await w.commit.commitReport(drafted.uid, commitBody(X2, 'save', drafted.draftEpoch, 2, 0, { findings: 'SYN X DRAFT 2' }), X2, null);
  assert.deepEqual([done.state.draft, done.state.savedBy, done.state.bodyLock], [null, NEW_EMAIL, null]);
  assert.equal(w.db.rows('reportDraft').find(d => d.uid === drafted.uid).present, false);
  assert.equal((await stateOf(Y, drafted)).bodyLock, 'in-progress');
});

test('OWNER-02 Reset of an in-progress report hands the saved text back to the account that saved it, whatever its email is now', async () => {
  const w = world();
  await w.boot();
  const X = RAD_A, X2 = renamedAs(RAD_A, NEW_EMAIL), Y = tookOldEmail();
  const s = w.study();
  w.orthanc.rows = [qido(s.uid, 'SYN A HOSPITAL')];
  await w.commit.commitReport(s.uid, commitBody(X, 'save', s.draftEpoch, 0, 0, { findings: 'SYN X SAVED' }), X, null);
  const reset = await w.commit.commitReport(s.uid, commitBody(Y, 'reset', s.draftEpoch, 0, 1), Y, null);
  assert.deepEqual([reset.released.savedBy, reset.released.savedKept], ['작성자 비공개', true]);
  assert.equal((await w.worklist.bootstrap(X2)).states[s.uid].draft.findings, 'SYN X SAVED');
  assert.equal((await w.worklist.bootstrap(Y)).states[s.uid].draft, null);
  const copy = w.db.rows('reportVersion').find(v => v.uid === s.uid && v.action === 'discarded');
  assert.deepEqual([copy.author, copy.authorSub], [RAD_A.actor, X.sub]);
  assert.equal(readBody(await w.evidence.versions(s.uid, X2)).find(v => v.action === 'discarded').findings, 'SYN X SAVED');
  assert.equal(readBody(await w.evidence.versions(s.uid, Y)).find(v => v.action === 'discarded').findings, '');
});

test('OWNER-03 saved searches, the default, folders and reading templates follow the account after its email changes, never the old email', async () => {
  const w = world();
  const X = RAD_A, X2 = renamedAs(RAD_A, NEW_EMAIL), Y = tookOldEmail();
  await w.filters.saveFilter({ name: 'SYN mine', quick: 'chest', isDefault: true }, X);
  const template = await w.preferences.saveTemplate({ title: 'SYN template', findings: 'SYN TEMPLATE TEXT' }, X);
  const mine = await w.preferences.prefs(X2);
  assert.deepEqual(mine.filters.map(f => [f.name, f.isDefault]), [['SYN mine', true]]);
  assert.ok(mine.templates.some(t => t.id === template.id), 'the template stays with the account');
  const theirs = await w.preferences.prefs(Y);
  assert.deepEqual(theirs.filters, []);
  assert.ok(!theirs.templates.some(t => t.id === template.id));
  assert.ok(theirs.templates.length > 0, 'the other account gets its own starting templates');
  await refused(() => w.filters.deleteFilter(mine.filters[0].id, Y), 404);
  await refused(() => w.preferences.deleteTemplate(template.id, Y), 404);
  await w.filters.setDefaultFilter(mine.filters[0].id, false, X2);
  assert.deepEqual((await w.preferences.prefs(X2)).filters.map(f => [f.name, f.isDefault]), [['SYN mine', false]]);
  assert.deepEqual((await w.preferences.deleteTemplate(template.id, X2)), { ok: true });
  assert.equal((await w.filters.readFilterFolders(Y)).revision, 0, 'the other account has no folder collection of the old email');
});

test('OWNER-04 a draft record id is never issued to another account: a study deleted and arriving again under its UID keeps the emptied row', async () => {
  const w = world();
  await w.boot();
  const X = RAD_A, Y = tookOldEmail();
  const s = w.study();
  w.orthanc.rows = [qido(s.uid, 'SYN A HOSPITAL')];
  await w.draft.putReport(s.uid, draftBody(X, s.draftEpoch, 0, { findings: 'SYN X DRAFT' }), X, null);
  const kept = storedAuthor(w, s.uid, X);
  await w.draft.discardDraft(s.uid, { expectedOwner: ownerOf(X), expectedRevision: `${s.draftEpoch}:1` }, X, null);
  await w.workflow(workflow => w.studyState.removeState(s.uid, TECH_A, workflow));
  assert.deepEqual(w.db.rows('reportDraft').filter(d => d.uid === s.uid).map(d => [d.author, d.authorSub, d.present]), [[kept, X.sub, false]],
    'the emptied row stays with its record id');
  const again = w.study({ uid: s.uid });
  await w.draft.putReport(s.uid, draftBody(Y, again.draftEpoch, 0, { findings: 'SYN Y DRAFT' }), Y, null);
  assert.deepEqual(w.db.rows('reportDraft').filter(d => d.uid === s.uid && d.present).map(d => d.authorSub), [Y.sub]);
  assert.notEqual(storedAuthor(w, s.uid, Y), kept);
});

test('first empty view fixes the draft record id through rename, first save, and retention', async () => {
  const w = world();
  await w.boot();
  const s = w.study();
  const x = renamedAs(RAD_A, `old#${RAD_A.sub}@synthetic.test`);
  const renamed = renamedAs(x, NEW_EMAIL), next = renamedAs(tookOldEmail(), x.actor);
  await w.draft.readDraft(s.uid, x);
  const recordId = actsOf(w.records, 'GET studies/:uid/draft').at(-1)[3];
  assert.ok(!recordId.includes(x.actor));
  assert.equal(w.db.rows('reportDraft').length, 0);
  await w.draft.putReport(s.uid, draftBody(renamed, s.draftEpoch, 0, { findings: 'SYN saved' }), renamed, null);
  await w.draft.readDraft(s.uid, renamed);
  assert.deepEqual(actsOf(w.records, 'GET studies/:uid/draft').map(entry => entry[3]), [recordId, recordId]);
  assert.equal((await w.draft.readDraft(s.uid, next)).present, false);
  const nextId = actsOf(w.records, 'GET studies/:uid/draft').at(-1)[3];
  assert.notEqual(nextId, recordId);
  await w.draft.putReport(s.uid, draftBody(next, s.draftEpoch, 0, { findings: 'SYN next' }), next, null);
  assert.deepEqual(w.db.rows('reportDraft').map(d => JSON.stringify([d.uid, d.author])), [recordId, nextId]);
  await w.draft.discardDraft(s.uid, { expectedOwner: ownerOf(renamed), expectedRevision: `${s.draftEpoch}:1` }, renamed, null);
  const end = w.db.rows('reportDraftPurposeEnd')[0];
  assert.equal(JSON.stringify([end.uid, end.author]), recordId);
  await w.draft.putReport(s.uid, draftBody(renamed, s.draftEpoch, 2, { findings: 'SYN again' }), renamed, null);
  await w.draft.forceDiscardDrafts(s.uid, { expectedOwner: ownerOf(ADMIN_A), expectedEpoch: s.draftEpoch }, ADMIN_A, null);
  assert.equal(w.db.rows('reportVersion').find(v => v.findings === 'SYN again').author, renamed.actor);
  assert.equal(w.db.rows('reportVersion').find(v => v.findings === 'SYN next').author, next.actor);
});

test('a literal legacy login ending in #sub keeps its id and full display name', async () => {
  const w = world(), s = w.study();
  const x = RAD_A, legacyName = `${x.actor}#${x.sub}`;
  w.db.seed('reportDraft', { uid: s.uid, author: legacyName, authorSub: null, findings: 'legacy', conclusion: '',
    recommendation: '', baseVersion: 0, revision: 1, present: true });
  await w.draft.putReport(s.uid, draftBody(x, s.draftEpoch, 0, { findings: 'new' }), x, null);
  await w.draft.forceDiscardDrafts(s.uid, { expectedOwner: ownerOf(ADMIN_A), expectedEpoch: s.draftEpoch }, ADMIN_A, null);
  const newKey = storedAuthor(w, s.uid, x);
  assert.notEqual(newKey, legacyName);
  assert.deepEqual(w.db.rows('reportDraft').map(row => row.author).sort(), [legacyName, newKey].sort());
  assert.deepEqual(w.db.rows('reportVersion').map(row => [row.findings, row.author]).sort(),
    [['legacy', legacyName], ['new', x.actor]]);
});

// ── An Addendum only adds to the approved report, and adds something; signing-key refusals say the action; a head saved
//    by another window of the same account is named as such and can be saved over by an explicit second send ──

const { ContractError } = require('/app/dist/emr-contract/validation');
const versionsOf = (w, uid) => w.db.rows('reportVersion').filter(v => v.uid === uid).map(v => [v.version, v.action, v.findings, v.conclusion]);
async function approvedStudy(w, text = { findings: 'Line one.\nLine two.', conclusion: 'Impression.' }) {
  const s = w.study();
  await w.commit.commitReport(s.uid, commitBody(RAD_A, 'approve', s.draftEpoch, 0, 0, text), RAD_A, null);
  return s;
}

test('an Addendum with nothing added is refused, the first one and a repeated one alike, and signs no version', async () => {
  const w = world(), s = await approvedStudy(w);
  const head = { findings: 'Line one.\nLine two.', conclusion: 'Impression.' };
  for (const text of [head, { ...head, findings: head.findings + '  \n' }, { ...head, recommendation: '\n' }]) {
    const body = await refused(() => w.commit.commitReport(s.uid, commitBody(RAD_A2, 'addendum', s.draftEpoch, 0, 1, text), RAD_A2, null), 400, 'REPORT_ADDENDUM_EMPTY');
    assert.match(body.message, /덧붙인 내용이 없습니다/);
  }
  assert.deepEqual(versionsOf(w, s.uid), [[1, 'approve', head.findings, head.conclusion]]);
  const added = await w.commit.commitReport(s.uid, commitBody(RAD_A2, 'addendum', s.draftEpoch, 0, 1, { ...head, recommendation: 'Follow up in 3 months.' }), RAD_A2, null);
  assert.equal(added.state.rs, 'A');
  // The same Addendum pressed again on the new head adds nothing: refused.
  await refused(() => w.commit.commitReport(s.uid, commitBody(RAD_A2, 'addendum', s.draftEpoch, 1, 2, { ...head, recommendation: 'Follow up in 3 months.' }), RAD_A2, null), 400, 'REPORT_ADDENDUM_EMPTY');
  assert.deepEqual(versionsOf(w, s.uid).map(v => v.slice(0, 2)), [[1, 'approve'], [2, 'addendum']]);
});

test('an Addendum that takes away or changes approved text is refused; one that writes after it is signed, the head kept in front', async () => {
  const w = world(), s = await approvedStudy(w);
  const cases = [
    { findings: 'Line one.', conclusion: 'Impression.' },                                  // a line taken away
    { findings: 'Line one.\nLine 2.\nAdded.', conclusion: 'Impression.' },               // a word changed
    { findings: 'Added.\nLine one.\nLine two.', conclusion: 'Impression.' },             // written before the head
    { findings: 'Line one.\nLine two.\nAdded.', conclusion: '' },                        // another field emptied
  ];
  for (const text of cases) {
    const body = await refused(() => w.commit.commitReport(s.uid, commitBody(RAD_A2, 'addendum', s.draftEpoch, 0, 1, text), RAD_A2, null), 400, 'REPORT_ADDENDUM_NOT_APPENDED');
    assert.match(body.message, /추가기재는 승인본에 덧붙이기만 합니다/);
  }
  assert.equal(w.db.rows('reportVersion').length, 1);
  await w.commit.commitReport(s.uid, commitBody(RAD_A2, 'addendum', s.draftEpoch, 0, 1, { findings: 'Line one.\nLine two.', conclusion: 'Impression.\nAddendum: no change.' }), RAD_A2, null);
  assert.deepEqual(versionsOf(w, s.uid), [[1, 'approve', 'Line one.\nLine two.', 'Impression.'],
    [2, 'addendum', 'Line one.\nLine two.', 'Impression.\nAddendum: no change.']]);
});

test('an Addendum written on an older approved text cannot drop the lines another reader added since', async () => {
  const w = world(), s = await approvedStudy(w, { findings: 'Base.' });
  await w.commit.commitReport(s.uid, commitBody(RAD_A2, 'addendum', s.draftEpoch, 0, 1, { findings: 'Base.\nAdded by the second reader.' }), RAD_A2, null);
  // The first reader's screen polled the new version number but still holds text written on v1.
  await refused(() => w.commit.commitReport(s.uid, commitBody(RAD_A, 'addendum', s.draftEpoch, 1, 2, { findings: 'Base.\nAdded by the first reader.' }), RAD_A, null), 400, 'REPORT_ADDENDUM_NOT_APPENDED');
  await w.commit.commitReport(s.uid, commitBody(RAD_A, 'addendum', s.draftEpoch, 1, 2, { findings: 'Base.\nAdded by the second reader.\nAdded by the first reader.' }), RAD_A, null);
  assert.deepEqual(versionsOf(w, s.uid).map(v => [v[0], v[1], v[2]]), [[1, 'approve', 'Base.'],
    [2, 'addendum', 'Base.\nAdded by the second reader.'], [3, 'addendum', 'Base.\nAdded by the second reader.\nAdded by the first reader.']]);
});

test('an Addendum compares line ends only as line ends: a head stored with CRLF takes text written after it', async () => {
  const w = world(), s = w.study({ rs: 'A', repDoc: 'syn-rad-a', confirm: '2026-11-01' });
  w.db.seed('report', { uid: s.uid, findings: 'Stored one.\r\nStored two.', conclusion: '', recommendation: '', version: 1, updatedBy: RAD_A.actor, updatedBySub: RAD_A.sub });
  w.db.seed('reportVersion', { uid: s.uid, version: 1, action: 'approve', findings: 'Stored one.\r\nStored two.', conclusion: '', recommendation: '', author: RAD_A.actor, authorSub: RAD_A.sub, citations: [] });
  await w.commit.commitReport(s.uid, commitBody(RAD_A2, 'addendum', s.draftEpoch, 0, 1, { findings: 'Stored one.\nStored two.\nAdded.' }), RAD_A2, null);
  assert.equal(versionsOf(w, s.uid).at(-1)[1], 'addendum');
});

test('the approver may still change the middle of the text within 24 hours (amend); an Addendum that does the same is refused', async () => {
  const w = world(), s = await approvedStudy(w);
  await refused(() => w.commit.commitReport(s.uid, commitBody(RAD_A, 'addendum', s.draftEpoch, 1, 1, { findings: 'Line one.\nLine 2.', conclusion: 'Impression.' }), RAD_A, null), 400, 'REPORT_ADDENDUM_NOT_APPENDED');
  const amended = await w.commit.commitReport(s.uid, commitBody(RAD_A, 'amend', s.draftEpoch, 1, 1, { findings: 'Line one.\nLine 2.', conclusion: 'Impression.' }), RAD_A, null);
  assert.equal(amended.state.rs, 'A');
  assert.deepEqual(versionsOf(w, s.uid).map(v => v.slice(0, 3)), [[1, 'approve', 'Line one.\nLine two.'], [2, 'amend', 'Line one.\nLine 2.']]);
});

test('a refusal for want of a signing key names the action it refused; the approval keeps its words', async () => {
  const w = world();
  const signer = { sign: async () => { throw new ContractError('DoctorSigningKeyUnavailable'); } };
  const failing = withDraftRequestContext(new PacsReportCommit(w.keycloak, w.sa, w.evidence, w.draft, signer), b2Ledger(w.db.root));
  const fresh = w.study();
  const approve = await refused(() => failing.commitReport(fresh.uid, commitBody(RAD_A, 'approve', fresh.draftEpoch, 0, 0, { findings: 'Text.' }), RAD_A, null), 503, 'DoctorSigningKeyUnavailable');
  assert.match(approve.message, /서명키를 확인하지 못해 승인하지 못했습니다/);
  const s = await approvedStudy(w);
  const said = {
    amend: [commitBody(RAD_A, 'amend', s.draftEpoch, 1, 1, { findings: 'Line one.\nLine 2.', conclusion: 'Impression.' }), /승인 후 수정을 저장하지 못했습니다/],
    addendum: [commitBody(RAD_A, 'addendum', s.draftEpoch, 1, 1, { findings: 'Line one.\nLine two.\nMore.', conclusion: 'Impression.' }), /추가기재\(Addendum\)를 저장하지 못했습니다/],
    reset: [commitBody(RAD_A, 'reset', s.draftEpoch, 1, 1, { reason: 'wrong patient' }), /판독 취소\(Reset\)를 하지 못했습니다/],
  };
  for (const [action, [body, words]] of Object.entries(said)) {
    const refusal = await refused(() => failing.commitReport(s.uid, body, RAD_A, null), 503, 'DoctorSigningKeyUnavailable');
    assert.match(refusal.message, words, action);
    assert.doesNotMatch(refusal.message, /승인하지 못했습니다/, action);
  }
  assert.deepEqual(versionsOf(w, s.uid).map(v => v.slice(0, 2)), [[1, 'approve']], 'no refused commit left a version');
});

test('a Save on a version another window of the same account saved is named as mine, and a second send on that version saves it', async () => {
  const w = world(), s = w.study();
  await w.commit.commitReport(s.uid, commitBody(RAD_A, 'save', s.draftEpoch, 0, 0, { findings: 'Window one.' }), RAD_A, null);
  // The second window still stands on v0.
  const body = await refused(() => w.commit.commitReport(s.uid, commitBody(RAD_A, 'save', s.draftEpoch, 1, 0, { findings: 'Window two.' }), RAD_A, null), 409, 'REPORT_VERSION_CONFLICT');
  assert.deepEqual(body.head, { version: 1, mine: true });
  assert.match(body.message, /다른 창에서 이 계정으로 v1을 저장했습니다/);
  assert.ok(!body.message.includes(RAD_A.actor) && !body.message.includes('syn-rad-a'), body.message);
  const saved = await w.commit.commitReport(s.uid, commitBody(RAD_A, 'save', s.draftEpoch, 1, 1, { findings: 'Window two.' }), RAD_A, null);
  assert.equal(saved.state.rs, 'T');
  assert.deepEqual(versionsOf(w, s.uid).map(v => v.slice(0, 3)), [[1, 'save', 'Window one.'], [2, 'save', 'Window two.']]);
  // A head another account signed is not mine: the refusal names its writer as before.
  const a = await approvedStudy(w);
  const other = await refused(() => w.commit.commitReport(a.uid, commitBody(RAD_A2, 'reset', a.draftEpoch, 0, 0, { reason: 'wrong patient' }), RAD_A2, null), 409, 'REPORT_VERSION_CONFLICT');
  assert.deepEqual(other.head, { version: 1, mine: false });
  assert.match(other.message, /^그 사이 .+가 v1을 저장했습니다/);
});

test('an Addendum pressed before the first draft write, on a version older than the approved head, is re-based - not reloaded', async () => {
  const w = world(), s = await approvedStudy(w, { findings: 'Base.' });
  await w.commit.commitReport(s.uid, commitBody(RAD_A2, 'addendum', s.draftEpoch, 0, 1, { findings: 'Base.\nSecond reader.' }), RAD_A2, null);
  // The first reader typed on v1 and pressed Addendum before any draft of theirs reached the server.
  const stale = await refused(() => w.commit.commitReport(s.uid, commitBody(RAD_A, 'addendum', s.draftEpoch, 1, 1, { findings: 'Base.\nFirst reader.' }), RAD_A, null), 409, 'REPORT_DRAFT_STALE');
  assert.equal(stale.draftBaseVersion, 1);
  assert.deepEqual({ version: stale.head.version, findings: stale.head.findings }, { version: 2, findings: 'Base.\nSecond reader.' });
  assert.equal(versionsOf(w, s.uid).length, 2, 'nothing was signed');
});