import { Body, Controller, Get, Header, Put, Req } from '@nestjs/common';
import { GatewaySettingsService } from './gateway-settings.service';
import type { Caller } from './pacs/access';

const caller = (req: any): Caller => ({
  sub: req.sub,
  actor: req.actor,
  roles: req.roles ?? [],
  institution: req.institution ?? null,
  kind: req.kind ?? 'member',
});

/** Gateway settings: the administrator's read and save, and the Gateway's read. Roles and checks are in the service. */
@Controller()
export class GatewaySettingsController {
  constructor(private readonly svc: GatewaySettingsService) {}

  @Get('admin/gateway-settings')
  @Header('Cache-Control', 'no-store')
  read(@Req() req: any) {
    return this.svc.adminRead(caller(req));
  }

  @Put('admin/gateway-settings')
  save(@Body() body: any, @Req() req: any) {
    return this.svc.adminSave(body, caller(req));
  }

  @Get('gateway/settings')
  @Header('Cache-Control', 'no-store')
  gateway(@Req() req: any) {
    // ?retention=1: the Gateway reads retentionDays (an older one does not ask and never gets the key).
    return this.svc.gatewayRead(caller(req), req.query?.retention === '1');
  }
}