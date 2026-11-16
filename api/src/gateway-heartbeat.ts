/**
 * Gateway 운영 상태 — 순수 규칙(하트비트 본문, 늦은 쓰기, 관리자 화면 답의 모양).
 *
 * Gateway agent는 30초마다(시작 직후 한 번) 자기 상태를 알린다: 큐 epoch, 그 큐에서 이번 실행의 번호 bootSeq(1, 2, …), 버전, 가동 초,
 * 큐 수(waiting·retry·failed — complete는 싣지 않는다), 마지막 STOW 뒤 경과 초, 로컬 Orthanc REST가 마지막에 답했는지와
 * 그 뒤 경과 초. 본문에는 이 호스트의 시각·UID·기관·자유 문구가 없다. 시각은 모두 KIN이 받은 시각(R)에서 만든다 —
 * 시작 = R − 가동 초, 마지막 STOW = R − 경과 초. 이것은 추정 시각이다(전송 지연만큼 이르다).
 *
 * 행 키는 (자격증명 sub, 큐 epoch)다. 같은 자격증명을 쓰는 서로 다른 큐는 서로 다른 행이고, 옛 epoch의 행은 지우지 않아
 * `No Contact`로 남는다(끊긴 Gateway가 조용히 사라지지 않게). 늦게 도착한 옛 하트비트는 새 것을 덮지 않는다. 순서는
 * 시계·도착 순서·전송 지연과 무관하게 (bootSeq, 가동 초)다: 더 큰 bootSeq가 이기고, 같은 실행이면 가동 초가 줄지 않을 때만
 * 쓴다. 더 작은 bootSeq는 저장된 실행이 연락 기준(180초) 넘게 조용할 때만 받는다 — 큐 파일을 백업에서 되살려 번호가
 * 내려간 경우이고, 하트비트 요청은 그보다 훨씬 짧은 시간 제한 안에서만 도착하므로 옛 실행의 늦은 하트비트일 수 없다.
 * 추정 시작 시각(R − 가동 초)은 표시용일 뿐 순서에 쓰지 않는다. 이미 다른 기관에 묶인 행은 덮지 않는다(자격증명의
 * 기관이 바뀐 것을 조용히 옮기지 않는다).
 *
 * 연락 판정 `No Contact`는 서버 시계끼리(받은 시각과 지금) 비교하고 기준은 180초다(30초 주기 여섯 번). 이 값은 구현이
 * 고른 신선도 규칙이지 출처 있는 사이트 기준이 아니다 — 그래서 색·경고 단계를 두지 않고 문구만 바꾼다.
 */
export const GATEWAY_HEARTBEAT_INVALID = 'GATEWAY_HEARTBEAT_INVALID';
export const GATEWAY_HEARTBEAT_INSTITUTION_CONFLICT = 'GATEWAY_HEARTBEAT_INSTITUTION_CONFLICT';
export const GATEWAY_HEARTBEAT_LIMIT = 'GATEWAY_HEARTBEAT_LIMIT';
export const GATEWAY_STATUS_RESTRICTED = 'GATEWAY_STATUS_RESTRICTED';
export const GATEWAY_NO_CONTACT_AFTER_SECONDS = 180;
/** 메모리 표의 상한. 상한에서도 이미 있는 행의 갱신은 받고, 새 행만 거절한다. */
export const GATEWAY_HEARTBEAT_ROWS_PER_INSTITUTION = 32;
export const GATEWAY_HEARTBEAT_ROWS_TOTAL = 1024;

export class GatewayHeartbeatInputError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/;
/** 가동·경과 초의 상한(10년). 그보다 큰 값은 고장 난 본문이다. */
const MAX_SECONDS = 10 * 366 * 24 * 3600;
const MAX_COUNT = 2 ** 31 - 1;
const TOP_KEYS = ['bootSeq', 'epoch', 'lastStowAgeSeconds', 'localOrthanc', 'queue', 'uptimeSeconds', 'version'];
const QUEUE_KEYS = ['failed', 'retry', 'waiting'];
const LOCAL_KEYS = ['ageSeconds', 'answered'];

export interface GatewayQueueCounts { waiting: number; retry: number; failed: number }
export interface GatewayHeartbeat {
  epoch: string; bootSeq: number; version: string; uptimeSeconds: number;
  queue: GatewayQueueCounts | null; lastStowAgeSeconds: number | null;
  localOrthanc: { answered: boolean; ageSeconds: number } | null;
}

/** 저장되는 한 행. 시각은 모두 서버 시계의 ms다. */
export interface GatewayHeartbeatRow {
  gateway: string; label: string; institutionId: string; epoch: string; bootSeq: number; version: string;
  uptimeSeconds: number; startedAt: number; receivedAt: number; queue: GatewayQueueCounts | null;
  lastStowAt: number | null; localOrthanc: { answered: boolean; observedAt: number } | null;
}

const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const closed = (value: Record<string, unknown>, keys: string[]) => {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, index) => key === keys[index]);
};
const seconds = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_SECONDS;
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_COUNT;

