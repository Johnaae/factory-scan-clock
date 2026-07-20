'use strict';

(function initMainDashboard(root) {
  const ACTIVITY_POLL_MS = 10000;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function statusLabel(status, note) {
    const st = String(status || '').trim();
    const label = st ? st.charAt(0).toUpperCase() + st.slice(1) : '—';
    return note ? `${label} · ${note}` : label;
  }

  async function fetchJson(url, opts) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error((data && data.message) || 'Request failed.');
    }
    return data;
  }

  function renderActivityRows(logs) {
    if (!logs.length) {
      return '<tr><td colspan="6" class="muted">No team scan activity yet.</td></tr>';
    }
    return logs
      .map(
        (l) => `<tr>
          <td class="muted">${escapeHtml(formatDateTime(l.time))}</td>
          <td><strong>${escapeHtml(l.team || '—')}</strong></td>
          <td>${escapeHtml(l.machine || '—')}</td>
          <td>${escapeHtml(l.tank || '—')}</td>
          <td>${escapeHtml(l.phase || '—')}</td>
          <td>${escapeHtml(statusLabel(l.status, l.note))}</td>
        </tr>`
      )
      .join('');
  }

  function mountTeamActivity() {
    const body = document.getElementById('teamActivityBody');
    const refreshBtn = document.getElementById('teamActivityRefresh');
    if (!body) return null;

    async function refresh() {
      try {
        const data = await fetchJson('/api/dashboard/team-activity?limit=60', { cache: 'no-store' });
        body.innerHTML = renderActivityRows(data.logs || []);
      } catch (err) {
        body.innerHTML = `<tr><td colspan="6" class="muted">${escapeHtml(err.message || 'Could not load scan activity.')}</td></tr>`;
      }
    }

    if (refreshBtn) refreshBtn.addEventListener('click', () => void refresh());
    void refresh();
    const timer = setInterval(() => void refresh(), ACTIVITY_POLL_MS);
    return { refresh, stop: () => clearInterval(timer) };
  }

  function mountManualScan() {
    const form = document.getElementById('teamManualScanForm');
    const input = document.getElementById('teamManualScanInput');
    const status = document.getElementById('teamManualScanStatus');
    if (!form || !input || !status) return null;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const barcode = String(input.value || '').trim();
      if (!barcode) {
        status.textContent = 'Enter a barcode to scan.';
        return;
      }
      status.textContent = 'Reading barcode…';
      try {
        const data = await fetchJson('/api/dashboard/manual-scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ barcode }),
        });
        status.textContent = `${data.label}: ${data.detail}`;
        input.value = '';
      } catch (err) {
        status.textContent = err.message || 'Could not read barcode.';
      }
      input.focus();
    });

    return { focus: () => input.focus() };
  }

  root.MainDashboard = { mountTeamActivity, mountManualScan };
})(window);
