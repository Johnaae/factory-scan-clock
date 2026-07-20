'use strict';

/** Team production session details — member cost breakdown for one session. */
(function initSessionDetails(root) {
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

  function fmtMoney(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return '$' + n.toFixed(2);
  }

  function fmtHours(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return n.toFixed(2);
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function ensureModal() {
    if (backdrop) return;
    backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop session-details-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.innerHTML = `
      <div class="modal modal-wide session-details-modal" role="document">
        <div class="modal-head">
          <h3 class="modal-title" id="sessionDetailsTitle">Session Details</h3>
          <div class="toolbar">
            <button type="button" class="btn btn-sm" data-session-details-close>Close</button>
          </div>
        </div>
        <div class="modal-body session-details-body" id="sessionDetailsBody"></div>
      </div>`;
    document.body.appendChild(backdrop);
    titleEl = backdrop.querySelector('#sessionDetailsTitle');
    bodyEl = backdrop.querySelector('#sessionDetailsBody');

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop || e.target.hasAttribute('data-session-details-close')) close();
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

  function detailRow(label, value, extraCls) {
    return `<div class="session-details-row${extraCls ? ` ${extraCls}` : ''}">
      <dt>${escapeHtml(label)}</dt>
      <dd>${value}</dd>
    </div>`;
  }

  function renderBody(session) {
    const memberRows = (session.members || []).length
      ? session.members
          .map(
            (m) => `<tr>
          <td>${escapeHtml(m.employee_name)}</td>
          <td>${escapeHtml(m.employee_code || '—')}</td>
          <td>${fmtMoney(m.hourly_rate)}</td>
          <td>${fmtHours(m.hours)}</td>
          <td>${fmtMoney(m.estimated_cost)}</td>
        </tr>`
          )
          .join('')
      : '<tr><td colspan="5" class="muted">No team members snapshotted for this session.</td></tr>';

    return `<dl class="session-details-grid">
      ${detailRow('Team', escapeHtml(session.team_name || '—'))}
      ${detailRow('Tank', escapeHtml(session.tank_number || '—'))}
      ${detailRow('Phase', escapeHtml(session.phase_name || '—'))}
      ${detailRow('Machine', escapeHtml(session.machine_name || '—'))}
      ${detailRow('Start', escapeHtml(fmtDateTime(session.started_at)))}
      ${detailRow('End', escapeHtml(session.finished_at ? fmtDateTime(session.finished_at) : session.status === 'running' ? 'In progress' : session.status === 'stopped' ? fmtDateTime(session.stopped_at) : '—'))}
      ${detailRow('Duration', escapeHtml(session.duration_display || '—'))}
      ${detailRow('Total est. labor cost', `<strong>${fmtMoney(session.total_estimated_cost)}</strong>`, 'session-details-row--highlight')}
    </dl>
    <h4 class="session-details-section-title">Member cost breakdown</h4>
    <p class="muted session-details-note">Estimated labor cost only — not official payroll. Rates are snapshotted when the session started.</p>
    <div class="table-wrap table-scroll">
      <table class="session-details-table">
        <thead>
          <tr><th>Member</th><th>Code</th><th>Hourly rate</th><th>Hours</th><th>Est. cost</th></tr>
        </thead>
        <tbody>${memberRows}</tbody>
      </table>
    </div>`;
  }

  async function openSessionDetails(sessionId) {
    const id = Number(sessionId);
    if (!Number.isInteger(id) || id <= 0) return;
    open();
    if (titleEl) titleEl.textContent = 'Session Details';
    if (bodyEl) bodyEl.innerHTML = '<p class="muted">Loading session details…</p>';
    try {
      const res = await fetch(`/api/manager/sessions/${id}/details`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error((data && data.message) || 'Could not load session details.');
      const session = data.session;
      if (titleEl) {
        titleEl.textContent = `Session · ${session.team_name || 'Team'} · Tank ${session.tank_number || '—'}`;
      }
      if (bodyEl) bodyEl.innerHTML = renderBody(session);
    } catch (err) {
      if (bodyEl) bodyEl.innerHTML = `<p class="muted">${escapeHtml(err.message || 'Could not load session details.')}</p>`;
    }
  }

  root.SessionDetails = { open: openSessionDetails, close };
})(window);
