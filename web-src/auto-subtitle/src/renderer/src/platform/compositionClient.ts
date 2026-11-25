import type { MediaAsset } from '../../../shared/mediaComposition'
import { AgentOutdated, api, controller } from './agentClient'

/** Explicit capability negotiation prevents an older agent silently ignoring media edits. */
export async function requireCompositionSupport(): Promise<void> {
  try {
    const result = await api<{ version: number; imageOverlay: boolean; imageInsert: boolean; videoInsert: boolean }>(
      '/composition/capabilities')
    if (result.version !== 1 || !result.imageOverlay || !result.imageInsert || !result.videoInsert) throw new AgentOutdated()
  } catch (error) {
    if (error instanceof AgentOutdated) throw new Error('이미지·영상 삽입을 지원하는 ItMatZip 에이전트로 업데이트해 주세요.')
    throw error
  }
}

export type MediaAssetInfo = {
  path: string
  kind: MediaAsset['kind']
  width: number
  height: number
  duration?: number
  hasAudio: boolean
  sourceOriginSec: number
}

/** Call again on project reopen: the agent's served-file allowlist does not survive a restart. */
export async function registerCompositionAsset(path: string, kind: MediaAsset['kind']): Promise<MediaAssetInfo> {
  await requireCompositionSupport()
  return api<MediaAssetInfo>('/media/asset', { path, kind })
}

/** Native pickers return persistent disk paths; blob URLs must never be saved in .autosub files. */
export async function pickCompositionAsset(kind: MediaAsset['kind']): Promise<MediaAsset | null> {
  await requireCompositionSupport()
  const picked = await controller<{ path?: string; video_path?: string; cancelled?: boolean }>(kind === 'image'
    ? '/api/agent/pick-local-image-file' : '/api/agent/pick-local-subtitle-media')
  const path = picked.path || picked.video_path
  if (picked.cancelled || !path) return null
  const info = await api<MediaAssetInfo>('/media/asset', { path, kind })
  return { id: `asset-${crypto.randomUUID()}`, kind, path: info.path, name: info.path.split(/[\\/]/).pop() || info.path,
    ...(kind === 'video' ? { duration: info.duration } : {}) }
}
