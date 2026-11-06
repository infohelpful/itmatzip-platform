/** UI-independent AI installation registry and status normalization. */
// 에이전트 1.7.14 이하는 binaries.runtime 을 보내지 않음 (Demucs·diffq 가 곧 실행 환경)
const vocalRuntimeReady = d => typeof d?.binaries?.runtime === 'boolean' ? d.binaries.runtime : !!d?.binaries?.demucs && !!d?.binaries?.diffq;

export const TOOLS = {
  'auto-subtitle': { name: 'AutoSubtitle', base: '/api/tools/auto-subtitle/v2', status: '/deps', job: '/deps/prepare', parts: [['packagesOk', '음성 인식 실행 환경'], ['ffmpegOk', 'FFmpeg'], ['modelPresent', 'Whisper AI 모델']], ready: d => !!d.engineReady },
  'silence-remover': { name: 'Silence Detector', base: '/api/tools/silence-remover', status: '/readiness', job: '/prepare/start', jobStatus: '/prepare/status', parts: [['ffmpeg', 'FFmpeg'], ['ffprobe', 'ffprobe']], ready: d => !!d.binaries?.ffmpeg && !!d.binaries?.ffprobe },
  // 필수 기본 모델(MDX-Net, ONNX ~105 MB) 기준. Demucs·Roformer·앙상블은 페이지에서 선택 시 추가 설치.
  'vocal-remover': { name: 'Vocal Remover', base: '/api/tools/vocal-remover', status: '/readiness', job: '/prepare', parts: [['ffmpeg', 'FFmpeg'], ['ffprobe', 'ffprobe'], ['runtime', 'AI 실행 환경'], ['model_ready', 'AI 분리 모델']], ready: d => !!d.binaries?.ffmpeg && !!d.binaries?.ffprobe && vocalRuntimeReady(d) && !!d.binaries?.model_ready, partReady: (key, d) => key === 'runtime' ? vocalRuntimeReady(d) : undefined },
  'image-enhancer': { name: 'Image Enhancer', base: '/api/tools/image-enhancer', status: '/readiness', job: '/prepare', parts: [['torch', 'PyTorch'], ['pip_stack', 'CodeFormer 실행 환경'], ['vendor_ready', 'CodeFormer 소스'], ['model_ready', 'CodeFormer AI 모델']], ready: d => !!d.binaries?.torch && !!d.binaries?.pip_stack && !!d.binaries?.vendor_ready && !!d.binaries?.model_ready },
  'background-remover': { name: 'Background Remover', base: '/api/tools/background-remover', status: '/readiness', job: '/prepare', parts: [['torch', 'PyTorch'], ['pip_stack', 'BiRefNet 실행 환경'], ['model_ready', 'BiRefNet AI 모델']], ready: d => !!d.binaries?.torch && !!d.binaries?.pip_stack && !!d.binaries?.model_ready },
  'create-music': { name: 'Create Music', base: '/api/tools/create-music', status: '/readiness?quick=1', job: '/prepare', parts: [['all_ready', 'ACE-Step 실행 환경·AI 모델']], ready: d => !!d.all_ready },
  'magic-eraser': { name: 'MagicEraser', base: '/api/tools/magic-eraser', status: '/readiness', job: '/prepare', parts: [['torch', 'PyTorch'], ['pip_stack', 'LaMa 실행 환경'], ['model_ready', 'LaMa AI 모델']], ready: d => !!d.binaries?.torch && !!d.binaries?.pip_stack && !!d.binaries?.model_ready },
  'voice-changer': { name: 'Voice Changer', base: '/api/tools/voice-changer', status: '/readiness', job: '/prepare', parts: [['ffmpeg', 'FFmpeg'], ['torch', 'PyTorch'], ['pip_stack', 'Seed-VC 실행 환경'], ['source_ready', 'Seed-VC 소스'], ['model_ready', 'Seed-VC AI 모델']], ready: d => !!d.binaries?.ffmpeg && !!d.binaries?.torch && !!d.binaries?.pip_stack && !!d.binaries?.source_ready && !!d.binaries?.model_ready },
  'watermark-remover': { name: 'Fixed Area Remover', base: '/api/tools/watermark-remover', status: '/readiness', job: '/prepare', parts: [['torch', 'PyTorch'], ['pip_stack', 'ProPainter 실행 환경'], ['source_ready', 'ProPainter 소스'], ['model_ready', 'ProPainter AI 모델']], ready: d => !!d.binaries?.torch && !!d.binaries?.pip_stack && !!d.binaries?.source_ready && !!d.binaries?.model_ready },
};

export const running = s => !!s && (s.state === 'running' || /^(installing|downloading|preparing|verifying|extracting|checking)/.test(s.phase || ''));
export const failed = s => !!s && (s.state === 'error' || ['error', 'failed'].includes(s.phase));

export function setupGatePhase(toolId, { agentOk = false, apiStarting = false, readiness = null, job = null, optionalJobs = [] } = {}) {
  if (!agentOk || apiStarting) return 'agent';
  const config = TOOLS[toolId];
  if (!config || !readiness || !config.ready(readiness) || running(job) || optionalJobs.some(running)) return 'setup';
  return 'ready';
}

export function setupRows(toolId, readiness, job) {
  const config = TOOLS[toolId];
  if (!config) return [];
  const stage = String(job?.step || job?.stage || job?.phase || job?.message || '').toLowerCase();
  const isReadyKey = key => config.partReady?.(key, readiness) ?? (key === 'all_ready' ? !!readiness?.all_ready : key === 'modelPresent' ? !!(readiness?.modelPresent || readiness?.modelLoaded) : key === 'packagesOk' ? !!readiness?.packagesOk : key === 'ffmpegOk' ? !!readiness?.ffmpegOk : !!readiness?.binaries?.[key]);
  const firstMissing = config.parts.find(([key]) => !isReadyKey(key))?.[0];
  const stageKey = toolId === 'auto-subtitle' ? /ffmpeg|파형/.test(stage) ? 'ffmpegOk' : /whisper|모델/.test(stage) ? 'modelPresent' : 'packagesOk'
    : /model|모델/.test(stage) && config.parts.some(([key]) => key === 'model_ready') ? 'model_ready' : firstMissing;
  const activeKey = stageKey && !isReadyKey(stageKey) ? stageKey : firstMissing;
  return config.parts.map(([key, label]) => {
    const isReady = isReadyKey(key);
    return { key, label, state: isReady ? 'ready' : key === activeKey && running(job) ? 'running' : key === activeKey && failed(job) ? 'failed' : 'waiting' };
  });
}

/**
 * 설치 작업 진행률 — 바이트 정보가 있으면 다운로드 비율, 없으면 작업 전체 퍼센트.
 * @returns {{ pct: number | null, bytesDone: number, bytesTotal: number, hasBytes: boolean }}
 */
export function jobProgress(job) {
  const clamp = v => typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
  const bytesDone = Number(job?.bytesDone ?? job?.bytes_done);
  const bytesTotal = Number(job?.bytesTotal ?? job?.bytes_total);
  const hasBytes = bytesTotal > 0 && bytesDone >= 0;
  const pct = hasBytes ? clamp(bytesDone / bytesTotal * 100) : clamp(job?.percent ?? job?.progress ?? job?.pct);
  return { pct, bytesDone: hasBytes ? bytesDone : 0, bytesTotal: hasBytes ? bytesTotal : 0, hasBytes };
}
