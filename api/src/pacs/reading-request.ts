/*
 * Reading request: a clinician of the owning institution asks for an existing study to be read, and the radiologists see
 * the request on their worklist row until the study's report is approved. No urgency, reason, cancel, message or order.
 *
 * The one rule. A request is kept on the original study the clinician picked (the clinician list lists originals). The
 * study's latest request is open while `readingRequestAt` is set and `readingRequestClosedAt` is NULL. It shows on the
 * report row the study opens on now - `examOpenUids`, the same server function the in-app unread marks use - and nowhere
 * else. The approval (`approve`) of that row closes it, once, in the approval's own transaction (closeReadingRequests),
 * with the approval's time: so a Reset, an amendment, an Addendum or a later merge or unmerge never reopens it, and an
 * approval refused (signing included) leaves it open. A request is made only while the row it opens on is not approved
 * (A) or destroyed (D); an open request answers a second press as it is (one request per study). The request never
 * changes the report, RS, hold, assignment or images: only its five StudyState fields and one audit row.
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { PrismaService } from '../prisma.service';
import type { StudyAccessService } from '../study-access.service';
import { activeGroups, examOpenUids, prepareExamRead, resolveExamScope } from '../exam-merge.service';
import type { ResolvedExamScope } from '../exam-merge.service';
import { CLINICIAN_ROLE } from '../clinician-policy';
import type { Caller } from './access';

export const READING_REQUEST_AUDIT_ACTION = 'study.reading-request';
const STUDY_UID = /^\d+(?:\.\d+)+$/;

type RequestCaller = Caller & { name?: string };
export interface ReadingRequestView { at: string; by: string; open: boolean; closedAt: string | null }

const holds = (c: Caller, role: string) => Array.isArray(c.roles) && c.roles.includes(role);
const iso = (value: unknown) => {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const t = new Date(value as any).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const error = (code: string, message: string) => ({ code, message });
const roleRequired = () => new ForbiddenException(error('READING_REQUEST_ROLE_REQUIRED', '판독 의뢰는 진료과 의사(clinician) 계정만 할 수 있습니다'));
const invalid = () => new BadRequestException(error('READING_REQUEST_INPUT_INVALID', '판독 의뢰 요청의 형식을 확인하세요'));
const missing = () => new NotFoundException(error('STUDY_NOT_FOUND', '검사를 찾을 수 없습니다'));
const ownerChanged = () => new ConflictException(error('OWNER_CHANGED', '로그인한 계정이 바뀌었습니다. 화면을 다시 불러오세요'));
const reported = (rs: string) => rs === 'D'
  ? new ConflictException(error('READING_REQUEST_DESTROYED', '보존 기간이 끝나 판독문을 파기한 검사입니다. 판독을 의뢰할 수 없습니다'))
  : new ConflictException(error('READING_REQUEST_REPORTED', '이미 승인된 판독문이 있습니다. 판독문을 보거나 Questions로 물어보세요'));
const busy = () => new ServiceUnavailableException(error('READING_REQUEST_BUSY', '판독 의뢰를 처리하는 중입니다. 다시 누르세요'));

/** Is the study's latest request open (requested and not closed by an approval)? */
export function readingRequestOpen(state: any): boolean {
  return iso(state?.readingRequestAt) !== null && state?.readingRequestClosedAt == null;
}

/** Who asked, as the token named them when they asked (the login when it carried no name). */
function requester(state: any): string {
  return typeof state?.readingRequestByName === 'string' && state.readingRequestByName.trim() ? state.readingRequestByName
    : typeof state?.readingRequestBy === 'string' ? state.readingRequestBy : '';
}

/** The study's latest request as the clinician screen shows it, or null when it never had one. */
export function readingRequestView(state: any): ReadingRequestView | null {
  const at = iso(state?.readingRequestAt);
  if (at === null) return null;
  const closedAt = state?.readingRequestClosedAt == null ? null : iso(state.readingRequestClosedAt);
  return { at, by: requester(state), open: state?.readingRequestClosedAt == null, closedAt };
}

/**
 * The approval of `uid` closes the open requests of the originals that row answers for - the studies `examOpenUids`
 * opens on it: every study of a merged exam on its base row, and on a split exam only the original on the row that is
 * itself (the first part; the second part's own approval closes nothing). Written in the approval's transaction, after its
 * StudyState row is locked, so a refused or rolled-back approval leaves the request open. The approved row's own request is
 * closed by the approval's own StudyState write (`ownClose`, judged on that locked row); the other studies of a merged exam
 * by `closeMergedReadingRequests` in the same transaction.
 */
