import { Body, Controller, Get, Header, HttpCode, Post, Req } from '@nestjs/common';
import { GatewayStatusService } from './gateway-status.service';
import type { Caller } from './pacs/access';

const caller = (req: any): Caller => ({
  sub: req.sub,
  actor: req.actor,
  roles: req.roles ?? [],
  institution: req.institution ?? null,
  kind: req.kind ?? 'member',
});

/**
 * Gateway 운영 상태: Gateway가 보내는 하트비트와 관리자 콘솔이 읽는 이 기관 Gateway들의 상태. 권한·기관·본문 판정은
 * 서비스가 한다(gateway 경로는 auth.guard가 gateway 신원에만 연다).
 */
@Controller()
export class GatewayStatusController {
  constructor(private readonly svc: GatewayStatusService) {}

  @Post('gateway/heartbeat')
  @HttpCode(200)
  heartbeat(@Body() body: any, @Req() req: any) {
    return this.svc.heartbeat(body, caller(req));
  }

  @Get('admin/gateway-status')
  @Header('Cache-Control', 'no-store')
  status(@Req() req: any) {
    return this.svc.status(caller(req));
  }
}
