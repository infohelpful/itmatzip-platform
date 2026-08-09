/**
 * 에이전트 파일 대화상자 엔드포인트 — 툴별 분리 (SSOT).
 * 공용 pick 은 경로만 즉시 반환(CFR·분석·툴 session 부작용 없음).
 *
 * | 상수 | 툴 |
 * |------|-----|
 * | AGENT_PICK_VIDEO | Silence Detector |
 * | AGENT_PICK_SUBTITLE_MEDIA | Auto Subtitle (영상·오디오 원본) |
 * | AGENT_PICK_AUDIO | Vocal Remover, Create Music, Voice Changer |
 * | AGENT_PICK_IMAGE | Image Enhancer, Auto Subtitle (워터마크 이미지) |
 * | AGENT_PICK_FOLDER | MagicEraser 폴더 일괄 지우기 |
 * | AGENT_PICK_FONT | Auto Subtitle (자막 폰트) |
 * | AGENT_PICK_PROJECT | Auto Subtitle (.autosub 프로젝트) |
 */

/** Silence Detector — video_path 만 */
export const AGENT_PICK_VIDEO = "/api/agent/pick-local-file";

/** Auto Subtitle — video_path + 에이전트 UTF-8 session (CFR는 prepare-preview) */
export const AGENT_PICK_SUBTITLE_MEDIA = "/api/agent/pick-local-subtitle-media";

/** Vocal Remover, Create Music */
export const AGENT_PICK_AUDIO = "/api/agent/pick-local-audio-file";

/** Auto Subtitle 프로젝트 불러오기 */
export const AGENT_PICK_PROJECT = "/api/agent/pick-local-project-file";

/** Auto Subtitle 자막 폰트 */
export const AGENT_PICK_FONT = "/api/agent/pick-local-font-file";

/** Image Enhancer, Background Remover, MagicEraser, Auto Subtitle 워터마크 이미지 */
export const AGENT_PICK_IMAGE = "/api/agent/pick-local-image-file";

/** MagicEraser 폴더 일괄 지우기 등 — 로컬 폴더 경로 */
export const AGENT_PICK_FOLDER = "/api/agent/pick-local-folder";
