import { afterEach, describe, expect, it, vi } from 'vitest'
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

describe('agent origin failover (ad blockers that block 127.0.0.1)', () => {
  const HEALTH = { status: 'ok', agent_version: '9.9.9' }

  /** fetch stub: only origins accepted by `reachable` answer, everything else fails like a blocked request. */
  function stubFetch(reachable: (origin: string) => boolean) {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: string) => {
      calls.push(input)
      const url = new URL(input)
      if (!reachable(url.origin)) throw new TypeError('Failed to fetch')
      const body = url.pathname === '/health' ? HEALTH : { ok: true }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    return calls
  }

  async function freshClient() {
    // The real app runs on the public site; Node has no window, so imitate that page.
    vi.stubGlobal('window', {
      location: {
        href: 'https://tools.itmatzip.com/kr/auto-subtitle/', origin: 'https://tools.itmatzip.com',
        hostname: 'tools.itmatzip.com', port: '', search: '', protocol: 'https:'
      }
    })
    vi.resetModules()
    return import('./agentClient')
  }

  afterEach(() => vi.unstubAllGlobals())

  it('uses https local.itmatzip.com first on the https site, without probing', async () => {
    const calls = stubFetch(() => true)
    const client = await freshClient()
    await client.api('/ping')
    expect(calls).toEqual(['https://local.itmatzip.com:19878/api/tools/auto-subtitle/v2/ping'])
    expect(client.toolApiBase).toBe('https://local.itmatzip.com:19878/api/tools/auto-subtitle/v2')
  })

  it('falls back to 127.0.0.1 when the https listener is not up', async () => {
    const calls = stubFetch((origin) => origin !== 'https://local.itmatzip.com:19878')
    const client = await freshClient()
    await client.api('/ping')
    expect(client.controllerOrigin).toBe('http://127.0.0.1:19876')
    expect(calls.at(-1)).toBe('http://127.0.0.1:19876/api/tools/auto-subtitle/v2/ping')
  })

  it('moves to a reachable host name when https, 127.0.0.1 and localhost are blocked, and sticks to it', async () => {
    const blocked = new Set(['https://local.itmatzip.com:19878', 'http://127.0.0.1:19876', 'http://localhost:19876'])
    const calls = stubFetch((origin) => !blocked.has(origin))
    const client = await freshClient()

    await expect(client.api('/ping')).resolves.toEqual({ ok: true })
    expect(client.controllerOrigin).toBe('http://itmatzip.localhost:19876')
    expect(client.toolApiBase).toBe('http://itmatzip.localhost:19876/api/tools/auto-subtitle/v2')
    expect(calls.at(-1)).toBe('http://itmatzip.localhost:19876/api/tools/auto-subtitle/v2/ping')

    calls.length = 0
    await client.api('/again')
    expect(calls).toEqual(['http://itmatzip.localhost:19876/api/tools/auto-subtitle/v2/again'])
  })

  it('keeps http first when the page itself is http (dev)', async () => {
    vi.stubGlobal('window', {
      location: {
        href: 'http://localhost:5173/', origin: 'http://localhost:5173',
        hostname: 'localhost', port: '5173', search: '', protocol: 'http:'
      }
    })
    vi.resetModules()
    const calls = stubFetch(() => true)
    const client = await import('./agentClient')
    await client.api('/ping')
    expect(calls).toEqual(['http://127.0.0.1:19876/api/tools/auto-subtitle/v2/ping'])
  })

  it('rewrites media URLs that were built with the old origin', async () => {
    const calls = stubFetch((origin) => origin === 'http://itmatzip.localhost:19876')
    const client = await freshClient()
    const res = await client.localAwareFetch(client.mediaFileUrl('C:\a.wav'))
    expect(res.ok).toBe(true)
    expect(calls.at(-1)!.startsWith('http://itmatzip.localhost:19876/api/tools/auto-subtitle/v2/media/file/')).toBe(true)
  })

  it('reports AgentUnavailable when no origin answers', async () => {
    stubFetch(() => false)
    const client = await freshClient()
    await expect(client.api('/ping')).rejects.toBeInstanceOf(client.AgentUnavailable)
  })

  it('never replays a request when the failing origin still answers /health', async () => {
    let apiCalls = 0
    vi.stubGlobal('fetch', async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/health') {
        return new Response(JSON.stringify(HEALTH), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      apiCalls++
      throw new TypeError('connection reset')
    })
    const client = await freshClient()
    await expect(client.api('/save', { x: 1 })).rejects.toBeInstanceOf(client.AgentUnavailable)
    expect(apiCalls).toBe(1)
  })
})
