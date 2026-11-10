import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { SubtitleLine } from '../../../shared/subtitles'
import { applyProofread, proofreadSource, type ProofreadChange } from '../aiProofread'
import { setAiMarks } from '../aiMarks'
import {
  acknowledgeMcpEdit, getMcpPendingEdit, getMcpStatus, heartbeatMcpEditor,
  publishMcpEditor, runMcpChat, type McpClient,
} from '../platform/aiAgent'
import './AiProofread.css'
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
  onJump: (startSec: number) => void
}

/** `changes`: 고친 단어 목록(API 교정과 같은 표시). `lineBefore/After`: 줄 수 변화. */
type ChatMessage = {
  role: 'user' | 'assistant'; text: string; proposed?: SubtitleLine[]; basis?: string
  changes?: ProofreadChange[]; lineBefore?: number; lineAfter?: number
}

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
type ApplyMode = 'review' | 'automatic'
const APPLY_MODE_KEY = 'autosub.mcpChat.applyMode'
const CLIENT_LABEL: Record<McpClient, string> = { codex: 'Codex', claude: 'Claude', antigravity: 'Antigravity' }

type Preset = { id: string; label: string; text: string }
const PRESETS_KEY = 'autosub.mcpChat.presets'
const SIZE_KEY = 'autosub.mcpChat.size'
const MAX_PRESETS = 3
const MAX_PRESET_TEXT = 1000
const DEFAULT_PRESET: Preset = {
  id: 'default',
  label: '읽기 좋게 줄바꿈·오타 수정',
  text: [
    '한 줄로 읽히면 절대 나누지 말고 1줄로 둬(공백 포함 30자 이하면 그대로 유지).',
    "30자를 넘는 문장만 문맥 단위(쉼표·절 끝·'~는데요/~했고' 뒤)로 나누고, 나눌 때도 조각이 너무 짧거나 한 단어만 따로 남지 않게 해줘.",
    "의미가 붙는 말은 중간에서 끊지 마. (예: 'PS5 게임', '윈도우에서 직접')",
    '오타·맞춤법·띄어쓰기를 고치고, 음성이 잘못 인식된 단어는 종류와 상관없이 앞뒤 문맥상 확실하면 올바른 말로 고쳐줘.',
    "(고유명사·영어/전문용어·숫자·동음이의어·조사/어미 오류 모두 해당. 예: '갓 오브 워 선지 오브 스파르타' → 'God of War: Sons of Sparta')",
    '말한 내용의 뜻과 순서는 바꾸지 말고(윤문·의역 금지), 문맥으로도 확신이 안 서는 부분만 그대로 둬.',
  ].join('\n'),
}
// The preset keeps a line of up to 30 characters (spaces included) as it is. aiProofread splits a line only
// when it is wider than round(target * 4/3) display units, so 23 -> 31 leaves every line the CLI kept under
// 30 characters alone (Hangul = 1 unit, space = 0.5) and only breaks the ones the CLI left too long.
const CLI_LINE_TARGET_UNITS = 23
const MIN_W = 300
const MIN_H = 300

function readPresets(): Preset[] {
  try {
    const raw = window.localStorage.getItem(PRESETS_KEY)
    if (raw === null) return [DEFAULT_PRESET]
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [DEFAULT_PRESET]
    return parsed.filter((item): item is Preset => !!item && typeof item.id === 'string' &&
      typeof item.label === 'string' && typeof item.text === 'string' && item.text.length <= MAX_PRESET_TEXT)
      .map(item => item.id === DEFAULT_PRESET.id ? DEFAULT_PRESET : item)
      .slice(0, MAX_PRESETS)
  } catch { return [DEFAULT_PRESET] }
}

function readSize(): { w: number; h: number } {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SIZE_KEY) ?? 'null') as { w?: unknown; h?: unknown } | null
    if (parsed && typeof parsed.w === 'number' && typeof parsed.h === 'number') {
      return { w: Math.max(MIN_W, parsed.w), h: Math.max(MIN_H, parsed.h) }
    }
  } catch { /* storage is optional */ }
  return { w: 370, h: 520 }
}

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

