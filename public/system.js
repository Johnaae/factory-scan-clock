'use strict';

const logoutBtn = document.getElementById('logoutBtn');
const serverStatusBadge = document.getElementById('serverStatusBadge');
const serverStatusDetail = document.getElementById('serverStatusDetail');
const databaseStatusBadge = document.getElementById('databaseStatusBadge');
const databaseStatusDetail = document.getElementById('databaseStatusDetail');
const pm2StatusBadge = document.getElementById('pm2StatusBadge');
const pm2StatusDetail = document.getElementById('pm2StatusDetail');
const appVersionEl = document.getElementById('appVersion');
const databaseSizeEl = document.getElementById('databaseSize');
const latestBackupFileEl = document.getElementById('latestBackupFile');
const lastBackupDateEl = document.getElementById('lastBackupDate');
const serverTimeEl = document.getElementById('serverTime');
const systemHintEl = document.getElementById('systemHint');
const btnCreateBackup = document.getElementById('btnCreateBackup');
const btnDownloadLatest = document.getElementById('btnDownloadLatest');

const FETCH_TIMEOUT_MS = 12000;
const PM2_FETCH_TIMEOUT_MS = 8000;

function formatLocalDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function setBadge(el, label, state) {
  if (!el) return;
  el.textContent = label;
  el.classList.remove('health-badge--ok', 'health-badge--fail', 'health-badge--loading');
  if (state === 'ok') el.classList.add('health-badge--ok');
  else if (state === 'fail') el.classList.add('health-badge--fail');
  else el.classList.add('health-badge--loading');
}

function setDetail(el, text) {
  if (el) el.textContent = text || '';
}

function setValue(el, text) {
  if (el) el.textContent = text || '—';
}

async function fetchJson(url, timeoutMs) {
  const limit = timeoutMs || FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  try {
    const res = await fetch(url, {
      credentials: 'same-origin',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: (data && data.message) || `HTTP ${res.status}`,
      };
    }
    return data;
  } catch (err) {
    const message =
      err && err.name === 'AbortError' ? 'Request timed out' : err && err.message ? err.message : 'Request failed';
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

async function apiJson(url, opts) {
  const res = await fetch(url, {
    ...opts,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(opts && opts.headers ? opts.headers : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && data.message ? data.message : `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function setHint(text, isError) {
  if (!systemHintEl) return;
  systemHintEl.textContent = text || '';
  systemHintEl.style.color = isError ? '#b91c1c' : '';
}

function applyServerStatus(data) {
  if (!data || data.error) {
    setBadge(serverStatusBadge, 'OFFLINE', 'fail');
    setDetail(serverStatusDetail, (data && data.error) || 'Server status check failed');
    return;
  }
  const online = data.status === 'online';
  setBadge(serverStatusBadge, online ? 'ONLINE' : 'OFFLINE', online ? 'ok' : 'fail');
  setDetail(serverStatusDetail, data.message || (online ? 'Node.js server is running' : 'Server unavailable'));
}

function applyDatabaseStatus(data) {
  if (!data || data.error) {
    setBadge(databaseStatusBadge, 'DISCONNECTED', 'fail');
    setDetail(databaseStatusDetail, (data && data.error) || 'Database status check failed');
    return;
  }
  const connected = data.status === 'connected';
  setBadge(databaseStatusBadge, connected ? 'CONNECTED' : 'DISCONNECTED', connected ? 'ok' : 'fail');
  setDetail(databaseStatusDetail, data.message || (connected ? 'PostgreSQL responding' : 'Database unavailable'));
}

function applyPm2Status(data) {
  if (!data || data.error) {
    setBadge(pm2StatusBadge, 'OFFLINE', 'fail');
    setDetail(pm2StatusDetail, (data && data.error) || 'PM2 status check failed');
    return;
  }
  const online = data.status === 'online';
  setBadge(pm2StatusBadge, online ? 'ONLINE' : 'OFFLINE', online ? 'ok' : 'fail');
  setDetail(pm2StatusDetail, data.message || (online ? 'factory-scan-clock is online' : 'PM2 process not online'));
}

function applyDatabaseSize(data) {
  if (!data || data.error || !data.size) {
    setValue(databaseSizeEl, data && data.error ? 'ERROR' : '—');
    return;
  }
  setValue(databaseSizeEl, data.size);
}

function applyServerTime(data) {
  if (!data || data.error || !data.server_time) {
    setValue(serverTimeEl, data && data.error ? 'ERROR' : '—');
    return;
  }
  setValue(serverTimeEl, formatLocalDate(data.server_time));
}

function applyBackupInfo(data) {
  if (!data || data.error) {
    setValue(latestBackupFileEl, '—');
    setDetail(lastBackupDateEl, 'Backup info unavailable');
    if (btnDownloadLatest) btnDownloadLatest.hidden = true;
    return;
  }

  if (appVersionEl) {
    setValue(appVersionEl, data.app_version ? `v${data.app_version}` : '—');
  }

  setValue(latestBackupFileEl, data.latest_backup_file || 'No PostgreSQL backups yet');
  setDetail(
    lastBackupDateEl,
    data.last_backup_at ? `Backup timestamp: ${formatLocalDate(data.last_backup_at)}` : 'No backup timestamp'
  );

  if (btnDownloadLatest) {
    if (data.latest_backup_file) {
      btnDownloadLatest.href = '/api/admin/backup/latest/download';
      btnDownloadLatest.hidden = false;
    } else {
      btnDownloadLatest.href = '#';
      btnDownloadLatest.hidden = true;
    }
  }

  if (Array.isArray(data.config_errors) && data.config_errors.length) {
    setHint(data.config_errors.join(' '), true);
  }
}

async function loadStatus() {
  const requests = [
    fetchJson('/api/system/server-status').then(applyServerStatus),
    fetchJson('/api/system/database-status').then(applyDatabaseStatus),
    fetchJson('/api/system/pm2-status', PM2_FETCH_TIMEOUT_MS).then(applyPm2Status),
    fetchJson('/api/system/database-size').then(applyDatabaseSize),
    fetchJson('/api/system/server-time').then(applyServerTime),
    fetchJson('/api/admin/backup/status').then(applyBackupInfo),
  ];

  await Promise.allSettled(requests);
}

async function createBackup() {
  if (!btnCreateBackup) return;
  btnCreateBackup.disabled = true;
  setHint('Creating backup… this may take a minute.');
  try {
    const data = await apiJson('/api/admin/backup/create', { method: 'POST' });
    setHint(data.message || 'Backup created successfully.');
    await loadStatus();
  } catch (err) {
    setHint(err.message || 'Backup failed.', true);
  } finally {
    btnCreateBackup.disabled = false;
  }
}

if (btnCreateBackup) {
  btnCreateBackup.addEventListener('click', () => {
    createBackup();
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    await apiJson('/api/auth/logout', { method: 'POST' });
    window.location.href = '/manager-login';
  });
}

loadStatus().catch((err) => {
  setHint(err.message || 'Could not load system status.', true);
});
