/**
 * 웹 편집기 상단 바 — 로고 오른쪽의 「대시보드」 이동과 에이전트 연결 상태.
 * 다른 ItMatZip 도구(무음 구간 감지 등) 머리글과 같은 정보를, 편집기의 어두운 상단 바에 맞춰 작게 보여 준다.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { api, controllerOrigin, agentFetch } from '../platform/agentClient'
import './SiteTopbarLinks.css'

type AgentState =
  | { kind: 'checking' }
  | { kind: 'online'; version: string; ms: number; ffmpeg: boolean | null }
  | { kind: 'offline' }

const POLL_MS = 10_000

async function probe(): Promise<AgentState> {
  const t0 = performance.now()
  try {
    const res = await agentFetch(`${controllerOrigin}/health`, { method: 'GET' })
    if (!res.ok) return { kind: 'offline' }
    const health = (await res.json()) as { agent_version?: unknown }
    const ms = Math.max(1, Math.round(performance.now() - t0))
    const version = typeof health.agent_version === 'string' ? health.agent_version : ''
    let ffmpeg: boolean | null = null
    try {
      const ff = await api<{ ffmpegPath?: string }>('/ffmpeg')
      ffmpeg = !!ff.ffmpegPath
    } catch {
      ffmpeg = null
    }
    return { kind: 'online', version, ms, ffmpeg }
  } catch {
    return { kind: 'offline' }
  }
}

export function SiteTopbarLinks(): ReactElement {
  const [agent, setAgent] = useState<AgentState>({ kind: 'checking' })

  useEffect(() => {
    let alive = true
    let timer = 0
    const tick = async () => {
      const next = await probe()
      if (!alive) return
      setAgent(next)
      timer = window.setTimeout(() => void tick(), POLL_MS)
    }
    void tick()
    const onFocus = () => { window.clearTimeout(timer); void tick() }
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      window.clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  return <div className="site-topbar-links">
    <a className="site-topbar-dashboard" href="../" title="ItMatZip 도구 대시보드로 이동">
      <span aria-hidden="true">←</span>대시보드
    </a>
    <div className={`site-topbar-agent site-topbar-agent--${agent.kind}`} role="status" aria-live="polite"
      title={agent.kind === 'offline' ? 'PC에서 ItMatZip 에이전트를 실행해 주세요.' : undefined}>
      <span className="site-topbar-agent-dot" aria-hidden="true" />
      <span className="site-topbar-agent-text">
        <span className="site-topbar-agent-main">
          {agent.kind === 'checking' && '에이전트 연결 확인 중…'}
          {agent.kind === 'online' && <>에이전트 연결됨{agent.version ? ` v${agent.version}` : ''} <span className="site-topbar-agent-ms">({agent.ms}ms)</span></>}
          {agent.kind === 'offline' && '에이전트 연결 안 됨'}
        </span>
        {agent.kind === 'online' && agent.ffmpeg !== null && <span className="site-topbar-agent-sub">
          {agent.ffmpeg ? 'FFmpeg · ffprobe 준비됨' : 'FFmpeg 준비 필요'}
        </span>}
      </span>
    </div>
  </div>
}