export function ownReadingRequestClose(prev: any, at: Date): { readingRequestClosedAt?: Date } {
  return readingRequestOpen(prev) ? { readingRequestClosedAt: at } : {};
}
export async function closeMergedReadingRequests(tx: any, uid: string, scope: Pick<ResolvedExamScope, 'kind' | 'studies'>, at: Date) {
  const others = scope.kind === 'merge' ? scope.studies.filter(study => study !== uid) : [];
  if (!others.length) return;
  await tx.studyState.updateMany({ where: { uid: { in: others }, readingRequestAt: { not: null }, readingRequestClosedAt: null },
    data: { readingRequestClosedAt: at } });
}

/**
 * The worklist rows' open requests: for each row (its uid and the originals it shows), the open request of an original of
 * the caller's own institution whose open row (`examOpenUids`) is that row. Two originals of one merged row show once: the
 * request opened first (then the lower study UID). A tele receiver never sees the owner's requests. Judged on the StudyState
 * rows the list itself read (`stateOf`); nothing more is read unless a row has an open request.
 */
export async function worklistReadingRequests(prisma: PrismaService, access: StudyAccessService, c: Caller,
  rows: { uid: string; studies: string[] }[], stateOf: (uid: string) => any): Promise<Map<string, { at: string; by: string }>> {
  const out = new Map<string, { at: string; by: string }>();
  if (typeof c.institution !== 'string' || !c.institution) return out;
  const open: any[] = [...new Set(rows.flatMap(row => row.studies))].map(uid => stateOf(uid))
    .filter(state => state && state.institutionId === c.institution && readingRequestOpen(state));
  if (!open.length) return out;
  const target = await examOpenUids(prisma, prisma, access, c, open.map(row => row.uid));
  const listed = new Set(rows.map(row => row.uid));
  const ordered = open.map(row => ({ row, at: iso(row.readingRequestAt) })).filter((e): e is { row: any; at: string } => e.at !== null)
    .sort((a, b) => a.at.localeCompare(b.at) || (a.row.uid < b.row.uid ? -1 : a.row.uid > b.row.uid ? 1 : 0));
  for (const { row, at } of ordered) {
    const on = target.get(row.uid);
    if (on && listed.has(on) && !out.has(on)) out.set(on, { at, by: requester(row) });
  }
  return out;
}

/**
 * Why this caller may not make a new request on this study now, or null when they may: the one rule the POST and the
 * clinician list both apply. `state` is the study's own StudyState row and `onRs` the report state of the row it opens on
 * now (undefined when it opens on none). In this order: the clinician role, the owning institution, a row it opens on, a
 * request already open (the POST answers that one as it is), an approved or a destroyed report.
 */
export type ReadingRequestRefusal = 'role' | 'unavailable' | 'open' | 'reported' | 'destroyed';
export function readingRequestRefusal(c: Caller, state: any, onRs: unknown): ReadingRequestRefusal | null {
  if (!holds(c, CLINICIAN_ROLE)) return 'role';
  if (typeof c.institution !== 'string' || !c.institution || state?.institutionId !== c.institution || typeof onRs !== 'string')
    return 'unavailable';
  if (readingRequestOpen(state)) return 'open';
  if (onRs === 'A') return 'reported';
  if (onRs === 'D') return 'destroyed';
  return null;
}

/**
 * The clinician list rows' requests: the row's own latest request (shown only for an own-institution study that opens on
 * a row now), whether this caller may ask now and, when not, why (readingRequestRefusal; an open request is shown as such,
 * not as a refusal). `uids` are the listed studies (the clinician list's own selection); their request fields are read
 * here, and the report state of a row they open on that is not itself listed.
 */
export async function clinicianReadingRequests(prisma: PrismaService, access: StudyAccessService, c: Caller, uids: string[]) {
  const out = new Map<string, { readingRequest: ReadingRequestView | null; readingRequestable: boolean;
    readingRequestRefusal: Exclude<ReadingRequestRefusal, 'open'> | null }>();
  if (!uids.length) return out;
  const states: any[] = await prisma.studyState.findMany({ where: { uid: { in: uids } }, select: { uid: true, institutionId: true,
    rs: true, readingRequestAt: true, readingRequestBy: true, readingRequestByName: true, readingRequestClosedAt: true } });
  const target = await examOpenUids(prisma, prisma, access, c, states.map(state => state.uid));
  const byUid = new Map(states.map(state => [state.uid, state]));
  const others = [...new Set([...target.values()].filter(uid => !byUid.has(uid)))];
  const rs = new Map<string, string>((others.length ? await prisma.studyState.findMany({ where: { uid: { in: others } },
    select: { uid: true, rs: true } }) : []).map(row => [row.uid, row.rs]));
  for (const state of states) {
    const on = target.get(state.uid);
    // The row it opens on is this study, another listed study (its row read above) or one read for it.
    const onRs = !on ? undefined : on === state.uid ? state.rs : byUid.get(on)?.rs ?? rs.get(on);
    const refusal = readingRequestRefusal(c, state, onRs);
    const shown = !!on && !!c.institution && state.institutionId === c.institution;
    out.set(state.uid, { readingRequest: shown ? readingRequestView(state) : null, readingRequestable: refusal === null,
      readingRequestRefusal: refusal === 'open' ? null : refusal });
  }
  return out;
}

