/*
 * MG-08 (D1877(2)): the existing worklist, report and viewer image reads - `/instances/{id}/...` (worklist preview and
 * thumbnails `frames/N/rendered`, report/print `image-uint16`/`image-int16`, strip `preview`, `pdf`, `file`) and the
 * image representations of `/dicom-web/` (WADO-RS frames, rendered, thumbnail, bulk data, whole-object retrieve) - used
 * to go from nginx straight to Orthanc after `auth_request`, which admits a read but cannot see it delivered, so no
 * study delivery record existed for them. nginx now routes them here. The handler runs the same DICOMweb gate
 * (PacsService.authzDicom: institution, StudyAccess, split UID), takes the study delivery's lease for the study and
 * patient the gate observed - its provide-prepared event durable before any byte, naming that patient and the archive's
 * revision the recorder read for this lease (image-delivery-record.ts) - and, once the archive still holds them after
 * Orthanc chose its answer, relays that answer unchanged (status, media type,
 * body; the query carries rendering and windowing as before). Descriptions without the image are not deliveries of the
 * image: the instance tag dumps and attachment info relayed here record a 열람 of the study's metadata of their own
 * (StudyImageDeliveryRecorder.describe), durable before their first byte; QIDO and DICOMweb metadata reuse a session read or prepare one through ViewingRecordService. The auth_request route refuses every image read
 * (pacs.controller.ts), so an image byte has no unrecorded way out.
 */
