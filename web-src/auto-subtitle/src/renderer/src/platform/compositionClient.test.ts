import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('./agentClient', async importOriginal => ({
  ...await importOriginal<typeof import('./agentClient')>(), api: vi.fn(), controller: vi.fn()
}))
import { api, controller } from './agentClient'
import { pickCompositionAsset, registerCompositionAsset } from './compositionClient'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api).mockImplementation(async (path, body) => path === '/composition/capabilities'
    ? { version: 1, imageOverlay: true, imageInsert: true, videoInsert: true }
    : { ...(body as object), width: 640, height: 360, duration: 12, hasAudio: true, sourceOriginSec: 0 })
})

it('uses the existing image picker and retains its actual disk path', async () => {
  vi.mocked(controller).mockResolvedValue({ path: 'C:/사진/장면.png' })
  const asset = await pickCompositionAsset('image')
  expect(controller).toHaveBeenCalledWith('/api/agent/pick-local-image-file')
  expect(api).toHaveBeenLastCalledWith('/media/asset', { path: 'C:/사진/장면.png', kind: 'image' })
  expect(asset).toMatchObject({ kind: 'image', name: '장면.png', path: 'C:/사진/장면.png' })
  expect(asset).not.toHaveProperty('duration')
})

it('uses video metadata to bound the inserted clip trim', async () => {
  vi.mocked(controller).mockResolvedValue({ video_path: 'C:/video.mp4' })
  expect(await pickCompositionAsset('video')).toMatchObject({ kind: 'video', duration: 12 })
  expect(controller).toHaveBeenCalledWith('/api/agent/pick-local-subtitle-media')
})

it('does not register a file when the user cancels the picker', async () => {
  vi.mocked(controller).mockResolvedValue({ cancelled: true, path: '' })
  expect(await pickCompositionAsset('image')).toBeNull()
  expect(api).toHaveBeenCalledTimes(1)
})

it('registers saved asset paths again when reopening the project', async () => {
  expect(await registerCompositionAsset('C:/photo.png', 'image')).toMatchObject({ path: 'C:/photo.png', kind: 'image' })
  expect(controller).not.toHaveBeenCalled()
})
