import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from 'react'
import type { SubtitleLine } from '../../../shared/subtitles'
import { applyProofread, proofreadSource } from '../aiProofread'
import {
  acknowledgeMcpEdit, getMcpPendingEdit, getMcpStatus, heartbeatMcpEditor,
  publishMcpEditor, runMcpChat, type McpClient,
} from '../platform/aiAgent'
import './SubtitleMcpChat.css'
import { startPolling } from '../platform/polling'

type Props = {
  subtitles: readonly SubtitleLine[]
  preparedAudioPath: string | null
  mediaDuration: number | null
  measureMaxUnits: () => number
  emphasisColor: string
  disabled: boolean
  onBeforeRun: () => void
  onApply: (lines: SubtitleLine[]) => void
}

type ChatMessage = { role: 'user' | 'assistant'; text: string; proposed?: SubtitleLine[]; basis?: string }
type ApplyMode = 'review' | 'automatic'
const APPLY_MODE_KEY = 'autosub.mcpChat.applyMode'
const CLIENT_LABEL: Record<McpClient, string> = { codex: 'Codex', claude: 'Claude', antigravity: 'Antigravity' }

function readApplyMode(): ApplyMode {
  try { return window.localStorage.getItem(APPLY_MODE_KEY) === 'automatic' ? 'automatic' : 'review' }
  catch { return 'review' }
}

function subtitleFingerprint(lines: readonly SubtitleLine[]): string {
  const source = proofreadSource(lines)
  const raw = JSON.stringify({
    starts: source.lineStarts,
    units: source.units.map(unit => [unit.id, unit.text, unit.line, unit.start, unit.end]),
  })
  let hash = 14695981039346656037n
  for (let i = 0; i < raw.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(raw.charCodeAt(i))) * 1099511628211n)
  return hash.toString(16).padStart(16, '0')
}

