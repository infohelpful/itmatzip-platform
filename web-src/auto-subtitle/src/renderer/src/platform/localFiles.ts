/**
 * Open/save dialogs for text files (projects, subtitle exports, scripts) using the browser's
 * File System Access API, with download / <input type=file> fallbacks for other browsers.
 *
 * The browser never reveals real disk paths, so a saved or opened file is identified by a
 * pseudo path ("name" or "name (2)") that maps to its file handle for later in-place saves.
 */
type FileType = { description: string; accept: Record<string, string[]> }
type Picker = {
  showSaveFilePicker?: (opts: { suggestedName?: string; types?: FileType[] }) => Promise<FileSystemFileHandle>
  showOpenFilePicker?: (opts: { types?: FileType[]; multiple?: boolean }) => Promise<FileSystemFileHandle[]>
}

const handles = new Map<string, FileSystemFileHandle>()

function remember(handle: FileSystemFileHandle): string {
  for (const [key, existing] of handles) if (existing === handle) return key
  let key = handle.name
  for (let n = 2; handles.has(key); n += 1) key = `${handle.name} (${n})`
  handles.set(key, handle)
  return key
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

async function writeHandle(handle: FileSystemFileHandle, content: string | Blob): Promise<void> {
  const writable = await handle.createWritable()
  try {
    await writable.write(content)
  } finally {
    await writable.close()
  }
}

/** Save dialog; returns the pseudo path, or null when the user cancelled. */
export async function saveTextAs(content: string | Blob, suggestedName: string, type: FileType): Promise<string | null> {
  const picker = window as unknown as Picker
  if (picker.showSaveFilePicker) {
    try {
      const handle = await picker.showSaveFilePicker({ suggestedName, types: [type] })
      await writeHandle(handle, content)
      return remember(handle)
    } catch (e) {
      if (isAbort(e)) return null
      throw e
    }
  }
  const blob = content instanceof Blob ? content : new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: suggestedName })
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  return suggestedName
}

/** 저장 창 없이 브라우저 기본 다운로드(보통 「다운로드」 폴더)로 받는다. */
export function downloadTextFile(content: string, fileName: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName })
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/** Overwrite a file previously opened or saved in this session. */
export async function saveTextInPlace(pseudoPath: string, content: string): Promise<boolean> {
  const handle = handles.get(pseudoPath)
  if (!handle) return false
  await writeHandle(handle, content)
  return true
}

/** Open dialog; returns null when cancelled. */
export async function openFile(type: FileType): Promise<{ path: string; file: File } | null> {
  const picker = window as unknown as Picker
  if (picker.showOpenFilePicker) {
    try {
      const [handle] = await picker.showOpenFilePicker({ types: [type], multiple: false })
      return { path: remember(handle), file: await handle.getFile() }
    } catch (e) {
      if (isAbort(e)) return null
      throw e
    }
  }
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), {
      type: 'file', accept: Object.values(type.accept).flat().join(',')
    })
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      resolve(file ? { path: file.name, file } : null)
    })
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}
