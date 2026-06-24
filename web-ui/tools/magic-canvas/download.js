import { configureBridge, fetchAgent, getAgentOrigin } from "../common/bridge.js?v=lna15";
import { AGENT_PORT } from "../common/agent-endpoints.js";

configureBridge({ healthPath: "/health" });

const STORAGE_DL_RESULT = "magic-canvas:dl-result-path";
const statusEl = document.getElementById("download-status");
const btn = document.getElementById("btn-download");

const resultPath = sessionStorage.getItem(STORAGE_DL_RESULT);

async function triggerDownload() {
  if (!resultPath) {
    statusEl.textContent = "저장할 결과가 없습니다.";
    return;
  }
  const url = `${getAgentOrigin()}/api/agent/read-local-image?path=${encodeURIComponent(resultPath)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("파일 읽기 실패");
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "magic-canvas-result.png";
  a.click();
  URL.revokeObjectURL(a.href);
  statusEl.textContent = "다운로드가 시작되었습니다.";
}

if (!resultPath) {
  statusEl.textContent = "결과 경로가 없습니다. 편집 화면에서 다시 시도하세요.";
} else {
  statusEl.textContent = "아래 버튼으로 결과 이미지를 저장하세요.";
  btn.disabled = false;
}

btn.addEventListener("click", () => {
  triggerDownload().catch((e) => {
    statusEl.textContent = e.message || "다운로드 실패";
  });
});
