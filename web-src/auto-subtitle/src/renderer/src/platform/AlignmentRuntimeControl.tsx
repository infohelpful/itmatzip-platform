/**
 * Web-only top-bar control: installs the WhisperX precise-alignment runtime and model on first use.
 * The desktop app ships with it; on the web it is a separate ~2.6GB download, so it is offered
 * instead of being part of the required engine. Reuses the GPU-runtime dialog styles.
 */
import { useCallback, useEffect, useState } from 'react'
import { getAlignmentStatus, installAlignment, onAlignmentMissing, type AlignmentStatus } from './webApi'

type Dialog =
  | { kind: 'none' }
  | { kind: 'offer' }
  | { kind: 'gpu' }
  | { kind: 'install'; pct: number; stage: string }
  | { kind: 'done' }
  | { kind: 'fail'; message: string }

export function AlignmentRuntimeControl({ disabled }: { disabled: boolean }) {
  const [status, setStatus] = useState<AlignmentStatus | null>(null)
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })

  const refresh = useCallback(() => {
    getAlignmentStatus().then(setStatus, () => setStatus(null))
  }, [])
  // CPU용 정렬이 깔린 NVIDIA PC: 한 번 GPU용으로 바꾸자고 묻는다(세션당 한 번).
  useEffect(() => {
    if (!status?.gpuUpgrade) return
    try {
      if (window.sessionStorage.getItem('autosub.alignGpuOffered') === '1') return
      window.sessionStorage.setItem('autosub.alignGpuOffered', '1')
    } catch { /* ignore */ }
    setDialog((d) => (d.kind === 'none' ? { kind: 'gpu' } : d))
  }, [status?.gpuUpgrade])
  useEffect(() => {
    refresh()
    return onAlignmentMissing(() => {
      refresh()
      setDialog((d) => (d.kind === 'none' ? { kind: 'offer' } : d))
    })
  }, [refresh])

  const install = useCallback(async () => {
    setDialog({ kind: 'install', pct: 0, stage: '시작…' })
    try {
      await installAlignment((pct, stage) => setDialog({ kind: 'install', pct, stage }))
      refresh()
      setDialog({ kind: 'done' })
    } catch (error) {
      setDialog({ kind: 'fail', message: error instanceof Error ? error.message : String(error) })
    }
  }, [refresh])

  const sizeGb = status ? (status.downloadHintMb / 1024).toFixed(1) : '2.5'
  const gpuGb = ((status?.gpuUpgradeHintMb ?? 3500) / 1000).toFixed(1)
  const close = () => setDialog({ kind: 'none' })

  return (
    <>
      {status && !status.ready ? (
        <button type="button" className="app-topbar-gpu-btn" disabled={disabled || dialog.kind === 'install'}
          onClick={() => setDialog({ kind: 'offer' })}
          title="단어 싱크를 음성에 정밀하게 맞추는 WhisperX 정렬 엔진을 설치합니다.">
          정밀 정렬 설치
        </button>
      ) : null}
      {status?.ready && status.gpuUpgrade ? (
        <button type="button" className="app-topbar-gpu-btn" disabled={disabled || dialog.kind === 'install'}
          onClick={() => setDialog({ kind: 'gpu' })}
          title="NVIDIA 그래픽카드로 정밀 정렬을 돌려 자막 추출 시간을 크게 줄입니다.">
          정렬 GPU 가속
        </button>
      ) : null}

      {dialog.kind === 'gpu' ? (
        <div className="post-engine-backdrop" role="presentation">
          <div className="post-engine-card" role="alertdialog" aria-modal="true" aria-labelledby="align-gpu-title">
            <h2 id="align-gpu-title" className="post-engine-title">정밀 정렬 GPU 가속</h2>
            <p className="post-engine-body">
              NVIDIA 그래픽카드가 있는데 정밀 정렬이 지금 <strong>CPU</strong>로 돌고 있습니다(11분 영상 기준 약 70초).
              GPU용 정렬 엔진(<strong>약 {gpuGb}GB</strong>, 한 번만)을 받으면 그래픽카드로 정렬해 훨씬 빨라집니다.
              지금 바꾸시겠습니까?
            </p>
            <div className="post-engine-actions">
              <button type="button" className="post-engine-secondary" onClick={close}>나중에</button>
              <button type="button" className="post-engine-primary" onClick={() => void install()}>GPU용으로 바꾸기</button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog.kind === 'offer' ? (
        <div className="post-engine-backdrop" role="presentation">
          <div className="post-engine-card" role="alertdialog" aria-modal="true" aria-labelledby="align-offer-title">
            <h2 id="align-offer-title" className="post-engine-title">정밀 정렬 설치</h2>
            <p className="post-engine-body">
              단어 싱크를 음성에 정밀하게 맞추려면 <strong>정렬 엔진과 한국어 정렬 모델(약 {sizeGb}GB)</strong>을
              한 번 내려받아야 합니다.{status?.gpuPresent ? ' NVIDIA 그래픽카드가 있어 GPU용으로 설치합니다.' : ''} 설치 전에는 빠른 추정 방식으로 싱크를 맞춥니다. 지금 설치하시겠습니까?
            </p>
            <div className="post-engine-actions">
              <button type="button" className="post-engine-secondary" onClick={close}>나중에</button>
              <button type="button" className="post-engine-primary" onClick={() => void install()}>설치</button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog.kind === 'install' ? (
        <div className="post-engine-backdrop" role="presentation">
          <div className="post-engine-card post-engine-card--wide" role="dialog" aria-modal="true"
            aria-labelledby="align-install-title" aria-busy="true">
            <h2 id="align-install-title" className="post-engine-title">정밀 정렬 설치 중</h2>
            <p className="post-engine-stage">{dialog.stage}</p>
            <div className="extract-progress-track" role="progressbar" aria-valuenow={Math.round(dialog.pct)}
              aria-valuemin={0} aria-valuemax={100}>
              <div className="extract-progress-fill" style={{ width: `${Math.min(100, dialog.pct)}%` }} />
            </div>
            <p className="extract-modal-pct">{Math.round(dialog.pct)}%</p>
          </div>
        </div>
      ) : null}

      {dialog.kind === 'done' || dialog.kind === 'fail' ? (
        <div className="post-engine-backdrop" role="presentation">
          <div className="post-engine-card" role="alertdialog" aria-modal="true" aria-labelledby="align-result-title">
            <h2 id="align-result-title" className="post-engine-title">
              {dialog.kind === 'done' ? '정밀 정렬 설치 완료' : '정밀 정렬 설치 실패'}
            </h2>
            <p className="post-engine-body">
              {dialog.kind === 'done'
                ? (status?.device === 'cuda'
                  ? '이제 정밀 정렬이 그래픽카드(GPU)로 동작합니다. 자막 추출과 「싱크 재정렬」이 빨라집니다.'
                  : '이제 자막 추출과 「싱크 재정렬」이 정밀 정렬로 동작합니다. 이미 추출한 자막은 「전체 자막 싱크 재정렬」로 다시 맞출 수 있습니다.')
                : dialog.message}
            </p>
            <button type="button" className="post-engine-primary" onClick={close}>확인</button>
          </div>
        </div>
      ) : null}
    </>
  )
}
