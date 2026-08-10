'use strict';

/** Reusable Tank Activity modal — shows sessions + alerts for one tank without page reload. */
(function initTankActivity(root) {
  let backdrop = null;
  let titleEl = null;
  let bodyEl = null;
  let wired = false;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDateTime(iso) {
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

  function statusLabel(st) {
    const s = String(st || '').trim();
    if (!s) return '—';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function ensureModal() {
    if (backdrop) return;
    backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop tank-activity-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.innerHTML = `
      <div class="modal modal-wide" role="document">
        <div class="modal-head">
          <h3 class="modal-title" id="tankActivityTitle">Tank Activity</h3>
          <div class="toolbar">
            <button type="button" class="btn btn-sm" data-tank-activity-close>Close</button>
          </div>
        </div>
        <div class="modal-body tank-activity-body" id="tankActivityBody"></div>
      </div>`;
    document.body.appendChild(backdrop);
    titleEl = backdrop.querySelector('#tankActivityTitle');
    bodyEl = backdrop.querySelector('#tankActivityBody');

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop || e.target.hasAttribute('data-tank-activity-close')) close();
    });
    if (!wired) {
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && backdrop && backdrop.classList.contains('show')) close();
      });
      wired = true;
    }
  }

  function open() {
    ensureModal();
    backdrop.classList.add('show');
    backdrop.setAttribute('aria-hidden', 'false');
  }

  function close() {
    if (!backdrop) return;
    backdrop.classList.remove('show');
    backdrop.setAttribute('aria-hidden', 'true');
  }

  function renderSessions(sessions) {
    if (!sessions.length) {
      return '<p class="muted">No production sessions recorded for this tank.</p>';
    }
    const rows = sessions
      .map((s) => {
        const phaseCell = s.excluded_from_tank_total
          ? `${escapeHtml(s.phase_name || '—')}<span class="tank-activity-excluded-label">Not included in tank total time</span>`
          : escapeHtml(s.phase_name || '—');
        return `<tr>
          <td>${escapeHtml(s.machine_name || '—')}</td>
          <td>${escapeHtml(s.team_name || '—')}</td>
          <td class="tank-activity-phase-cell">${phaseCell}</td>
          <td>${escapeHtml(fmtDateTime(s.started_at))}</td>
          <td>${escapeHtml(s.finished_at ? fmtDateTime(s.finished_at) : 'In progress')}</td>
          <td>${escapeHtml(s.duration_display || '—')}</td>
          <td>${escapeHtml(statusLabel(s.status))}</td>
          <td>${s.total_estimated_cost != null ? escapeHtml('$' + Number(s.total_estimated_cost).toFixed(2)) : '—'}</td>
          <td>${s.id ? `<button type="button" class="btn btn-sm btn-session-details" data-session-id="${Number(s.id)}">Details</button>` : '—'}</td>
        </tr>`;
      })
      .join('');
    return `<div class="table-wrap table-scroll">
      <table>
        <thead>
          <tr><th>Machine</th><th>Team</th><th>Phase</th><th>Start</th><th>End</th><th>Duration</th><th>Status</th><th>Est. cost</th><th></th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  function renderAlerts(alerts) {
    if (!alerts.length) {
      return '<p class="muted">No alerts recorded for this tank.</p>';
    }
    const rows = alerts
      .map((a) => {
        const cls = a.css_class === 'alert-maint' ? 'alert-maint' : 'alert-qa';
        const st = a.status === 'open' ? 'Open' : 'Resolved';
        return `<tr class="${cls}">
          <td>${escapeHtml(st)}</td>
          <td>${escapeHtml(a.alert_label || a.alert_type || '—')}</td>
          <td>${escapeHtml(a.machine_name || '—')}</td>
          <td>${escapeHtml(a.team_name || '—')}</td>
          <td>${escapeHtml(fmtDateTime(a.reported_at))}</td>
          <td>${escapeHtml(a.resolved_at ? fmtDateTime(a.resolved_at) : '—')}</td>
        </tr>`;
      })
      .join('');
    return `<div class="table-wrap table-scroll">
      <table>
        <thead>
          <tr><th>Status</th><th>Type</th><th>Machine</th><th>Team</th><th>Reported</th><th>Resolved</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  function renderDowntime(intervals, totalDisplay) {
    const rows = Array.isArray(intervals) ? intervals : [];
    if (!rows.length) {
      return '<p class="muted">No downtime recorded for this tank.</p>';
    }
    const body = rows
      .map(
        (d) => `<tr>
          <td>${escapeHtml(fmtDateTime(d.started_at))}</td>
          <td>${escapeHtml(d.ended_at ? fmtDateTime(d.ended_at) : d.open ? 'Open' : '—')}</td>
          <td>${escapeHtml(d.duration_display || '—')}</td>
          <td>${escapeHtml(d.reason_label || d.reason_code || '—')}</td>
          <td>${escapeHtml(d.reason_note || '—')}</td>
          <td>${escapeHtml(d.phase_name || '—')}</td>
        </tr>`
      )
      .join('');
    return `<p class="tank-activity-total"><strong>Total Downtime:</strong> ${escapeHtml(totalDisplay || '—')}</p>
      <div class="table-wrap table-scroll">
      <table>
        <thead>
          <tr><th>Start</th><th>End</th><th>Duration</th><th>Reason</th><th>Note</th><th>Phase</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
  }

  function renderPhaseSummary(summary, totalDisplay) {
    const rows = Array.isArray(summary) ? summary : [];
    if (!rows.length) {
      return '<p class="muted">No phase time summary for this tank yet.</p>';
    }
    const items = rows
      .map((row) => {
        const st = String(row.status || 'not_started');
        const time = st === 'not_started' ? '—' : escapeHtml(row.total_duration_display || '0m');
        const label = row.status_label
          ? escapeHtml(row.status_label)
          : st === 'running'
            ? 'Running'
            : st === 'paused'
              ? 'Paused'
              : st === 'completed'
                ? 'Completed'
                : 'Not Started';
        const completed =
          st === 'completed' && row.completed_at
            ? ` · ${escapeHtml(fmtDateTime(row.completed_at))}`
            : '';
        const notes = row.notes ? `<div class="tank-activity-phase-notes">${escapeHtml(row.notes)}</div>` : '';
        return `<li class="phase-time-summary-item phase-time-summary-item--${escapeHtml(st)}">
          <strong>${escapeHtml(row.phase_name || row.phase_code || '—')}</strong>
          — ${time} — ${label}${completed}
          ${notes}
        </li>`;
      })
      .join('');
    return `<div class="phase-time-summary">
      <p class="tank-activity-total"><strong>Tank Total Running Time:</strong> ${escapeHtml(totalDisplay || '—')}</p>
      <ul class="phase-time-summary-list">${items}</ul>
    </div>`;
  }

  async function openTankActivity(tankNumber) {
    const tank = String(tankNumber || '').trim();
    if (!tank) return;
    open();
    if (titleEl) titleEl.textContent = `Tank Activity · ${tank}`;
    if (bodyEl) bodyEl.innerHTML = '<p class="muted">Loading tank activity…</p>';
    try {
      const res = await fetch(`/api/manager/tank-activity?tank=${encodeURIComponent(tank)}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error((data && data.message) || 'Could not load tank activity.');
      if (!bodyEl) return;
      bodyEl.innerHTML = `
        <h4 class="tank-activity-section-title">Phase Time Summary</h4>
        ${renderPhaseSummary(data.phase_time_summary || [], data.tank_total_running_time_display)}
        <h4 class="tank-activity-section-title">Downtime</h4>
        ${renderDowntime(data.downtime_intervals || [], data.downtime_total_display)}
        <h4 class="tank-activity-section-title">Production Sessions</h4>
        ${renderSessions(data.sessions || [])}
        <h4 class="tank-activity-section-title">Alerts</h4>
        ${renderAlerts(data.alerts || [])}`;
      bodyEl.querySelectorAll('.btn-session-details').forEach((btn) => {
        btn.addEventListener('click', () => {
          const sessionId = btn.getAttribute('data-session-id');
          if (sessionId && root.SessionDetails) root.SessionDetails.open(sessionId);
        });
      });
    } catch (err) {
      if (bodyEl) bodyEl.innerHTML = `<p class="muted">${escapeHtml(err.message || 'Could not load tank activity.')}</p>`;
    }
  }

  root.TankActivity = { open: openTankActivity, close };
})(window);
