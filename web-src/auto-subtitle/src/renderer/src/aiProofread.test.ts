import { describe, expect, it } from 'vitest'
import { displayTextFromSubtitleWords, subtitleLineEditDisplayText, type SubtitleLine, type SubtitleWord } from '../../shared/subtitles'
import { buildExportCueLines } from '../../shared/exportCuePipeline'
import { applyProofread, lineWidthUnits, proofreadSource } from './aiProofread'
import type { ProofreadAnswer } from './platform/aiAgent'

let seq = 0
function row(tokens: Array<[string, number, number]>): SubtitleLine {
  const words: SubtitleWord[] = tokens.map(([word, start, end]) => ({ word, start, end, id: `w${seq++}` }))
  return { start: words[0]!.start, end: words[words.length - 1]!.end, text: displayTextFromSubtitleWords(words), words }
}

const answer = (a: Partial<ProofreadAnswer>): ProofreadAnswer =>
  ({ corrections: [], lineStarts: [0], uncertain: [], emphasis: [], ...a })

const texts = (lines: SubtitleLine[]) => lines.map(l => subtitleLineEditDisplayText(l))
const times = (lines: SubtitleLine[]) => lines.flatMap(l => (l.words ?? []).map(w => [w.id, w.start, w.end]))

describe('proofreadSource', () => {
  it('numbers visible words in order and marks where each line starts', () => {
    const lines = [row([['크롬', 0, 1], ['1', 1, 1.2], ['.05', 1.2, 1.5]]), row([['버전', 2, 2.5]])]
    const src = proofreadSource(lines)
    expect(src.units.map(u => u.text)).toEqual(['크롬', '1', '.05', '버전'])
    expect(src.lineStarts).toEqual([0, 3])
  })

  it('uses the edited caption when it lines up with the words, and locks it when it does not', () => {
    const a = row([['제이펙', 0, 1], ['포맷', 1, 2]])
    const b = row([['오늘은', 3, 4], ['원본', 4, 5]])
    const lines = [{ ...a, text: 'JPEG 포맷', captionText: 'JPEG 포맷' }, { ...b, text: '오늘', captionText: '오늘' }]
    const src = proofreadSource(lines)
    expect(src.units.map(u => [u.text, u.locked])).toEqual([['JPEG', false], ['포맷', false], ['오늘은', true], ['원본', true]])
  })
})

