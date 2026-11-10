/**
 * 자막 목록에 표시하는 "AI가 고친 단어 / 확인이 필요한 단어" 정보.
 * API 교정(AiProofread)과 AI 자막 채팅(SubtitleMcpChat)이 같은 표시를 쓰도록 한 곳에 둔다.
 * 칩은 단어 시작 시각(start)으로 찾는다 — 단어 id 는 줄 순서 기반이라 줄을 나누면 바뀐다.
 */
import { useSyncExternalStore } from 'react'
import type { ProofreadChange, ProofreadFlag } from './aiProofread'

export type AiMarks = { changes: readonly ProofreadChange[]; uncertain: readonly ProofreadFlag[] }

let current: AiMarks | null = null
const listeners = new Set<() => void>()

export function setAiMarks(next: AiMarks | null): void {
  current = next
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useAiMarks(): AiMarks | null {
  return useSyncExternalStore(subscribe, () => current, () => null)
}
