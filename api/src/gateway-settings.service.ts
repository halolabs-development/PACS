import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { StudyAccessService } from './study-access.service';
import { Caller, inst, need, needExact } from './pacs/access';
import { dump } from './pacs/values';
import { GATEWAY_SETTINGS_INVALID, GATEWAY_SETTINGS_RESTRICTED, GATEWAY_SETTINGS_STALE, GatewayPeer, GatewaySettings,
  GatewaySettingsInputError, gatewaySettingsAnswer, gatewaySettingsAudit, parseGatewaySettingsInput,
  storedGatewaySettings } from './gateway-settings';

/**
 * Gateway settings of an institution (routing rules, lossless compression and the retention of delivered copies). The rule is
 * gateway-settings.ts; this service reads and writes the one Institution column. The administrator reads and saves the
 * own institution's settings (accounts with a restricted study scope are refused, as for Gateway Status); the
 * institution's Gateways read them on GET /api/gateway/settings with their own credential.
 *
 * A save and a DICOM Peer removal lock the institution row first (FOR UPDATE), so a route never names a removed peer.
 */
@Injectable()
export class GatewaySettingsService {
  constructor(private readonly prisma: PrismaService, private readonly studyAccess: StudyAccessService) {}

  private async storePeers(db: any, me: string): Promise<GatewayPeer[]> {
    const rows = await db.dicomPeer.findMany({ where: { institutionId: me, kind: 'store' },
      orderBy: [{ name: 'asc' }, { aet: 'asc' }] });
    return rows.map((p: any) => ({ id: p.id, name: p.name, aet: p.aet, host: p.host, port: p.port }));
  }

  private async admin(c: Caller, what: string) {
    need(c.roles, 'admin', what);
    const access = await this.studyAccess.snapshot(c);
    if (access.policy.restricted)
      throw new ForbiddenException({ code: GATEWAY_SETTINGS_RESTRICTED,
        message: '검사 접근 범위가 제한된 계정은 Gateway 규칙을 보거나 바꿀 수 없습니다' });
    return access;
  }

  /** `GET /api/admin/gateway-settings`: the settings and the institution's store peers a route may name. */
  async adminRead(c: Caller) {
    const access = await this.admin(c, 'Gateway 규칙 조회');
    const me = inst(c);
    const own = await this.prisma.institution.findUnique({ where: { id: me }, select: { gatewaySettings: true } });
    if (!own) throw new BadRequestException(`알 수 없는 기관입니다: ${me}`);
    const answer = { settings: storedGatewaySettings(own.gatewaySettings), peers: await this.storePeers(this.prisma, me) };
    await this.studyAccess.unchanged(c, access);
    return answer;
  }

  /**
   * `PUT /api/admin/gateway-settings` with `{ revision, routes, compression, retentionDays }` (no retentionDays = keep it). The row lock, the check of
   * the revision the form started from, the write and the audit row are one transaction; the same settings again write
   * nothing.
   */
  async adminSave(body: unknown, c: Caller) {
    const access = await this.admin(c, 'Gateway 규칙 저장');
    const me = inst(c);
    const result = await this.prisma.$transaction(async tx => {
      const locked = await tx.$queryRaw<any[]>`SELECT "gatewaySettings" FROM "Institution" WHERE id = ${me} FOR UPDATE`;
      if (!locked.length) throw new BadRequestException(`알 수 없는 기관입니다: ${me}`);
      const current = storedGatewaySettings(locked[0].gatewaySettings);
      const peers = await this.storePeers(tx, me);
      let input;
      try { input = parseGatewaySettingsInput(body, new Set(peers.map(p => p.id)), current.retentionDays); }
      catch (error) {
        if (error instanceof GatewaySettingsInputError)
          throw new BadRequestException({ code: error.code, field: error.field });
        throw error;
      }
      if (input.expectedRevision !== current.revision)
        throw new ConflictException({ code: GATEWAY_SETTINGS_STALE, revision: current.revision,
          message: '다른 곳에서 Gateway 규칙이 바뀌었습니다. 다시 불러온 뒤 저장하세요.' });
      // The scope the save was admitted with still holds, checked before anything is written (a refusal writes nothing).
      await this.studyAccess.unchanged(c, access, tx);
      const same = JSON.stringify({ routes: current.routes, compression: current.compression, retentionDays: current.retentionDays })
        === JSON.stringify(input.settings);
      if (same) return { settings: current, changed: false };
      const next: GatewaySettings = { revision: current.revision + 1, ...input.settings };
      await tx.institution.update({ where: { id: me }, data: { gatewaySettings: next as any } });
      await tx.auditLog.create({ data: { actor: c.actor || 'unknown', action: 'institution.gateway-settings.save',
        target: me, detail: dump({ institution: me, ...gatewaySettingsAudit(next) }) } });
      return { settings: next, changed: true };
    }, { maxWait: 4000, timeout: 8000 });
    return result;
  }

  /**
   * `GET /api/gateway/settings`: a Gateway credential only, its own institution (the token's binding). `withRetention`:
   * the Gateway asked for retentionDays (`?retention=1`); an older one does not and never gets the key.
   */
  async gatewayRead(c: Caller, withRetention = false) {
    needExact(c, 'gateway', 'Gateway 설정 조회');
    const me = inst(c);
    const own = await this.prisma.institution.findUnique({ where: { id: me }, select: { gatewaySettings: true } });
    if (!own) throw new BadRequestException({ code: GATEWAY_SETTINGS_INVALID, message: `알 수 없는 기관입니다: ${me}` });
    return gatewaySettingsAnswer(storedGatewaySettings(own.gatewaySettings), await this.storePeers(this.prisma, me),
      withRetention);
  }
}