describe('applyProofread', () => {
  it('fixes words in the caption only and keeps every chip and timing', () => {
    const lines = [row([['크롬', 0, 1], ['1', 1, 1.2], ['.05', 1.2, 1.5], ['버전부터', 1.5, 2]])]
    const src = proofreadSource(lines)
    const out = applyProofread(lines, src, answer({ corrections: [{ id: 1, text: '105' }, { id: 2, text: '' }] }))
    expect(texts(out.lines)).toEqual(['크롬 105 버전부터'])
    expect(out.lines[0]!.words!.map(w => w.word)).toEqual(['크롬', '1', '.05', '버전부터'])
    expect(times(out.lines)).toEqual(times(lines))
    expect(out.changes.map(c => [c.before, c.after])).toEqual([['1', '105'], ['.05', '']])
  })

  it('re-splits lines at the new starts and merges where a start was removed', () => {
    const lines = [
      row([['여러분', 0, .5], ['매일', .5, 1]]),
      row([['쓰는', 1, 1.5], ['JPG가', 1.5, 2], ['언제', 2.2, 2.6], ['나왔을까요?', 2.6, 3.2]])
    ]
    const src = proofreadSource(lines)
    const out = applyProofread(lines, src, answer({ lineStarts: [0, 4] }))
    expect(texts(out.lines)).toEqual(['여러분 매일 쓰는 JPG가', '언제 나왔을까요?'])
    expect(times(out.lines)).toEqual(times(lines))
    expect(out.lineCountBefore).toBe(2)
    expect(out.lineCountAfter).toBe(2)
  })

  it('keeps corrections on the right words after a split, so word highlight stays aligned', () => {
    const lines = [row([['제이펙', 0, 1], ['엑셀은', 1, 2], ['좋습니다', 2, 3], ['그래서', 4, 5], ['씁니다', 5, 6]])]
    const src = proofreadSource(lines)
    const out = applyProofread(lines, src, answer({
      lineStarts: [0, 3], corrections: [{ id: 0, text: 'JPEG' }, { id: 1, text: 'XL은' }]
    }))
    expect(texts(out.lines)).toEqual(['JPEG XL은 좋습니다', '그래서 씁니다'])
    const cues = buildExportCueLines(out.lines, { includeWords: true })
    expect(cues[0]!.words!.map(w => [w.text, w.start])).toEqual([['JPEG', 0], ['XL은', 1], ['좋습니다', 2]])
  })

  it('adds emphasis on the chosen words in the corrected caption', () => {
    const lines = [row([['압축률이', 0, 1], ['30%', 1, 2], ['좋아요', 2, 3]])]
    const out = applyProofread(lines, proofreadSource(lines), answer({ emphasis: [1] }), { emphasisColor: '#ff3366' })
    expect(out.lines[0]!.emphasis).toEqual([{ start: 5, end: 8, text: '30%', color: '#ff3366' }])
    expect(out.emphasized).toHaveLength(1)
  })

  it('does not rewrite a line whose caption was edited out of step with its words', () => {
    const a = row([['오늘은', 0, 1], ['원본', 1, 2]])
    const lines = [{ ...a, text: '오늘', captionText: '오늘' }]
    const out = applyProofread(lines, proofreadSource(lines), answer({ corrections: [{ id: 0, text: '오늘도' }] }))
    expect(texts(out.lines)).toEqual(['오늘'])
    expect(out.changes).toEqual([])
  })

  it('ignores ids out of range and reports uncertain words with their time', () => {
    const lines = [row([['백팔십오', 3, 4], ['버전', 4, 5]])]
    const out = applyProofread(lines, proofreadSource(lines), answer({
      corrections: [{ id: 9, text: 'x' }], lineStarts: [0, 7], uncertain: [{ id: 0, reason: '숫자 확인' }, { id: 5, reason: 'x' }]
    }))
    expect(texts(out.lines)).toEqual(['백팔십오 버전'])
    expect(out.uncertain).toEqual([{ id: lines[0]!.words![0]!.id, text: '백팔십오', reason: '숫자 확인', start: 3 }])
  })

  it('never joins speech across a silent stretch and always breaks after a long one', () => {
    const lines = [
      row([['안녕하세요', 0, 1], ['여러분', 1, 1.6]]),
      // 1.5초 쉼: AI 가 합치라고 해도 합치지 않는다
      row([['오늘은', 3.1, 3.6], ['JPEG', 3.6, 4]]),
      // 같은 줄 안이지만 8초 인트로 음악 뒤: AI 가 안 나눠도 나눈다
      row([['XL', 4, 4.3], ['이야기', 12.3, 13], ['입니다', 13, 13.5]])
    ]
    const src = proofreadSource(lines)
    expect(src.pauses).toEqual([{ id: 2, sec: 1.5 }, { id: 5, sec: 8 }])
    const out = applyProofread(lines, src, answer({ lineStarts: [0] }))
    expect(texts(out.lines)).toEqual(['안녕하세요 여러분', '오늘은 JPEG XL', '이야기 입니다'])
    expect(times(out.lines)).toEqual(times(lines))
  })

  it('does not merge lines past one screen line even if the answer asks for it', () => {
    const lines = [row([['가나다라', 0, 1], ['마바사', 1, 2]]), row([['아자차카', 2, 3], ['타파하', 3, 4]])]
    const src = proofreadSource(lines)
    expect(texts(applyProofread(lines, src, answer({ lineStarts: [0] }), { maxUnits: 10 }).lines)).toHaveLength(2)
    expect(texts(applyProofread(lines, src, answer({ lineStarts: [0] }), { maxUnits: 20 }).lines)).toEqual(['가나다라 마바사 아자차카 타파하'])
  })

  it('splits a line that is still wider than one screen line at a phrase ending', () => {
    const lines = [row([
      ['여러분', 0, .4], ['예전에', .4, .8], ['공들여', .8, 1.2], ['만들었던', 1.2, 1.7], ['영상을', 1.7, 2.1],
      ['다시', 2.1, 2.4], ['꺼내서', 2.4, 2.8], ['쓰고', 2.8, 3.1], ['싶은데', 3.1, 3.5],
      ['원본', 3.6, 3.9], ['프로젝트', 3.9, 4.4], ['파일이', 4.4, 4.8], ['어디로', 4.8, 5.2], ['갔는지', 5.2, 5.6],
      ['안', 5.6, 5.8], ['보여서', 5.8, 6.2], ['난감했던', 6.2, 6.7], ['적', 6.7, 6.9], ['있으신가요?', 6.9, 7.6]
    ])]
    const src = proofreadSource(lines)
    const out = applyProofread(lines, src, answer({ lineStarts: [0] }), { maxUnits: 40 })
    const shown = texts(out.lines)
    expect(shown.every(t => lineWidthUnits(t) <= 40)).toBe(true)
    expect(shown[0]!.endsWith('싶은데')).toBe(true)
    expect(times(out.lines)).toEqual(times(lines))
  })

  it('folds consecutive rows without speech into one row and keeps them apart from speech', () => {
    const silent = (start: number, end: number, word: string): SubtitleLine =>
      ({ start, end, text: '', words: [{ word, start, end, isSilence: true }] })
    const lines = [row([['안녕하세요', 0, 1]]), silent(1, 4, '--'), silent(4, 9, '오디오'), silent(9, 12, '--'),
      row([['오늘은', 12, 13]])]
    const out = applyProofread(lines, proofreadSource(lines), answer({ lineStarts: [0, 1] }))
    expect(out.lines).toHaveLength(3)
    expect(out.lines[1]!.words!.map(w => w.word)).toEqual(['--', '오디오', '--'])
    expect([out.lines[1]!.start, out.lines[1]!.end]).toEqual([1, 12])
    expect(out.silentMerged).toBe(2)
    expect(texts([out.lines[0]!, out.lines[2]!])).toEqual(['안녕하세요', '오늘은'])
  })

  it('splits sentences into readable phrase lines even when the AI keeps them whole', () => {
    const lines = [row([
      ['여러분', 0, .4], ['예전에', .4, .8], ['공들여', .8, 1.2], ['만들었던', 1.2, 1.7], ['영상을', 1.7, 2.1],
      ['다시', 2.1, 2.4], ['꺼내서', 2.4, 2.8], ['쓰고', 2.8, 3.1], ['싶은데', 3.1, 3.5],
      ['원본', 3.6, 3.9], ['프로젝트', 3.9, 4.4], ['파일이', 4.4, 4.8], ['어디로', 4.8, 5.2], ['갔는지', 5.2, 5.6],
      ['안', 5.6, 5.8], ['보여서', 5.8, 6.2], ['난감했던', 6.2, 6.7], ['적', 6.7, 6.9], ['있으신가요?', 6.9, 7.6]
    ])]
    const out = applyProofread(lines, proofreadSource(lines), answer({ lineStarts: [0] }), { maxUnits: 34, targetUnits: 18 })
    expect(texts(out.lines)).toEqual([
      '여러분 예전에 공들여 만들었던 영상을',
      '다시 꺼내서 쓰고 싶은데',
      '원본 프로젝트 파일이 어디로 갔는지',
      '안 보여서 난감했던 적 있으신가요?'
    ])
    expect(times(out.lines)).toEqual(times(lines))
  })

  it('leaves a short line alone and never leaves a one-word line just to hit the target', () => {
    const lines = [row([['그래서', 0, .5], ['오늘은', .5, 1], ['원본', 1, 1.4], ['프로젝트', 1.4, 2], ['파일이', 2, 2.5],
      ['없어도', 2.5, 3]])]
    const out = applyProofread(lines, proofreadSource(lines), answer({ lineStarts: [0] }), { maxUnits: 34, targetUnits: 18 })
    expect(texts(out.lines)).toEqual(['그래서 오늘은 원본 프로젝트 파일이 없어도'])
  })
})

