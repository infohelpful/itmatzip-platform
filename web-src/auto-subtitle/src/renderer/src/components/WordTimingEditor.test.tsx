// @vitest-environment jsdom
import { afterEach, beforeAll, describe, it, expect, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WordTimingEditor, type WordTimingEditorProps } from './WordTimingEditor'
import { TIMING_CUT_GAP_PX, TIMING_PCM_RATE, TIMING_PX_PER_SEC } from './wordTimingWaveform'

beforeAll(() => {
  // jsdom has no canvas; the strip draws nothing but stays interactive.
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext']
})
afterEach(cleanup)

const PAD = 16
const words = [
  { id: 'a', start: 0, end: 1, word: '앞' },
  { id: 'b', start: 1, end: 2, word: '설치나' },
  { id: 'c', start: 2, end: 2.5, word: '뒤' }
]
function setup(extra: Partial<WordTimingEditorProps> = {}) {
  const props: WordTimingEditorProps = {
    lines: [{ start: 0, end: 2.5, text: '앞 설치나 뒤', words }], target: { lineIndex: 0, wordIndex: 1 }, duration: 3,
    onApply: vi.fn(), onSplit: vi.fn(), onUndo: vi.fn(), onDelete: vi.fn(), onPause: vi.fn(), onClose: vi.fn(), ...extra
  }
  const view = render(<WordTimingEditor {...props} />)
  return { props, view, user: userEvent.setup() }
}
/** Pointer x inside the track for source time `t` (the strip starts at the previous chip, 0 s). */
const xAt = (t: number) => PAD + t * TIMING_PX_PER_SEC

