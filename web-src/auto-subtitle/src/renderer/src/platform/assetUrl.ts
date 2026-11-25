import { useEffect, useState } from 'react'
import { needsBlobMedia } from './browserMediaUrl'
import { localAwareFetch } from './agentClient'

/**
 * Playable URL of an inserted/overlay media file the agent has registered (`registerCompositionAsset`
 * or the picker). On https pages the file is read once through fetch and shared as a blob: URL by the
 * preview and every thumbnail; blob URLs are never written into the project.
 */
const cache = new Map<string, Promise<string>>()

export function playableAssetUrl(path: string): Promise<string> {
  const url = window.api.getMediaFileUrl(path)
  if (!needsBlobMedia(url)) return Promise.resolve(url)
  let pending = cache.get(url)
  if (!pending) {
    pending = localAwareFetch(url, { cache: 'no-store' })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.blob()
      })
      .then(blob => URL.createObjectURL(blob))
    pending.catch(() => cache.delete(url))
    cache.set(url, pending)
  }
  return pending
}

/** `ready` is false until the agent has registered the path (files are only served after that). */
export function useAssetUrl(path: string | undefined, ready: boolean): string | undefined {
  const [loaded, setLoaded] = useState<{ path: string; url: string } | null>(null)
  useEffect(() => {
    if (!path || !ready) return
    let live = true
    playableAssetUrl(path).then(url => { if (live) setLoaded({ path, url }) }, () => { if (live) setLoaded(null) })
    return () => { live = false }
  }, [path, ready])
  return loaded && loaded.path === path ? loaded.url : undefined
}
