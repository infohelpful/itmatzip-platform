/**
 * AI 교정(Claude / ChatGPT 중 선택) — 툴바 버튼, AI 연동 설정(키·용어 사전), 실행·결과 확인 창, 적용 뒤 칩 표시.
 * 키는 에이전트가 PC 에 암호화해 보관하고 이 화면에는 끝 4자리만 온다.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { SubtitleLine } from '../../../shared/subtitles'
import { applyProofread, lineWidthUnits, proofreadSource, type ProofreadResult } from '../aiProofread'
import {
  chooseAi, deleteAiKey, getAiSettings, MODEL_LABEL, PROVIDER_LABEL, runProofread, saveAiKey, saveGlossary,
  type AiProvider, type AiSettings, type ProofreadUsage
} from '../platform/aiAgent'
import './AiProofread.css'

type Props = {
  subtitles: readonly SubtitleLine[]
  /** 지금 자막 디자인으로 화면 한 줄에 들어가는 글자 수(한글 1, 영문·숫자 0.5) */
  measureMaxUnits: () => number
  emphasisColor: string
  disabled: boolean
  onBeforeRun: () => void
  onApply: (lines: SubtitleLine[]) => void
  onJump: (startSec: number) => void
}

type Review = { result: ProofreadResult; usage: ProofreadUsage | null }
/** 칩 표시는 단어 시작 시각으로 찾는다 — 단어 id 는 줄 순서 기반이라 줄을 나누면 바뀐다. */
type Marks = { changed: number[]; uncertain: ProofreadResult['uncertain'] }

const EMPHASIZE_KEY = 'autosub.ai.emphasize'
/** 읽기 편한 한 줄 목표 길이(한글 약 18자) — 화면 한 줄(`maxUnits`)은 끊을 데가 없을 때만 쓰는 상한 */
const TARGET_UNITS = 18

function readEmphasize(): boolean {
  try { return window.localStorage.getItem(EMPHASIZE_KEY) === '1' } catch { return false }
}

