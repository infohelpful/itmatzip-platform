/**
 * 사용자-facing 문구 (에이전트·연결·포트 등 기술 용어 노출 최소화)
 */

function ht(key, fallback) {
  try {
    if (typeof window !== "undefined" && typeof window.itzT === "function") {
      return window.itzT(key, fallback);
    }
  } catch (e) {}
  return fallback;
}

export const LOCAL_HELPER_NAME = "IT맛집 도우미";

export function helperNeedApp() {
  return ht("helper.needApp", "PC에서 IT맛집 도우미를 실행해 주세요");
}
export function helperChecking() {
  return ht("helper.checking", "준비 확인 중…");
}
export function helperSetup() {
  return ht("helper.setup", "영상 처리 도구를 준비하는 중입니다… (처음엔 시간이 걸릴 수 있습니다)");
}
export const MSG_HELPER_READY = "";
export function helperError() {
  return ht("helper.error", "영상 분석을 준비하지 못했습니다. 도우미를 다시 실행해 보세요.");
}
export function analyzeNeedApp() {
  return ht("helper.analyzeNeedApp", "IT맛집 도우미를 실행한 뒤 다시 시도해 주세요.");
}
export function pickFileNeedApp() {
  return ht("helper.pickNeedApp", "IT맛집 도우미를 실행한 뒤 파일을 선택해 주세요.");
}
export function subtitleNeedApp() {
  return ht("helper.subtitleNeedApp", "IT맛집 도우미를 실행한 뒤 다시 시도해 주세요.");
}
export function subtitlePrepare() {
  return ht(
    "helper.subtitlePrepare",
    "처음 자막 추출 시 AI 음성 인식 모델(약 1.6GB)과 FFmpeg를 PC에 받습니다. 잠시만 기다려 주세요.",
  );
}
export function subtitleJobBusy() {
  return ht(
    "helper.subtitleBusy",
    "다른 작업이 끝난 뒤 다시 시도해 주세요. (전사·보내기는 한 번에 하나만 실행됩니다)",
  );
}
export function subtitlePickFile() {
  return ht("helper.subtitlePick", "IT맛집 도우미를 실행한 뒤 영상·오디오 파일을 선택해 주세요.");
}

/** @deprecated 호출 시점에 번역되도록 함수를 쓰세요. 기존 import 호환용 live binding */
export const MSG_HELPER_NEED_APP = helperNeedApp;
export const MSG_HELPER_CHECKING = helperChecking;
export const MSG_HELPER_SETUP = helperSetup;
export const MSG_HELPER_ERROR = helperError;
export const MSG_ANALYZE_NEED_APP = analyzeNeedApp;
export const MSG_PICK_FILE_NEED_APP = pickFileNeedApp;
export const MSG_SUBTITLE_NEED_APP = subtitleNeedApp;
export const MSG_SUBTITLE_PREPARE = subtitlePrepare;
export const MSG_SUBTITLE_JOB_BUSY = subtitleJobBusy;
export const MSG_SUBTITLE_PICK_FILE = subtitlePickFile;
