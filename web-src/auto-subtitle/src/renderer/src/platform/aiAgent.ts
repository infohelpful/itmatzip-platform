/**
 * AutoSubtitle AI proofreading — calls into the local agent, which holds the user's Claude API key
 * (DPAPI-encrypted, never returned to the page) and makes the Claude request itself.
 */
import { api } from './agentClient'

export type AiProvider = 'claude' | 'openai'
export type AiProviderState = { configured: boolean; keyHint: string | null; model: string; models: string[] }
export type AiSettings = {
  provider: AiProvider
  providers: Record<AiProvider, AiProviderState>
  /** 지금 고른 AI 의 키가 있는지 */
  configured: boolean
  glossary: string[]
}

export const PROVIDER_LABEL: Record<AiProvider, string> = { claude: 'Claude', openai: 'ChatGPT' }
/** 모델 표시 이름 — 첫 번째가 기본(저렴), 두 번째가 고품질 */
export const MODEL_LABEL: Record<string, string> = {
  'claude-haiku-5-5': 'Claude Haiku 5.5 — 저렴 (기본)',
  'claude-opus-5-5': 'Claude Opus 5.5 — 고품질 (약 40배 비쌈)',
  'gpt-6-luna': 'GPT-6 Luna — 저렴 (기본)',
  'gpt-6.1-sol': 'GPT-6.1 Sol — 고품질 (약 20배 비쌈)'
}

export type ProofreadAnswer = {
  corrections: { id: number; text: string }[]
  lineStarts: number[]
  uncertain: { id: number; reason: string }[]
  emphasis: number[]
}

export type ProofreadInput = {
  provider: AiProvider
  words: string[]
  lineStarts: number[]
  /** 말소리가 끊긴 곳 — 이 번호의 단어 앞에서 `sec` 초 쉼 */
  pauses: { id: number; sec: number }[]
  maxUnits: number
  emphasize: boolean
}

export type ProofreadUsage = { input: number; output: number; cacheRead: number }

export const getAiSettings = (): Promise<AiSettings> => api<AiSettings>('/ai/settings')
export const saveAiKey = (provider: AiProvider, apiKey: string): Promise<AiSettings> =>
  api<AiSettings>('/ai/key', { provider, apiKey }, 'PUT')
export const deleteAiKey = (provider: AiProvider): Promise<AiSettings> =>
  api<AiSettings>(`/ai/key?provider=${provider}`, undefined, 'DELETE')
export const chooseAi = (provider: AiProvider, model?: string): Promise<AiSettings> =>
  api<AiSettings>('/ai/provider', model ? { provider, model } : { provider }, 'PUT')
export const saveGlossary = (terms: string[]): Promise<AiSettings> => api<AiSettings>('/ai/glossary', { terms }, 'PUT')

/** Starts the job and polls until it ends. `onTick` gets elapsed seconds while Claude works. */
export async function runProofread(
  input: ProofreadInput,
  signal: AbortSignal,
  onTick: (elapsedSec: number) => void
): Promise<{ answer: ProofreadAnswer; usage: ProofreadUsage | null }> {
  const { jobId } = await api<{ jobId: string }>('/ai/proofread', input, 'POST')
  const cancel = () => { void api('/ai/proofread/cancel', { jobId }, 'POST').catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException('취소했습니다.', 'AbortError')
      const s = await api<{ state: string; elapsedSec?: number; error?: string; result?: ProofreadAnswer;
        usage?: ProofreadUsage }>(`/ai/proofread?jobId=${encodeURIComponent(jobId)}&wait=5`)
      if (s.state === 'running') { onTick(s.elapsedSec ?? 0); continue }
      if (s.state === 'done' && s.result) return { answer: s.result, usage: s.usage ?? null }
      throw new Error(s.error || 'AI 교정이 중단되었습니다.')
    }
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
