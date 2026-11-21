import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req, StreamableFile } from '@nestjs/common';
import { GatewaySupportService } from './gateway-support.service';
import type { Caller } from './pacs/access';

const caller = (req: any): Caller => ({
  sub: req.sub,
  actor: req.actor,
  roles: req.roles ?? [],
  institution: req.institution ?? null,
  kind: req.kind ?? 'member',
});

/**
 * Gateway remote support: the administrator's requests (diagnostics, restart, update to a held version) and the
 * Gateway's own pull of them over its outbound calls. Roles, institution, line binding and states are in the service
 * (gateway paths are opened by auth.guard to gateway credentials only).
 */
@Controller()
export class GatewaySupportController {
  constructor(private readonly svc: GatewaySupportService) {}

  @Get('admin/gateway-support')
  @Header('Cache-Control', 'no-store')
  list(@Req() req: any) {
    return this.svc.adminList(caller(req));
  }

  @Post('admin/gateway-support')
  @HttpCode(200)
  request(@Body() body: any, @Req() req: any) {
    return this.svc.adminRequest(body, caller(req));
  }

  @Get('admin/gateway-support/:id/diagnostics')
  @Header('Cache-Control', 'no-store')
  diagnostics(@Param('id') id: string, @Req() req: any) {
    return this.svc.adminDiagnostics(id, caller(req));
  }

  @Get('gateway/support')
  @Header('Cache-Control', 'no-store')
  poll(@Query() query: any, @Req() req: any) {
    return this.svc.gatewayPoll(query, caller(req));
  }

  @Post('gateway/support/:id')
  @HttpCode(200)
  result(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.svc.gatewayResult(id, body, caller(req));
  }

  @Get('gateway/update/:version')
  @Header('Cache-Control', 'no-store')
  async bundle(@Param('version') version: string, @Req() req: any) {
    return new StreamableFile(await this.svc.gatewayBundle(version, caller(req)), { type: 'application/json' });
  }
}
