/**
 * Web replacement for the Electron preload bridge (`window.api`).
 *
 * The desktop renderer talks to Electron main + the Python sidecar through `window.api`.
 * On tools.itmatzip.com the same calls go to the local ItMatZip agent over HTTP instead.
 * Every method of `SidecarApi` is present so the renderer runs unchanged; calls that are not
 * wired to the agent yet reject with `WebApiNotReady` so the UI shows a clear error.
 */
import type { SidecarApi } from '../../../shared/ipc'

export class WebApiNotReady extends Error {
  constructor(readonly method: string) {
    super(`웹판에서 아직 연결되지 않은 기능입니다: ${method}`)
    this.name = 'WebApiNotReady'
  }
}

const notReady = (method: string) => (): Promise<never> => Promise.reject(new WebApiNotReady(method))
const noSubscription = () => () => {}

export function createWebApi(): SidecarApi {
  return {
    prepareSourceMedia: notReady('prepareSourceMedia'),
    cancelMediaPreparation: async () => {},
    readPreparedPcm: notReady('readPreparedPcm'),
    fingerprintMedia: notReady('fingerprintMedia'),
    realignWords: notReady('realignWords'),
    cancelRealignment: async () => {},
    openVideoFileDialog: notReady('openVideoFileDialog'),
    // Browsers never expose a dropped file's disk path; media is picked through the agent instead.
    getPathForFile: () => '',
    getMediaFileUrl: (absoluteFilePath: string) => {
      throw new WebApiNotReady(`getMediaFileUrl(${absoluteFilePath})`)
    },
    sidecarCall: (method: string) => Promise.reject(new WebApiNotReady(`sidecarCall:${method}`)),
    getDepsStatus: notReady('getDepsStatus'),
    getFfmpegCapabilities: notReady('getFfmpegCapabilities'),
    prepareAllEngines: notReady('prepareAllEngines'),
    getGpuRuntimeStatus: notReady('getGpuRuntimeStatus'),
    installGpuRuntime: notReady('installGpuRuntime'),
    onGpuInstallProgress: noSubscription,
    openExternal: async (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer')
      return { ok: true as const }
    },
    exportVideoWithBurnedSubtitles: notReady('exportVideoWithBurnedSubtitles'),
    exportByFormat: notReady('exportByFormat'),
    onExportProgress: noSubscription,
    showExportResultInFolder: notReady('showExportResultInFolder'),
    onModelDownloadProgress: noSubscription,
    onModelReady: noSubscription,
    sendVideoDropPath: (absolutePath: string) => {
      console.warn(new WebApiNotReady(`sendVideoDropPath(${absolutePath})`).message)
    },
    cancelTranscription: async () => {},
    cancelWaveform: async () => {},
    onTranscribeMode: noSubscription,
    onTranscribeDiag: noSubscription,
    onTranscribeProgress: noSubscription,
    onTranscribeComplete: noSubscription,
    onTranscribeError: noSubscription,
    notifySubtitleRenderReady: () => {},
    openProjectFile: notReady('openProjectFile'),
    openScriptFile: notReady('openScriptFile'),
    saveProjectFile: notReady('saveProjectFile'),
    saveProjectFileAs: notReady('saveProjectFileAs'),
    logWaveformDebug: async (scope: string, message: string, ...details: unknown[]) => {
      console.debug(`[waveform:${scope}]`, message, ...details)
      return { ok: true as const, path: '' }
    },
    logTimelineEdit: async (scope: string, message: string, ...details: unknown[]) => {
      console.debug(`[timeline:${scope}]`, message, ...details)
      return { ok: true as const, path: '' }
    },
    readLocalMediaFileBuffer: notReady('readLocalMediaFileBuffer'),
    readLocalPeaksJsonFile: notReady('readLocalPeaksJsonFile'),
    getWaveformPeaksCachePath: notReady('getWaveformPeaksCachePath')
  }
}