function cssId(id: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&')
}

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function AiProofread(props: Props): JSX.Element {
  const { subtitles, measureMaxUnits, emphasisColor, disabled, onBeforeRun, onApply, onJump } = props
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [runOpen, setRunOpen] = useState(false)
  const [emphasize, setEmphasize] = useState(readEmphasize)
  const [maxUnits, setMaxUnits] = useState(20)
  const [running, setRunning] = useState<{ elapsed: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [marks, setMarks] = useState<Marks | null>(null)
  const [marksOpen, setMarksOpen] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    try { setSettings(await getAiSettings()) } catch { setSettings(null) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    try { window.localStorage.setItem(EMPHASIZE_KEY, emphasize ? '1' : '0') } catch { /* ignore */ }
  }, [emphasize])

  const openRun = () => {
    setError(null)
    setReview(null)
    setMaxUnits(measureMaxUnits())
    setRunOpen(true)
  }

  const start = async () => {
    if (!settings?.configured) { setSettingsOpen(true); return }
    const source = proofreadSource(subtitles)
    if (source.units.length === 0) { setError('교정할 자막이 없습니다.'); return }
    onBeforeRun()
    setError(null)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setRunning({ elapsed: 0 })
    try {
      const { answer, usage } = await runProofread({
        provider: settings!.provider,
        words: source.units.map(u => u.text), lineStarts: source.lineStarts, pauses: source.pauses, maxUnits,
        targetUnits: Math.min(TARGET_UNITS, maxUnits), emphasize
      }, ctrl.signal, elapsed => setRunning({ elapsed }))
      // 기다리는 동안 자막을 고쳤을 수 있으니 지금 자막에 맞춰 다시 만든다(바뀐 단어가 있으면 중단).
      const now = proofreadSource(subtitles)
      if (now.units.length !== source.units.length || now.units.some((u, i) => u.id !== source.units[i]!.id || u.text !== source.units[i]!.text)) {
        throw new Error('교정 중에 자막이 바뀌었습니다. 다시 실행해 주세요.')
      }
      const result = applyProofread(subtitles, source, answer, { emphasisColor, maxUnits, targetUnits: Math.min(TARGET_UNITS, maxUnits) })
      setReview({ result, usage })
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e))
    } finally {
      abortRef.current = null
      setRunning(null)
    }
  }

  const apply = () => {
    if (!review) return
    onApply(review.result.lines)
    setMarks({ changed: review.result.changes.map(c => c.start), uncertain: review.result.uncertain })
    setMarksOpen(review.result.uncertain.length > 0)
    setReview(null)
    setRunOpen(false)
  }

  // 적용 뒤 칩 표시 — 가상 목록이 행을 다시 그려도 유지되도록 단어 id 선택자로 칠한다.
  const markStyle = useMemo(() => {
    if (!marks) return ''
    const rules: string[] = []
    const sel = (start: number) => `.subtitle-word-chip[data-word-start="${cssId(String(start))}"]`
    const changed = marks.changed.map(sel)
    const unsure = marks.uncertain.map(u => sel(u.start))
    if (changed.length) rules.push(`${changed.join(',')}{box-shadow:inset 0 -3px 0 #3ecf8e !important}`)
    if (unsure.length) rules.push(`${unsure.join(',')}{outline:2px dashed #f5a524 !important;outline-offset:1px}`)
    return rules.join('\n')
  }, [marks])

  const hasMarks = !!marks && (marks.changed.length > 0 || marks.uncertain.length > 0)

  return (
    <>
      <button type="button" className="app-topbar-gpu-btn preview-project-btn subtitle-panel-action-btn ai-proofread-btn"
        disabled={disabled} onClick={openRun}
        title="AI(Claude 또는 ChatGPT)가 오타를 고치고, 문맥에 맞게 화면 한 줄에 들어가도록 줄을 나눕니다. 단어 시간은 바뀌지 않습니다.">
        AI 교정
      </button>
      <button type="button" className="ai-proofread-gear" aria-label="AI 연동 설정" title="AI 연동 설정 (Claude / ChatGPT 선택 · API 키 · 용어 사전)"
        onClick={() => { setError(null); setSettingsOpen(true) }}>
        ⚙
      </button>
      {hasMarks ? (
        <span className="ai-marks">
          <button type="button" className="ai-marks-toggle" onClick={() => setMarksOpen(o => !o)}>
            AI 수정 {marks!.changed.length} · 확인 필요 {marks!.uncertain.length} ▾
          </button>
          {marksOpen ? (
            <div className="ai-marks-pop" role="dialog" aria-label="AI 교정 표시">
              <p className="ai-marks-legend">
                <span className="ai-legend-changed" /> AI가 고친 단어 <span className="ai-legend-unsure" /> 확인이 필요한 단어
              </p>
              {marks!.uncertain.length ? (
                <ul className="ai-marks-list">
                  {marks!.uncertain.map(u => (
                    <li key={u.id}>
                      <button type="button" onClick={() => onJump(u.start)}>
                        <span className="ai-time">{clock(u.start)}</span> <b>{u.text}</b> — {u.reason}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="ai-muted">확인이 필요한 단어가 없습니다.</p>}
              <div className="ai-row-end">
                <button type="button" className="ai-btn" onClick={() => { setMarks(null); setMarksOpen(false) }}>표시 지우기</button>
              </div>
            </div>
          ) : null}
        </span>
      ) : null}
      {markStyle ? <style>{markStyle}</style> : null}

      {settingsOpen && !runOpen ? (
        <AiSettingsDialog settings={settings} onChange={setSettings} onClose={() => { setSettingsOpen(false); void refresh() }} />
      ) : null}

      {runOpen ? (
        <div className="extract-modal-backdrop" role="presentation">
          <div className="extract-modal-card ai-card ai-card--wide" role="dialog" aria-modal="true" aria-labelledby="ai-run-title">
            <h2 id="ai-run-title" className="extract-modal-title">AI 교정</h2>
            {review ? (
              <ReviewBody review={review} onJump={onJump} />
            ) : (
              <div className="ai-body">
                {settings ? (
                  <>
                    <AiChoice settings={settings} busy={!!running}
                      onChoose={p => { void chooseAi(p).then(setSettings).catch(e => setError(String(e?.message ?? e))) }} />
                    <p className="ai-muted ai-small">
                      모델: {MODEL_LABEL[settings.providers[settings.provider].model] ?? settings.providers[settings.provider].model}
                      {' · '}
                      <button type="button" className="ai-inline-link" onClick={() => setSettingsOpen(true)}>바꾸기</button>
                    </p>
                    {!settings.configured ? (
                      <p className="ai-error">
                        {PROVIDER_LABEL[settings.provider]} API 키가 없습니다.{' '}
                        <button type="button" className="ai-inline-link" onClick={() => setSettingsOpen(true)}>키 등록하기</button>
                      </p>
                    ) : null}
                  </>
                ) : null}
                <p className="ai-muted">
                  자막 글자만 AI로 보냅니다. 영상과 음성은 PC 밖으로 나가지 않고, 단어 시간도 바뀌지 않습니다.
                  사용한 만큼 등록한 API 키로 요금이 나갑니다.
                </p>
                <ul className="ai-plan">
                  <li>오타·띄어쓰기·숫자와 영문 표기 수정{settings?.glossary.length ? ` (용어 사전 ${settings.glossary.length}개 반영)` : ''}</li>
                  <li>읽기 쉽게 의미 단위로 줄 나누기 — 한 줄 약 {Math.min(TARGET_UNITS, maxUnits)}자 안팎,
                    끊을 데가 없을 때만 최대 {maxUnits}자(지금 자막 디자인의 화면 한 줄). 두 줄로 넘어가지 않음</li>
                  <li>말소리가 없는 구간(오프닝·음악 등)은 다른 줄과 섞지 않고, 연달아 있으면 한 줄로 묶음</li>
                  <li>확신이 없는 단어는 고치지 않고 표시만</li>
                </ul>
                <label className="ai-check">
                  <input name="proofread-emphasis" type="checkbox" checked={emphasize} disabled={!!running} onChange={e => setEmphasize(e.target.checked)} />
                  중요 부분 강조 색 칠하기
                  <span className="ai-swatch" style={{ background: emphasisColor }} />
                </label>
                {running ? (
                  <p className="ai-status" role="status">{settings ? PROVIDER_LABEL[settings.provider] : 'AI'}가 교정하는 중… {clock(running.elapsed)}</p>
                ) : null}
              </div>
            )}
            {error ? <p className="ai-error" role="alert">{error}</p> : null}
            <div className="ai-row-end">
              {review ? (
                <>
                  <button type="button" className="ai-btn" onClick={() => setReview(null)}>취소</button>
                  <button type="button" className="ai-btn ai-btn--primary" onClick={apply}
                    disabled={review.result.changes.length === 0 && review.result.lineCountAfter === review.result.lineCountBefore
                      && review.result.emphasized.length === 0 && review.result.uncertain.length === 0
                      && review.result.silentMerged === 0}>
                    적용 (Ctrl+Z로 되돌리기)
                  </button>
                </>
              ) : running ? (
                <button type="button" className="ai-btn" onClick={() => abortRef.current?.abort()}>취소</button>
              ) : (
                <>
                  <button type="button" className="ai-btn" onClick={() => setRunOpen(false)}>닫기</button>
                  <button type="button" className="ai-btn ai-btn--primary" onClick={() => void start()}
                    disabled={disabled || !settings?.configured}>교정 시작</button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {settingsOpen && runOpen ? (
        <AiSettingsDialog settings={settings} onChange={setSettings} onClose={() => { setSettingsOpen(false); void refresh() }} />
      ) : null}
    </>
  )
}

function ReviewBody({ review, onJump }: { review: Review; onJump: (sec: number) => void }): JSX.Element {
  const { result, usage } = review
  return (
    <div className="ai-body">
      <p className="ai-summary">
        단어 <b>{result.changes.length}</b>개 수정 · 줄 {result.lineCountBefore} → <b>{result.lineCountAfter}</b>
        {' '}· 확인 필요 <b>{result.uncertain.length}</b>
        {result.emphasized.length ? <> · 강조 <b>{result.emphasized.length}</b></> : null}
        {result.silentMerged ? <> · 말소리 없는 줄 <b>{result.silentMerged}</b>개 묶음</> : null}
      </p>
      {result.changes.length ? (
        <>
          <h3 className="ai-sub">고친 단어</h3>
          <ul className="ai-diff">
            {result.changes.map(c => (
              <li key={c.id}>
                <button type="button" onClick={() => onJump(c.start)}>
                  <span className="ai-time">{clock(c.start)}</span> <del>{c.before}</del> → <ins>{c.after || '(앞 단어에 합침)'}</ins>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {result.uncertain.length ? (
        <>
          <h3 className="ai-sub">확인이 필요한 단어 (고치지 않음)</h3>
          <ul className="ai-diff">
            {result.uncertain.map(u => (
              <li key={u.id}>
                <button type="button" onClick={() => onJump(u.start)}>
                  <span className="ai-time">{clock(u.start)}</span> <b>{u.text}</b> — {u.reason}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {usage ? (
        <p className="ai-muted ai-small">사용량: 입력 {usage.input.toLocaleString()} · 출력 {usage.output.toLocaleString()} 토큰</p>
      ) : null}
    </div>
  )
}

function AiChoice({ settings, busy, onChoose }: {
  settings: AiSettings
  busy: boolean
  onChoose: (provider: AiProvider) => void
}): JSX.Element {
  return (
    <div className="ai-seg" role="radiogroup" aria-label="사용할 AI">
      {(['claude', 'openai'] as const).map(p => (
        <button key={p} type="button" role="radio" aria-checked={settings.provider === p} disabled={busy}
          className={`ai-seg-btn${settings.provider === p ? ' is-on' : ''}`} onClick={() => onChoose(p)}>
          {PROVIDER_LABEL[p]}
          <span className={settings.providers[p].configured ? 'ai-dot is-ok' : 'ai-dot'} />
        </button>
      ))}
    </div>
  )
}

const KEY_HELP: Record<AiProvider, string> = {
  claude: 'console.anthropic.com → Settings → API Keys 에서 만든 sk-ant- 로 시작하는 키',
  openai: 'platform.openai.com → API keys 에서 만든 sk- 로 시작하는 키'
}

function AiSettingsDialog({ settings, onChange, onClose }: {
  settings: AiSettings | null
  onChange: (s: AiSettings) => void
  onClose: () => void
}): JSX.Element {
  const [key, setKey] = useState('')
  const [glossary, setGlossary] = useState((settings?.glossary ?? []).join('\n'))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const run = async (fn: () => Promise<AiSettings>, okText: string) => {
    setBusy(true)
    setMsg(null)
    try {
      onChange(await fn())
      setMsg({ ok: true, text: okText })
      return true
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
      return false
    } finally {
      setBusy(false)
    }
  }

  if (!settings) {
    return (
      <div className="extract-modal-backdrop" role="presentation">
        <div className="extract-modal-card ai-card" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title">
          <h2 id="ai-settings-title" className="extract-modal-title">AI 연동</h2>
          <p className="ai-error">에이전트에서 AI 설정을 읽지 못했습니다. ItMatZip 에이전트를 최신 버전으로 업데이트해 주세요.</p>
          <div className="ai-row-end"><button type="button" className="ai-btn" onClick={onClose}>닫기</button></div>
        </div>
      </div>
    )
  }

  const provider = settings.provider
  const state = settings.providers[provider]
  const label = PROVIDER_LABEL[provider]

  return (
    <div className="extract-modal-backdrop" role="presentation">
      <div className="extract-modal-card ai-card" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title">
        <h2 id="ai-settings-title" className="extract-modal-title">AI 연동</h2>
        <div className="ai-body">
          <h3 className="ai-sub">사용할 AI</h3>
          <AiChoice settings={settings} busy={busy}
            onChoose={p => { setKey(''); void run(() => chooseAi(p), `${PROVIDER_LABEL[p]}로 교정합니다.`) }} />

          <h3 className="ai-sub">{label} 모델</h3>
          <select name="proofread-model" className="ai-input" value={state.model} disabled={busy}
            onChange={e => void run(() => chooseAi(provider, e.target.value), '모델을 바꿨습니다.')}>
            {state.models.map(m => <option key={m} value={m}>{MODEL_LABEL[m] ?? m}</option>)}
          </select>

          <h3 className="ai-sub">{label} API 키</h3>
          {state.configured ? (
            <p className="ai-ok">연결됨 · …{state.keyHint}</p>
          ) : (
            <p className="ai-muted">
              {KEY_HELP[provider]}를 넣어 주세요. 키는 이 PC의 에이전트에만 암호화해 저장되고, 사이트 서버로는 보내지 않습니다.
            </p>
          )}
          <div className="ai-key-row">
            <input name="proofread-api-key" type="password" className="ai-input" autoComplete="off"
              placeholder={state.configured ? '새 키로 바꾸기' : provider === 'claude' ? 'sk-ant-…' : 'sk-…'}
              value={key} spellCheck={false} onChange={e => setKey(e.target.value)} />
            <button type="button" className="ai-btn ai-btn--primary" disabled={busy || !key.trim()}
              onClick={async () => { if (await run(() => saveAiKey(provider, key), '키를 확인하고 저장했습니다.')) setKey('') }}>
              {busy ? '확인 중…' : '연결 확인 후 저장'}
            </button>
          </div>
          {state.configured ? (
            <button type="button" className="ai-link" disabled={busy}
              onClick={() => void run(() => deleteAiKey(provider), '키를 지웠습니다.')}>{label} 키 삭제</button>
          ) : null}

          <h3 className="ai-sub">용어 사전 (두 AI 공통)</h3>
          <p className="ai-muted ai-small">채널명·제품명·사람 이름처럼 자주 틀리는 말을 한 줄에 하나씩 적어 두면, AI가 이 표기대로 고칩니다.</p>
          <textarea name="proofread-glossary" className="ai-input ai-glossary" rows={5} value={glossary} spellCheck={false}
            placeholder={'예)\nJPEG XL\n이지캡처\nItMatZip'} onChange={e => setGlossary(e.target.value)} />
          <div className="ai-row-end">
            <button type="button" className="ai-btn" disabled={busy}
              onClick={() => void run(() => saveGlossary(glossary.split('\n')), '용어 사전을 저장했습니다.')}>용어 사전 저장</button>
          </div>
          {msg ? <p className={msg.ok ? 'ai-ok' : 'ai-error'} role="status">{msg.text}</p> : null}
        </div>
        <div className="ai-row-end">
          <button type="button" className="ai-btn" onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  )
}

/**
 * 프리뷰 자막 상자 한 줄에 들어가는 글자 수(한글 1, 영문·숫자 0.5). 자막 상자의 최대 폭(여백 제외)을
 * 지금 글꼴로 잰 한글 한 글자 폭으로 나눈다 — 글꼴·크기·상자 폭을 바꾸면 따라 바뀐다.
 */
export function previewLineCapacityUnits(el: HTMLElement | null): number | null {
  if (!el) return null
  const cs = getComputedStyle(el)
  const px = (v: string) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0)
  const max = px(cs.maxWidth)
  if (!(max > 0)) return null
  const inner = max - px(cs.paddingLeft) - px(cs.paddingRight) - px(cs.borderLeftWidth) - px(cs.borderRightWidth)
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return null
  ctx.font = cs.font
  // 띄어쓰기·쉼표·영문이 섞인 실제 자막 문장으로 잰다(한글만 재면 공백 폭을 작게 잡아 두 줄로 넘어갔다).
  const sample = '그 자리에 요즘 쇼츠, 트렌드에 딱 맞는 스타일 자막을 얹어 HitPaw로 1080p 영상을 완성합니다.'
  const spacing = px(cs.letterSpacing) || 0
  const pxPerUnit = (ctx.measureText(sample).width + spacing * [...sample].length) / lineWidthUnits(sample)
  if (!(pxPerUnit > 0) || !(inner > 0)) return null
  // 글꼴 렌더링 차이·굵은 외곽선 여유 5%
  return Math.max(4, Math.min(80, Math.floor((inner * 0.95) / pxPerUnit)))
}