describe('word timing editor', () => {
  it('has no time fields or apply button: only play, split and undo under the strip', () => {
    setup()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: '시간 적용' })).toBeNull()
    expect(screen.queryByRole('button', { name: '이 단어 삭제' })).toBeNull()
    for (const name of ['재생', '구간 나누기', '구간 되돌리기']) {
      const button = screen.getByRole('button', { name })
      // Icon only: the name is a hover tooltip, not text in the button.
      expect(button.textContent).toBe('')
      expect(button.dataset.tip).toContain(name)
    }
  })
  it('places the icon buttons centred under the selected chip', () => {
    setup()
    const actions = document.querySelector<HTMLElement>('.word-timing-actions')!
    expect(actions.style.left).toBe(`${xAt(1.5)}px`)
  })
  it('shows only the chips connected to the selected chip, each labelled with its start time', () => {
    setup()
    const labels = [...document.querySelectorAll('.word-timing-box-label')].map(e => e.textContent)
    expect(labels).toEqual(['00:00.00', '00:01.00', '00:02.00'])
    expect(document.querySelector('.word-timing-length')?.textContent).toBe('1.00초')
  })
  it('applies a trim as soon as the trim line is released (keyboard: on key up)', async () => {
    const { props, user } = setup()
    const endTrim = screen.getByRole('slider', { name: '끝 트림' })
    endTrim.focus()
    await user.keyboard('{ArrowLeft}')
    expect(props.onApply).toHaveBeenCalledExactlyOnceWith(1, 1.999)
  })
  it('applies a dragged trim once on release, clamped so a merge stops at the neighbour edge', () => {
    const { props } = setup()
    const track = document.querySelector('.word-timing-track')!
    const handle = document.querySelector('[data-trim-edge="end"]')!
    fireEvent.pointerDown(handle, { button: 0, clientX: xAt(2), pointerId: 1 })
    fireEvent.pointerMove(track, { clientX: xAt(2.3), pointerId: 1 })
    fireEvent.pointerMove(track, { clientX: xAt(9), pointerId: 1 })
    // See-through while dragged so the waveform under the bar stays visible.
    expect(handle.classList.contains('word-timing-trim--dragging')).toBe(true)
    expect(props.onApply).not.toHaveBeenCalled()
    fireEvent.pointerUp(track, { pointerId: 1 })
    expect(props.onApply).toHaveBeenCalledExactlyOnceWith(1, 2.5)
    expect(handle.classList.contains('word-timing-trim--dragging')).toBe(false)
  })
  it('draws cut audio between chips as a narrow gap and closes it when the trim is dragged over the cut', () => {
    // 1 s of cut audio between 설치나 (ends 2 s) and 뒤 (starts 3 s).
    const gapWords = [words[0]!, words[1]!, { id: 'c', start: 3, end: 3.5, word: '뒤' }]
    const { props } = setup({ lines: [{ start: 0, end: 3.5, text: '앞 설치나 뒤', words: gapWords }] })
    const labelLeft = () => [...document.querySelectorAll<HTMLElement>('.word-timing-box-label')].map(e => parseFloat(e.style.left))
    expect(labelLeft()).toEqual([xAt(0) + 2, xAt(1) + 2, xAt(2) + TIMING_CUT_GAP_PX + 2])
    const track = document.querySelector('.word-timing-track')!
    const handle = document.querySelector<HTMLElement>('[data-trim-edge="end"]')!
    fireEvent.pointerDown(handle, { button: 0, clientX: xAt(2), pointerId: 1 })
    // Half way into the cut: the trim follows the pointer, the rest of the cut is still a narrow gap.
    fireEvent.pointerMove(track, { clientX: xAt(2.5), pointerId: 1 })
    expect(parseFloat(handle.style.left)).toBe(xAt(2.5))
    expect(labelLeft()[2]).toBe(xAt(2.5) + TIMING_CUT_GAP_PX + 2)
    // The boundary before the drag shows as a dashed line.
    expect(parseFloat(document.querySelector<HTMLElement>('.word-timing-original')!.style.left)).toBe(xAt(2))
    // Over the whole cut: the chips touch again.
    fireEvent.pointerMove(track, { clientX: xAt(3), pointerId: 1 })
    expect(labelLeft()[2]).toBe(xAt(3) + 2)
    fireEvent.pointerUp(track, { pointerId: 1 })
    expect(props.onApply).toHaveBeenCalledExactlyOnceWith(1, 3)
    expect(document.querySelector('.word-timing-original')).toBeNull()
  })
  it('closes when anything outside the editor and its chip is pressed', () => {
    const chip = document.createElement('button')
    chip.id = 'chip-under-test'
    document.body.append(chip)
    const { props } = setup({ chipElementId: 'chip-under-test' })
    fireEvent.pointerDown(chip)
    fireEvent.pointerDown(document.querySelector('.word-timing-track')!, { button: 0, clientX: xAt(1.2), pointerId: 1 })
    expect(props.onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.body)
    expect(props.onClose).toHaveBeenCalledExactlyOnceWith('outside')
    chip.remove()
  })
  it('moves the play line where the strip is clicked and splits the chip there', async () => {
    const { props, user } = setup()
    const split = screen.getByRole('button', { name: '구간 나누기' }) as HTMLButtonElement
    expect(split.disabled).toBe(true) // the play line starts on the chip's start
    const track = document.querySelector('.word-timing-track')!
    fireEvent.pointerDown(track, { button: 0, clientX: xAt(1.4), pointerId: 1 })
    fireEvent.pointerUp(track, { pointerId: 1 })
    expect(document.querySelector('.word-timing-playhead-bubble')?.textContent).toBe('00:01.40설|치나')
    expect(split.disabled).toBe(false)
    await user.click(split)
    expect(props.onSplit).toHaveBeenCalledExactlyOnceWith(1.4)
  })
  it('undoes the last edit, deletes with the Delete key and closes with Escape', async () => {
    const { props, user } = setup()
    await user.click(screen.getByRole('button', { name: '구간 되돌리기' }))
    expect(props.onUndo).toHaveBeenCalledOnce()
    await user.keyboard('{Delete}')
    expect(props.onDelete).toHaveBeenCalledOnce()
    await user.keyboard('{Escape}')
    expect(props.onClose).toHaveBeenCalledOnce()
    expect(props.onApply).not.toHaveBeenCalled()
  })
  it('plays the selected chip once from the start trim on Space, then parks the play line on the start trim', async () => {
    const sources: FakeSource[] = []
    class FakeSource {
      buffer: { length: number } | null = null
      loop = false
      offset = -1
      onended: (() => void) | null = null
      constructor() { sources.push(this) }
      connect() {}
      disconnect() {}
      start(_when: number, offset: number) { this.offset = offset }
      stop() {}
    }
    class FakeContext {
      currentTime = 0
      destination = {}
      resume() { return Promise.resolve() }
      createBuffer(_c: number, length: number) { return { length, getChannelData: () => new Float32Array(length) } }
      createBufferSource() { return new FakeSource() }
    }
    vi.stubGlobal('AudioContext', FakeContext)
    const loadPcm = vi.fn(async (_start: number, _end: number) => new Int16Array(TIMING_PCM_RATE * 2))
    const { props, user } = setup({ loadPcm })
    await act(async () => { await Promise.resolve() })
    expect(loadPcm.mock.calls.map(c => c[0])).toEqual([0, 1, 2])
    const bubbleTime = () => document.querySelector('.word-timing-playhead-bubble')?.firstChild?.textContent
    // The play line was moved inside the chip, but Space still starts on the start trim line.
    const track = document.querySelector('.word-timing-track')!
    fireEvent.pointerDown(track, { button: 0, clientX: xAt(1.6), pointerId: 1 })
    fireEvent.pointerUp(track, { pointerId: 1 })
    document.body.focus()
    await user.keyboard(' ')
    expect(props.onPause).toHaveBeenCalledOnce()
    expect(sources.map(s => ({ offset: s.offset, loop: s.loop, frames: s.buffer!.length })))
      .toEqual([{ offset: 0, loop: false, frames: TIMING_PCM_RATE }])
    expect(screen.getByRole('button', { name: '정지' })).toBeTruthy()
    // Reaching the end: no repeat, the play line goes back to the start trim.
    act(() => sources[0]!.onended?.())
    expect(screen.getByRole('button', { name: '재생' })).toBeTruthy()
    expect(bubbleTime()).toBe('00:01.00')
    expect(sources).toHaveLength(1)
    // Space plays it once more; Space again stops it.
    await user.keyboard(' ')
    expect(sources).toHaveLength(2)
    await user.keyboard(' ')
    expect(screen.getByRole('button', { name: '재생' })).toBeTruthy()
    vi.unstubAllGlobals()
  })
  it('moves the play line with the start trim line', () => {
    setup()
    const bubbleTime = () => document.querySelector('.word-timing-playhead-bubble')?.firstChild?.textContent
    const track = document.querySelector('.word-timing-track')!
    fireEvent.pointerDown(track, { button: 0, clientX: xAt(1.6), pointerId: 1 })
    fireEvent.pointerUp(track, { pointerId: 1 })
    expect(bubbleTime()).toBe('00:01.60')
    const handle = document.querySelector('[data-trim-edge="start"]')!
    fireEvent.pointerDown(handle, { button: 0, clientX: xAt(1), pointerId: 2 })
    fireEvent.pointerMove(track, { clientX: xAt(1.3), pointerId: 2 })
    expect(bubbleTime()).toBe('00:01.30')
    fireEvent.pointerMove(track, { clientX: xAt(.8), pointerId: 2 })
    expect(bubbleTime()).toBe('00:00.80')
  })
})
