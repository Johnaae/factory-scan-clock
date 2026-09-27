'use strict';

/**
 * Shared manager-dashboard request layer.
 * - Classifies every API result: ok | auth | forbidden | network | timeout | server | transient_auth | client.
 * - A 401/403 is only treated as "session ended" after /api/auth/manager-session confirms it,
 *   so one failed request can never log the manager out of an otherwise valid session.
 * - Network / server failures show a non-blocking connection banner (never a login prompt).
 * - Confirmed expiry shows one overlay (no redirect loops); it clears itself if the session
 *   becomes valid again (e.g. the manager logs in from another tab).
 */
(function initManagerSession(root) {
  const DEFAULT_TIMEOUT_MS = 20000;
  const CONFIRM_TIMEOUT_MS = 10000;
  const CONFIRM_CACHE_MS = 2000;
  const EXPIRED_RECHECK_MS = 15000;
  const TRANSIENT_KINDS = new Set(['network', 'timeout', 'server', 'transient_auth']);

  let state = 'ok';
  let confirmInFlight = null;
  let lastConfirm = { at: 0, value: null };
  let lastOkAt = null;
  let recheckTimer = null;
  let overlayEl = null;
  let bannerEl = null;

  function emit(type, detail) {
    document.dispatchEvent(new CustomEvent('manager-session', { detail: { type, ...(detail || {}) } }));
  }

  function on(type, fn) {
    document.addEventListener('manager-session', (ev) => {
      if (ev.detail && ev.detail.type === type) fn(ev.detail);
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function rawFetch(url, opts, timeoutMs) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetch(url, {
        credentials: 'same-origin',
        ...opts,
        signal: controller ? controller.signal : undefined,
      });
      const text = await res.text();
      let data = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (_e) {
          data = { ok: false, error: 'non_json_response', message: text.trim().slice(0, 240) };
        }
      }
      return { res, data, kind: null };
    } catch (err) {
      const kind = err && err.name === 'AbortError' ? 'timeout' : 'network';
      return { res: null, data: {}, kind, error: err };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** true = valid manager session, false = no manager session, null = could not tell (network). */
  function confirmSession() {
    if (Date.now() - lastConfirm.at < CONFIRM_CACHE_MS && lastConfirm.value !== null) {
      return Promise.resolve(lastConfirm.value);
    }
    if (confirmInFlight) return confirmInFlight;
    confirmInFlight = (async () => {
      const r = await rawFetch('/api/auth/manager-session', { cache: 'no-store' }, CONFIRM_TIMEOUT_MS);
      let value = null;
      if (r.res && r.res.ok && r.data && r.data.ok) value = true;
      else if (r.res && (r.res.status === 401 || r.res.status === 403)) value = false;
      lastConfirm = { at: Date.now(), value };
      return value;
    })().finally(() => {
      confirmInFlight = null;
    });
    return confirmInFlight;
  }

  function classifyStatus(res) {
    if (res.ok) return 'ok';
    if (res.status >= 500) return 'server';
    return 'client';
  }

  async function request(url, opts) {
    const options = { ...(opts || {}) };
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    delete options.timeoutMs;
    const method = String(options.method || 'GET').toUpperCase();

    let r = await rawFetch(url, options, timeoutMs);
    if (r.res && (r.res.status === 401 || r.res.status === 403)) {
      const valid = state === 'expired' ? false : await confirmSession();
      if (valid === false) {
        markExpired();
        r.kind = 'auth';
      } else if (valid === null) {
        r.kind = 'network';
      } else if (r.res.status === 403) {
        r.kind = 'forbidden';
      } else if (method === 'GET' || method === 'HEAD') {
        r = await rawFetch(url, options, timeoutMs);
        r.kind = r.res ? (r.res.status === 401 ? 'transient_auth' : classifyStatus(r.res)) : r.kind;
      } else {
        r.kind = 'transient_auth';
      }
    } else if (r.res) {
      r.kind = classifyStatus(r.res);
    }

    if (r.kind === 'ok' || r.kind === 'client' || r.kind === 'forbidden') noteReachable();
    else if (TRANSIENT_KINDS.has(r.kind)) noteTransient(r);
    return r;
  }

  function describe(result, fallback) {
    const r = result || {};
    const data = r.data || {};
    const status = r.res ? r.res.status : 0;
    switch (r.kind) {
      case 'auth':
        return 'Manager session ended. Log in again to continue.';
      case 'forbidden':
        return data.message && data.message !== 'Forbidden.' ? data.message : 'This account is not allowed to view this section.';
      case 'network':
        return 'Cannot reach the server. Check the network connection — retrying automatically.';
      case 'timeout':
        return 'The server did not respond in time — retrying automatically.';
      case 'transient_auth':
        return 'Session check failed temporarily — retrying automatically.';
      case 'server':
        if (status === 503 || data.error === 'database_unavailable') {
          return 'Server is starting up or the database is busy — retrying automatically.';
        }
        return `Server error (HTTP ${status}) — retrying automatically.`;
      default:
        return data.message || fallback || 'Request failed.';
    }
  }

  function isTransient(kindOrErr) {
    const kind = kindOrErr && typeof kindOrErr === 'object' ? kindOrErr.kind : kindOrErr;
    return TRANSIENT_KINDS.has(kind);
  }

  /** Like request(), but throws an Error (with .kind/.status) for anything that is not ok:true JSON. */
  async function fetchJson(url, opts, fallback) {
    const r = await request(url, opts);
    if (r.kind === 'ok' && !(r.data && r.data.ok === false)) return r.data;
    const err = new Error(describe(r.kind === 'ok' ? { ...r, kind: 'client' } : r, fallback));
    err.kind = r.kind === 'ok' ? 'client' : r.kind;
    err.status = r.res ? r.res.status : 0;
    err.data = r.data;
    throw err;
  }

  function loginUrl() {
    const next = `${window.location.pathname}${window.location.search || ''}`;
    return `/manager-login?next=${encodeURIComponent(next)}`;
  }

  function renderOverlay() {
    if (overlayEl) {
      overlayEl.hidden = false;
      return;
    }
    overlayEl = document.createElement('div');
    overlayEl.className = 'mgr-session-overlay';
    overlayEl.setAttribute('role', 'alertdialog');
    overlayEl.setAttribute('aria-modal', 'true');
    overlayEl.setAttribute('aria-labelledby', 'mgrSessionTitle');
    overlayEl.innerHTML = `<div class="mgr-session-card">
      <h2 id="mgrSessionTitle" class="mgr-session-title">Manager session ended</h2>
      <p class="mgr-session-text">Your manager login is no longer active (logged out elsewhere or expired).
        Dashboard data is hidden until you log in again.</p>
      <p class="mgr-session-status" data-role="status"></p>
      <div class="mgr-session-actions">
        <a class="btn btn-primary" data-role="login" href="${escapeHtml(loginUrl())}">Log in again</a>
        <button type="button" class="btn" data-role="check">Check again</button>
      </div>
    </div>`;
    document.body.appendChild(overlayEl);
    overlayEl.querySelector('[data-role="check"]').addEventListener('click', () => void recheckExpired(true));
  }

  function markExpired() {
    if (state === 'expired') return;
    state = 'expired';
    hideBanner();
    renderOverlay();
    emit('expired');
    if (recheckTimer == null) {
      recheckTimer = window.setInterval(() => void recheckExpired(false), EXPIRED_RECHECK_MS);
    }
  }

  async function recheckExpired(userInitiated) {
    if (state !== 'expired') return;
    const statusEl = overlayEl && overlayEl.querySelector('[data-role="status"]');
    if (userInitiated && statusEl) statusEl.textContent = 'Checking…';
    lastConfirm = { at: 0, value: null };
    const valid = await confirmSession();
    if (valid === true) {
      markRestored();
      return;
    }
    if (statusEl) {
      statusEl.textContent =
        valid === null ? 'Cannot reach the server right now.' : userInitiated ? 'Still logged out.' : '';
    }
  }

  function markRestored() {
    state = 'ok';
    if (recheckTimer != null) {
      clearInterval(recheckTimer);
      recheckTimer = null;
    }
    if (overlayEl) overlayEl.hidden = true;
    emit('restored');
  }

  function fmtClock(d) {
    return d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '';
  }

  function noteReachable() {
    lastOkAt = new Date();
    hideBanner();
  }

  function noteTransient(result) {
    if (state === 'expired') return;
    if (!bannerEl) {
      bannerEl = document.createElement('div');
      bannerEl.className = 'mgr-conn-banner';
      bannerEl.setAttribute('role', 'status');
      bannerEl.setAttribute('aria-live', 'polite');
      bannerEl.innerHTML = `<span data-role="msg"></span>
        <button type="button" class="btn btn-sm" data-role="retry">Retry now</button>`;
      document.body.appendChild(bannerEl);
      bannerEl.querySelector('[data-role="retry"]').addEventListener('click', () => {
        bannerEl.querySelector('[data-role="msg"]').textContent = 'Retrying…';
        emit('retry');
      });
    }
    const since = lastOkAt ? ` Showing data last updated at ${fmtClock(lastOkAt)}.` : '';
    bannerEl.querySelector('[data-role="msg"]').textContent = `${describe(result)}${since}`;
    bannerEl.hidden = false;
  }

  function hideBanner() {
    if (bannerEl) bannerEl.hidden = true;
  }

  window.addEventListener('online', () => emit('retry'));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state === 'expired') void recheckExpired(false);
  });

  root.ManagerSession = {
    request,
    fetchJson,
    describe,
    isTransient,
    confirmSession,
    isExpired: () => state === 'expired',
    on,
  };
})(window);
