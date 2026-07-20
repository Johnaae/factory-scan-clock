'use strict';

/** Shared production alert alarm — Main + Manager dashboards, offline Web Audio API. */
(function initAlertSound(root) {
  const ALERT_POLL_MS = 5000;
  const ALERT_REPEAT_MS = 10000;
  const ENABLED_STORAGE_KEY = 'factory_alert_sound_enabled';
  const MUTE_STORAGE_KEY = 'factory_alert_sound_muted';
  const LEGACY_MUTE_STORAGE_KEY = 'mainDashboardAlertMuted';

  /** @type {AudioContext | null} */
  let audioCtx = null;
  let audioUnlocked = false;
  let muted = false;
  let hasOpenAlerts = false;
  /** @type {Set<number>} */
  let knownOpenAlertIds = new Set();
  let alertPollTimer = null;
  let alertRepeatTimer = null;
  let gestureUnlockBound = false;
  /** @type {(() => void) | null} */
  let removeGestureUnlockListeners = null;
  /** @type {(() => Promise<void>) | null} */
  let pollNowFn = null;

  function isProductionAlert(alert) {
    const type = String((alert && alert.alert_type) || '').toLowerCase();
    return type === 'qa_qc' || type === 'maintenance';
  }

  async function fetchOpenProductionAlerts() {
    if (root.MachineDashboard && typeof root.MachineDashboard.fetchOpenAlerts === 'function') {
      const alerts = await root.MachineDashboard.fetchOpenAlerts();
      return (alerts || []).filter(isProductionAlert);
    }
    const res = await fetch('/api/manager/alerts?status=open', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error((data && data.message) || 'Could not load alerts.');
    return (data.alerts || []).filter(isProductionAlert);
  }

  function readSoundEnabledPref() {
    try {
      return localStorage.getItem(ENABLED_STORAGE_KEY) === 'true';
    } catch (_err) {
      return false;
    }
  }

  function writeSoundEnabledPref(enabled) {
    try {
      if (enabled) localStorage.setItem(ENABLED_STORAGE_KEY, 'true');
      else localStorage.removeItem(ENABLED_STORAGE_KEY);
    } catch (_err) {
      /* ignore */
    }
  }

  function readSoundMutedPref() {
    try {
      const value = localStorage.getItem(MUTE_STORAGE_KEY);
      if (value === 'true') return true;
      if (value === 'false') return false;
      if (localStorage.getItem(LEGACY_MUTE_STORAGE_KEY) === '1') return true;
      return false;
    } catch (_err) {
      return false;
    }
  }

  function writeSoundMutedPref(isMuted) {
    try {
      localStorage.setItem(MUTE_STORAGE_KEY, isMuted ? 'true' : 'false');
      localStorage.removeItem(LEGACY_MUTE_STORAGE_KEY);
    } catch (_err) {
      /* ignore */
    }
  }

  async function unlockAudio() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    if (!audioCtx) audioCtx = new Ctx();
    try {
      await audioCtx.resume();
      audioUnlocked = audioCtx.state === 'running';
      return audioUnlocked;
    } catch (_err) {
      audioUnlocked = false;
      return false;
    }
  }

  function playAlertTone(ctx, startAt, frequencyHz, durationSec, volume) {
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, startAt);
    master.gain.exponentialRampToValueAtTime(volume, startAt + 0.008);
    master.gain.setValueAtTime(volume, startAt + Math.max(0.012, durationSec * 0.7));
    master.gain.exponentialRampToValueAtTime(0.0001, startAt + durationSec);

    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(frequencyHz, startAt);
    oscGain.gain.value = 0.78;
    osc.connect(oscGain);
    oscGain.connect(master);
    master.connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + durationSec + 0.02);

    const harmonic = ctx.createOscillator();
    const harmGain = ctx.createGain();
    harmonic.type = 'sawtooth';
    harmonic.frequency.setValueAtTime(frequencyHz * 1.002, startAt);
    harmGain.gain.value = 0.22;
    harmonic.connect(harmGain);
    harmGain.connect(master);
    harmonic.start(startAt);
    harmonic.stop(startAt + durationSec + 0.02);
  }

  /**
   * Industrial alternating-tone alarm (~2.5–3s).
   * 900 Hz / 450 Hz × 4 per cycle, short pause, repeat 3 times.
   */
  function playAlertSound() {
    if (!audioUnlocked || muted || !audioCtx) return false;
    try {
      const ctx = audioCtx;
      const now = ctx.currentTime;
      const VOL = 0.46;
      const TONE_DUR = 0.25;
      const PAUSE = 0.12;
      const CYCLE_LEN = 4 * TONE_DUR + PAUSE;
      const freqs = [900, 450, 900, 450];

      for (let cycle = 0; cycle < 3; cycle++) {
        const base = cycle * CYCLE_LEN;
        freqs.forEach((freq, i) => {
          playAlertTone(ctx, now + base + i * TONE_DUR, freq, TONE_DUR, VOL);
        });
      }
      return true;
    } catch (_err) {
      return false;
    }
  }

  function stopAlertRepeat() {
    if (alertRepeatTimer) {
      clearInterval(alertRepeatTimer);
      alertRepeatTimer = null;
    }
  }

  function startAlertRepeat() {
    if (alertRepeatTimer) return;
    alertRepeatTimer = window.setInterval(() => {
      if (hasOpenAlerts && !muted && audioUnlocked) playAlertSound();
    }, ALERT_REPEAT_MS);
  }

  function updateSoundStatus(el) {
    if (!el) return;
    if (!readSoundEnabledPref()) {
      el.textContent = 'Alert sound not enabled yet.';
      return;
    }
    if (!audioUnlocked) {
      el.textContent = 'Alert sound enabled — click anywhere once to unlock audio.';
      return;
    }
    if (muted) {
      el.textContent = hasOpenAlerts
        ? 'Muted — open alerts are active but silent.'
        : 'Muted — no open alerts.';
      return;
    }
    el.textContent = hasOpenAlerts
      ? 'Alert sound active — repeating every 10 seconds while alerts remain open.'
      : 'Alert sound enabled — waiting for open alerts.';
  }

  function unbindGestureUnlock() {
    if (removeGestureUnlockListeners) {
      removeGestureUnlockListeners();
      removeGestureUnlockListeners = null;
    }
    gestureUnlockBound = false;
  }

  function bindGestureUnlock(statusEl, banner, onUnlocked) {
    if (gestureUnlockBound || !readSoundEnabledPref()) return;
    gestureUnlockBound = true;

    async function tryGestureUnlock() {
      if (audioUnlocked) {
        unbindGestureUnlock();
        return;
      }
      const ok = await unlockAudio();
      if (!ok) return;
      showEnableBanner(banner, false);
      updateSoundStatus(statusEl);
      if (onUnlocked) await onUnlocked();
      unbindGestureUnlock();
    }

    const opts = { passive: true, capture: true };
    document.addEventListener('pointerdown', tryGestureUnlock, opts);
    document.addEventListener('keydown', tryGestureUnlock, true);
    document.addEventListener('touchstart', tryGestureUnlock, opts);
    removeGestureUnlockListeners = () => {
      document.removeEventListener('pointerdown', tryGestureUnlock, opts);
      document.removeEventListener('keydown', tryGestureUnlock, true);
      document.removeEventListener('touchstart', tryGestureUnlock, opts);
    };
  }

  async function restoreSoundPreferences(statusEl, banner, onUnlocked) {
    if (!readSoundEnabledPref()) {
      showEnableBanner(banner, true);
      updateSoundStatus(statusEl);
      return;
    }
    showEnableBanner(banner, false);
    const ok = await unlockAudio();
    updateSoundStatus(statusEl);
    if (!ok) bindGestureUnlock(statusEl, banner, onUnlocked);
  }

  function syncMuteButtons(muteBtn, unmuteBtn) {
    if (muteBtn) muteBtn.hidden = muted;
    if (unmuteBtn) unmuteBtn.hidden = !muted;
  }

  function showEnableBanner(banner, show) {
    if (!banner) return;
    if (show) {
      banner.hidden = false;
      banner.removeAttribute('hidden');
    } else {
      banner.hidden = true;
      banner.setAttribute('hidden', '');
    }
  }

  async function pollOpenAlerts(statusEl) {
    try {
      const alerts = await fetchOpenProductionAlerts();
      const nextIds = new Set(alerts.map((a) => Number(a.id)).filter((id) => Number.isFinite(id)));
      const wasOpen = hasOpenAlerts;
      hasOpenAlerts = nextIds.size > 0;

      let shouldPlayNow = false;
      if (hasOpenAlerts) {
        for (const id of nextIds) {
          if (!knownOpenAlertIds.has(id)) {
            shouldPlayNow = true;
            break;
          }
        }
        if (!wasOpen) shouldPlayNow = true;
        knownOpenAlertIds = nextIds;
        startAlertRepeat();
        if (shouldPlayNow && audioUnlocked && !muted) playAlertSound();
      } else {
        knownOpenAlertIds = new Set();
        stopAlertRepeat();
      }

      updateSoundStatus(statusEl);
    } catch (_err) {
      /* ignore transient poll errors */
    }
  }

  /**
   * @param {object} [options]
   * @param {string} [options.bannerId]
   * @param {string} [options.enableBtnId]
   * @param {string} [options.testBtnId]
   * @param {string} [options.muteBtnId]
   * @param {string} [options.unmuteBtnId]
   * @param {string} [options.statusId]
   */
  function mount(options) {
    const opts = options || {};
    const banner = document.getElementById(opts.bannerId || 'alertSoundEnableBanner');
    const enableBtn = document.getElementById(opts.enableBtnId || 'btnEnableAlertSound');
    const testBtn = document.getElementById(opts.testBtnId || 'btnTestAlertSound');
    const muteBtn = document.getElementById(opts.muteBtnId || 'btnMuteAlertSound');
    const unmuteBtn = document.getElementById(opts.unmuteBtnId || 'btnUnmuteAlertSound');
    const statusEl = document.getElementById(opts.statusId || 'alertSoundStatus');
    if (!banner || !enableBtn || !testBtn || !muteBtn || !unmuteBtn) return null;

    muted = readSoundMutedPref();
    syncMuteButtons(muteBtn, unmuteBtn);
    pollNowFn = () => pollOpenAlerts(statusEl);
    void restoreSoundPreferences(statusEl, banner, pollNowFn);

    enableBtn.addEventListener('click', async () => {
      const ok = await unlockAudio();
      if (!ok) {
        updateSoundStatus(statusEl);
        return;
      }
      writeSoundEnabledPref(true);
      showEnableBanner(banner, false);
      unbindGestureUnlock();
      playAlertSound();
      updateSoundStatus(statusEl);
      void pollOpenAlerts(statusEl);
    });

    testBtn.addEventListener('click', async () => {
      if (!audioUnlocked) {
        const ok = await unlockAudio();
        if (!ok) {
          if (!readSoundEnabledPref()) showEnableBanner(banner, true);
          updateSoundStatus(statusEl);
          return;
        }
        showEnableBanner(banner, false);
        if (readSoundEnabledPref()) unbindGestureUnlock();
      }
      if (!playAlertSound()) updateSoundStatus(statusEl);
    });

    muteBtn.addEventListener('click', () => {
      muted = true;
      writeSoundMutedPref(true);
      syncMuteButtons(muteBtn, unmuteBtn);
      updateSoundStatus(statusEl);
    });

    unmuteBtn.addEventListener('click', () => {
      muted = false;
      writeSoundMutedPref(false);
      syncMuteButtons(muteBtn, unmuteBtn);
      updateSoundStatus(statusEl);
      if (hasOpenAlerts && audioUnlocked) playAlertSound();
    });

    void pollOpenAlerts(statusEl);
    if (alertPollTimer) clearInterval(alertPollTimer);
    alertPollTimer = window.setInterval(() => void pollOpenAlerts(statusEl), ALERT_POLL_MS);

    return {
      stop: () => {
        stopAlertRepeat();
        unbindGestureUnlock();
        if (alertPollTimer) clearInterval(alertPollTimer);
        alertPollTimer = null;
        pollNowFn = null;
      },
      pollNow: () => pollOpenAlerts(statusEl),
    };
  }

  function pollNow() {
    if (pollNowFn) return pollNowFn();
    return Promise.resolve();
  }

  root.AlertSound = {
    mount,
    pollNow,
    playTest: () => playAlertSound(),
    ENABLED_STORAGE_KEY,
    MUTE_STORAGE_KEY,
  };
})(window);
