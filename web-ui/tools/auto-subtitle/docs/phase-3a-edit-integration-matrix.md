# Phase 3A — 편집 통합 매트릭스 (Block SSOT)

Phase 0~2 완료 후 Phase 3 설계 SSOT. 구현은 **3B(Tier 1) → 3C(Tier 2) → 3D(Tier 3)** 순.

## 아키텍처 정책 (Hard-coded)

| 정책 | 규칙 |
|------|------|
| Relocate 폐기 | `reorderCuesWithRelocate` 사용 금지. `blocks[]` splice → `_rebuildVirtualIndex` cumsum |
| Hard delete skip | `Hub.hardDeletedMediaSkips[]` (preview-only). splice **전** `[sourceIn, sourceOut]` capture → `getPlaybackSkipRanges()` merge. **cutRanges / virtualTimelineDeleted push 금지** |
| Direct mutation | `deleteBlockAt` / `deleteBlocksAt` → `applyBlockChange` 직접. `applySubtitleChange` 브릿지 금지 |
| Reorder semantics | `listableCueIndices(cues)` → storage index splice. Insert: `reorderBlocksByListInsert(fromListPos, insertBeforeListPos)`. Position: `reorderBlocksByListPosition(fromListPos, toListPos)` |
| Word soft delete (Tier 2) | **Duration Shrink** — tombstone/`applyPendingVirtualMediaCuts` 제거. empty block → `deleteBlockAt` 승격 |
| Lifecycle | `reset` / `ingest*` → `hardDeletedMediaSkips = []` |

## 편집 액션별 블록 상태 변화 매트릭스

| 액션 | Tier | blocks 배열 조작 | duration / sourceIn·Out | Tombstone / Skip | _rebuildVirtualIndex |
|------|------|------------------|-------------------------|------------------|----------------------|
| `deleteSubtitleLineAt` | **1 (3B)** | `deleteBlockAt(i)` — splice 제거 | 변경 없음 (삭제됨) | `hardDeletedMediaSkips` append. tombstone/cut **금지** | Yes (structural) |
| `deleteSubtitleLinesAt` | **1 (3B)** | `deleteBlocksAt(indices↓)` | 동일 | 다중 skip merge | Yes |
| `reorderSubtitleLinesByListInsert` | **1 (3B)** | listPos→index, insert splice | **preserveIds** — duration/source 유지 | 없음 | Yes |
| `reorderSubtitleLinesByListPosition` | **1 (3B)** | listPos→toListPos splice | preserveIds | 없음 | Yes |
| `deleteWordAt` | **2 (3C)** | words soft-delete → duration shrink | source span 재계산 → duration | **Shrink: virtual tombstone 없음**. preview skip은 soft-delete word에서 derived. empty → hard delete | Yes |
| `deleteWordRangeAt` | **2 (3C)** | 동일 | 동일 | 동일 | Yes |
| `backspaceWordAt` | **2 (3C)** | word delete 또는 **block merge** (이전 줄) | merge 시 envelope 재계산 | Shrink; merge 시 skip 없음 | Yes |
| 파형 Trim | **2 (3C)** | 브릿지 `applySubtitleChange` | sourceIn/Out 변경 → duration sync | 없음 | Yes |
| `applyPendingVirtualMediaCuts` | **2 (3C)** | Tier 1 hard delete 후 **호출 금지** (중복). Tier 2 word path **제거됨** | — | Tier 2에서 제거 | — |
| `splitSubtitleAt` | **3 (3D)** | 1 block → 2 blocks | source/duration 분할 규칙 | 없음 | Yes |
| `mergeEmptySubtitleAt` | **3 (3D)** | 2 blocks → 1 | envelope merge | 없음 | Yes |
| `applyCueWordAutoAlign` | **3 (3D)** | block split/words | source anchor 유지 | 없음 | Yes |

## Phase 3D — Project v2

- `buildProjectJson`: `version: 2`, `blocks[]`, `hardDeletedMediaSkips[]`, `subtitles` (하위 호환)
- `ingestFromProject`: v2 document → blocks SSOT 직접 복원; v1 → subtitles → adapter

## Phase 4 — Export SSOT (blocks)

- `shared/blocks-to-export.js`: `blocksToExportSegments`, `blocksToVirtualAudioMap`, `blocksRequireConcatExport`, `buildBlockStitchedProgramExportCues`
- `export-client.js`: Hub `blocks` + `_virtualIndex` 전달 시 block 경로 (legacy cue fallback 유지)
- `overlay-capture-schedule.js`: block program 축 — `_virtualIndex` virtualStart/End + word soft-delete media run 분할
- `hardDeletedMediaSkips`는 export/cutRanges에 **미포함** (preview-only)

## Word Soft Delete — AI 권장안 (채택)

**Duration Shrink:** 단어 삭제 시 해당 word의 media span만큼 `block.duration` 및 word tree를 재계산한다. `virtualTimelineDeleted` / `hardDeletedMediaSkips` / `cutRanges`에는 **등록하지 않는다**. 줄이 비면 `deleteBlockAt` (hard delete + orphan skip).

## Phase 3 DoD (요약)

1. List-order OFF — DnD 후 Phase 2 virtual highlight가 새 block 순서와 일치
2. Vrew 타임코드 virtualStart 단조 + ripple
3. Undo — blocks, blockId, hardDeletedMediaSkips 복원
4. Hard delete — orphan media skip, tombstone/cut 이중 등록 없음
5. Waveform trim — duration structural rebuild (Phase 0 브릿지)
