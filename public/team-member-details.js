'use strict';

/** Compact per-member details modal (hours + estimated pay) for team View Members. */
(function initTeamMemberDetails(root) {
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

  function money(n) {
    const v = Number(n);
    return Number.isFinite(v) ? `$${v.toFixed(2)}` : '$0.00';
  }

  function hours(n) {
    const v = Number(n);
    return Number.isFinite(v) ? v.toFixed(2) : '0.00';
  }

  function ensureModal() {
    if (backdrop) return;
    backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop team-member-details-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.innerHTML = `
      <div class="modal team-member-details-modal" role="document">
        <div class="modal-head">
          <h3 class="modal-title" id="teamMemberDetailsTitle">Employee Details</h3>
          <div class="toolbar">
            <button type="button" class="btn btn-sm" data-member-details-close>Close</button>
          </div>
        </div>
        <div class="modal-body team-member-details-body" id="teamMemberDetailsBody"></div>
      </div>`;
    document.body.appendChild(backdrop);
    titleEl = backdrop.querySelector('#teamMemberDetailsTitle');
    bodyEl = backdrop.querySelector('#teamMemberDetailsBody');

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop || e.target.hasAttribute('data-member-details-close')) close();
    });
    if (!wired) {
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && backdrop && backdrop.classList.contains('show')) close();
      });
      wired = true;
    }
  }

  function open(teamId, memberId) {
    ensureModal();
    backdrop.classList.add('show');
    backdrop.setAttribute('aria-hidden', 'false');
    if (titleEl) titleEl.textContent = 'Employee Details';
    if (bodyEl) bodyEl.innerHTML = '<p class="muted">Loading details…</p>';
    void load(teamId, memberId);
  }

  function close() {
    if (!backdrop) return;
    backdrop.classList.remove('show');
    backdrop.setAttribute('aria-hidden', 'true');
  }

  function row(label, value, extraCls) {
    return `<div class="team-member-details-row${extraCls ? ` ${extraCls}` : ''}">
      <dt>${escapeHtml(label)}</dt>
      <dd>${value}</dd>
    </div>`;
  }

  function renderMember(m) {
    if (titleEl) titleEl.textContent = m.name || 'Employee Details';
    const statusCls = m.on_shift ? 'team-member-status--active' : 'team-member-status--inactive';
    const statusText = m.on_shift ? 'Active' : 'Off shift';
    const noTime = !m.has_time_data;
    const timeNote = noTime
      ? '<p class="muted team-member-details-note">No time recorded.</p>'
      : '';
    return `
      <dl class="team-member-details-grid">
        ${row('Employee name', escapeHtml(m.name || '—'))}
        ${row('Employee code', escapeHtml(m.code || '—'))}
        ${row('Status', `<span class="team-member-status ${statusCls}">${statusText}</span>`)}
        ${row('Position / role', escapeHtml(m.role || '—'))}
        ${row('Today hours', hours(m.today_hours))}
        ${row('Week hours', hours(m.week_hours))}
        ${row('Hourly rate', money(m.hourly_rate))}
        ${row('Estimated pay today', money(m.estimated_pay_today))}
        ${row('Estimated pay this week', money(m.estimated_pay_week))}
      </dl>
      ${timeNote}`;
  }

  async function load(teamId, memberId) {
    try {
      const res = await fetch(`/api/manager/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}/details`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !data.member) {
        throw new Error((data && data.message) || 'Could not load member details.');
      }
      if (bodyEl) bodyEl.innerHTML = renderMember(data.member);
    } catch (err) {
      if (bodyEl) bodyEl.innerHTML = `<p class="muted">${escapeHtml(err.message || 'Could not load member details.')}</p>`;
    }
  }

  root.TeamMemberDetails = { open, close };
})(window);
