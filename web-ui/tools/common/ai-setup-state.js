/** UI-independent AI installation registry and status normalization. */
export const TOOLS = {
  'auto-subtitle': { name: 'AutoSubtitle', base: '/api/tools/auto-subtitle/v2', status: '/deps', job: '/deps/prepare', parts: [['packagesOk', '음성 인식 실행 환경'], ['ffmpegOk', 'FFmpeg'], ['modelPresent', 'Whisper AI 모델']], ready: d => !!d.engineReady },
  'silence-remover': { name: 'Silence Detector', base: '/api/tools/silence-remover', status: '/readiness', job: '/prepare/start', jobStatus: '/prepare/status', parts: [['ffmpeg', 'FFmpeg'], ['ffprobe', 'ffprobe']], ready: d => !!d.binaries?.ffmpeg && !!d.binaries?.ffprobe },
  'vocal-remover': { name: 'Vocal Remover', base: '/api/tools/vocal-remover', status: '/readiness', job: '/prepare', parts: [['ffmpeg', 'FFmpeg'], ['ffprobe', 'ffprobe'], ['demucs', 'Demucs'], ['diffq', 'diffq'], ['model_ready', 'Demucs AI 모델']], ready: d => !!d.binaries?.ffmpeg && !!d.binaries?.ffprobe && !!d.binaries?.demucs && !!d.binaries?.diffq && !!d.binaries?.model_ready },
  'image-enhancer': { name: 'Image Enhancer', base: '/api/tools/image-enhancer', status: '/readiness', job: '/prepare', parts: [['torch', 'PyTorch'], ['pip_stack', 'CodeFormer 실행 환경'], ['vendor_ready', 'CodeFormer 소스'], ['model_ready', 'CodeFormer AI 모델']], ready: d => !!d.binaries?.torch && !!d.binaries?.pip_stack && !!d.binaries?.vendor_ready && !!d.binaries?.model_ready },
  'background-remover': { name: 'Background Remover', base: '/api/tools/background-remover', status: '/readiness', job: '/prepare', parts: [['torch', 'PyTorch'], ['pip_stack', 'BiRefNet 실행 환경'], ['model_ready', 'BiRefNet AI 모델']], ready: d => !!d.binaries?.torch && !!d.binaries?.pip_stack && !!d.binaries?.model_ready },
  'create-music': { name: 'Create Music', base: '/api/tools/create-music', status: '/readiness?quick=1', job: '/prepare', parts: [['all_ready', 'ACE-Step 실행 환경·AI 모델']], ready: d => !!d.all_ready },
  'magic-eraser': { name: 'MagicEraser', base: '/api/tools/magic-eraser', status: '/readiness', job: '/prepare', parts: [['torch', 'PyTorch'], ['pip_stack', 'LaMa 실행 환경'], ['model_ready', 'LaMa AI 모델']], ready: d => !!d.binaries?.torch && !!d.binaries?.pip_stack && !!d.binaries?.model_ready },
  'voice-changer': { name: 'Voice Changer', base: '/api/tools/voice-changer', status: '/readiness', job: '/prepare', parts: [['ffmpeg', 'FFmpeg'], ['torch', 'PyTorch'], ['pip_stack', 'Seed-VC 실행 환경'], ['source_ready', 'Seed-VC 소스'], ['model_ready', 'Seed-VC AI 모델']], ready: d => !!d.binaries?.ffmpeg && !!d.binaries?.torch && !!d.binaries?.pip_stack && !!d.binaries?.source_ready && !!d.binaries?.model_ready },
  'watermark-remover': { name: 'Fixed Area Remover', base: '/api/tools/watermark-remover', status: '/readiness', job: '/prepare', parts: [['torch', 'PyTorch'], ['pip_stack', 'ProPainter 실행 환경'], ['source_ready', 'ProPainter 소스'], ['model_ready', 'ProPainter AI 모델']], ready: d => !!d.binaries?.torch && !!d.binaries?.pip_stack && !!d.binaries?.source_ready && !!d.binaries?.model_ready },
};

export const running = s => !!s && (s.state === 'running' || /^(installing|downloading|preparing|verifying|extracting|checking)/.test(s.phase || ''));
export const failed = s => !!s && (s.state === 'error' || ['error', 'failed'].includes(s.phase));

export function setupRows(toolId, readiness, job) {
  const config = TOOLS[toolId];
  if (!config) return [];
  const stage = String(job?.step || job?.stage || job?.phase || job?.message || '').toLowerCase();
  const isReadyKey = key => key === 'all_ready' ? !!readiness?.all_ready : key === 'modelPresent' ? !!(readiness?.modelPresent || readiness?.modelLoaded) : key === 'packagesOk' ? !!readiness?.packagesOk : key === 'ffmpegOk' ? !!readiness?.ffmpegOk : !!readiness?.binaries?.[key];
  const firstMissing = config.parts.find(([key]) => !isReadyKey(key))?.[0];
  const stageKey = toolId === 'auto-subtitle' ? /ffmpeg|파형/.test(stage) ? 'ffmpegOk' : /whisper|모델/.test(stage) ? 'modelPresent' : 'packagesOk'
    : /model|모델/.test(stage) && config.parts.some(([key]) => key === 'model_ready') ? 'model_ready' : firstMissing;
  const activeKey = stageKey && !isReadyKey(stageKey) ? stageKey : firstMissing;
  return config.parts.map(([key, label]) => {
    const isReady = isReadyKey(key);
    return { key, label, state: isReady ? 'ready' : key === activeKey && running(job) ? 'running' : key === activeKey && failed(job) ? 'failed' : 'waiting' };
  });
}
