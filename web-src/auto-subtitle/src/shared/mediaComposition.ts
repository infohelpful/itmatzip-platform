import { clipPlanFromCuts, mapSourceIntervalToProgram, type ProgramClip } from './clipPlan'
import type { CutRange } from './ipc'
import type { SubtitleLine } from './subtitles'

/** Editable media references use original source coordinates, never rippled program times. */
export type MediaAnchor = {
  sourceTime: number
  wordId?: string
  edge?: 'start' | 'end'
}
export type MediaFit = 'contain' | 'cover'
export type MediaAsset = {
  id: string
  kind: 'image' | 'video'
  path: string
  name: string
  /** Video duration is metadata; the agent probes again before encoding. */
  duration?: number
}
export type MediaInsertion = {
  id: string
  assetId: string
  at: MediaAnchor
  duration: number
  sourceStart: number
  fit: MediaFit
  muted: boolean
  /** Caption shown over the inserted clip (preview and export); original captions never show there. */
  caption?: string
}
export type ImageOverlay = {
  id: string
  assetId: string
  start: MediaAnchor
  end: MediaAnchor
  fit: MediaFit
}
export type MediaEdits = {
  version: 1
  assets: MediaAsset[]
  insertions: MediaInsertion[]
  /** Array order is stacking order: last is on top, below captions and watermark. */
  overlays: ImageOverlay[]
}

type ClipBase = { id: string; programStart: number; duration: number }
export type CompositionClip = ClipBase & (
  | { kind: 'source'; sourceStart: number; sourceEnd: number }
  | { kind: 'image'; assetId: string; fit: MediaFit; caption?: string }
  | { kind: 'video'; assetId: string; sourceStart: number; sourceEnd: number; fit: MediaFit; muted: boolean; caption?: string }
)
export type CompositionOverlay = {
  id: string; assetId: string; start: number; end: number; fit: MediaFit
}
/** Resolved plan consumed by preview and export. Do not use this as editable project state. */
export type MediaComposition = {
  version: 1
  assets: MediaAsset[]
  clips: CompositionClip[]
  overlays: CompositionOverlay[]
  duration: number
}

const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const nonnegative = (x: unknown): x is number => finite(x) && x >= 0
const name = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0
const fit = (x: unknown): x is MediaFit => x === 'contain' || x === 'cover'
function anchor(x: unknown): x is MediaAnchor {
  return record(x) && nonnegative(x.sourceTime) &&
    (x.wordId === undefined ? x.edge === undefined : name(x.wordId) && (x.edge === 'start' || x.edge === 'end'))
}

/** Reject a damaged project as a whole; silently dropping media would change the user's edit. */
export function parseMediaEdits(raw: unknown): MediaEdits {
  if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.assets) ||
      !Array.isArray(raw.insertions) || !Array.isArray(raw.overlays) ||
      [raw.assets, raw.insertions, raw.overlays].some(items => items.length > 10000)) throw new Error('미디어 편집 데이터가 올바르지 않습니다.')
  const ids = new Set<string>()
  const unique = (id: unknown): id is string => {
    if (!name(id) || ids.has(id)) return false
    ids.add(id)
    return true
  }
  const assets: MediaAsset[] = raw.assets.map(a => {
    if (!record(a) || !unique(a.id) || !name(a.path) || !name(a.name) ||
        (a.kind !== 'image' && a.kind !== 'video') ||
        (a.kind === 'video' && (!finite(a.duration) || a.duration <= 0))) throw new Error('미디어 파일 정보가 올바르지 않습니다.')
    return { id: a.id, kind: a.kind, path: a.path, name: a.name,
      ...(a.kind === 'video' ? { duration: a.duration as number } : {}) }
  })
  const byId = new Map(assets.map(a => [a.id, a]))
  const insertions: MediaInsertion[] = raw.insertions.map(c => {
    if (!record(c) || !unique(c.id) || !name(c.assetId) || !anchor(c.at) ||
        !finite(c.duration) || c.duration <= 0 || !nonnegative(c.sourceStart) ||
        !fit(c.fit) || typeof c.muted !== 'boolean' ||
        (c.caption !== undefined && (typeof c.caption !== 'string' || c.caption.length > 2000))) throw new Error('삽입 클립 정보가 올바르지 않습니다.')
    const asset = byId.get(c.assetId)
    if (!asset || (asset.kind === 'video' && c.sourceStart + c.duration > asset.duration! + 1e-6) ||
        (asset.kind === 'image' && c.sourceStart !== 0)) throw new Error('삽입 클립의 원본 구간이 올바르지 않습니다.')
    return { id: c.id, assetId: c.assetId, at: { ...c.at }, duration: c.duration,
      sourceStart: c.sourceStart, fit: c.fit, muted: c.muted,
      ...(typeof c.caption === 'string' && c.caption.trim() ? { caption: c.caption } : {}) }
  })
  const overlays: ImageOverlay[] = raw.overlays.map(o => {
    if (!record(o) || !unique(o.id) || !name(o.assetId) || byId.get(o.assetId)?.kind !== 'image' ||
        !anchor(o.start) || !anchor(o.end) || !fit(o.fit)) throw new Error('이미지 적용 범위가 올바르지 않습니다.')
    return { id: o.id, assetId: o.assetId, start: { ...o.start }, end: { ...o.end }, fit: o.fit }
  })
  return { version: 1, assets, insertions, overlays }
}