export function SubtitleMcpChat({ subtitles, preparedAudioPath, mediaDuration, measureMaxUnits, emphasisColor, disabled, onBeforeRun, onApply, onJump }: Props): JSX.Element | null {
  const [connected, setConnected] = useState(false)
  const [open, setOpen] = useState(false)
  const [clients, setClients] = useState<McpClient[]>([])
  const [client, setClient] = useState<McpClient>('codex')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [applyMode, setApplyMode] = useState<ApplyMode>(readApplyMode)
  const [presets, setPresets] = useState<Preset[]>(readPresets)
  const [editing, setEditing] = useState<{ label: string; text: string } | null>(null)
  const [size, setSize] = useState(readSize)
  const sizeRef = useRef(size)
  sizeRef.current = size
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
          targetUnits: CLI_LINE_TARGET_UNITS,
        })
        if (applyModeRef.current === 'automatic') {
          onBeforeRunRef.current()
          onApplyRef.current(result.lines)
          setAiMarks({ changes: result.changes, uncertain: [] })
          setMessages(items => [...items, {
            role: 'assistant', text: 'CLI가 만든 수정안을 자동 적용했습니다. Ctrl+Z로 되돌릴 수 있습니다.',
            changes: result.changes, lineBefore: result.lineCountBefore, lineAfter: result.lineCountAfter,
          }])
        } else {
          setMessages(items => [...items, {
            role: 'assistant', text: 'CLI가 현재 열린 자막에 대한 수정안을 보냈습니다. 확인한 뒤 적용하세요.',
            proposed: result.lines, basis: currentBasis,
            changes: result.changes, lineBefore: result.lineCountBefore, lineAfter: result.lineCountAfter,
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

  const savePresets = (next: Preset[]) => {
    setPresets(next)
    try { window.localStorage.setItem(PRESETS_KEY, JSON.stringify(next)) } catch { /* storage is optional */ }
  }
  const hasDefault = presets.some(item => item.id === DEFAULT_PRESET.id)
  const canAddPreset = presets.length < MAX_PRESETS

  const startResize = (edge: 'right' | 'top' | 'corner') => (event: ReactPointerEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startY = event.clientY
    const start = sizeRef.current
    let latest = start
    const move = (e: PointerEvent) => {
      const w = edge === 'top' ? start.w : start.w + (e.clientX - startX)
      const h = edge === 'right' ? start.h : start.h - (e.clientY - startY)
      latest = {
        w: Math.max(MIN_W, Math.min(w, window.innerWidth - 28)),
        h: Math.max(MIN_H, Math.min(h, window.innerHeight - 40)),
      }
      setSize(latest)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try { window.localStorage.setItem(SIZE_KEY, JSON.stringify(latest)) } catch { /* storage is optional */ }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const instruction = prompt.trim()
    if (!instruction || busy) return
    setPrompt('')
    void send(instruction, instruction)
  }

  /** Sends `instruction` to the CLI; `shown` is what the chat log displays (a preset shows its name). */
  const send = async (instruction: string, shown: string) => {
    if (busy) return
    setError('')
    setMessages(current => [...current, { role: 'user', text: shown }])
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
        <section className="subtitle-mcp-chat" aria-label="AutoSubtitle AI 채팅"
          style={{ width: `min(${size.w}px, calc(100vw - 28px))`, height: `min(${size.h}px, calc(100vh - 40px))` }}>
          <div className="subtitle-mcp-chat-resize is-top" onPointerDown={startResize('top')} role="separator" aria-orientation="horizontal" aria-label="채팅창 높이 조절" />
          <div className="subtitle-mcp-chat-resize is-right" onPointerDown={startResize('right')} role="separator" aria-orientation="vertical" aria-label="채팅창 너비 조절" />
          <div className="subtitle-mcp-chat-resize is-corner" onPointerDown={startResize('corner')} role="separator" aria-label="채팅창 크기 조절" />
          <header className="subtitle-mcp-chat-head">
            <div><b>AI 자막 채팅</b><small>MCP 설정됨 · {CLIENT_LABEL[client]}</small></div>
            <button type="button" onClick={() => setOpen(false)} aria-label="채팅 닫기">×</button>
          </header>
          <div className="subtitle-mcp-chat-notice">이 채팅은 CLI에 자막 텍스트만 전달합니다. AI는 음성을 듣지 못하고 문맥으로만 오타를 고칩니다.</div>
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
                {message.changes ? (
                  <>
                    <p className="subtitle-mcp-chat-summary">
                      단어 <b>{message.changes.length}</b>개 수정
                      {message.lineBefore !== undefined && message.lineAfter !== undefined
                        ? <> · 줄 {message.lineBefore} → <b>{message.lineAfter}</b></> : null}
                    </p>
                    {message.changes.length ? (
                      <ul className="ai-diff">
                        {message.changes.map(c => (
                          <li key={c.id}>
                            <button type="button" onClick={() => onJump(c.start)}>
                              <span className="ai-time">{clock(c.start)}</span> <del>{c.before}</del> → <ins>{c.after || '(앞 단어에 합침)'}</ins>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                ) : null}
                {message.proposed ? (
                  <>
                    <pre>{message.proposed.filter(line => !line.isDeleted).map(line => line.captionText ?? line.text).join('\n')}</pre>
                    <button type="button" className="subtitle-mcp-chat-apply" onClick={() => {
                      const currentBasis = subtitleFingerprint(subtitlesRef.current)
                      if (currentBasis !== message.basis) { setError('수정안을 만든 뒤 자막이 바뀌었습니다. 최신 자막으로 다시 요청해 주세요.'); return }
                      onBeforeRun()
                      onApply(message.proposed!)
                      setAiMarks({ changes: message.changes ?? [], uncertain: [] })
                      setMessages(current => current.map((entry, i) => i === index ? {
                        role: 'assistant', text: '수정안을 자막 편집기에 적용했습니다. Ctrl+Z로 되돌릴 수 있습니다.',
                        changes: entry.changes, lineBefore: entry.lineBefore, lineAfter: entry.lineAfter,
                      } : entry))
                    }}>수정안 적용</button>
                  </>
                ) : null}
              </article>
            ))}
            {busy ? <p className="subtitle-mcp-chat-thinking" role="status">AI가 수정안을 만드는 중…</p> : null}
          </div>
          {error ? <p className="subtitle-mcp-chat-error" role="alert">{error}</p> : null}
          <div className="subtitle-mcp-chat-presets" aria-label="프리셋">
            {presets.map(preset => (
              <span className="subtitle-mcp-chat-preset" key={preset.id}>
                <button type="button" className="subtitle-mcp-chat-preset-run" disabled={busy} title={preset.text}
                  onClick={() => void send(preset.text, `프리셋: ${preset.label}`)}>{preset.label}</button>
                <button type="button" className="subtitle-mcp-chat-preset-del" aria-label={`${preset.label} 프리셋 삭제`}
                  onClick={() => savePresets(presets.filter(item => item.id !== preset.id))}>×</button>
              </span>
            ))}
            {canAddPreset && !editing ? (
              <button type="button" className="subtitle-mcp-chat-preset-add"
                onClick={() => setEditing({ label: '', text: prompt.trim() })}>+ 프리셋 추가 ({presets.length}/{MAX_PRESETS})</button>
            ) : null}
            {!hasDefault && canAddPreset && !editing ? (
              <button type="button" className="subtitle-mcp-chat-preset-add"
                onClick={() => savePresets([DEFAULT_PRESET, ...presets])}>기본 프리셋 복원</button>
            ) : null}
          </div>
          {editing ? (
            <form className="subtitle-mcp-chat-preset-edit" onSubmit={event => {
              event.preventDefault()
              const label = editing.label.trim()
              const text = editing.text.trim()
              if (!label || !text || !canAddPreset) return
              savePresets([...presets, { id: `p-${Date.now().toString(36)}`, label: label.slice(0, 24), text }])
              setEditing(null)
            }}>
              <input name="mcp-preset-label" value={editing.label} maxLength={24} placeholder="프리셋 이름"
                aria-label="프리셋 이름" onChange={event => setEditing({ ...editing, label: event.target.value })} />
              <textarea name="mcp-preset-text" value={editing.text} maxLength={MAX_PRESET_TEXT} rows={4} placeholder="이 프리셋을 누르면 바로 전달할 요청"
                aria-label="프리셋 내용" onChange={event => setEditing({ ...editing, text: event.target.value })} />
              <div>
                <button type="submit" disabled={!editing.label.trim() || !editing.text.trim()}>저장</button>
                <button type="button" onClick={() => setEditing(null)}>취소</button>
              </div>
            </form>
          ) : null}
          <form className="subtitle-mcp-chat-form" onSubmit={submit}>
            <textarea name="mcp-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={1000}
              placeholder="자막에 원하는 수정을 입력하세요" aria-label="AI 자막 수정 요청" rows={2} />
            <button type="submit" disabled={busy || !prompt.trim()}>{busy ? '처리 중' : '보내기'}</button>
          </form>
        </section>
      )}
    </div>
  )
}
