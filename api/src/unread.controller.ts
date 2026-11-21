import { Body, Controller, Get, Inject, Optional, Param, Post, Query, Req } from '@nestjs/common';
import { EMR_CLINICAL_ROUTES, ClinicalRoutes, clinicalRoutes } from './emr-clinical/routes';
import { ClinicianQuestionService } from './clinician-question.service';
import { ImageRequestService } from './image-request.service';

// 귀속은 가드가 서명된 토큰에서 채운 값뿐이다(clinician-question.controller.ts와 같다).
const caller = (r: any) => ({ sub: r.sub, actor: r.actor, roles: r.roles ?? [], institution: r.institution ?? null, kind: r.kind,
  name: typeof r.displayName === 'string' ? r.displayName : undefined });
// An unread row names its record's id, study and listed revision only (no body): the 열람 names that head, as a question
// list row does (clinician-question.controller.ts).
const head = (item: { revision: number }) => [item.revision];

/**
 * In-app unread marks: one read of a view's unread count and items (the rule lives in each record's service, over that
 * record's own list filter), and the person's seen mark of a question thread or an image request their screen showed.
 * No email, message or push; the marks are the person's own reading state.
 */
@Controller()
export class UnreadController {
  constructor(private questions: ClinicianQuestionService, private requests: ImageRequestService,
    @Optional() @Inject(EMR_CLINICAL_ROUTES) private readonly clinical?: ClinicalRoutes) {}
  @Get('unread') list(@Req() r: any, @Query() q: any) {
    if (q?.view === 'image-request-mine')
      return clinicalRoutes(this.clinical).collection(r, 'GET unread', 'image-request', tx => this.requests.unread(caller(r), q, tx), undefined, head);
    return clinicalRoutes(this.clinical).collection(r, 'GET unread', 'question', tx => this.questions.unread(caller(r), q, tx), undefined, head);
  }
  @Post('questions/:id/seen') question(@Param('id') id: string, @Req() r: any, @Body() b: any) { return this.questions.seen(id, caller(r), b); }
  @Post('image-requests/:id/seen') request(@Param('id') id: string, @Req() r: any, @Body() b: any) { return this.requests.seen(id, caller(r), b); }
}