describe('applyProofread fitLines (줄 맞춤)', () => {
  const sentence = (text: string): SubtitleLine => {
    let t = 0
    return row(text.split(' ').map(w => [w, t, (t += 0.4)] as [string, number, number]))
  }
  const run = (text: string, lineStarts: number[], maxUnits: number) => {
    const lines = [sentence(text)]
    return texts(applyProofread(lines, proofreadSource(lines), answer({ lineStarts }), { maxUnits, fitLines: true }).lines)
  }

  it('puts a sentence that fits on one screen line back on one line', () => {
    expect(run('저는 이 게임을 하면서 시간 가는 줄 몰랐습니다.', [0, 4], 40)).toEqual(['저는 이 게임을 하면서 시간 가는 줄 몰랐습니다.'])
  })

  it('never joins two sentences into one line', () => {
    const lines = [row([['안녕하세요.', 0, 1]]), row([['반갑습니다.', 1.2, 2]])]
    const out = applyProofread(lines, proofreadSource(lines), answer({ lineStarts: [0, 1] }), { maxUnits: 40, fitLines: true })
    expect(texts(out.lines)).toEqual(['안녕하세요.', '반갑습니다.'])
  })

  it('does not leave a short tail like "있으신가요?" alone: it takes the words before it along', () => {
    const text = '여러분 예전에 공들여 만들었던 영상을 다시 꺼내서 쓰고 싶은데 원본 프로젝트 파일이 어디로 갔는지 안 보여서 난감했던 적 있으신가요?'
    const n = text.split(' ').length
    const out = run(text, [0, 8, n - 1], 30)
    expect(out.every(line => lineWidthUnits(line) <= 30)).toBe(true)
    expect(out.every(line => lineWidthUnits(line) >= 10)).toBe(true)
    expect(out.at(-1)).toContain('있으신가요?')
    expect(out.at(-1)!.split(' ').length).toBeGreaterThan(2)
  })

  it('does not split "쓸 | 수 있는" or "하시는 | 분들도"', () => {
    const a = run('그래서 오늘은 윈도우에서 직접 설치해서 쓸 수 있는 방법을 처음부터 끝까지 천천히 알려드리겠습니다.', [0, 6], 30)
    expect(a.every(line => !line.endsWith('쓸') && !line.startsWith('수 '))).toBe(true)
    const b = run('전투 시스템은 기존 시리즈보다 훨씬 빨라졌고 콤보가 자유롭게 이어지기 때문에 처음 하시는 분들도 금방 적응하실 수 있습니다.', [0, 5, 9, 13], 30)
    expect(b.every(line => !line.endsWith('하시는') && !line.startsWith('분들도') && !line.startsWith('때문에'))).toBe(true)
  })
})

describe('applyProofread fitLines keeps the line structure of the answer before fitting', () => {
  it('rebuilds the lines the answer asks for even when the pieces together are wider than a screen line', () => {
    // 5-word source rows; the answer wants two natural lines, each narrower than the limit but 3 rows long
    const rows = [
      row([['그래서', 0, .4], ['오늘은', .4, .8], ['윈도우에서', .8, 1.2], ['직접', 1.2, 1.6], ['설치해서', 1.6, 2]]),
      row([['쓸', 2, 2.4], ['수', 2.4, 2.8], ['있는', 2.8, 3.2], ['자막', 3.2, 3.6], ['도구를', 3.6, 4]]),
      row([['처음부터', 4, 4.4], ['끝까지', 4.4, 4.8], ['천천히', 4.8, 5.2], ['알려드리겠습니다.', 5.2, 5.6]]),
    ]
    const out = applyProofread(rows, proofreadSource(rows), answer({ lineStarts: [0, 10] }), { maxUnits: 36, fitLines: true })
    expect(texts(out.lines)).toEqual(['그래서 오늘은 윈도우에서 직접 설치해서 쓸 수 있는 자막 도구를', '처음부터 끝까지 천천히 알려드리겠습니다.'])
  })
})
