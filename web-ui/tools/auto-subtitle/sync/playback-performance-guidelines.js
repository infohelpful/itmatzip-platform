/**
 * AutoSubtitle playbackPerformanceGuidelines.ts
 */

export const PLAYBACK_PERFORMANCE_GUIDELINES = {
  jumpCutDeadband:
    "점프 직후 video.currentTime 이 블록 경계에 다시 걸리면 무한 점프할 수 있음 — o_start 에 1~2ms 데드밴드를 더함.",
  audioPopMitigation:
    "짧은 페이드(5~20ms) 또는 점프 직전 gain→0→seek→복구. Web Audio는 GainNode.setTargetAtTime.",
  waveformVirtualViewport:
    "전체 RMS 대신 [T_start,T_end] 만 slice. 재생 중 translate 스크롤만.",
  wordListVirtualization:
    "긴 목록은 가상 스크롤(뷰포트 밖 DOM 제거).",
  ipcLargePeaks:
    "대용량 peaks JSON은 바이너리/청크 권장.",
  pythonDownsample: "10ms RMS면 1시간 ≈ 360k float — gzip/바이너리 권장.",
};