/** Word timing edits follow the word ID; removed IDs fall back to the last stored source boundary. */
export function resolveMediaAnchor(a: MediaAnchor, subtitles: readonly SubtitleLine[], sourceDuration: number): number {
  const words = subtitles.flatMap(l => l.words ?? [])
  const word = a.wordId ? words.find(w => w.id === a.wordId) : undefined
  // splitWordAt replaces an ID with <id>~1 / <id>~2 (possibly with a numeric collision suffix).
  // Follow the outside edge of its descendants, including further splits, after timing edits.
  const prefix = `${a.wordId}~`
  const children = !word && a.wordId ? words.filter(w => w.id?.startsWith(prefix) &&
    /^[12](?:\.\d+)?(?:~[12](?:\.\d+)?)*$/.test(w.id.slice(prefix.length))) : []
  const time = word && a.edge ? word[a.edge] : children.length && a.edge
    ? (a.edge === 'start' ? Math.min(...children.map(w => w.start)) : Math.max(...children.map(w => w.end)))
    : a.sourceTime
  return Math.max(0, Math.min(sourceDuration, time))
}

export function compositionSourceClips(plan: MediaComposition): ProgramClip[] {
  return plan.clips.flatMap(c => c.kind === 'source' ? [{ occurrenceId: c.id,
    sourceStart: c.sourceStart, sourceEnd: c.sourceEnd, programStart: c.programStart }] : [])
}

/**
 * The original part before an inserted clip ends this much before the insertion point. Word ends come
 * from speech recognition and often fall a frame after a cut in the original, so the frame that holds
 * the point can already be the next scene; ending one frame early (any rate from 23.976 fps up) keeps
 * that frame out of both preview and export. The original still resumes at the insertion point.
 */
export const INSERT_FRAME_GUARD_SEC = 0.045

/** Inserts survive source-word deletion, and inserts at the same boundary retain array order.
 * Overlays follow only original source portions, so they cannot cover an inserted clip.
 */
export function buildMediaComposition(sourceDuration: number, cuts: readonly CutRange[],
  subtitles: readonly SubtitleLine[], edits: MediaEdits, options: { frameGuardSec?: number } = {}): MediaComposition {
  const guard = Math.max(0, options.frameGuardSec ?? 0)
  const clean = parseMediaEdits(edits)
  const kept = clipPlanFromCuts(sourceDuration, cuts)
  const assets = new Map(clean.assets.map(a => [a.id, a]))
  const insertions = clean.insertions.map((c, order) => ({ ...c, order,
    time: resolveMediaAnchor(c.at, subtitles, sourceDuration) })).sort((a, b) => a.time - b.time || a.order - b.order)
  const clips: CompositionClip[] = []
  let programStart = 0
  let sourceCursor = 0
  const appendSource = (end: number) => {
    for (const c of kept) {
      const s = Math.max(c.sourceStart, sourceCursor), e = Math.min(c.sourceEnd, end)
      if (e <= s) continue
      clips.push({ id: `source:${clips.length}`, kind: 'source', sourceStart: s, sourceEnd: e,
        programStart, duration: e - s })
      programStart += e - s
    }
    sourceCursor = end
  }
  for (const c of insertions) {
    // The guard is dropped from the original (not played later); the original resumes at the point.
    appendSource(Math.max(sourceCursor, c.time - guard))
    sourceCursor = Math.max(sourceCursor, c.time)
    const a = assets.get(c.assetId)!
    const base = { id: `insert:${c.id}`, assetId: a.id, programStart, duration: c.duration, fit: c.fit,
      ...(c.caption?.trim() ? { caption: c.caption.trim() } : {}) }
    clips.push(a.kind === 'image' ? { ...base, kind: 'image' } : { ...base, kind: 'video',
      sourceStart: c.sourceStart, sourceEnd: c.sourceStart + c.duration, muted: c.muted })
    programStart += c.duration
  }
  appendSource(sourceDuration)
  if (!clips.length) throw new Error('내보낼 영상 구간이 없습니다.')
  const plan: MediaComposition = { version: 1, assets: clean.assets, clips, overlays: [], duration: programStart }
  const sourceClips = compositionSourceClips(plan)
  plan.overlays = clean.overlays.flatMap(o => {
    const start = resolveMediaAnchor(o.start, subtitles, sourceDuration)
    const end = resolveMediaAnchor(o.end, subtitles, sourceDuration)
    if (end <= start) return []
    return mapSourceIntervalToProgram(start, end, sourceClips).map((p, i) => ({
      id: `overlay:${o.id}:${i}`, assetId: o.assetId, start: p.start, end: p.end, fit: o.fit
    }))
  })
  return plan
}

