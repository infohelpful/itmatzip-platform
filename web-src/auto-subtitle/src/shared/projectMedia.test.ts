import { describe, expect, it } from 'vitest'
import { checkReplacementDuration } from './projectMedia'

describe('checkReplacementDuration', () => {
  it('저장된 길이와 거의 같으면 허용한다', () => {
    expect(checkReplacementDuration(600, 600.1, 590)).toEqual({ ok: true, basis: 'saved' })
  })
  it('길이가 다르면 거부한다(시간축이 어긋남)', () => {
    const r = checkReplacementDuration(600, 612, 590)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('영상 길이가 달라')
  })
  it('저장된 길이가 없으면 자막 끝보다 짧은 영상만 거부한다', () => {
    expect(checkReplacementDuration(null, 700, 590)).toEqual({ ok: true, basis: 'subtitles' })
    expect(checkReplacementDuration(null, 500, 590).ok).toBe(false)
  })
  it('길이를 못 읽으면 거부한다', () => {
    expect(checkReplacementDuration(600, 0, 590).ok).toBe(false)
  })
})