import { ConflictException, Controller, Get, Inject, NotFoundException, Param, Post, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import { EMR_RECORD_PORT, EmrRecordPort } from './emr-runtime/record-port';
import { recordGatewayStow } from './pacs/dicom-gateway';
import { gatewayStowRefusal, readStowHead } from './gateway-stow-identity';
import type { GatewayStowRefusal } from './gateway-stow-identity';
import { archiveRead, imageRead, RECORDED_STUDY_HEADER, StudyImageDeliveryRecorder } from './image-delivery-record';
import { PrismaService } from './prisma.service';
import { REQUEST_CONTEXT_SOURCE, RequestContextSource } from './emr-runtime/request-context';
import { ViewingRecordService } from './emr-viewing/viewing-record.service';
import { DicomwebReadRecorder } from './emr-viewing/dicomweb-read';
import { OrthancService } from './orthanc.service';
import { orthancFetch } from './orthanc-transport';
import { Caller, PacsService } from './pacs.service';
import { admitDicomRead } from './auth.service';

export const IMAGE_RELAY_SURFACE = 'GET image-relay/*';
const PREFIX = '/api/image-relay';

/** The original path and query nginx appended to the relay prefix; anything but a plain image-root path is no route. */
function relayTarget(url: string): { path: string; query: string } | null {
  if (!url.startsWith(PREFIX + '/')) return null;
  const rest = url.slice(PREFIX.length), mark = rest.indexOf('?');
  const path = mark < 0 ? rest : rest.slice(0, mark), query = mark < 0 ? '' : rest.slice(mark);
  if (!/^\/(?:instances|dicom-web)\/[A-Za-z0-9.,\-/]+$/.test(path) || /\/\/|(?:^|\/)\.\.?(?:\/|$)/.test(path)) return null;
  if (!/^[\x21-\x7e]*$/.test(query)) return null;
  return { path, query };
}

const member = (req: any): Caller => ({ sub: req.sub, actor: req.actor, roles: req.roles ?? [],
  institution: req.institution ?? null, kind: req.kind ?? 'member' });

@Controller()
export class ImageRelayController {
  private readonly metadata: DicomwebReadRecorder;
  constructor(private readonly pacs: PacsService, private readonly orthanc: OrthancService,
    private readonly deliveries: StudyImageDeliveryRecorder,
    @Inject(EMR_RECORD_PORT) private readonly records: EmrRecordPort,
    prisma: PrismaService, @Inject(REQUEST_CONTEXT_SOURCE) requests: RequestContextSource,
    viewing: ViewingRecordService) { this.metadata = new DicomwebReadRecorder(prisma, requests, viewing); }

  /**
   * Gateway STOW. Before any byte reaches the archive, the archive's study of this UID is observed and, when it holds
   * one, the body is read as far as its first object's PatientID (gateway-stow-identity.ts): a copy under another
   * PatientID, or any copy of a UID two patients already answer, is refused 409 with its code and nothing is sent. The
   * Gateway reads the code and stops repeating the transfer. Everything else is relayed as the bytes arrived.
   */
  @Post('gateway/stow/:uid')
  async stow(@Param('uid') uid: string, @Req() req: any, @Res() res: any) {
    await this.pacs.authzDicom('/dicom-web/studies/' + uid, 'POST', member(req));
    const abort = new AbortController(), stop = () => abort.abort();
    req.once('aborted', stop);
    let refusal: GatewayStowRefusal | null = null;
    try {
      const user = process.env.ORTHANC_USER, pass = process.env.ORTHANC_PASS;
      if (!user || !pass) throw new Error('Orthanc credentials unavailable');
      const contentType = String(req.headers['content-type'] ?? '');
      const stored = (await this.orthanc.studyIdentityResources(uid, abort.signal)).map(row => OrthancService.tag(row, '00100020'));
      // One reader of the request for the head and for the relay: the bytes held for the decision are sent first.
      const body: AsyncIterator<Buffer> = req[Symbol.asyncIterator]();
      const head = stored.length === 1 ? await readStowHead(() => body.next(), contentType) : null;
      refusal = gatewayStowRefusal(stored, head ? head.identity : null, String(req.institution ?? ''));
      if (refusal) {
        // The refusal is answered once the request has been read to its end, so the proxy delivers it as it is.
        for (let step = await body.next(); !step.done; step = await body.next());
      } else {
        const relayed = async function* (): AsyncGenerator<Buffer> {
          if (head) yield* head.chunks;
          if (head?.ended) return;
          try { for (let step = await body.next(); !step.done; step = await body.next()) yield step.value; }
          finally { await body.return?.(); }
        };
        const upstream = await orthancFetch((process.env.ORTHANC_URL ?? 'http://orthanc:8042').replace(/\/$/, '') + '/dicom-web/studies/' + uid, {
          // Node's fetch sends an async iterable of bytes as the request stream (as it did the request itself).
          method: 'POST', redirect: 'error', body: relayed() as any, duplex: 'half', signal: abort.signal,
          headers: { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
            'Content-Type': contentType, Accept: 'application/dicom+json' },
        } as RequestInit, 'body');
        const bytes = Buffer.from(await upstream.arrayBuffer());
        if (upstream.ok) await recordGatewayStow(this.records, this.orthanc, req, uid, JSON.parse(bytes.toString('utf8')));
        res.status(upstream.status);
        const type = upstream.headers.get('content-type');
        if (type) res.setHeader('Content-Type', type);
        res.end(bytes);
      }
    } catch {
      throw new ServiceUnavailableException('영상 수신 또는 기재 기록을 확인하지 못했습니다. 같은 전송을 다시 확인하세요.');
    } finally { req.off('aborted', stop); }
    // The code is the whole answer: the Gateway reads nothing else, and no person reads this response.
    if (refusal) throw new ConflictException({ code: refusal });
  }

  @Get('image-relay/*')
  async read(@Req() req: any, @Res() res: any) {
    const target = relayTarget(String(req.originalUrl ?? req.url ?? ''));
    if (!target) throw new NotFoundException('영상 경로가 올바르지 않습니다');
    const uri = target.path + target.query;
    const admitted = await admitDicomRead(res, () => this.pacs.authzDicom(uri, req.method, member(req)));
    // A HEAD or a description is no delivery (image-delivery-record.ts lease()); an instance description is a 열람 of
    // the study's metadata, recorded apart from the deliveries (describe()).
    const lease = await this.deliveries.lease(req, IMAGE_RELAY_SURFACE, target.path, () => archiveRead(admitted));
    const described = lease ? null : await this.deliveries.describe(req, IMAGE_RELAY_SURFACE, target.path, () => archiveRead(admitted));
    if (lease) res.setHeader(RECORDED_STUDY_HEADER, admitted!.studyUid);
    const selected = lease ? () => lease.confirm() : described ? () => described.confirm() : undefined;
    const abort = new AbortController();
    const stop = () => { if (!res.writableFinished) abort.abort(); };
    let relayed = false;
    const closed = new Promise<void>(resolve => {
      if (res.destroyed || res.closed) resolve(); else res.once('close', () => resolve());
    });
    req.once('aborted', stop);
    res.once('close', stop);
    // nginx sets both forwarded headers on every proxied request (server level); the relay validates their shape.
    const first = (name: string) => String(req.headers?.[name] ?? '').split(',')[0].trim();
    const origin = `${first('x-forwarded-proto')}://${first('x-forwarded-host')}`;
    try {
      // Orthanc selects what it answers when the request reaches it, after the lease read the study: the answer is
      // copied only once the archive still holds the patient and revision the record names (C6/C7, I3).
      if (target.path.startsWith('/dicom-web/') && !imageRead(target.path)) {
        await this.metadata.relay(req, res, this.orthanc, uri, origin, admitted!, abort.signal);
      } else {
        await this.orthanc.relay(uri, String(req.headers?.accept ?? '*/*'), res, abort.signal, origin, selected);
      }
      relayed = true;
    } catch (error) {
      // After the headers a JSON error cannot follow; cutting the connection is the truthful end of a partial image.
      if (res.headersSent) { res.destroy(); return; }
      throw error;
    } finally {
      req.off('aborted', stop);
      // A served image is a relayed success answer the client received in full; Orthanc's error answers are not.
      if (lease) void closed.then(() => lease.release(relayed && res.writableFinished === true && res.statusCode >= 200 && res.statusCode < 300));
    }
  }
}