export function SubtitleMcpChat({ subtitles, preparedAudioPath, mediaDuration, measureMaxUnits, emphasisColor, disabled, onBeforeRun, onApply }: Props): JSX.Element | null {
  const [connected, setConnected] = useState(false)
  const [open, setOpen] = useState(false)
  const [clients, setClients] = useState<McpClient[]>([])
  const [client, setClient] = useState<McpClient>('codex')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [applyMode, setApplyMode] = useState<ApplyMode>(readApplyMode)
  const listRef = useRef<HTMLDivElement>(null)
  const subtitlesRef = useRef(subtitles)
  subtitlesRef.current = subtitles
  const applyModeRef = useRef(applyMode)
  applyModeRef.current = applyMode
  const onApplyRef = useRef(onApply)
  onApplyRef.current = onApply
  const onBeforeRunRef = useRef(onBeforeRun)
  onBeforeRunRef.current = onBeforeRun
  const settingsRef = useRef({ measureMaxUnits, emphasisColor })
  settingsRef.current = { measureMaxUnits, emphasisColor }
  const editorSessionIdRef = useRef('')
  if (!editorSessionIdRef.current) {
    editorSessionIdRef.current = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID() : `editor-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
  const source = useMemo(() => proofreadSource(subtitles), [subtitles])
  const basis = useMemo(() => subtitleFingerprint(subtitles), [subtitles])
  const editorSnapshot = useMemo(() => {
    const words = source.units.map((unit, index) => ({
      index, id: unit.id, text: unit.text, lineIndex: unit.line, start: unit.start, end: unit.end,
    }))
    const lines = source.lineStarts.map((start, index) => {
      const end = source.lineStarts[index + 1] ?? words.length
      return { lineIndex: index, text: words.slice(start, end).map(word => word.text).join(' ') }
    })
    return { lines, words, lineStarts: source.lineStarts, pauses: source.pauses, audioPath: preparedAudioPath, duration: mediaDuration }
  }, [source, preparedAudioPath, mediaDuration])
  const currentEditorRef = useRef({ sessionId: editorSessionIdRef.current, basis, snapshot: editorSnapshot })
  currentEditorRef.current = { sessionId: editorSessionIdRef.current, basis, snapshot: editorSnapshot }
  const seenEditIdsRef = useRef(new Set<string>())

  useEffect(() => {
    if (!editorSnapshot.words.length) return
    void publishMcpEditor(editorSessionIdRef.current, basis, editorSnapshot).catch(() => undefined)
  }, [basis, editorSnapshot])

  useEffect(() => {
    const pulse = async () => {
      const current = currentEditorRef.current
      if (!current.snapshot.words.length) return
      const state = await heartbeatMcpEditor(current.sessionId)
      if (!state.ok) await publishMcpEditor(current.sessionId, current.basis, current.snapshot)
    }
    return startPolling(pulse, 10_000)
  }, [])

  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        const state = await getMcpStatus()
        if (!active) return
        setConnected(state.connected)
        const configured = state.configuredClients ?? []
        setClients(configured)
        setClient(current => configured.includes(current) ? current : configured[0] ?? current)
      } catch (error) { if (active) setConnected(false); throw error }
    }
    const stop = startPolling(poll, 30_000)
    return () => { active = false; stop() }
  }, [])

  useEffect(() => {
    if (!connected || !subtitles.length) return
    let active = true
    const pollPending = async () => {
      try {
        const sessionId = editorSessionIdRef.current
        const { pending } = await getMcpPendingEdit(sessionId)
        if (!active || !pending || seenEditIdsRef.current.has(pending.editId)) return
        seenEditIdsRef.current.add(pending.editId)
        const current = subtitlesRef.current
        const currentBasis = subtitleFingerprint(current)
        if (currentBasis !== currentEditorRef.current.basis || pending.revision !== (await publishMcpEditor(
          sessionId, currentEditorRef.current.basis, currentEditorRef.current.snapshot,
        )).revision) {
          setMessages(items => [...items, { role: 'assistant', text: 'CLI가 수정하는 동안 자막이 바뀌어 수정안을 반영하지 않았습니다. 현재 자막을 다시 가져와 요청해 주세요.' }])
          await acknowledgeMcpEdit(sessionId, pending.editId)
          return
        }
        const currentSource = proofreadSource(current)
        const maxUnits = Math.max(4, Math.min(80, Math.round(settingsRef.current.measureMaxUnits())))
        const result = applyProofread(current, currentSource, pending.answer, {
          emphasisColor: settingsRef.current.emphasisColor,
          maxUnits,
          targetUnits: Math.min(18, maxUnits),
        })
        if (applyModeRef.current === 'automatic') {
          onBeforeRunRef.current()
          onApplyRef.current(result.lines)
          setMessages(items => [...items, { role: 'assistant', text: 'CLI가 만든 수정안을 자동 적용했습니다. Ctrl+Z로 되돌릴 수 있습니다.' }])
        } else {
          setMessages(items => [...items, {
            role: 'assistant', text: 'CLI가 현재 열린 자막에 대한 수정안을 보냈습니다. 확인한 뒤 적용하세요.',
            proposed: result.lines, basis: currentBasis,
          }])
          setOpen(true)
        }
        await acknowledgeMcpEdit(sessionId, pending.editId)
      } catch (error) { throw error /* Keep the pending edit and back off until reconnection. */ }
    }
    const stop = startPolling(pollPending, 3000)
    return () => { active = false; stop() }
  }, [connected, subtitles.length > 0])

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }) }, [messages, busy])

  if (!connected) return null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const instruction = prompt.trim()
    if (!instruction || busy) return
    setPrompt('')
    setError('')
    setMessages(current => [...current, { role: 'user', text: instruction }])
    if (disabled) { setError('현재 편집 작업이 끝난 뒤 요청해 주세요.'); return }
    if (!subtitles.length) { setError('먼저 영상에서 자막을 추출하거나 자막 파일을 열어 주세요.'); return }
    if (!clients.includes(client)) { setError('트레이의 AI MCP 설정에서 사용할 CLI를 연결해 주세요.'); return }
    onBeforeRun()
    setBusy(true)
    try {
      const message = await runMcpChat(client, instruction, editorSessionIdRef.current)
      setMessages(current => [...current, { role: 'assistant', text: message }])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  return (
    <div className="subtitle-mcp-chat-anchor">
      {!open ? (
        <button className="subtitle-mcp-chat-launch" type="button" onClick={() => setOpen(true)} aria-label="AutoSubtitle AI 채팅 열기">
          <span aria-hidden="true">✦</span> AI 자막 채팅
        </button>
      ) : (
        <section className="subtitle-mcp-chat" aria-label="AutoSubtitle AI 채팅">
          <header className="subtitle-mcp-chat-head">
            <div><b>AI 자막 채팅</b><small>MCP 설정됨 · {CLIENT_LABEL[client]}</small></div>
            <button type="button" onClick={() => setOpen(false)} aria-label="채팅 닫기">×</button>
          </header>
          <div className="subtitle-mcp-chat-notice">이 채팅은 CLI에 자막 텍스트를 전달합니다. 실제 음성 대조는 CLI에서 AutoSubtitle MCP 오디오 도구를 직접 사용할 때 가능합니다.</div>
          <label className="subtitle-mcp-chat-mode">
            사용할 AI
            <select name="mcp-client" value={client} onChange={event => setClient(event.target.value as McpClient)}>
              {clients.map(id => <option key={id} value={id}>{CLIENT_LABEL[id]}</option>)}
            </select>
          </label>
          <label className="subtitle-mcp-chat-mode">
            수정 방식
            <select name="mcp-apply-mode" value={applyMode} onChange={event => {
              const next = event.target.value as ApplyMode
              setApplyMode(next)
              try { window.localStorage.setItem(APPLY_MODE_KEY, next) } catch { /* storage is optional */ }
            }}>
              <option value="review">확인 후 적용</option>
              <option value="automatic">자동 수정</option>
            </select>
          </label>
          <div className="subtitle-mcp-chat-messages" ref={listRef} aria-live="polite">
            {!messages.length ? <p className="subtitle-mcp-chat-empty">예: “문맥에 맞게 오타를 고치고 읽기 편하게 줄을 나눠줘”</p> : null}
            {messages.map((message, index) => (
              <article className={`subtitle-mcp-chat-message is-${message.role}`} key={index}>
                <p>{message.text}</p>
                {message.proposed ? (
                  <>
                    <pre>{message.proposed.filter(line => !line.isDeleted).map(line => line.captionText ?? line.text).join('\n')}</pre>
                    <button type="button" className="subtitle-mcp-chat-apply" onClick={() => {
                      const currentBasis = subtitleFingerprint(subtitlesRef.current)
                      if (currentBasis !== message.basis) { setError('수정안을 만든 뒤 자막이 바뀌었습니다. 최신 자막으로 다시 요청해 주세요.'); return }
                      onBeforeRun()
                      onApply(message.proposed!)
                      setMessages(current => current.map((entry, i) => i === index ? { role: 'assistant', text: '수정안을 자막 편집기에 적용했습니다. Ctrl+Z로 되돌릴 수 있습니다.' } : entry))
                    }}>수정안 적용</button>
                  </>
                ) : null}
              </article>
            ))}
            {busy ? <p className="subtitle-mcp-chat-thinking" role="status">AI가 수정안을 만드는 중…</p> : null}
          </div>
          {error ? <p className="subtitle-mcp-chat-error" role="alert">{error}</p> : null}
          <form className="subtitle-mcp-chat-form" onSubmit={event => void submit(event)}>
            <textarea name="mcp-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={1000}
              placeholder="자막에 원하는 수정을 입력하세요" aria-label="AI 자막 수정 요청" rows={2} />
            <button type="submit" disabled={busy || !prompt.trim()}>{busy ? '처리 중' : '보내기'}</button>
          </form>
        </section>
      )}
    </div>
  )
}
