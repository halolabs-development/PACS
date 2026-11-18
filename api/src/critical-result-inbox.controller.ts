import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { CriticalResultService } from './critical-result.service';

// Attribution is what the guard filled from the signed token only (as critical-result.controller.ts).
const caller = (r: any) => ({ sub: r.sub, actor: r.actor, roles: r.roles ?? [], institution: r.institution ?? null, kind: r.kind,
  name: typeof r.displayName === 'string' ? r.displayName : undefined });

/**
 * The critical result hospital inbox: one setting of the administrator's own institution, the member the Send Critical
 * Result dialog checks by default. The admin role and the member's eligibility are the service's checks. No study record.
 */
@Controller('admin')
export class CriticalResultInboxController {
  constructor(private service: CriticalResultService) {}
  @Get('critical-result-inbox') inbox(@Req() r: any) { return this.service.inbox(caller(r)); }
  @Patch('critical-result-inbox') save(@Req() r: any, @Body() b: any) { return this.service.saveInbox(caller(r), b); }
}
