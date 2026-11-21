import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { PatientConsentService } from './patient-consent.service';
import type { Caller } from './pacs.service';

// Attribution is what the guard filled from the signed token only.
const caller = (r: any): Caller => ({ sub: r.sub, actor: r.actor, roles: r.roles ?? [], institution: r.institution ?? null, kind: r.kind ?? 'member' });

/**
 * Patient Consent on the Members console. The patient ID travels in the body (never the URL), so an ordinary lookup
 * leaves no patient ID in a request log. The admin role, the institution and the patient are the service's checks.
 */
@Controller('admin')
export class PatientConsentController {
  constructor(private service: PatientConsentService) {}
  @Post('patient-consent/lookup') @HttpCode(200)
  lookup(@Req() r: any, @Body() b: any) { return this.service.lookup(caller(r), b); }
  @Post('patient-consent')
  record(@Req() r: any, @Body() b: any) { return this.service.record(caller(r), b); }
  @Post('patient-consent/:id/withdraw') @HttpCode(200)
  withdraw(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.service.withdraw(caller(r), id, b); }
}