/**
 * `POST studies/:uid/reading-request` with exactly `{expectedOwner}`. The clinician role (a mixed-role member who holds it
 * too may ask); the study owned by the caller's institution now, inside the access policy, with a row it opens on now
 * (404 otherwise, the same answer for each). The study row is locked first, so two presses - one person's or two - make
 * one request; an approval racing it either closes it (it waits for this lock) or is seen here and refuses it. Inside the
 * lock a study whose original this request observed none of is not found, and a merge or unmerge committed while it waited
 * (the row it opens on is no longer the one chosen before the lock) saves nothing and answers busy.
 */
export async function createReadingRequest(prisma: PrismaService, access: StudyAccessService, c: RequestCaller, uid: string, body: any) {
  if (c.kind !== 'member' || ![c.institution, c.sub, c.actor].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256))
    throw roleRequired();
  if (!holds(c, CLINICIAN_ROLE)) throw roleRequired();
  if (typeof uid !== 'string' || uid.length > 64 || !STUDY_UID.test(uid)) throw invalid();
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'expectedOwner') throw invalid();
  const owner = [c.institution, c.sub];
  if (JSON.stringify(body.expectedOwner) !== JSON.stringify(owner)) throw ownerChanged();
  // The source tags the access policy reads and the study's own source identity (one patient resource), before any lock.
  await prepareExamRead(prisma, access, c, uid, true);
  const on = (await examOpenUids(prisma, prisma, access, c, [uid])).get(uid);
  if (!on) throw missing();
  const name = Array.from(typeof c.name === 'string' && c.name.trim() ? c.name : c.actor).slice(0, 256).join('');
  try {
    return await prisma.$transaction(async (tx: any) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await access.snapshot(c, tx);
      const rows: any[] = await tx.$queryRaw`SELECT uid, "institutionId", rs, "readingRequestAt", "readingRequestBySub",
        "readingRequestBy", "readingRequestByName", "readingRequestClosedAt" FROM "StudyState" WHERE uid=${uid} FOR UPDATE`;
      const state = rows[0];
      if (!state || state.institutionId !== c.institution) throw missing();
      // The study the clinician picked: inside the access policy and one identified source (the list shows no other).
      try { await resolveExamScope(tx, access, c, { uid, purpose: 'source', state, identity: true }); }
      catch (e) { if (e instanceof NotFoundException) throw missing(); throw e; }
      // A study of which this request observed no original (Orthanc answered none) is not there to be read.
      if (access.observedSourceCount(c, uid) === 0) throw missing();
      // The row it opens on, as the exam groups say now: a merge or an unmerge committed while this waited for the lock
      // moves it, and the request is not saved against the row chosen before (the busy answer: press again).
      const merged = (await activeGroups(tx, [uid])).find(group => group.kind === 'merge');
      if ((merged ? merged.baseUid : uid) !== on) throw busy();
      const target = on === uid ? state : (await tx.$queryRaw`SELECT rs FROM "StudyState" WHERE uid=${on}` as any[])[0];
      const refusal = readingRequestRefusal(c, state, target?.rs);
      if (refusal === 'open') return { owner, created: false, readingRequest: readingRequestView(state)! };
      if (refusal === 'reported' || refusal === 'destroyed') throw reported(target.rs);
      if (refusal === 'role') throw roleRequired();
      if (refusal !== null) throw missing();
      const at = new Date();
      await tx.$executeRaw`UPDATE "StudyState" SET "readingRequestAt"=${at}, "readingRequestBySub"=${c.sub},
        "readingRequestBy"=${c.actor}, "readingRequestByName"=${name}, "readingRequestClosedAt"=NULL, "updatedAt"=${at}
        WHERE uid=${uid}`;
      // Who and when, the study and the row it opens on; the creating institution for the owner-only audit read.
      await tx.auditLog.create({ data: { actor: c.actor, action: READING_REQUEST_AUDIT_ACTION, target: uid,
        detail: JSON.stringify({ institution: c.institution, sub: c.sub, openUid: on, at: at.toISOString(), role: CLINICIAN_ROLE }) } });
      return { owner, created: true, readingRequest: { at: at.toISOString(), by: name, open: true, closedAt: null } as ReadingRequestView };
    }, { maxWait: 4000, timeout: 8000 });
  } catch (e: any) {
    if (['P2024', 'P2028', 'P2034'].includes(e?.code) || e?.code === 'P2010' && ['55P03', '57014', '40P01'].includes(e?.meta?.code))
      throw busy();
    throw e;
  }
}
