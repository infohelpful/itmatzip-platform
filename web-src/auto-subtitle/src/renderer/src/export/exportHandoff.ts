/**
 * 편집 화면 → 내보내기 페이지(같은 창 이동) 작업 전달.
 *
 * 내보내기 요청을 IndexedDB 에 넣고 `export.html?job=…` 으로 이동하면 그 페이지가 꺼내 쓴다.
 * 자막·단어 데이터가 길어 sessionStorage(약 5MB)를 넘을 수 있어 IndexedDB 를 쓴다.
 * 결과(저장 경로)도 같은 레코드에 남겨, 내보내기 페이지를 새로고침해도 같은 작업을 다시 돌리지 않는다.
 */
import type { ExportRequest } from '../../../shared/ipc'

export type ExportHandoffResult =
  | { ok: true; outputPath: string; savedByBrowser: boolean }
  | { ok: false; canceled: true }

export type ExportHandoffJob = {
  id: string
  createdAt: number
  /** 화면 표시용 — 원본 영상 파일 이름 */
  videoName: string
  request: ExportRequest
  result?: ExportHandoffResult
  /** 편집 화면 상태(.autosub 프로젝트 JSON 등) — 같은 창에서 편집 화면으로 돌아오면 이걸로 되살린다 */
  editorSnapshot?: EditorSnapshot
}

export type EditorSnapshot = {
  /** buildAutosubProjectJson() 결과 — 영상 경로·자막·단어·컷·자막 디자인 */
  projectJson: string
  /** 저장해 둔 .autosub 경로(있으면 「저장」이 같은 파일에 덮어쓰도록) */
  projectFilePath: string | null
  exportFormat: ExportRequest['format']
}

/** 이 탭에서 되살릴 작업 id — sessionStorage 는 같은 탭의 페이지 이동·새로고침에도 남는다 */
const RESTORE_KEY = 'autosub.restoreEditorJob'

export function markEditorRestore(jobId: string): void {
  try { window.sessionStorage.setItem(RESTORE_KEY, jobId) } catch { /* 막힌 저장소 — 무시 */ }
}

export function pendingEditorRestore(): string | null {
  try { return window.sessionStorage.getItem(RESTORE_KEY) } catch { return null }
}

export function clearEditorRestore(): void {
  try { window.sessionStorage.removeItem(RESTORE_KEY) } catch { /* 무시 */ }
}

export async function loadEditorSnapshot(jobId: string): Promise<EditorSnapshot | null> {
  const job = await loadExportJob(jobId)
  return job?.editorSnapshot ?? null
}

const DB_NAME = 'autosub-export-handoff'
const STORE = 'jobs'
/** 하루 지난 작업은 열 때 정리한다 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('브라우저 저장소를 열 수 없습니다.'))
  })
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb()
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const req = run(tx.objectStore(STORE))
      let value: T | undefined
      if (req) req.onsuccess = () => { value = req.result }
      tx.oncomplete = () => resolve(value)
      tx.onerror = () => reject(tx.error ?? new Error('브라우저 저장소에 쓰지 못했습니다.'))
      tx.onabort = () => reject(tx.error ?? new Error('브라우저 저장소 작업이 취소되었습니다.'))
    })
  } finally {
    db.close()
  }
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export async function saveExportJob(request: ExportRequest, videoName: string, editorSnapshot?: EditorSnapshot): Promise<string> {
  const job: ExportHandoffJob = { id: newId(), createdAt: Date.now(), videoName, request, ...(editorSnapshot ? { editorSnapshot } : {}) }
  await withStore('readwrite', (store) => store.put(job))
  void pruneOldJobs()
  return job.id
}

export async function loadExportJob(id: string): Promise<ExportHandoffJob | null> {
  const job = await withStore<ExportHandoffJob>('readonly', (store) => store.get(id))
  return job ?? null
}

export async function saveExportResult(id: string, result: ExportHandoffResult): Promise<void> {
  const job = await loadExportJob(id)
  if (!job) return
  await withStore('readwrite', (store) => store.put({ ...job, result }))
}

export async function pruneOldJobs(now = Date.now()): Promise<void> {
  try {
    const all = await withStore<ExportHandoffJob[]>('readonly', (store) => store.getAll() as IDBRequest<ExportHandoffJob[]>)
    const stale = (all ?? []).filter((job) => now - job.createdAt > MAX_AGE_MS)
    if (stale.length === 0) return
    await withStore('readwrite', (store) => { for (const job of stale) store.delete(job.id) })
  } catch {
    /* 정리 실패는 무시 */
  }
}
