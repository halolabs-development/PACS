import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { StudyAccessService } from './study-access.service';
import { Caller, inst, need, needExact } from './pacs/access';
import { API_PROCESS_STARTED_AT } from './api-process';
import { decideGatewayHeartbeat, GATEWAY_HEARTBEAT_INSTITUTION_CONFLICT, GATEWAY_HEARTBEAT_INVALID, GATEWAY_HEARTBEAT_LIMIT,
  GATEWAY_HEARTBEAT_ROWS_PER_INSTITUTION, GATEWAY_HEARTBEAT_ROWS_TOTAL, GATEWAY_STATUS_RESTRICTED, GatewayHeartbeatInputError,
  GatewayHeartbeatRow, gatewayHeartbeatRow, gatewayStatusAnswer, parseGatewayHeartbeat } from './gateway-heartbeat';

/**
 * Gateway 운영 상태(관리자 콘솔 Gateway Status의 Gateway 줄). 규칙은 `gateway-heartbeat.ts` 한 곳에 있다.
 *
 * 행은 이 API 프로세스의 메모리에만 있다(`presence.service.ts`의 보기 표시와 같은 운영 상태). 하트비트마다 감사 행을 쓰지
 * 않는다 — 사람의 행위도, 임상·전달 기록도 아니다. API가 다시 시작하면 표는 비고, 각 Gateway의 다음 하트비트가 정상
 * 수락되면 다시 채워진다(agent는 약 30초마다 보내지만 그 도착 기한은 보장하지 않는다). 화면은 그 사실을 서버 시작 시각과 함께 말한다. 한 프로세스 안에서 한 요청의 판정과 쓰기는 await 없이 끝나
 * 서로 끼어들지 않는다. API가 여러 프로세스가 되면 공유 저장소를 다시 정한다.
 */
@Injectable()
export class GatewayStatusService {
  private readonly rows = new Map<string, GatewayHeartbeatRow>();
  /** 시험만 바꾼다: 받은 시각과 판정 시각의 서버 시계. */
  protected clock = () => Date.now();

  constructor(private readonly studyAccess: StudyAccessService) {}

  /** `POST /api/gateway/heartbeat`. gateway 자격증명만(admin 예외 없음). 기관·신원은 검증된 토큰에서만 온다. */
  heartbeat(body: unknown, c: Caller) {
    needExact(c, 'gateway', 'Gateway 운영 상태 보고');
    const me = inst(c);
    let beat;
    try { beat = parseGatewayHeartbeat(body); }
    catch (error) {
      if (error instanceof GatewayHeartbeatInputError)
        throw new BadRequestException({ code: GATEWAY_HEARTBEAT_INVALID, field: error.message });
      throw error;
    }
    const gateway = String(c.sub ?? '').slice(0, 256);
    if (!gateway) throw new ForbiddenException('Gateway 신원이 없습니다');
    const next = gatewayHeartbeatRow(beat, gateway, String(c.actor || gateway).slice(0, 256), me, this.clock());
    const key = gateway + '\n' + beat.epoch;
    const stored = this.rows.get(key);
    const decision = decideGatewayHeartbeat(stored, next);
    if (decision === 'conflict') throw new ConflictException({ code: GATEWAY_HEARTBEAT_INSTITUTION_CONFLICT });
    if (decision === 'stale') return { result: 'stale' };
    if (!stored) {
      let own = 0;
      for (const row of this.rows.values()) if (row.institutionId === me) own++;
      if (own >= GATEWAY_HEARTBEAT_ROWS_PER_INSTITUTION || this.rows.size >= GATEWAY_HEARTBEAT_ROWS_TOTAL)
        throw new HttpException({ code: GATEWAY_HEARTBEAT_LIMIT }, HttpStatus.TOO_MANY_REQUESTS);
    }
    this.rows.set(key, next);
    return { result: 'stored' };
  }

  /** 이 기관의 행(사본) — 원격 지원이 요청을 묶을 줄을 찾는다(`gateway-support.service.ts`). 권한 판정은 부르는 쪽이 한다. */
  rowsOf(institutionId: string): GatewayHeartbeatRow[] {
    return [...this.rows.values()].filter(row => row.institutionId === institutionId)
      .sort((a, b) => b.receivedAt - a.receivedAt || a.gateway.localeCompare(b.gateway) || a.epoch.localeCompare(b.epoch))
      .map(row => ({ ...row }));
  }

  /**
   * `GET /api/admin/gateway-status`. admin, 자기 기관 행만. 큐 수는 검사 활동을 세는 값이라, 검사 접근이 제한된 계정에는
   * 운영 지표(`/api/admin/metrics`)와 같은 이유로 주지 않고, 읽는 동안 접근 조건이 바뀌었으면 그 답을 내보내지 않는다.
   */
  async status(c: Caller) {
    need(c.roles, 'admin', 'Gateway 운영 상태 조회');
    const me = inst(c);
    const access = await this.studyAccess.snapshot(c);
    if (access.policy.restricted)
      throw new ForbiddenException({ code: GATEWAY_STATUS_RESTRICTED,
        message: '검사 접근 범위가 제한된 계정은 Gateway 운영 상태를 볼 수 없습니다' });
    const answer = gatewayStatusAnswer(this.rows.values(), me, this.clock(), API_PROCESS_STARTED_AT);
    await this.studyAccess.unchanged(c, access);
    return answer;
  }
}