/** 닫힌 본문. 키를 더하거나 빼거나, 범위 밖 수·형식 밖 글자는 모두 400이다(어느 칸인지만 말한다). */
export function parseGatewayHeartbeat(body: unknown): GatewayHeartbeat {
  if (!plain(body) || !closed(body, TOP_KEYS)) throw new GatewayHeartbeatInputError('body');
  const { epoch, bootSeq, version, uptimeSeconds, queue, lastStowAgeSeconds, localOrthanc } = body;
  if (typeof epoch !== 'string' || !UUID.test(epoch)) throw new GatewayHeartbeatInputError('epoch');
  if (!Number.isSafeInteger(bootSeq) || (bootSeq as number) < 1 || (bootSeq as number) > MAX_COUNT)
    throw new GatewayHeartbeatInputError('bootSeq');
  if (typeof version !== 'string' || !VERSION.test(version)) throw new GatewayHeartbeatInputError('version');
  if (!seconds(uptimeSeconds)) throw new GatewayHeartbeatInputError('uptimeSeconds');
  const uptime = uptimeSeconds as number;
  let counts: GatewayQueueCounts | null = null;
  if (queue !== null) {
    if (!plain(queue) || !closed(queue, QUEUE_KEYS) || !QUEUE_KEYS.every(key => count(queue[key])))
      throw new GatewayHeartbeatInputError('queue');
    counts = { waiting: queue.waiting as number, retry: queue.retry as number, failed: queue.failed as number };
  }
  // 경과 초는 이 실행 안의 관측이라 가동 초보다 클 수 없다.
  if (lastStowAgeSeconds !== null && (!seconds(lastStowAgeSeconds) || (lastStowAgeSeconds as number) > uptime))
    throw new GatewayHeartbeatInputError('lastStowAgeSeconds');
  let local: GatewayHeartbeat['localOrthanc'] = null;
  if (localOrthanc !== null) {
    if (!plain(localOrthanc) || !closed(localOrthanc, LOCAL_KEYS) || typeof localOrthanc.answered !== 'boolean'
      || !seconds(localOrthanc.ageSeconds) || (localOrthanc.ageSeconds as number) > uptime)
      throw new GatewayHeartbeatInputError('localOrthanc');
    local = { answered: localOrthanc.answered, ageSeconds: localOrthanc.ageSeconds as number };
  }
  return { epoch, bootSeq: bootSeq as number, version, uptimeSeconds: uptime, queue: counts,
    lastStowAgeSeconds: lastStowAgeSeconds as number | null, localOrthanc: local };
}

/** 받은 시각 R(서버 ms)에서 행을 만든다. 신원·기관은 검증된 토큰에서만 온다. */
export function gatewayHeartbeatRow(beat: GatewayHeartbeat, gateway: string, label: string, institutionId: string,
  receivedAt: number): GatewayHeartbeatRow {
  return { gateway, label, institutionId, epoch: beat.epoch, bootSeq: beat.bootSeq, version: beat.version,
    uptimeSeconds: beat.uptimeSeconds, startedAt: receivedAt - beat.uptimeSeconds * 1000, receivedAt, queue: beat.queue,
    lastStowAt: beat.lastStowAgeSeconds === null ? null : receivedAt - beat.lastStowAgeSeconds * 1000,
    localOrthanc: beat.localOrthanc && { answered: beat.localOrthanc.answered,
      observedAt: receivedAt - beat.localOrthanc.ageSeconds * 1000 } };
}

export type GatewayHeartbeatDecision = 'stored' | 'stale' | 'conflict';

/** 늦은 쓰기와 기관 이동의 판정(한 곳). */
export function decideGatewayHeartbeat(stored: GatewayHeartbeatRow | undefined, next: GatewayHeartbeatRow):
  GatewayHeartbeatDecision {
  if (!stored) return 'stored';
  if (stored.institutionId !== next.institutionId) return 'conflict';
  if (next.bootSeq > stored.bootSeq) return 'stored';
  if (next.bootSeq === stored.bootSeq) return next.uptimeSeconds >= stored.uptimeSeconds ? 'stored' : 'stale';
  // A lower run number: only a queue restored from a backup, once the stored run has been silent past the contact rule.
  return next.receivedAt - stored.receivedAt > GATEWAY_NO_CONTACT_AFTER_SECONDS * 1000 ? 'stored' : 'stale';
}

const iso = (ms: number | null) => ms === null ? null : new Date(ms).toISOString();

/** Keycloak 서비스 계정 이름(`service-account-gw-…`)은 화면에 client 이름(`gw-…`)으로 보인다. */
export function gatewayDisplayName(label: string): string {
  const name = label.startsWith('service-account-') ? label.slice('service-account-'.length) : label;
  return name.slice(0, 128);
}

/**
 * 관리자 화면의 답. 이 기관 행만, 최근 연락 순. 답은 명시한 칸뿐이다 — 큐 행·오류 문구·주소·토큰은 없다.
 * `serverStartedAt`은 이 답을 만든 API 프로세스의 시작 시각이다: 메모리 표라 그 전의 연락은 기억하지 않는다.
 */
export function gatewayStatusAnswer(rows: Iterable<GatewayHeartbeatRow>, institutionId: string, now: number,
  serverStartedAt: number) {
  const own = [...rows].filter(row => row.institutionId === institutionId)
    .sort((a, b) => b.receivedAt - a.receivedAt || a.gateway.localeCompare(b.gateway) || a.epoch.localeCompare(b.epoch));
  return {
    institutionId, generatedAt: new Date(now).toISOString(), serverStartedAt: new Date(serverStartedAt).toISOString(),
    noContactAfterSeconds: GATEWAY_NO_CONTACT_AFTER_SECONDS,
    gateways: own.map(row => ({
      gateway: gatewayDisplayName(row.label), queueInstance: row.epoch,
      contact: now - row.receivedAt > GATEWAY_NO_CONTACT_AFTER_SECONDS * 1000 ? 'no_contact' : 'recent',
      lastContactAt: iso(row.receivedAt), startedAt: iso(row.startedAt), version: row.version,
      queue: row.queue && { ...row.queue }, lastStowAt: iso(row.lastStowAt),
      localOrthanc: row.localOrthanc && { answered: row.localOrthanc.answered, observedAt: iso(row.localOrthanc.observedAt) },
    })),
  };
}
