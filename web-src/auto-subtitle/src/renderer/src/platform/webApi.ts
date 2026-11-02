/**
 * Web replacement for the Electron preload bridge (`window.api`).
 *
 * Each method mirrors one desktop IPC handler (src/main/index.ts). Engine work goes to the local
 * agent (`/api/tools/auto-subtitle/v2`, agent/routers/autosub.py); file dialogs for media use the
 * agent's native picker so the engine gets a real path; projects and subtitle files are opened and
 * saved by the browser. IPC push events (progress, transcription results) become polling here.
 */
import type {
  DepsStatus, ExportProgressPayload, ExportRequest, ExportResult, FfmpegCapabilities, GpuInstallProgressPayload, GpuRuntimeStatus,
  OpenVideoDialogResult, ProjectOpenResult, ProjectSaveAsResult, ProjectSaveResult, RealignRequest, RealignResult,
  ScriptOpenResult, SidecarApi, TranscribeDiagPayload, TranscribeErrorPayload, TranscribeMode,
  WaveformPeaksCachePathResult
} from '../../../shared/ipc'
import type { PreparedMediaResult } from '../../../shared/preparedMedia'
import type { MediaFingerprintResult } from '../../../shared/projectMedia'
import type { PcmRange, PcmReadResult } from '../../../shared/pcmAudio'
import { parseAutosubProjectFile } from '../../../shared/autosubProject'
import { decodeTextBuffer } from '../../../shared/scriptImport'
import { clipPlanFromCuts, mapSourceIntervalToProgram, validateClipPlan } from '../../../shared/clipPlan'
import { buildRenderSchedule } from '../../../shared/exportRenderSchedule'
import type { ExportSubtitleUpdatePayload } from '../../../shared/ipc'
import { SubtitleFrameRenderer } from './subtitleFrameRenderer'
import {
  AgentUnavailable, agentFetch, api, apiBinary, controller, mediaFileUrl, pathFromMediaUrl, readError, sleep, toolApiBase
} from './agentClient'
import { openFile, saveTextAs, saveTextInPlace } from './localFiles'
import {
  buildAssText, buildMappedSubtitles, buildSrtText, buildTxtText, buildWebVttText, normalizeCutRanges,
  normalizeMappedSubtitles
} from './subtitleTextExport'

export class WebApiNotReady extends Error {
  constructor(readonly method: string) {
    super(`웹판에서 아직 지원하지 않는 기능입니다: ${method}`)
    this.name = 'WebApiNotReady'
  }
}

/** Minimal event hub standing in for `ipcRenderer.on/removeListener`. */
function channel<T>() {
  const listeners = new Set<(value: T) => void>()
  return {
    on(cb: (value: T) => void) {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    emit(value: T) {
      for (const cb of [...listeners]) {
        try {
          cb(value)
        } catch (error) {
          console.error(error)
        }
      }
    }
  }
}

const UTF8_BOM = '﻿'
const SCRIPT_FILE_MAX_BYTES = 8 * 1024 * 1024
const PROJECT_TYPE = { description: 'AutoSubtitle 프로젝트', accept: { 'application/json': ['.autosub'] } }
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** Same rule as the desktop main process: only #rgb, #rrggbb or #rrggbbaa. */
const sanitizeHexColor = (value: unknown): string | undefined =>
  typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value) ? value : undefined
const baseName = (p: string) => (p.split(/[\\/]/).pop() || p).replace(/\.[^.]+$/, '')

