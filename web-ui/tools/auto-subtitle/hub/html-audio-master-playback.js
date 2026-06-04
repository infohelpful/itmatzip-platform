/**
 * Electron App.tsx playMasterVideoSynced — HTMLAudio 마스터 + muted video 슬레이브.
 */

const MASTER_AUDIO_ASSIGN_EPS_SEC = 0.002;
const HAVE_FUTURE = HTMLMediaElement.HAVE_FUTURE_DATA;
const SEEK_EVENT_FALLBACK_MS = 320;

/**
 * @param {HTMLAudioElement} audio
 * @param {number} timelineSec
 */
export function assignMasterAudioTimelineSecIfNeeded(audio, timelineSec) {
  const t = Math.max(0, Number(timelineSec));
  if (!Number.isFinite(t)) return false;
  if (Math.abs(audio.currentTime - t) <= MASTER_AUDIO_ASSIGN_EPS_SEC) return false;
  audio.currentTime = t;
  return true;
}

/**
 * @param {HTMLMediaElement} el
 * @param {number} targetSec
 * @param {() => void} done
 */
/** @param {HTMLMediaElement} el @param {number} targetSec @param {() => void} done */
export function seekWithNudge(el, targetSec, done) {
  const target = Math.max(0, Number(targetSec));
  const cur = el.currentTime;
  const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
  const nearSame = Math.abs(cur - target) < 1e-4;
  const nudgeForward =
    dur != null ? Math.min(target + 0.001, Math.max(0, dur - 0.001)) : target + 0.001;
  const nudgeBackward = Math.max(0, target - 0.001);
  const nudge =
    nearSame && Math.abs(nudgeForward - target) > 1e-6
      ? nudgeForward
      : nearSame && Math.abs(nudgeBackward - target) > 1e-6
        ? nudgeBackward
        : null;

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done();
  };
  window.setTimeout(finish, SEEK_EVENT_FALLBACK_MS);

  if (nudge != null) {
    el.currentTime = nudge;
    el.addEventListener(
      "seeked",
      () => {
        el.currentTime = target;
        el.addEventListener("seeked", finish, { once: true });
      },
      { once: true },
    );
    return;
  }
  el.currentTime = target;
  el.addEventListener("seeked", finish, { once: true });
}

/**
 * @param {HTMLAudioElement} masterAudio
 * @param {HTMLVideoElement} videoEl
 * @param {{
 *   targetVideoSec?: number,
 *   targetAudioSec?: number,
 *   onAudioPlayRejected?: (reason?: unknown) => void,
 * }} [opts]
 */
export function playMasterVideoSynced(masterAudio, videoEl, opts = {}) {
  const targetVideoSec = opts.targetVideoSec;
  const targetAudioSec = opts.targetAudioSec;
  const shouldSeekVideo = Number.isFinite(targetVideoSec);
  const shouldSeekAudio = Number.isFinite(targetAudioSec);

  const playBoth = () => {
    void (async () => {
      try {
        await masterAudio.play();
      } catch (e) {
        opts.onAudioPlayRejected?.(e);
        return;
      }
      await new Promise((resolve) => {
        if (!masterAudio.paused) {
          resolve();
          return;
        }
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          masterAudio.removeEventListener("playing", onPlaying);
          resolve();
        };
        const onPlaying = () => finish();
        masterAudio.addEventListener("playing", onPlaying, { once: true });
        window.setTimeout(finish, 120);
      });
      void videoEl.play().catch(() => undefined);
    })();
  };

  let videoSeekDone = !shouldSeekVideo;
  let audioSeekDone = !shouldSeekAudio;
  const audioReady = () => masterAudio.readyState >= HAVE_FUTURE;

  let done = false;
  const playSync = () => {
    if (done) return;
    if (!audioSeekDone) return;
    if (!audioReady()) return;
    done = true;
    if (!videoSeekDone) {
      seekWithNudge(videoEl, Number(targetVideoSec), () => {});
    }
    playBoth();
  };

  const runSeekAndPlay = () => {
    if (shouldSeekVideo && Number.isFinite(targetVideoSec)) {
      seekWithNudge(videoEl, Number(targetVideoSec), () => {
        videoSeekDone = true;
      });
    }
    if (shouldSeekAudio && Number.isFinite(targetAudioSec)) {
      seekWithNudge(masterAudio, Number(targetAudioSec), () => {
        audioSeekDone = true;
        playSync();
      });
    }
    if (masterAudio.readyState < HAVE_FUTURE) {
      masterAudio.addEventListener("canplay", playSync, { once: true });
    }
    queueMicrotask(playSync);
    window.setTimeout(playSync, 250);
  };

  const broken =
    masterAudio.networkState === HTMLMediaElement.NETWORK_NO_SOURCE ||
    masterAudio.readyState === 0;

  if (broken && masterAudio.src) {
    let recovered = false;
    const cont = () => {
      if (recovered) return;
      recovered = true;
      runSeekAndPlay();
    };
    masterAudio.addEventListener("canplay", cont, { once: true });
    masterAudio.addEventListener("loadeddata", cont, { once: true });
    masterAudio.load();
    window.setTimeout(cont, 280);
    return;
  }
  runSeekAndPlay();
}
