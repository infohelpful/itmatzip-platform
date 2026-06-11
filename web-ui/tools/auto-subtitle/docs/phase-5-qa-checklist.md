# Phase 5 — QA Checklist (Program Segment + Export)

## Playback (CFR segment preview)

- [ ] 자막 추출 후 ▶ 재생 — 클립 경계에서 끊김·점프 없음
- [ ] silence 블록 — 영상 freeze, 오디오 mute, programSec는 wall clock으로 진행
- [ ] 줄 삭제 / DnD reorder — 재생 중이면 seamless 재-arm, playhead anchor 유지
- [ ] Undo/Redo — blocks 복원 + playhead(programSec, clipPos) 복원

## HQ preview (Phase 4-12)

- [ ] HQ 토글 — program-master 단일 파일 재생
- [ ] 편집(텍스트/삭제/reorder) — 자동 CFR segment 모드 복귀
- [ ] HQ ↔ CFR 전환 시 playhead 유지

## Export

- [ ] video export — bake_level UI 표시 (L0/L1/L4)
- [ ] mp3/wav (blocks) — programClips 기반 cut_ranges 파생
- [ ] export 자막 세로 중앙 — preview와 WYSIWYG 일치

## Diagnostics

- [ ] `autoSubtitleSyncDiag.enable(true)` → 재생 → `.report()` 샘플 수집
- [ ] `node test/program-playback-clock.test.mjs` 통과
- [ ] `python -m unittest agent.engines.test_program_bake_ladder` 통과
