import { Body, Controller, Param, Post, Req, Res } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { StudyAccessService } from './study-access.service';
import { createReadingRequest } from './pacs/reading-request';

// Attribution is only what the guard filled from the signed token; the display name too, never the request body.
const caller = (r: any) => ({ sub: r.sub, actor: r.actor, roles: r.roles ?? [], institution: r.institution ?? null, kind: r.kind,
  name: typeof r.displayName === 'string' ? r.displayName : undefined });

/**
 * Reading request (pacs/reading-request.ts): a clinician asks for an existing study to be read. A new request answers 201;
 * a press while the study's request is open answers 200 with that request as it is (`created: false`).
 */
@Controller()
export class ReadingRequestController {
  constructor(private prisma: PrismaService, private studyAccess: StudyAccessService) {}
  @Post('studies/:uid/reading-request')
  async create(@Param('uid') uid: string, @Req() r: any, @Body() b: any, @Res({ passthrough: true }) res: any) {
    const answer = await createReadingRequest(this.prisma, this.studyAccess, caller(r), uid, b);
    if (!answer.created) res.status(200);
    return answer;
  }
}
