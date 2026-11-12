/** Whole-file digest; paths and modification times are not media identity. */
export type MediaFingerprint = { algorithm: 'sha256'; size: number; digest: string }
export type MediaFingerprintResult =
  | { ok: true; fingerprint: MediaFingerprint }
  | { ok: false; reason: string }

export function parseMediaFingerprint(raw: unknown): MediaFingerprint | null {
  if (typeof raw !== 'object' || raw === null) return null
  const v = raw as Record<string, unknown>
  return v.algorithm === 'sha256' && Number.isSafeInteger(v.size) && Number(v.size) >= 0 &&
    typeof v.digest === 'string' && /^[a-f0-9]{64}$/.test(v.digest)
    ? { algorithm: 'sha256', size: Number(v.size), digest: v.digest } : null
}

export function sameMedia(a: MediaFingerprint, b: MediaFingerprint): boolean {
  return a.algorithm === b.algorithm && a.size === b.size && a.digest === b.digest
}

/** 같은 타임스탬프로 보려면 길이가 거의 같아야 한다 — 프레임 반올림 정도(초)만 허용한다. */
export const REPLACE_MEDIA_DURATION_TOLERANCE_SEC = 0.25

export type ReplaceMediaCheck = { ok: true; basis: 'saved' | 'subtitles' } | { ok: false; reason: string }

function clockText(sec: number): string {
  const total = Math.max(0, sec)
  const m = Math.floor(total / 60)
  return `${m}분 ${(total - m * 60).toFixed(1)}초`
}

/**
 * 원본 영상을 다른 영상으로 바꿔도 되는지 길이로 판단한다. `expected` 는 저장된(또는 지금 열린) 원본 길이이고,
 * 없으면 자막이 끝나는 시각보다 새 영상이 짧지 않은지만 본다. 길이가 다르면 시간축이 어긋나므로 거부한다.
 */
export function checkReplacementDuration(
  expected: number | null, actual: number, lastSubtitleEnd: number
): ReplaceMediaCheck {
  if (!Number.isFinite(actual) || actual <= 0) return { ok: false, reason: '선택한 영상의 길이를 확인하지 못했습니다.' }
  if (expected !== null && expected > 0) {
    if (Math.abs(actual - expected) > REPLACE_MEDIA_DURATION_TOLERANCE_SEC) {
      return {
        ok: false,
        reason: `영상 길이가 달라 불러올 수 없습니다. (기존 ${clockText(expected)}, 선택한 영상 ${clockText(actual)}) ` +
          '길이가 다르면 자막 시간축이 어긋나므로 이 영상으로는 자막을 새로 만들어야 합니다.'
      }
    }
    return { ok: true, basis: 'saved' }
  }
  if (actual + REPLACE_MEDIA_DURATION_TOLERANCE_SEC < lastSubtitleEnd) {
    return {
      ok: false,
      reason: `영상이 자막보다 짧아 불러올 수 없습니다. (자막 ${clockText(lastSubtitleEnd)}, 선택한 영상 ${clockText(actual)}) ` +
        '같은 길이의 영상을 선택해 주세요.'
    }
  }
  return { ok: true, basis: 'subtitles' }
}
