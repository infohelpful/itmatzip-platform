/**
 * 웹 내보내기 페이지(`export.html?job=…`) — 편집 화면이 새 탭으로 연다.
 *
 * 실제 작업(자막 이미지 그리기 → 영상 합성·인코딩, 또는 SRT/대본 저장)을 이 페이지에서 진행하고,
 * 끝나면 사용자 「다운로드」 폴더에 저장한다. 편집 탭은 그대로 남아 있으므로 작업이 사라지지 않는다.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { ExportFormat, ExportProgressPayload } from '../../../shared/ipc'
import { loadExportJob, saveExportResult, type ExportHandoffJob } from './exportHandoff'
import './exportPage.css'

const FORMAT_INFO: Partial<Record<ExportFormat, { running: string; done: string; kind: string }>> = {
  video: { running: '자막 입힌 영상을 만들고 있습니다', done: '자막 입힌 영상을 저장했습니다', kind: '자막 입힌 영상 (MP4)' },
  srt: { running: 'SRT 자막 파일을 저장하고 있습니다', done: 'SRT 자막 파일을 저장했습니다', kind: '자막 파일 (.srt)' },
  txt: { running: '대본 파일을 저장하고 있습니다', done: '대본 파일을 저장했습니다', kind: '대본 (.txt)' },
  vtt: { running: 'WebVTT 자막을 저장하고 있습니다', done: 'WebVTT 자막을 저장했습니다', kind: '자막 파일 (.vtt)' },
  ass: { running: 'ASS 자막을 저장하고 있습니다', done: 'ASS 자막을 저장했습니다', kind: '자막 파일 (.ass)' },
  mp3: { running: 'MP3 오디오를 만들고 있습니다', done: 'MP3 오디오를 저장했습니다', kind: '오디오 (.mp3)' },
  wav: { running: 'WAV 오디오를 만들고 있습니다', done: 'WAV 오디오를 저장했습니다', kind: '오디오 (.wav)' }
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'running' }
  | { kind: 'done'; outputPath: string; savedByBrowser: boolean }
  | { kind: 'canceled' }
  | { kind: 'error'; message: string }

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error:\s*/, '') || '알 수 없는 오류가 발생했습니다.'
}

/** 편집 탭으로 돌아간다(이 탭은 편집 화면이 열었으므로 닫을 수 있다). 열 수 없으면 편집 화면으로 이동. */
function backToEditor(): void {
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.focus()
      window.close()
      return
    }
  } catch {
    /* 다른 출처 등 — 아래로 */
  }
  window.location.href = './'
}

