import { describe, expect, it } from 'vitest'
import { mediaFileUrl, pathFromMediaUrl, pathToken, tokenToPath, toolApiBase } from './agentClient'

describe('agent media URLs', () => {
  it('round-trips Korean and space-containing Windows paths', () => {
    const path = 'E:\\영상 폴더\\테스트 1.mp4'
    expect(tokenToPath(pathToken(path))).toBe(path)
    expect(pathToken(path)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('builds a file URL the PCM reader can map back to the path', () => {
    const path = 'C:\\ProgramData\\itmatzip-agent\\auto-subtitle\\PreparedMedia\\' + 'a'.repeat(64) + '.wav'
    const url = mediaFileUrl(path)
    expect(url.startsWith(`${toolApiBase}/media/file/`)).toBe(true)
    expect(pathFromMediaUrl(url)).toBe(path)
    expect(pathFromMediaUrl('file:///C:/x.wav')).toBeNull()
  })
})