export function createWebApi(): SidecarApi {
  const modelProgress = channel<number>()
  const modelReady = channel<void>()
  const gpuProgress = channel<GpuInstallProgressPayload>()
  const exportProgress = channel<ExportProgressPayload>()
  const txMode = channel<TranscribeMode>()
  const txDiag = channel<TranscribeDiagPayload>()
  const txProgress = channel<number>()
  const txComplete = channel<unknown>()
  const txError = channel<TranscribeErrorPayload>()
  let activeTranscription: string | null = null

  async function pollTranscription(jobId: string): Promise<void> {
    let since = 0
    while (activeTranscription === jobId) {
      let batch: { done: boolean; unknown?: boolean; events: Array<{ seq: number; type: string; payload: unknown }> }
      try {
        batch = await api(`/transcribe/events?jobId=${encodeURIComponent(jobId)}&since=${since}`)
      } catch (error) {
        if (activeTranscription === jobId) txError.emit({ message: errorText(error) })
        break
      }
      if (activeTranscription !== jobId) break
      for (const event of batch.events) {
        since = event.seq + 1
        if (event.type === 'modelReady') modelReady.emit()
        else if (event.type === 'mode') txMode.emit(event.payload as TranscribeMode)
        else if (event.type === 'diag') {
          const diag = event.payload as TranscribeDiagPayload
          if (diag.message.includes('alignment_runtime_missing')) notifyAlignmentMissing()
          txDiag.emit(diag)
        }
        else if (event.type === 'progress') txProgress.emit(Number(event.payload))
        else if (event.type === 'complete') txComplete.emit(event.payload)
        else if (event.type === 'error') txError.emit(event.payload as TranscribeErrorPayload)
      }
      if (batch.done) break
      await sleep(300)
    }
    if (activeTranscription === jobId) activeTranscription = null
  }

  async function registerMedia(path: string): Promise<string> {
    return (await api<{ path: string }>('/media/register', { path })).path
  }

  async function exportSubtitleFile(req: ExportRequest): Promise<ExportResult> {
    const format = req.format
    if (format !== 'srt' && format !== 'vtt' && format !== 'ass' && format !== 'txt') {
      throw new WebApiNotReady(`${format} 내보내기`)
    }
    // Same mapping as the desktop `export:by-format` handler.
    const cuts = normalizeCutRanges(Array.isArray(req.cutRanges) ? req.cutRanges : [])
    const plan = req.clipPlan ? validateClipPlan(req.clipPlan, Math.max(...req.clipPlan.map((c) => c.sourceEnd))) : null
    const mapped = plan
      ? req.subtitles.flatMap((cue) => mapSourceIntervalToProgram(cue.start, cue.end, plan)
        .map((t) => ({ ...t, text: cue.text }))).sort((a, b) => a.start - b.start)
      : normalizeMappedSubtitles(buildMappedSubtitles(req.subtitles, cuts))
    const text = format === 'srt' ? buildSrtText(mapped)
      : format === 'vtt' ? buildWebVttText(mapped, req.subtitleStyle)
        : format === 'ass' ? buildAssText(mapped, req.subtitleStyle)
          : buildTxtText(mapped)
    const labels = { srt: 'SubRip', vtt: 'WebVTT', ass: 'Advanced SubStation Alpha', txt: 'Text' }
    const name = `${req.inputPath ? baseName(req.inputPath) : 'AutoSubtitle_export'}.${format}`
    const saved = await saveTextAs(UTF8_BOM + text, name,
      { description: labels[format], accept: { 'text/plain': [`.${format}`] } })
    if (saved === null) return { canceled: true }
    exportProgress.emit({ percent: 100 })
    return { canceled: false, outputPath: saved, format }
  }

  type ExportJob = { state: string; percent: number; label: string; encoderName: string | null
    error: string | null; outputPath: string | null }

  async function pollExport(jobId: string, fallbackLabel: string): Promise<string> {
    for (;;) {
      const job = await api<ExportJob>(`/export/${encodeURIComponent(jobId)}`)
      exportProgress.emit({ percent: job.percent, label: job.label || fallbackLabel, encoderName: job.encoderName ?? undefined })
      if (job.state === 'done' && job.outputPath) return job.outputPath
      if (job.state === 'error') throw new Error(job.error || '내보내기에 실패했습니다.')
      await sleep(500)
    }
  }

  /** Video burn-in and MP3/WAV: the agent writes next to the media into a folder the user picks. */
  async function exportMediaFile(req: ExportRequest): Promise<ExportResult> {
    if (!Array.isArray(req.subtitles)) throw new Error('내보낼 자막 데이터가 없습니다.')
    const picked = await controller<{ path?: string; cancelled?: boolean }>('/api/agent/pick-local-folder')
    if (!picked.path) return { canceled: true }
    const format = req.format
    if (format === 'mp3' || format === 'wav') {
      if (req.clipPlan) throw new Error('순서 변경·반복 클립의 오디오 단독 내보내기는 아직 지원하지 않습니다.')
      const started = await api<{ jobId: string }>('/export/audio', {
        inputPath: req.inputPath, outDir: picked.path, format, cutRanges: Array.isArray(req.cutRanges) ? req.cutRanges : []
      })
      return { canceled: false, outputPath: await pollExport(started.jobId, '오디오 인코딩 중…'), format }
    }

    exportProgress.emit({ percent: 2, label: 'FFmpeg·인코더 확인 중…' })
    const job = await api<{ jobId: string; width: number; height: number; renderWidth: number; renderHeight: number
      duration: number; fps: number; encoderName: string }>('/export/video', { inputPath: req.inputPath, outDir: picked.path })
    const encoderName = job.encoderName
    try {
      // Same schedule and style defaults as the desktop `export:by-format` video branch.
      const cuts = Array.isArray(req.cutRanges) ? req.cutRanges : []
      const clips = validateClipPlan(req.clipPlan ?? clipPlanFromCuts(job.duration, cuts), job.duration)
      const highlightColor = sanitizeHexColor(req.subtitleStyle?.wordHighlightColor)
      const schedule = buildRenderSchedule({ cues: req.subtitles, clips, fps: job.fps, highlightWords: highlightColor !== undefined })
      const st = req.subtitleStyle
      const base: Omit<ExportSubtitleUpdatePayload, 'text' | 'words' | 'activeIndex'> = {
        width: job.renderWidth, height: job.renderHeight, layoutWidth: job.width, layoutHeight: job.height,
        fontFamily: st?.fontFamily ?? 'Malgun Gothic', fontSize: st?.fontSize ?? 26, textColor: st?.textColor ?? '#f4f6fb',
        fontWeight: st?.fontWeight ?? 700, bgColor: st?.bgColor ?? '#080a10', bgOpacity: st?.bgOpacity ?? 62,
        bgPaddingPct: st?.bgPaddingPct ?? 100, strokeColor: st?.strokeColor ?? '#000000', strokeWidth: st?.strokeWidth ?? 2,
        x: st?.x ?? 50, y: st?.y ?? 10, wordHighlightColor: highlightColor
      }
      const renderer = new SubtitleFrameRenderer(job.renderWidth, job.renderHeight)
      try {
        for (const [i, state] of schedule.entries()) {
          exportProgress.emit({ percent: 4 + Math.round((i / Math.max(1, schedule.length)) * 8),
            label: `자막 렌더 중 ${i + 1}/${schedule.length}…`, encoderName })
          const png = await renderer.render({ ...base, text: state.text, words: state.words, activeIndex: state.activeIndex })
          const res = await agentFetch(`${toolApiBase}/export/video/${encodeURIComponent(job.jobId)}/state/${i}`,
            { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png })
          if (!res.ok) throw new Error(await readError(res))
        }
      } finally {
        renderer.dispose()
      }
      await api(`/export/video/${encodeURIComponent(job.jobId)}/encode`, {
        schedule: schedule.map((s) => ({ startFrame: s.startFrame, endFrame: s.endFrame })), clips
      })
      return { canceled: false, outputPath: await pollExport(job.jobId, '자막 렌더·합성·인코딩 중…'), format }
    } catch (error) {
      await api(`/export/${encodeURIComponent(job.jobId)}/cancel`, {}).catch(() => {})
      throw error
    }
  }

  const api_: SidecarApi = {
    // -- media -----------------------------------------------------------------------
    prepareSourceMedia: async (path: string, requestId: string): Promise<PreparedMediaResult> => {
      try {
        let status = await api<{ state: string; result?: PreparedMediaResult }>('/media/prepare', { path, requestId })
        while (status.state === 'running') {
          status = await api(`/media/prepare?requestId=${encodeURIComponent(requestId)}&wait=5`)
        }
        return status.result ?? { ok: false, reason: '미디어 준비 상태를 알 수 없습니다.' }
      } catch (error) {
        return { ok: false, reason: errorText(error) }
      }
    },
    cancelMediaPreparation: async (requestId: string) => {
      await api('/media/prepare/cancel', { requestId }).catch(() => {})
    },
    readPreparedPcm: async (url: string, ranges: PcmRange[]): Promise<PcmReadResult> => {
      const path = pathFromMediaUrl(url)
      if (!path) return { ok: false, reason: '준비된 오디오 캐시만 읽을 수 있습니다.' }
      try {
        const res = await apiBinary('/media/pcm', { path, ranges })
        if (!res.ok) return { ok: false, reason: await readError(res) }
        const totalFrames = Number(res.headers.get('X-Pcm-Total-Frames'))
        return { ok: true, block: { sampleRate: 48000, channels: 2, totalFrames, pcm: await res.arrayBuffer() } }
      } catch (error) {
        return { ok: false, reason: errorText(error) }
      }
    },
    fingerprintMedia: async (path: string): Promise<MediaFingerprintResult> => {
      try {
        return await api<MediaFingerprintResult>('/media/fingerprint', { path })
      } catch (error) {
        return { ok: false, reason: errorText(error) }
      }
    },
    openVideoFileDialog: async (): Promise<OpenVideoDialogResult> => {
      const picked = await controller<{ video_path?: string; cancelled?: boolean }>('/api/agent/pick-local-subtitle-media')
      if (!picked.video_path) return { canceled: true, filePaths: [] }
      return { canceled: false, filePaths: [await registerMedia(picked.video_path)] }
    },
    // Browsers never expose a dropped file's disk path; the drop handler then asks for the dialog.
    getPathForFile: () => '',
    getMediaFileUrl: (absoluteFilePath: string) => mediaFileUrl(absoluteFilePath),
    readLocalMediaFileBuffer: async (absoluteFilePath: string) => {
      try {
        const res = await fetch(mediaFileUrl(absoluteFilePath), { cache: 'no-store' })
        if (!res.ok) return { ok: false as const, reason: await readError(res) }
        return { ok: true as const, arrayBuffer: await res.arrayBuffer() }
      } catch (error) {
        return { ok: false as const, reason: errorText(error) }
      }
    },
    readLocalPeaksJsonFile: async (absoluteFilePath: string) => {
      try {
        return await api<{ ok: true; json: unknown } | { ok: false; reason: string }>('/waveform/read', { path: absoluteFilePath })
      } catch (error) {
        return { ok: false as const, reason: errorText(error) }
      }
    },
    getWaveformPeaksCachePath: async (absoluteVideoPath: string): Promise<WaveformPeaksCachePathResult> => {
      try {
        return await api<WaveformPeaksCachePathResult>('/waveform/cache-path', { path: absoluteVideoPath })
      } catch (error) {
        return { ok: false, reason: errorText(error) }
      }
    },
    cancelWaveform: async (requestId: string) => {
      await api('/waveform/cancel', { requestId }).catch(() => {})
    },
    sidecarCall: (method: string, params?: Record<string, unknown>) => api('/sidecar', { method, params: params ?? {} }),

    // -- engine ----------------------------------------------------------------------
    getDepsStatus: () => api<DepsStatus>('/deps'),
    getFfmpegCapabilities: () => api<FfmpegCapabilities>('/ffmpeg'),
    prepareAllEngines: async () => {
      let state = await api<{ state: string; percent: number; error: string | null }>('/deps/prepare', {}, 'POST')
      while (state.state === 'running') {
        modelProgress.emit(Math.round(state.percent * 100) / 100)
        await sleep(500)
        state = await api('/deps/prepare')
      }
      if (state.state === 'error') throw new Error(state.error || '필수 엔진 준비에 실패했습니다.')
      modelProgress.emit(100)
      modelReady.emit()
      return { ok: true as const }
    },
    getGpuRuntimeStatus: () => api<GpuRuntimeStatus>('/gpu'),
    installGpuRuntime: async () => {
      type GpuState = { state: string; pct: number; stage: string; error: string | null
        result: { ok: true; source: 'local' | 'download' | 'existing'; dir: string } | null }
      let state = await api<GpuState>('/gpu/install', {}, 'POST')
      while (state.state === 'running') {
        gpuProgress.emit({ pct: state.pct, stage: state.stage })
        await sleep(500)
        state = await api('/gpu/install')
      }
      if (state.state !== 'done' || !state.result) throw new Error(state.error || 'GPU 런타임 설치에 실패했습니다.')
      gpuProgress.emit({ pct: 100, stage: '완료' })
      return state.result
    },
    onGpuInstallProgress: gpuProgress.on,
    onModelDownloadProgress: modelProgress.on,
    onModelReady: modelReady.on,

    // -- transcription ---------------------------------------------------------------
    sendVideoDropPath: (absolutePath: string, alignmentMode?: 'accurate' | 'fast') => {
      const jobId = crypto.randomUUID()
      activeTranscription = jobId
      void (async () => {
        try {
          const first = await api<{ done: boolean; events: Array<{ type: string; payload: unknown }> }>(
            '/transcribe', { path: absolutePath, alignmentMode, jobId })
          const failed = first.events.find((e) => e.type === 'error')
          if (failed) {
            activeTranscription = null
            txError.emit(failed.payload as TranscribeErrorPayload)
            return
          }
          await pollTranscription(jobId)
        } catch (error) {
          if (activeTranscription === jobId) {
            activeTranscription = null
            txError.emit({ message: errorText(error) })
          }
        }
      })()
    },
    cancelTranscription: async () => {
      activeTranscription = null
      await api('/transcribe/cancel', {}).catch(() => {})
    },
    onTranscribeMode: txMode.on,
    onTranscribeDiag: txDiag.on,
    onTranscribeProgress: txProgress.on,
    onTranscribeComplete: txComplete.on,
    onTranscribeError: txError.on,

    realignWords: async (request: RealignRequest): Promise<RealignResult> => {
      try {
        let status = await api<{ state: string; result?: RealignResult }>('/realign', request)
        while (status.state === 'running') {
          status = await api(`/realign?requestId=${encodeURIComponent(request.requestId)}&wait=5`)
        }
        const result = status.result ?? { ok: false, reason: '정렬 상태를 알 수 없습니다.' }
        if (!result.ok && result.reason === 'alignment_runtime_missing') {
          notifyAlignmentMissing()
          return { ok: false, reason: '정밀 정렬이 아직 설치되지 않았습니다. 위쪽의 「정밀 정렬 설치」를 먼저 실행해 주세요.' }
        }
        return result
      } catch (error) {
        return { ok: false, reason: errorText(error) }
      }
    },
    cancelRealignment: async (requestId: string) => {
      await api('/realign/cancel', { requestId }).catch(() => {})
    },

    // -- projects, scripts, exports --------------------------------------------------
    openProjectFile: async (): Promise<ProjectOpenResult> => {
      const picked = await openFile(PROJECT_TYPE)
      if (!picked) return { canceled: true }
      return { canceled: false, path: picked.path, content: await picked.file.text() }
    },
    openScriptFile: async (): Promise<ScriptOpenResult> => {
      const picked = await openFile({ description: '대본·자막', accept: { 'text/plain': ['.txt', '.srt', '.vtt'] } })
      if (!picked) return { canceled: true }
      if (picked.file.size > SCRIPT_FILE_MAX_BYTES) return { canceled: false, ok: false, reason: '파일이 너무 큽니다(최대 8MB).' }
      try {
        const { text, encoding } = decodeTextBuffer(new Uint8Array(await picked.file.arrayBuffer()))
        return { canceled: false, ok: true, path: picked.path, name: picked.file.name, text, encoding }
      } catch (error) {
        return { canceled: false, ok: false, reason: errorText(error) }
      }
    },
    saveProjectFile: async (path: string, content: string): Promise<ProjectSaveResult> => {
      try {
        const parsed = parseAutosubProjectFile(JSON.parse(content))
        if (!parsed.ok) return { ok: false, reason: parsed.reason }
        const saved = await saveTextInPlace(path, JSON.stringify(parsed.data, null, 2))
        return saved ? { ok: true } : { ok: false, reason: '이 파일에 다시 쓰려면 "다른 이름으로 저장"으로 위치를 한 번 골라 주세요.' }
      } catch (error) {
        return { ok: false, reason: errorText(error) }
      }
    },
    saveProjectFileAs: async (content: string, defaultPath?: string): Promise<ProjectSaveAsResult> => {
      const parsed = parseAutosubProjectFile(JSON.parse(content))
      if (!parsed.ok) throw new Error(parsed.reason)
      const suggested = defaultPath ? `${baseName(defaultPath)}.autosub` : 'New_AutoSubtitle.autosub'
      const saved = await saveTextAs(JSON.stringify(parsed.data, null, 2), suggested, PROJECT_TYPE)
      return saved === null ? { canceled: true } : { canceled: false, path: saved }
    },
    exportByFormat: (req: ExportRequest) =>
      req.format === 'video' || req.format === 'mp3' || req.format === 'wav' ? exportMediaFile(req) : exportSubtitleFile(req),
    exportVideoWithBurnedSubtitles: (req) => exportMediaFile({ ...req, format: 'video' }),
    onExportProgress: exportProgress.on,
    showExportResultInFolder: async (absoluteFilePath: string) => {
      try {
        return await api<{ ok: true } | { ok: false; reason: string }>('/export/show-in-folder', { path: absoluteFilePath })
      } catch (error) {
        return { ok: false as const, reason: errorText(error) }
      }
    },

    // -- misc ------------------------------------------------------------------------
    openExternal: async (url: string) => {
      if (!/^https?:\/\//.test(url)) return { ok: false as const, reason: 'invalid-url' }
      window.open(url, '_blank', 'noopener,noreferrer')
      return { ok: true as const }
    },
    notifySubtitleRenderReady: () => {},
    logWaveformDebug: async (scope: string, message: string, ...details: unknown[]) => {
      console.debug(`[waveform:${scope}]`, message, ...details)
      return { ok: true as const, path: '' }
    },
    logTimelineEdit: async (scope: string, message: string, ...details: unknown[]) => {
      console.debug(`[timeline:${scope}]`, message, ...details)
      return { ok: true as const, path: '' }
    }
  }
  return api_
}

export { AgentUnavailable }

// -- precise alignment runtime (web only; the desktop app ships it) ------------------------
export type AlignmentStatus = { installed: boolean; modelPresent: boolean; ready: boolean; downloadHintMb: number }
const alignmentMissingListeners = new Set<() => void>()

/** Lets the install button reappear when an alignment attempt finds the runtime missing. */
export function onAlignmentMissing(cb: () => void): () => void {
  alignmentMissingListeners.add(cb)
  return () => void alignmentMissingListeners.delete(cb)
}

function notifyAlignmentMissing(): void {
  for (const cb of [...alignmentMissingListeners]) cb()
}

export function getAlignmentStatus(): Promise<AlignmentStatus> {
  return api<AlignmentStatus>('/alignment')
}

export async function installAlignment(onProgress: (pct: number, stage: string) => void): Promise<void> {
  let state = await api<{ state: string; pct: number; stage: string; error: string | null }>('/alignment/install', {}, 'POST')
  while (state.state === 'running') {
    onProgress(state.pct, state.stage)
    await sleep(1000)
    state = await api('/alignment/install')
  }
  if (state.state !== 'done') throw new Error(state.error || '정밀 정렬 설치에 실패했습니다.')
  onProgress(100, '완료')
}
