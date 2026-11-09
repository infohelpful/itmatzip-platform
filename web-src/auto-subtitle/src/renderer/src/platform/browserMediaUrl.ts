import { useEffect, useState } from 'react'
import { isLoopbackUrl, localAwareFetch } from './agentClient'

/**
 * An https page cannot hand `http://127.0.0.1` URLs to <video>/<audio> without Chrome logging
 * "Mixed Content" warnings (media tags cannot declare targetAddressSpace either). On https pages the
 * file is therefore read through fetch() — which can declare it — and played from a blob: URL.
 * Plain-http pages (the agent's own bundled UI) keep using the direct URL.
 */
export function needsBlobMedia(url: string): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'https:' && isLoopbackUrl(url)
}

type Loaded = { source: string; playable: string }

export function useBrowserMediaUrl(url: string | undefined): string | undefined {
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!url || !needsBlobMedia(url)) {
      setLoaded(null)
      return
    }
    let cancelled = false
    let objectUrl: string | undefined
    const controller = new AbortController()
    void (async () => {
      try {
        const res = await localAwareFetch(url, { cache: 'no-store', signal: controller.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setLoaded({ source: url, playable: objectUrl })
      } catch {
        // Fall back to the direct URL (works, only logs the browser warning).
        if (!cancelled) setLoaded({ source: url, playable: url })
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [url])

  if (!url) return undefined
  if (!needsBlobMedia(url)) return url
  return loaded?.source === url ? loaded.playable : undefined
}
