/**
 * 사용자-facing 문구 (에이전트·연결·포트 등 기술 용어 노출 최소화)
 */

export const LOCAL_HELPER_NAME = "IT맛집 도우미";

export const MSG_HELPER_NEED_APP = `PC에서 ${LOCAL_HELPER_NAME}를 실행해 주세요`;
export const MSG_HELPER_CHECKING = "준비 확인 중…";
export const MSG_HELPER_SETUP = "영상 처리 도구를 준비하는 중입니다… (처음엔 시간이 걸릴 수 있습니다)";
export const MSG_HELPER_READY = ""; // 준비되면 상단 안내 숨김
export const MSG_HELPER_ERROR =
  "영상 분석을 준비하지 못했습니다. 도우미를 다시 실행해 보세요.";

export const MSG_ANALYZE_NEED_APP = `${LOCAL_HELPER_NAME}를 실행한 뒤 다시 시도해 주세요.`;
export const MSG_PICK_FILE_NEED_APP = `${LOCAL_HELPER_NAME}를 실행한 뒤 파일을 선택해 주세요.`;

/** Auto Subtitle — 첫 사용 시 모델 다운로드 안내 */
export const MSG_SUBTITLE_NEED_APP = `${LOCAL_HELPER_NAME}를 실행한 뒤 다시 시도해 주세요.`;
export const MSG_SUBTITLE_PREPARE =
  "처음 자막 추출 시 AI 음성 인식 모델(약 1.6GB)과 FFmpeg를 PC에 받습니다. 잠시만 기다려 주세요.";
export const MSG_SUBTITLE_JOB_BUSY =
  "다른 작업이 끝난 뒤 다시 시도해 주세요. (전사·보내기는 한 번에 하나만 실행됩니다)";
export const MSG_SUBTITLE_PICK_FILE = `${LOCAL_HELPER_NAME}를 실행한 뒤 영상·오디오 파일을 선택해 주세요.`;