export default function ExportPage(): ReactElement {
  const jobId = new URLSearchParams(window.location.search).get('job') ?? ''
  const [job, setJob] = useState<ExportHandoffJob | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [progress, setProgress] = useState<ExportProgressPayload>({ percent: 0 })
  const [folderNotice, setFolderNotice] = useState('')
  const started = useRef(false)

  const run = useCallback(async (target: ExportHandoffJob) => {
    setPhase({ kind: 'running' })
    setProgress({ percent: 1, label: '내보내기를 준비하고 있습니다…' })
    setFolderNotice('')
    try {
      const res = await window.api.exportByFormat({ ...target.request, saveTo: 'downloads' })
      if (res.canceled) {
        await saveExportResult(target.id, { ok: false, canceled: true }).catch(() => {})
        setPhase({ kind: 'canceled' })
        return
      }
      const savedByBrowser = res.savedByBrowser === true
      await saveExportResult(target.id, { ok: true, outputPath: res.outputPath, savedByBrowser }).catch(() => {})
      setProgress({ percent: 100 })
      setPhase({ kind: 'done', outputPath: res.outputPath, savedByBrowser })
    } catch (error) {
      setPhase({ kind: 'error', message: errorMessage(error) })
    }
  }, [])

  useEffect(() => window.api.onExportProgress((payload) => {
    setProgress((prev) => ({ ...prev, ...payload, percent: Math.max(prev.percent, Number(payload.percent) || 0) }))
  }), [])

  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      const loaded = jobId ? await loadExportJob(jobId).catch(() => null) : null
      if (!loaded) { setPhase({ kind: 'missing' }); return }
      setJob(loaded)
      // 새로고침: 이미 끝난 작업은 다시 돌리지 않고 결과만 보여 준다.
      if (loaded.result?.ok) {
        setProgress({ percent: 100 })
        setPhase({ kind: 'done', outputPath: loaded.result.outputPath, savedByBrowser: loaded.result.savedByBrowser })
        return
      }
      await run(loaded)
    })()
  }, [jobId, run])

  // 영상을 만드는 동안 탭을 닫으면 작업이 멈출 수 있다.
  useEffect(() => {
    if (phase.kind !== 'running') return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [phase.kind])

  useEffect(() => {
    const info = job ? FORMAT_INFO[job.request.format] : undefined
    const title = phase.kind === 'done' ? '저장 완료' : phase.kind === 'error' ? '내보내기 실패' : '내보내는 중'
    document.title = `${title}${info ? ` · ${info.kind}` : ''} - Auto Subtitle | ItMatZip`
  }, [job, phase.kind])

  const info = job ? FORMAT_INFO[job.request.format] : undefined
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent)))

  const openFolder = async (path: string) => {
    const res = await window.api.showExportResultInFolder(path)
    setFolderNotice(res.ok ? '' : res.reason)
  }

  return <section className="axp-card" aria-live="polite">
    <div className="axp-head">
      <span className={`axp-badge axp-badge--${phase.kind}`} aria-hidden="true">
        {phase.kind === 'done' ? '✓' : phase.kind === 'error' || phase.kind === 'missing' ? '!' : phase.kind === 'canceled' ? '–' : ''}
      </span>
      <div className="axp-head-text">
        <h1 className="axp-title">
          {phase.kind === 'loading' && '내보내기를 준비하고 있습니다'}
          {phase.kind === 'missing' && '내보낼 작업을 찾을 수 없습니다'}
          {phase.kind === 'running' && (info?.running ?? '내보내고 있습니다')}
          {phase.kind === 'done' && (info?.done ?? '저장했습니다')}
          {phase.kind === 'canceled' && '저장할 폴더를 고르지 않아 취소했습니다'}
          {phase.kind === 'error' && '내보내기에 실패했습니다'}
        </h1>
        {job && <p className="axp-sub">
          <span className="axp-file" title={job.videoName}>{job.videoName}</span>
          {info && <><span className="axp-dot" aria-hidden="true">·</span><span>{info.kind}</span></>}
        </p>}
      </div>
    </div>

    {(phase.kind === 'running' || phase.kind === 'loading') && <>
      <div className="axp-progress" role="progressbar" aria-label="내보내기 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="axp-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="axp-progress-meta">
        <span>{progress.label || '작업 중…'}</span>
        <span className="axp-percent">{percent}%</span>
      </div>
      {progress.encoderName && <p className="axp-note">인코더: {progress.encoderName}</p>}
      <p className="axp-note">작업이 끝날 때까지 이 탭을 닫지 마세요. 편집하던 화면은 원래 탭에 그대로 남아 있습니다.</p>
    </>}

    {phase.kind === 'done' && <>
      <div className="axp-result">
        <span className="axp-result-label">{phase.savedByBrowser ? '브라우저 「다운로드」 폴더' : '저장 위치'}</span>
        <code className="axp-result-path" title={phase.outputPath}>{phase.savedByBrowser ? fileNameOf(phase.outputPath) : phase.outputPath}</code>
      </div>
      {phase.savedByBrowser && <p className="axp-note">브라우저 다운로드 목록(Ctrl+J)에서 바로 열 수 있습니다.</p>}
      {folderNotice && <p className="axp-note axp-note--warn">{folderNotice}</p>}
      <div className="axp-actions">
        {!phase.savedByBrowser && <button type="button" className="axp-btn axp-btn--primary" onClick={() => void openFolder(phase.outputPath)}>폴더 열기</button>}
        <button type="button" className={`axp-btn${phase.savedByBrowser ? ' axp-btn--primary' : ''}`} onClick={backToEditor}>편집 화면으로 돌아가기</button>
      </div>
    </>}

    {(phase.kind === 'error' || phase.kind === 'canceled') && <>
      {phase.kind === 'error' && <p className="axp-error">{phase.message}</p>}
      <div className="axp-actions">
        {job && <button type="button" className="axp-btn axp-btn--primary" onClick={() => void run(job)}>다시 시도</button>}
        <button type="button" className="axp-btn" onClick={backToEditor}>편집 화면으로 돌아가기</button>
      </div>
    </>}

    {phase.kind === 'missing' && <>
      <p className="axp-note">내보내기 정보가 만료되었거나 다른 브라우저에서 열었습니다. 편집 화면에서 「내보내기」를 다시 눌러 주세요.</p>
      <div className="axp-actions">
        <a className="axp-btn axp-btn--primary" href="./">편집 화면 열기</a>
      </div>
    </>}
  </section>
}
