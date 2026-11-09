/** Poll serially, with backoff after failures; never stack requests on a slow agent. */
export function startPolling(task: () => Promise<void>, intervalMs: number): () => void {
  let stopped = false
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = async () => {
    try { await task(); failures = 0 }
    catch { failures = Math.min(failures + 1, 5) }
    if (!stopped) timer = setTimeout(run, Math.min(60_000, intervalMs * 2 ** failures))
  }
  void run()
  return () => { stopped = true; clearTimeout(timer) }
}
