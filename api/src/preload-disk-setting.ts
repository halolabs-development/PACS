/**
 * The reading-PC preload cache's disk cap, KIN_PRELOAD_DISK_GB in GiB (1024³ bytes). A site setting with no product
 * default: the site decides it from the reading PC's disk (docs/ops/preload-cache.md). Without a valid cap preload stays
 * off and each study shows Failed with that reason. /api/me, the startup log and the installation check all read the
 * setting through this one rule.
 */
type Env = Record<string, string | undefined>;

export function preloadDiskGb(env: Env = process.env): number | null {
  const raw = String(env.KIN_PRELOAD_DISK_GB ?? '').trim();
  const gb = raw ? Number(raw) : NaN;
  // The same test the reading PC applies to the cap it receives (preload-store.js budgetFor): whole bytes, at least one.
  const bytes = Number.isFinite(gb) && gb > 0 ? Math.floor(gb * 1024 ** 3) : NaN;
  return Number.isSafeInteger(bytes) && bytes > 0 ? gb : null;
}

const GUIDE = '기관이 판독 PC 디스크에 맞춰 .env에 GiB 숫자로 정합니다(docs/ops/preload-cache.md).';

/** One startup line when this site's preload is off, saying why; null when the cap is set. The value is never echoed. */
export function preloadDiskStartupNotice(env: Env = process.env): string | null {
  if (preloadDiskGb(env) !== null) return null;
  const effect = '미리 받기(Preload)가 꺼져 있고, 워크리스트의 Preload는 Failed와 그 이유를 보입니다.';
  return String(env.KIN_PRELOAD_DISK_GB ?? '').trim()
    ? `[KIN API] KIN_PRELOAD_DISK_GB 설정 오류: 바이트로 바꿔 1 이상이고 너무 크지 않은 GiB 숫자만 허용합니다. ${effect} ${GUIDE}`
    : `[KIN API] KIN_PRELOAD_DISK_GB가 설정되지 않았습니다. ${effect} ${GUIDE}`;
}
