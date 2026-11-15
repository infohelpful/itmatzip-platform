import { useEffect, useRef, type ReactNode } from 'react'
import { EditorToolIcon } from './EditorToolIcon'

type SplitOptions = { atLinebreak: boolean; atPunctuation: boolean; atSlash: boolean }
type Props = {
  children?: ReactNode
  canAlign: boolean
  canRead: boolean
  canImport: boolean
  realigning: boolean
  split: SplitOptions
  onSplit: (value: SplitOptions) => void
  onAlign: () => void
  onAlignAll: () => void
  onCancel: () => void
  onReading: () => void
  onImport: () => void
}

export function SubtitleActionsToolbar(props: Props) {
  const menuRef = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) menuRef.current.open = false
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [])

  return <div className="editor-subtitle-tools" role="group" aria-label="자막 싱크 및 대본 도구">
    {/* 현재 줄·전체 싱크 재정렬, 발음 입력 버튼은 화면에서 뺐다(기능 코드는 App 에 남아 있다). 진행 중 정렬을 멈추는 버튼만 유지한다. */}
    {props.realigning && <div className="editor-tool-group">
      <button type="button" onClick={props.onCancel}>
        <EditorToolIcon name="cancel" /><span>정렬 취소</span>
      </button>
    </div>}
    <div className="editor-tool-group" role="group" aria-label="대본·자막 가져오기">
      <button type="button" disabled={!props.canImport} onClick={props.onImport}
        title="SRT/VTT는 큐 시간을 그대로 가져옵니다. 대본(.txt)은 먼저 추출한 자막의 단어 시간에 맞춥니다.">
        <EditorToolIcon name="import" /><span>대본/SRT 가져오기</span>
      </button>
      <details className="editor-split-menu" ref={menuRef}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open = false }}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.currentTarget.open = false
            event.currentTarget.querySelector('summary')?.focus()
          }
        }}>
        <summary><EditorToolIcon name="split" /><span>대본 분할 기준 <EditorToolIcon name="chevron" /></span></summary>
        <div className="editor-split-options" role="group" aria-label="대본 분할 기준 옵션">
          <p>대본을 나눌 위치</p>
          {([['atLinebreak', '줄바꿈'], ['atPunctuation', '문장부호'], ['atSlash', '슬래시(/)']] as const).map(([key, label]) =>
            <label key={key}><input name={`split-${key}`} type="checkbox" checked={props.split[key]}
              onChange={event => props.onSplit({ ...props.split, [key]: event.target.checked })} />{label}</label>)}
        </div>
      </details>
    </div>
    {props.children}
  </div>
}
