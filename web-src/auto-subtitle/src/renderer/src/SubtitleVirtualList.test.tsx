// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { editSubtitleText } from '../../shared/editSubtitleText'
import { SubtitleVirtualList, type SubtitleVirtualListProps } from './SubtitleVirtualList'

beforeAll(() => {
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } })
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 800, height: 800, top: 0, left: 0, bottom: 800, right: 800,
    x: 0, y: 0, toJSON: () => ({})
  })
})

afterEach(cleanup)

const source = {
  start: 0, end: 2, text: '원래 자막',
  words: [{ start: 0, end: 1, word: '원래' }, { start: 1, end: 2, word: '자막' }]
}

function props(): SubtitleVirtualListProps {
  const noop = vi.fn()
  return {
    subtitles: [source], selectedRows: new Set(), onSelectRow: noop,
    activeSubtitleIndexRef: { current: null }, playheadSecRef: { current: 0 },
    isPlaying: false, mediaFileUrl: null,
    onSubtitleCardClick: noop, onCardNavigate: noop, onRequestPausePlayback: noop,
    onWordBlockClick: noop, onWaveformSeekAndPlay: noop,
    splitSubtitleAtWord: noop, backspaceWordAt: noop, deleteWordAt: noop,
    deleteWordRangeAt: noop, onUndo: noop, onRedo: noop,
    updateSubtitleAt: vi.fn(), splitSubtitleAt: noop, mergeEmptySubtitleAt: noop,
    formatTimecode: sec => String(sec), onTogglePlayback: noop
  }
}

describe('subtitle text draft', () => {
  it('does not restore an old caption when focus leaves for the waveform after an external correction', () => {
    const initial = props()
    const view = render(<SubtitleVirtualList {...initial} />)
    const input = screen.getByRole('textbox', { name: '자막 텍스트' }) as HTMLTextAreaElement
    fireEvent.focus(input)

    const corrected = editSubtitleText(source, '교정된 문구')
    view.rerender(<SubtitleVirtualList {...initial} subtitles={[corrected]} />)
    fireEvent.blur(input)

    expect(initial.updateSubtitleAt).not.toHaveBeenCalled()
    expect(input.value).toBe('교정된 문구')
  })

  it('commits a typed caption once before blur', () => {
    const initial = props()
    render(<SubtitleVirtualList {...initial} />)
    const input = screen.getByRole('textbox', { name: '자막 텍스트' }) as HTMLTextAreaElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '직접 수정' } })
    fireEvent.blur(input)
    expect(initial.updateSubtitleAt).toHaveBeenCalledOnce()
    expect(initial.updateSubtitleAt).toHaveBeenCalledWith(0, '직접 수정')
  })

  it('commits an unfinished IME composition when focus leaves', () => {
    const initial = props()
    render(<SubtitleVirtualList {...initial} />)
    const input = screen.getByRole('textbox', { name: '자막 텍스트' }) as HTMLTextAreaElement
    fireEvent.focus(input)
    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: '한글 조합 중' } })
    expect(initial.updateSubtitleAt).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(initial.updateSubtitleAt).toHaveBeenCalledOnce()
    expect(initial.updateSubtitleAt).toHaveBeenCalledWith(0, '한글 조합 중')
  })
})