export type CompositionPosition = {
  clip: CompositionClip
  localTime: number
  /** null means the original media MUST be paused, including its separate WebAudio clock. */
  originalSourceTime: number | null
  assetTime: number | null
}

export function compositionPositionAt(plan: MediaComposition, programTime: number): CompositionPosition {
  if (!Number.isFinite(programTime) || !plan.clips.length) throw new Error('재생 위치가 올바르지 않습니다.')
  const t = Math.max(0, Math.min(plan.duration, programTime))
  const clip = plan.clips.find(c => t >= c.programStart && t < c.programStart + c.duration) ?? plan.clips[plan.clips.length - 1]
  const localTime = Math.max(0, Math.min(clip.duration, t - clip.programStart))
  return { clip, localTime,
    originalSourceTime: clip.kind === 'source' ? clip.sourceStart + localTime : null,
    assetTime: clip.kind === 'video' ? clip.sourceStart + localTime : null }
}

/** A source boundary has two program positions when there is an insertion at that boundary. */
export function sourceBoundaryToProgram(plan: MediaComposition, sourceTime: number, side: 'before' | 'after' = 'after'): number {
  if (!Number.isFinite(sourceTime)) throw new Error('원본 위치가 올바르지 않습니다.')
  let before = 0, after = plan.duration
  for (const c of plan.clips) {
    if (c.kind !== 'source') continue
    if (sourceTime > c.sourceStart && sourceTime < c.sourceEnd) return c.programStart + sourceTime - c.sourceStart
    if (c.sourceEnd <= sourceTime) before = c.programStart + c.duration
    if (c.sourceStart >= sourceTime) { after = c.programStart; break }
  }
  return side === 'before' ? before : after
}

export const EMPTY_MEDIA_EDITS: MediaEdits = { version: 1, assets: [], insertions: [], overlays: [] }

/** Files no clip or overlay refers to any more are dropped (replacing or deleting leaves none behind). */
export function pruneMediaAssets(edits: MediaEdits): MediaEdits {
  const used = new Set([...edits.insertions.map(c => c.assetId), ...edits.overlays.map(o => o.assetId)])
  return edits.assets.every(a => used.has(a.id)) ? edits : { ...edits, assets: edits.assets.filter(a => used.has(a.id)) }
}

/**
 * Inserted clips that play back to back between two original portions. The original stops at
 * `stopSource` (end of the previous original portion; 0 before any) and resumes at `resumeSource`
 * (start of the next original portion; null when nothing follows).
 */
export type InsertionGroup = {
  programStart: number
  duration: number
  clips: Array<Extract<CompositionClip, { kind: 'image' | 'video' }>>
  stopSource: number
  resumeSource: number | null
}

export function insertionGroups(plan: MediaComposition): InsertionGroup[] {
  const groups: InsertionGroup[] = []
  let lastSourceEnd = 0
  let open: InsertionGroup | null = null
  for (const c of plan.clips) {
    if (c.kind === 'source') {
      if (open) open.resumeSource = c.sourceStart
      open = null
      lastSourceEnd = c.sourceEnd
      continue
    }
    if (!open) {
      open = { programStart: c.programStart, duration: 0, clips: [], stopSource: lastSourceEnd, resumeSource: null }
      groups.push(open)
    }
    open.clips.push(c)
    open.duration += c.duration
  }
  return groups
}

/** Image overlays in original time for preview (stacking order kept; never shown during an inserted clip). */
export function overlaySourceRanges(edits: MediaEdits, subtitles: readonly SubtitleLine[], sourceDuration: number):
  Array<{ id: string; assetId: string; start: number; end: number; fit: MediaFit }> {
  return edits.overlays.flatMap(o => {
    const start = resolveMediaAnchor(o.start, subtitles, sourceDuration)
    const end = resolveMediaAnchor(o.end, subtitles, sourceDuration)
    return end > start ? [{ id: o.id, assetId: o.assetId, start, end, fit: o.fit }] : []
  })
}

/** Captions written on inserted clips, in finished-video time (they fill exactly their clip). */
export function insertCaptionCues(plan: MediaComposition): Array<{ start: number; end: number; text: string }> {
  return plan.clips.flatMap(c => c.kind !== 'source' && c.caption
    ? [{ start: c.programStart, end: c.programStart + c.duration, text: c.caption }] : [])
}
