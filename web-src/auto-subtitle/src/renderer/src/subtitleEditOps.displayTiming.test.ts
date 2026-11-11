import { expect, it } from 'vitest'
import type { SubtitleLine } from '../../shared/subtitles'
import { mergeEmptySubtitleWithPrevious, mergeSubtitleIntoPrevious, splitSubtitleAtWordBoundary, splitSubtitleLine } from './subtitleEditOps'

const line: SubtitleLine = {
  start: 0, end: 3, text: '하나 둘 셋', displayStartAdj: -0.2, displayEndAdj: 0.4,
  words: [
    { id: 'a', start: 0, end: 1, word: '하나' },
    { id: 'b', start: 1, end: 2, word: '둘' },
    { id: 'c', start: 2, end: 3, word: '셋' }
  ]
}

it('split keeps the start adjustment on the first row and the end adjustment on the second', () => {
  for (const out of [splitSubtitleAtWordBoundary([line], 0, 2), splitSubtitleLine([line], 0, 3)]) {
    expect(out).toHaveLength(2)
    expect(out[0]!.displayStartAdj).toBe(-0.2)
    expect(out[0]!.displayEndAdj).toBeUndefined()
    expect(out[1]!.displayStartAdj).toBeUndefined()
    expect(out[1]!.displayEndAdj).toBe(0.4)
  }
})

it('merge keeps the first row start adjustment and the last row end adjustment', () => {
  const [first, second] = splitSubtitleAtWordBoundary([line], 0, 2)
  const merged = mergeSubtitleIntoPrevious([first!, second!], 1)!
  expect(merged).toHaveLength(1)
  expect(merged[0]!.displayStartAdj).toBe(-0.2)
  expect(merged[0]!.displayEndAdj).toBe(0.4)

  const empty: SubtitleLine = { start: 3, end: 4, text: '', displayEndAdj: -0.3 }
  const mergedEmpty = mergeEmptySubtitleWithPrevious([{ ...line, displayEndAdj: undefined }, empty], 1)!
  expect(mergedEmpty[0]!.displayStartAdj).toBe(-0.2)
  expect(mergedEmpty[0]!.displayEndAdj).toBe(-0.3)
})

it('leaves rows without adjustments exactly as before', () => {
  const plain: SubtitleLine = { ...line }
  delete plain.displayStartAdj
  delete plain.displayEndAdj
  const out = splitSubtitleAtWordBoundary([plain], 0, 1)
  expect('displayStartAdj' in out[0]!).toBe(false)
  expect('displayEndAdj' in out[1]!).toBe(false)
})
