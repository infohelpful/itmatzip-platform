import { TIMING_PCM_CHANNELS, TIMING_PCM_RATE } from './wordTimingWaveform'

let sharedContext: AudioContext | null = null
function audioContext(): AudioContext {
  sharedContext ??= new AudioContext()
  return sharedContext
}

/**
 * Plays one chip once from the already loaded PCM (Web Audio), independent of the video player, so
 * playback stops exactly on the chip's end boundary.
 */
export class ChipLoopPlayer {
  private source: AudioBufferSourceNode | null = null
  private startedAt = 0
  private from = 0
  private rangeStart = 0
  private duration = 0

  get playing(): boolean {
    return this.source !== null
  }

  /** Play [at, rangeStart + pcm length) once; `onEnd` runs when it reaches the end (not on stop()). */
  play(pcm: Int16Array, rangeStart: number, at: number, onEnd?: () => void): void {
    this.stop()
    const frames = Math.floor(pcm.length / TIMING_PCM_CHANNELS)
    if (frames < 2) return
    const ctx = audioContext()
    const buffer = ctx.createBuffer(TIMING_PCM_CHANNELS, frames, TIMING_PCM_RATE)
    for (let c = 0; c < TIMING_PCM_CHANNELS; c++) {
      const data = buffer.getChannelData(c)
      for (let f = 0; f < frames; f++) data[f] = pcm[f * TIMING_PCM_CHANNELS + c]! / 32768
    }
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.loop = false
    source.connect(ctx.destination)
    source.onended = () => {
      if (this.source !== source) return
      this.source = null
      source.disconnect()
      onEnd?.()
    }
    this.duration = frames / TIMING_PCM_RATE
    this.rangeStart = rangeStart
    this.from = Math.max(0, Math.min(this.duration - 1 / TIMING_PCM_RATE, at - rangeStart))
    void ctx.resume()
    source.start(0, this.from)
    this.startedAt = ctx.currentTime
    this.source = source
  }

  /** Current source time, or null when stopped. */
  position(): number | null {
    if (!this.source || !sharedContext) return null
    const elapsed = Math.max(0, sharedContext.currentTime - this.startedAt)
    return this.rangeStart + Math.min(this.duration, this.from + elapsed)
  }

  stop(): void {
    const source = this.source
    this.source = null
    if (!source) return
    try {
      source.stop()
    } catch {
      // already stopped
    }
    source.disconnect()
  }
}
