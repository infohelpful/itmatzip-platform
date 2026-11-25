import { it, expect } from 'vitest'
import { materializeProjectCuts } from './editableProjectTimeline'
import { editWordTiming } from './wordTimingEdit'
import { mergeWaveformPeaksStitchCutRanges } from './virtualTimeline'
import { subtitleLinesToSentenceTokenTimeline, sentenceTokenTimelineToSubtitleLines } from './sentenceTokenTimelineAdapter'
import type { SubtitleLine } from './subtitles'

it('loads duplicated legacy cuts once, allows restoring a cut edge, and preserves it after save/reopen',()=>{
  const lines:SubtitleLine[]=[{start:0,end:3,text:'앞 뒤',words:[
    {id:'a',start:0,end:1,word:'앞'},
    {id:'b',start:1,end:2,word:'삭제',isDeleted:true},
    {id:'c',start:2,end:3,word:'뒤'}
  ]}]
  const loaded=materializeProjectCuts(lines,[{start:1,end:2}],
    [{id:'old',mediaStartSec:1,mediaEndSec:2,text:'',isDeleted:true}])
  const changed=editWordTiming(loaded,{lineIndex:0,wordIndex:2},1.95,3,3)
  const timeline=JSON.parse(JSON.stringify(subtitleLinesToSentenceTokenTimeline(changed)))
  const reopened=materializeProjectCuts(sentenceTokenTimelineToSubtitleLines(timeline),[],[])
  expect(mergeWaveformPeaksStitchCutRanges([],reopened,[])).toEqual([{start:1,end:1.95}])
  expect(reopened[0].words![2].manualStartLocked).toBe(true)
})

it('materializes a legacy cut in a caption-free gap without reviving it',()=>{
  const lines=[{start:0,end:1,text:'앞',words:[{start:0,end:1,word:'앞'}]},
    {start:2,end:3,text:'뒤',words:[{start:2,end:3,word:'뒤'}]}]
  const loaded=materializeProjectCuts(lines,[{start:1.1,end:1.9}],[])
  expect(mergeWaveformPeaksStitchCutRanges([],loaded,[])).toEqual([{start:1.1,end:1.9}])
})
