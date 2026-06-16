/** Line Mode v4 — feature flag (신규 빌드 기본 on). */
export const LINE_MODE_ONLY = true;

/** 가로 영상 자막 한 줄 최대 글자(공백 포함 표시 길이) */
export const LINE_MODE_MAX_CHARS = { horizontal: 28, vertical: 20 };
/** 한 줄 최대 재생 길이(초) — 넘으면 분할 */
export const LINE_MODE_MAX_DURATION_SEC = 6.5;
export const LINE_MODE_MIN_CUE_SEC = 0.04;
export const LINE_MODE_SNAP_RADIUS_SEC = 0.15;

/** reflow: 이보다 짧은 무음은 끊기 점수에 반영하지 않음 */
export const LINE_MODE_REFLOW_GAP_MIN_SEC = 0.35;
export const LINE_MODE_REFLOW_GAP_MULTIPLIER = 6;
/** reflow: 짧은 호흡에서 조기 분할(거의 max chars 찼을 때만) */
export const LINE_MODE_REFLOW_THRESHOLD_EARLY = 10;
export const LINE_MODE_REFLOW_EARLY_MIN_CHAR_RATIO = 0.9;
/** reflow: 이 점수 미만이면 호흡 대신 max_chars에 맞게 최대한 묶음 */
export const LINE_MODE_REFLOW_MIN_SPLIT_SCORE = 5;
