/**
 * HTTP access to the local ItMatZip agent.
 *
 * - Controller (Go, :19876): native file dialogs (`/api/agent/pick-*`).
 * - Tool API (FastAPI behind the Go proxy): `/api/tools/auto-subtitle/v2/*`.
 * Both default to http://127.0.0.1:19876. For development the tool API can point at a separately
 * run FastAPI with `?agentApi=http://127.0.0.1:19887` (remembered in localStorage).
 */
const DEFAULT_AGENT_ORIGIN = 'http://127.0.0.1:19876'
const API_PATH = '/api/tools/auto-subtitle/v2'
const STORAGE_KEY = 'autosub.agentApi'

function readOverride(): string | null {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('agentApi')
    if (fromQuery !== null) {
      if (fromQuery) localStorage.setItem(STORAGE_KEY, fromQuery)
      else localStorage.removeItem(STORAGE_KEY)
      return fromQuery || null
    }
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

const trimSlash = (s: string) => s.replace(/\/+$/, '')
export const controllerOrigin = DEFAULT_AGENT_ORIGIN
export const toolApiBase = trimSlash(readOverride() || DEFAULT_AGENT_ORIGIN) + API_PATH

export class AgentUnavailable extends Error {
  constructor(cause: unknown) {
    super('ItMatZip 에이전트에 연결할 수 없습니다. 에이전트가 실행 중인지 확인해 주세요.')
    this.name = 'AgentUnavailable'
    this.cause = cause
  }
}

/** Chrome Local Network Access: requests from a public page to loopback must declare it. */
function loopbackInit(init: RequestInit): RequestInit {
  try {
    new Request('http://127.0.0.1/', { targetAddressSpace: 'loopback' } as RequestInit)
    return { ...init, targetAddressSpace: 'loopback' } as RequestInit
  } catch {
    return init
  }
}

export async function agentFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, loopbackInit({ cache: 'no-store', ...init }))
  } catch (error) {
    throw new AgentUnavailable(error)
  }
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const parsed = JSON.parse(text) as { detail?: unknown }
    if (typeof parsed.detail === 'string') return parsed.detail
  } catch {
    /* plain text */
  }
  return text || `HTTP ${res.status}`
}

export async function api<T>(path: string, body?: unknown, method?: 'GET' | 'POST'): Promise<T> {
  const res = await agentFetch(toolApiBase + path, body === undefined && method !== 'POST'
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as T
}

export async function apiBinary(path: string, body: unknown): Promise<Response> {
  return agentFetch(toolApiBase + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
}

export async function controller<T>(path: string): Promise<T> {
  const res = await agentFetch(controllerOrigin + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as T
}

export { readError }

/** UTF-8 path -> base64url token used in media URLs (non-ASCII paths survive any proxy). */
export function pathToken(path: string): string {
  const bytes = new TextEncoder().encode(path)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function tokenToPath(token: string): string {
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (token.length % 4)) % 4)
  const bin = atob(b64)
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

export function mediaFileUrl(path: string): string {
  const name = path.split(/[\\/]/).pop() || 'media'
  return `${toolApiBase}/media/file/${pathToken(path)}/${encodeURIComponent(name)}`
}

/** Inverse of mediaFileUrl; null for any other URL. */
export function pathFromMediaUrl(url: string): string | null {
  const prefix = `${toolApiBase}/media/file/`
  if (!url.startsWith(prefix)) return null
  const token = url.slice(prefix.length).split('/')[0]
  try {
    return tokenToPath(token)
  } catch {
    return null
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
