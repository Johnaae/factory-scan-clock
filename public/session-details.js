'use strict';

/** Team production session details — read-only audit / history (no editing). */
(function initSessionDetails(root) {
  let backdrop = null;
  let titleEl = null;
  let bodyEl = null;
  let currentSessionId = null;

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
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function fmtDurationMs(ms) {
    const totalMin = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
    if (totalMin < 1) return '0m';
    if (totalMin < 60) return `${totalMin}m`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
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
          <h3 id="sessionDetailsTitle">Session Details</h3>
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
    currentSessionId = null;
  }

  function detailRow(label, valueHtml, extraCls) {
    return `<div class="session-details-row${extraCls ? ` ${extraCls}` : ''}">
      <dt>${escapeHtml(label)}</dt><dd>${valueHtml}</dd>
    </div>`;
  }

  function endLabel(session) {
    if (session.finished_at) return fmtDateTime(session.finished_at);
    if (session.status === 'running') return 'In progress';
    if (session.status === 'stopped') return fmtDateTime(session.stopped_at);
    return '—';
  }

  function renderAuditBlock(session, edits) {
    if (!edits.length) return '';
    const latest = edits[0];
    const originalDuration =
      latest.original_duration_ms != null
        ? fmtDurationMs(latest.original_duration_ms)
        : '—';
    const correctedDuration =
      latest.edited_duration_ms != null
        ? fmtDurationMs(latest.edited_duration_ms)
        : session.duration_display || '—';

    const priorEdits =
      edits.length > 1
        ? `<h4 class="session-details-section-title">Earlier edits</h4>
           <ul class="session-details-edits">${edits
             .slice(1)
             .map(
               (e) =>
                 `<li>${escapeHtml(fmtDateTime(e.edited_at))} by ${escapeHtml(
                   e.edited_by_name || 'Manager'
                 )}: ${escapeHtml(e.edit_reason || '')}<br/>
                 <span class="muted">${escapeHtml(fmtDateTime(e.original_started_at))} → ${escapeHtml(
                   fmtDateTime(e.original_ended_at)
                 )} became ${escapeHtml(fmtDateTime(e.edited_started_at))} → ${escapeHtml(
                   fmtDateTime(e.edited_ended_at)
                 )}</span></li>`
             )
             .join('')}</ul>`
        : '';

    return `
      <div class="session-audit-panel">
        <h4 class="session-details-section-title">Correction audit <span class="badge badge-warn">Edited</span></h4>
        <div class="session-audit-compare">
          <div class="session-audit-col">
            <h5>Original</h5>
            <dl class="session-details-grid">
              ${detailRow('Start', escapeHtml(fmtDateTime(latest.original_started_at)))}
              ${detailRow('End', escapeHtml(fmtDateTime(latest.original_ended_at)))}
              ${detailRow('Duration', escapeHtml(originalDuration))}
            </dl>
          </div>
          <div class="session-audit-col">
            <h5>Corrected</h5>
            <dl class="session-details-grid">
              ${detailRow('Start', escapeHtml(fmtDateTime(latest.edited_started_at || session.started_at)))}
              ${detailRow('End', escapeHtml(fmtDateTime(latest.edited_ended_at || session.finished_at || session.stopped_at)))}
              ${detailRow('Duration', escapeHtml(correctedDuration))}
            </dl>
          </div>
        </div>
        <dl class="session-details-grid">
          ${detailRow('Edited', 'Yes')}
          ${detailRow('Edited By', escapeHtml(latest.edited_by_name || 'Manager'))}
          ${detailRow('Edited At', escapeHtml(fmtDateTime(latest.edited_at)))}
          ${detailRow('Edit Reason', escapeHtml(latest.edit_reason || '—'))}
        </dl>
        ${priorEdits}
      </div>`;
  }

  function renderBody(session) {
    const edits = session.edits || [];
    const memberRows = (session.members || []).length
      ? (session.members || [])
          .map(
            (m) => `<tr>
          <td>${escapeHtml(m.employee_name || '—')}</td>
          <td>${escapeHtml(m.employee_code || '—')}</td>
          <td>${fmtMoney(m.hourly_rate)}</td>
          <td>${fmtHours(m.hours)}</td>
          <td>${fmtMoney(m.estimated_cost)}</td>
        </tr>`
          )
          .join('')
      : '<tr><td colspan="5" class="muted">No team members snapshotted for this session.</td></tr>';

    return `
    <p class="muted session-details-note">Read-only history. Use <strong>Edit Phase Time</strong> on the Tank Report to correct times.</p>
    <dl class="session-details-grid">
      ${detailRow('Phase', escapeHtml(session.phase_name || '—'))}
      ${detailRow('Piece', escapeHtml(session.piece_number != null ? `Piece ${session.piece_number}` : '—'))}
      ${detailRow('Team', escapeHtml(session.team_name || '—'))}
      ${detailRow('Machine', escapeHtml(session.machine_name || '—'))}
      ${detailRow('Tank', escapeHtml(session.tank_number || '—'))}
      ${detailRow('Start', escapeHtml(fmtDateTime(session.started_at)))}
      ${detailRow('End', escapeHtml(endLabel(session)))}
      ${detailRow('Duration', escapeHtml(session.duration_display || '—'))}
      ${detailRow(
        'Status',
        `${escapeHtml(session.status_label || session.status || '—')}${
          edits.length ? ' <span class="badge badge-warn">Edited</span>' : ''
        }`
      )}
    </dl>

    ${renderAuditBlock(session, edits)}

    <h4 class="session-details-section-title">Member cost breakdown</h4>
    <p class="muted session-details-note">Snapshot rates for estimate only — tank labor hours use membership history.</p>
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
    currentSessionId = id;
    open();
    if (titleEl) titleEl.textContent = 'Session Details';
    if (bodyEl) bodyEl.innerHTML = '<p class="muted">Loading session details…</p>';
    try {
      const res = await fetch(`/api/manager/sessions/${id}/details`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error((data && data.message) || 'Could not load session details.');
      const session = data.session;
      if (titleEl) {
        titleEl.textContent = `${session.phase_name || 'Session'} · Piece ${
          session.piece_number != null ? session.piece_number : '—'
        } · Tank ${session.tank_number || '—'}`;
      }
      if (bodyEl) bodyEl.innerHTML = renderBody(session);
    } catch (err) {
      if (bodyEl) bodyEl.innerHTML = `<p class="muted">${escapeHtml(err.message || 'Could not load session details.')}</p>`;
    }
  }

  root.SessionDetails = { open: openSessionDetails, close };
})(window);
