'use strict';

/** Production history table (machine sessions). */
(function initProductionHistory(root) {
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  async function loadFilters(machineSelect, teamSelect) {
    const [machinesRes, teamsRes] = await Promise.all([
      fetch('/api/manager/machines'),
      fetch('/api/manager/teams'),
    ]);
    const machinesData = await machinesRes.json().catch(() => ({}));
    const teamsData = await teamsRes.json().catch(() => ({}));
    if (machineSelect && machinesData.ok) {
      const opts = ['<option value="">All machines</option>'];
      for (const m of machinesData.machines || []) {
        opts.push(`<option value="${Number(m.id)}">${escapeHtml(m.name)}</option>`);
      }
      machineSelect.innerHTML = opts.join('');
    }
    if (teamSelect && teamsData.ok) {
      const opts = ['<option value="">All teams</option>'];
      for (const t of teamsData.teams || []) {
        opts.push(`<option value="${Number(t.id)}">${escapeHtml(t.name)}</option>`);
      }
      teamSelect.innerHTML = opts.join('');
    }
  }

  async function fetchHistory(filters) {
    const params = new URLSearchParams();
    if (filters.date) params.set('date', filters.date);
    if (filters.machine_id) params.set('machine_id', filters.machine_id);
    if (filters.team_id) params.set('team_id', filters.team_id);
    if (filters.tank) params.set('tank', filters.tank);
    params.set('limit', '200');
    const res = await fetch(`/api/manager/production-history?${params}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error((data && data.message) || 'Could not load history');
    return data.rows || [];
  }

  function renderTable(rows) {
    if (!rows.length) {
      return '<p class="muted">No finished production sessions for this filter.</p>';
    }
    const body = rows
      .map(
        (r) => `<tr>
      <td>${escapeHtml(r.date || '—')}</td>
      <td>${escapeHtml(r.machine_name || '—')} <span class="muted">(${escapeHtml(r.machine_code || '')})</span></td>
      <td>${escapeHtml(r.team_name || '—')}</td>
      <td>${escapeHtml(r.tank_number || '—')}</td>
      <td>${escapeHtml(r.phase_name || r.activity_name || '—')}</td>
      <td>${escapeHtml(fmtDateTime(r.started_at))}</td>
      <td>${escapeHtml(fmtDateTime(r.finished_at))}</td>
      <td>${escapeHtml(r.duration_display || '—')}</td>
      <td>${escapeHtml(r.status || '—')}</td>
      <td>${escapeHtml(r.alerts_summary || '—')}</td>
    </tr>`
      )
      .join('');
    return `<div class="table-wrap table-scroll"><table class="data-table">
      <thead><tr>
        <th>Date</th><th>Machine</th><th>Team</th><th>Tank</th><th>Phase</th>
        <th>Start</th><th>End</th><th>Duration</th><th>Status</th><th>Alerts</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
  }

  function mount(opts) {
    const bodyEl = document.getElementById(opts.bodyId);
    const dateEl = document.getElementById(opts.dateId);
    const machineEl = document.getElementById(opts.machineId);
    const teamEl = document.getElementById(opts.teamId);
    const tankEl = document.getElementById(opts.tankId);
    const refreshBtn = document.getElementById(opts.refreshId);
    if (!bodyEl) return;

    void loadFilters(machineEl, teamEl);

    async function refresh() {
      bodyEl.innerHTML = '<p class="muted">Loading…</p>';
      try {
        const rows = await fetchHistory({
          date: dateEl && dateEl.value ? dateEl.value : undefined,
          machine_id: machineEl && machineEl.value ? machineEl.value : undefined,
          team_id: teamEl && teamEl.value ? teamEl.value : undefined,
          tank: tankEl && tankEl.value ? tankEl.value.trim() : undefined,
        });
        bodyEl.innerHTML = renderTable(rows);
      } catch (err) {
        bodyEl.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
      }
    }

    if (refreshBtn) refreshBtn.addEventListener('click', () => void refresh());
    if (dateEl) dateEl.addEventListener('change', () => void refresh());
    if (machineEl) machineEl.addEventListener('change', () => void refresh());
    if (teamEl) teamEl.addEventListener('change', () => void refresh());
    if (tankEl) {
      tankEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void refresh();
      });
    }
    void refresh();
  }

  root.ProductionHistory = { mount, fetchHistory, renderTable };
})(window);
