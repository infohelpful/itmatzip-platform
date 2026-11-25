import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMediaComposition, type MediaEdits } from '../../../shared/mediaComposition'
import type { ExportRequest } from '../../../shared/ipc'

vi.mock('./agentClient', async importOriginal => ({
  ...await importOriginal<typeof import('./agentClient')>(), api: vi.fn(), controller: vi.fn(), agentFetch: vi.fn()
}))
vi.mock('./subtitleFrameRenderer', () => ({ SubtitleFrameRenderer: class {
  async render() { return new Blob(['png'], { type: 'image/png' }) }
  dispose() {}
} }))
vi.mock('./localFiles', () => ({ saveTextAs: vi.fn(async () => 'export.srt'), openFile: vi.fn(),
  downloadTextFile: vi.fn(), saveTextInPlace: vi.fn() }))

import { AgentOutdated, agentFetch, api, controller } from './agentClient'
import { saveTextAs } from './localFiles'
import { createWebApi } from './webApi'

const edits: MediaEdits = { version: 1, assets: [{ id: 'photo', kind: 'image', path: 'C:/photo.png', name: '사진' }],
  insertions: [{ id: 'still', assetId: 'photo', at: { sourceTime: 2 }, duration: 3, sourceStart: 0, fit: 'contain', muted: true }],
  overlays: [] }
const request = (): ExportRequest => ({ inputPath: 'C:/original.mp4', format: 'video', saveTo: 'downloads',
  cutRanges: [], subtitles: [{ start: 0, end: 10, text: '원본' }], composition: buildMediaComposition(10, [], [], edits) })

describe('composition export bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api).mockImplementation(async path => {
      if (path === '/composition/capabilities') return { version: 1, imageOverlay: true, imageInsert: true, videoInsert: true }
      if (path === '/export/downloads-dir') return { path: 'C:/output' }
      if (path === '/export/video') return { jobId: 'job', width: 640, height: 360, renderWidth: 640, renderHeight: 360,
        duration: 10, fps: 30, encoderName: 'CPU' }
      if (path.endsWith('/encode')) return { ok: true }
      if (path === '/export/job') return { state: 'done', percent: 100, outputPath: 'C:/output/result.mp4' }
      throw new Error(`Unexpected API call ${path}`)
    })
    vi.mocked(agentFetch).mockResolvedValue(new Response('', { status: 200 }))
  })
  it('sends the composition and schedules no original captions during inserted media', async () => {
    const req = request()
    const result = await createWebApi().exportByFormat(req)
    expect(result).toMatchObject({ canceled: false, outputPath: 'C:/output/result.mp4' })
    const encode = vi.mocked(api).mock.calls.find(([path]) => path.endsWith('/encode'))!
    expect(encode[1]).toEqual({ composition: req.composition,
      schedule: [{ startFrame: 0, endFrame: 60 }, { startFrame: 150, endFrame: 390 }] })
    expect(agentFetch).toHaveBeenCalledTimes(2)
  })
  it('rejects older agents before starting a job or selecting an output folder', async () => {
    vi.mocked(api).mockRejectedValue(new AgentOutdated())
    await expect(createWebApi().exportByFormat(request())).rejects.toThrow('이미지·영상 삽입')
    expect(api).toHaveBeenCalledTimes(1)
    expect(controller).not.toHaveBeenCalled()
    expect(agentFetch).not.toHaveBeenCalled()
  })
  it('exports subtitle timestamps with the insertion gap', async () => {
    await createWebApi().exportByFormat({ ...request(), format: 'srt', saveTo: undefined })
    const text = vi.mocked(saveTextAs).mock.calls[0][0] as string
    expect(text).toContain('00:00:00,000 --> 00:00:02,000')
    expect(text).toContain('00:00:05,000 --> 00:00:13,000')
  })
  it('fails explicitly instead of exporting original audio without inserts', async () => {
    await expect(createWebApi().exportByFormat({ ...request(), format: 'wav' })).rejects.toThrow('오디오 단독')
    expect(api).not.toHaveBeenCalled()
  })
  it('rejects ambiguous composition and legacy clip plans', async () => {
    await expect(createWebApi().exportByFormat({ ...request(), clipPlan: [], format: 'srt' })).rejects.toThrow('동시에')
  })
})
