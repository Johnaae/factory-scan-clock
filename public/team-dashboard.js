'use strict';

/** Team-centric production cards with collapsible member rosters. */
(function initTeamDashboard(root) {
  const POLL_MS = 8000;
  const FETCH_TIMEOUT_MS = 20000;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function fetchJson(url, opts) {
    const options = opts || {};
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), options.timeoutMs || FETCH_TIMEOUT_MS)
      : null;
    try {
      const res = await fetch(url, {
        cache: 'no-store',
        ...options,
        signal: controller ? controller.signal : undefined,
      });
      const data = await res.json().catch(() => ({}));
      return { res, data };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('Request timed out. The server may still be starting — please retry.');
      }
      throw new Error((err && err.message) || 'Network error');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function renderLoadError(message) {
    return `<div class="manager-load-error" role="alert">
      <p class="manager-load-error-msg">${escapeHtml(message || 'Could not load data.')}</p>
      <button type="button" class="btn btn-sm btn-primary" data-retry="teams">Retry</button>
    </div>`;
  }

  function statusLabel(st, statusLabelText) {
    if (statusLabelText) return statusLabelText;
    if (!st || st === 'idle') return 'Idle';
    if (st === 'running') return 'Running';
    if (st === 'stopped' || st === 'paused') return 'Paused';
    return st.charAt(0).toUpperCase() + st.slice(1);
  }

  function statusClass(st) {
    if (st === 'running') return 'team-dashboard-status--running';
    if (st === 'stopped' || st === 'paused') return 'team-dashboard-status--idle';
    return 'team-dashboard-status--idle';
  }

  function fmtMoney(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return '$' + n.toFixed(2);
  }

  function renderSessionDetailsBtn(sessionId) {
    const id = Number(sessionId);
    if (!Number.isInteger(id) || id <= 0) return '';
    return `<button type="button" class="btn btn-sm btn-session-details" data-session-id="${id}">Details</button>`;
  }

  function renderMemberRow(m, teamId, opts) {
    const rosterInactive = !m.active;
    const onShift = Boolean(m.on_shift);
    const status = rosterInactive ? 'Inactive' : onShift ? 'Active' : 'Off shift';
    const statusCls =
      rosterInactive || !onShift ? 'team-member-status--inactive' : 'team-member-status--active';
    const rowMuted = rosterInactive || !onShift;
    const role = m.role ? `<span class="muted team-member-role">${escapeHtml(m.role)}</span>` : '';
    const nameHtml =
      root.TeamMemberPicker && root.TeamMemberPicker.memberNameHtml
        ? root.TeamMemberPicker.memberNameHtml(m)
        : `<span class="team-member-detail-name">${escapeHtml(m.name)}</span>`;
    const showActions = opts && opts.allowMemberEdit;
    const detailsBtn = showActions
      ? `<button type="button" class="btn btn-sm btn-member-details" data-team-id="${teamId}" data-member-id="${m.id}" data-member-name="${escapeHtml(m.employee_name || m.name || '')}">Details</button>`
      : '';
    const removeBtn =
      showActions && m.active
        ? `<button type="button" class="btn btn-sm btn-remove-member" data-team-id="${teamId}" data-member-id="${m.id}">Remove</button>`
        : '';
    const actions = detailsBtn || removeBtn ? `<div class="team-member-detail-actions">${detailsBtn}${removeBtn}</div>` : '';
    return `<li class="team-member-detail-row${rowMuted ? ' team-member-detail-row--inactive' : ''}">
      <div class="team-member-detail-main">
        ${nameHtml}
        ${role}
        <span class="team-member-status ${statusCls}">${status}</span>
      </div>
      ${actions}
    </li>`;
  }

  function renderTankCell(tank) {
    const t = tank && String(tank).trim();
    if (!t || t === '—') return '—';
    return `<span class="machine-card-tank-line"><span>${escapeHtml(t)}</span>` +
      `<button type="button" class="btn btn-sm btn-view-tank-activity" data-tank="${escapeHtml(t)}">View Tank Activity</button></span>`;
  }

  function renderMembersHtml(team, opts) {
    const allMembers = team.members || [];
    const activeMembers = allMembers.filter((m) => m.active);
    const memberRows = activeMembers.length
      ? activeMembers.map((m) => renderMemberRow(m, team.id, opts)).join('')
      : '<li class="muted team-member-detail-empty">No active members.</li>';
    const addMemberForm =
      opts && opts.allowMemberEdit && team.active && root.TeamMemberPicker
        ? `<div class="team-add-member-form">${root.TeamMemberPicker.renderAddMemberForm(team.id, { floatDropdown: true })}</div>`
        : '';
    return `<ul class="team-member-detail-list">${memberRows}</ul>${addMemberForm}`;
  }

  function teamActionBtn(team, opts) {
    if (!opts || !opts.allowMemberEdit) return '';
    if (team.active) {
      return `<button type="button" class="btn btn-sm btn-delete-team" data-team-id="${team.id}" data-team-name="${escapeHtml(team.name)}">Delete Team</button>`;
    }
    return `<button type="button" class="btn btn-sm btn-restore-team" data-team-id="${team.id}" data-team-name="${escapeHtml(team.name)}">Restore Team</button>`;
  }

  function renderPhaseSummaryHtml(summary) {
    if (!summary || !summary.length) return '';
    const items = summary
      .map(
        (row) =>
          `<li class="phase-time-summary-item phase-time-summary-item--${escapeHtml(row.status || 'not_started')}">${escapeHtml(row.summary_line || row.phase_name || '')}</li>`
      )
      .join('');
    return `<div class="phase-time-summary" data-field="phase-summary">
      <h4 class="phase-time-summary-title">Phase Time Summary</h4>
      <ul class="phase-time-summary-list">${items}</ul>
    </div>`;
  }

  function renderActiveSessionsHtml(sessions) {
    if (!sessions || !sessions.length) return '';
    const byTank = new Map();
    for (const s of sessions) {
      const key = String(s.tank_number || s.tank_id || '');
      if (!byTank.has(key)) {
        byTank.set(key, { tank_number: s.tank_number, items: [] });
      }
      byTank.get(key).items.push(s);
    }
    const groups = Array.from(byTank.values()).sort((a, b) =>
      String(a.tank_number || '').localeCompare(String(b.tank_number || ''), undefined, {
        numeric: true,
        sensitivity: 'base',
      })
    );
    const body = groups
      .map((g) => {
        const pieces = g.items
          .slice()
          .sort((a, b) => Number(a.piece_number) - Number(b.piece_number))
          .map(
            (s) =>
              `<li class="team-active-session-piece">Piece ${Number(s.piece_number) || 1} · ${escapeHtml(String(s.phase_name || '—'))} · ${escapeHtml(String(s.running_time_display || s.elapsed_display || s.status_label || s.status || '—'))}</li>`
          )
          .join('');
        return `<li class="team-active-session-tank">
          <strong>Tank ${escapeHtml(String(g.tank_number || '—'))}</strong>
          <ul class="team-active-session-pieces">${pieces}</ul>
        </li>`;
      })
      .join('');
    return `<div class="team-active-sessions" data-field="active-sessions">
      <h4 class="phase-time-summary-title">Active Production</h4>
      <ul class="phase-time-summary-list team-active-session-groups">${body}</ul>
    </div>`;
  }

  function renderTeamCard(team, opts) {
    const st = team.status || 'idle';
    const actionBtn = teamActionBtn(team, opts);

    return `<article class="team-dashboard-card ${!team.active ? 'team-dashboard-card--inactive' : ''}" data-team-id="${team.id}">
      <header class="team-dashboard-card-head">
        <h3 class="team-dashboard-card-title">${escapeHtml(team.name)}</h3>
        <div class="team-dashboard-head-actions">
          <span class="team-dashboard-status ${statusClass(st)}" data-field="status">${escapeHtml(team.active ? statusLabel(st, team.status_label) : 'Inactive')}</span>
          <span class="team-dashboard-head-btns" data-field="team-actions">${actionBtn}</span>
        </div>
      </header>
      <dl class="team-dashboard-grid">
        <div><dt>Current Machine</dt><dd data-field="machine">${escapeHtml(team.current_machine || '—')}</dd></div>
        <div><dt>Current Tank</dt><dd data-field="tank">${renderTankCell(team.current_tank)}</dd></div>
        <div><dt>Current Phase</dt><dd data-field="phase">${escapeHtml(team.current_phase || '—')}</dd></div>
        <div class="team-dashboard-time-block">
          <div><dt>Current Phase Time</dt><dd class="team-dashboard-elapsed" data-field="elapsed">${escapeHtml(team.running_time_display || team.elapsed_display || '—')}</dd></div>
          <div><dt>Tank Total Running Time</dt><dd data-field="tank-total">${escapeHtml(team.tank_total_running_time_display || '—')}</dd></div>
        </div>
        <div><dt>Est. Labor Cost</dt><dd data-field="labor-cost">${team.estimated_labor_cost != null ? escapeHtml(fmtMoney(team.estimated_labor_cost)) : '—'}</dd></div>
        <div><dt>Members</dt><dd data-field="member-count">${Number(team.member_count) || 0}</dd></div>
      </dl>
      ${team.phase_time_summary && team.phase_time_summary.length ? renderPhaseSummaryHtml(team.phase_time_summary) : ''}
      ${team.active_sessions && team.active_sessions.length ? renderActiveSessionsHtml(team.active_sessions) : ''}
      <div class="team-dashboard-session-actions" data-field="session-actions">${renderSessionDetailsBtn(team.session_id)}</div>
      <details class="team-members-collapse">
        <summary class="team-members-collapse-summary">View Members</summary>
        <div class="team-members-collapse-content">${renderMembersHtml(team, opts)}</div>
      </details>
    </article>`;
  }

  /** Update a team card's dynamic fields in place; keep <details> open state and member DOM stable. */
  function updateTeamCardInPlace(cardEl, team, opts) {
    const st = team.status || 'idle';
    cardEl.classList.toggle('team-dashboard-card--inactive', !team.active);
    const setField = (name, html) => {
      const elx = cardEl.querySelector(`[data-field="${name}"]`);
      if (elx && elx.innerHTML !== html) elx.innerHTML = html;
    };
    const statusEl = cardEl.querySelector('[data-field="status"]');
    if (statusEl) {
      statusEl.className = `team-dashboard-status ${statusClass(st)}`;
      const label = escapeHtml(team.active ? statusLabel(st, team.status_label) : 'Inactive');
      if (statusEl.innerHTML !== label) statusEl.innerHTML = label;
    }
    setField('machine', escapeHtml(team.current_machine || '—'));
    setField('tank', renderTankCell(team.current_tank));
    setField('phase', escapeHtml(team.current_phase || '—'));
    setField('elapsed', escapeHtml(team.running_time_display || team.elapsed_display || '—'));
    setField('tank-total', escapeHtml(team.tank_total_running_time_display || '—'));
    setField('labor-cost', team.estimated_labor_cost != null ? escapeHtml(fmtMoney(team.estimated_labor_cost)) : '—');
    setField('member-count', String(Number(team.member_count) || 0));
    const phaseSummaryEl = cardEl.querySelector('[data-field="phase-summary"]');
    const nextPhaseSummary =
      team.phase_time_summary && team.phase_time_summary.length ? renderPhaseSummaryHtml(team.phase_time_summary) : '';
    if (phaseSummaryEl && nextPhaseSummary !== phaseSummaryEl.outerHTML) {
      phaseSummaryEl.outerHTML = nextPhaseSummary || '';
    } else if (!phaseSummaryEl && nextPhaseSummary) {
      const actionsEl = cardEl.querySelector('[data-field="session-actions"]');
      if (actionsEl) actionsEl.insertAdjacentHTML('beforebegin', nextPhaseSummary);
    } else if (phaseSummaryEl && !nextPhaseSummary) {
      phaseSummaryEl.remove();
    }
    const activeSessionsEl = cardEl.querySelector('[data-field="active-sessions"]');
    const nextActiveSessions =
      team.active_sessions && team.active_sessions.length
        ? renderActiveSessionsHtml(team.active_sessions)
        : '';
    if (activeSessionsEl && nextActiveSessions !== activeSessionsEl.outerHTML) {
      activeSessionsEl.outerHTML = nextActiveSessions || '';
    } else if (!activeSessionsEl && nextActiveSessions) {
      const actionsEl = cardEl.querySelector('[data-field="session-actions"]');
      if (actionsEl) actionsEl.insertAdjacentHTML('beforebegin', nextActiveSessions);
    } else if (activeSessionsEl && !nextActiveSessions) {
      activeSessionsEl.remove();
    }
    const sessionActionsEl = cardEl.querySelector('[data-field="session-actions"]');
    if (sessionActionsEl) {
      const nextActions = renderSessionDetailsBtn(team.session_id);
      if (sessionActionsEl.innerHTML !== nextActions) sessionActionsEl.innerHTML = nextActions;
    }
    const actionsEl = cardEl.querySelector('[data-field="team-actions"]');
    if (actionsEl && opts && opts.allowMemberEdit) {
      const nextActions = teamActionBtn(team, opts);
      if (actionsEl.innerHTML !== nextActions) actionsEl.innerHTML = nextActions;
    }

    // Only refresh member list when its content changed AND the user isn't typing in the add-member inputs.
    const details = cardEl.querySelector('.team-members-collapse');
    const contentEl = cardEl.querySelector('.team-members-collapse-content');
    if (contentEl) {
      const active = document.activeElement;
      const typingHere =
        active &&
        contentEl.contains(active) &&
        (active.tagName === 'INPUT' || active.tagName === 'BUTTON');
      if (!typingHere) {
        const nextHtml = renderMembersHtml(team, opts);
        if (contentEl.innerHTML !== nextHtml) contentEl.innerHTML = nextHtml;
      }
    }
    void details;
  }

  function wireSessionDetailsButtons(container) {
    if (!container) return;
    container.querySelectorAll('.btn-session-details').forEach((btn) => {
      if (btn.dataset.wired === '1') return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', () => {
        const sessionId = btn.getAttribute('data-session-id');
        if (sessionId && root.SessionDetails) root.SessionDetails.open(sessionId);
      });
    });
  }

  function wireTankActivityButtons(container) {
    if (!container) return;
    container.querySelectorAll('.btn-view-tank-activity').forEach((btn) => {
      if (btn.dataset.wired === '1') return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', () => {
        const tank = btn.getAttribute('data-tank');
        if (tank && root.TankActivity) root.TankActivity.open(tank);
      });
    });
  }

  async function fetchTeams() {
    const { res, data } = await fetchJson('/api/manager/teams/dashboard');
    if (!res.ok || !data.ok) throw new Error((data && data.message) || 'Could not load teams');
    return data.teams || [];
  }

  async function removeMember(teamId, memberId) {
    const res = await fetch(`/api/manager/teams/${teamId}/members/${memberId}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error((data && data.message) || 'Could not remove member');
  }

  function wirePickers(container, onChanged) {
    if (root.TeamMemberPicker) root.TeamMemberPicker.wireAllPickers(container, onChanged);
  }

  async function deactivateTeam(teamId) {
    const res = await fetch(`/api/manager/teams/${teamId}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error((data && data.message) || 'Could not delete team');
  }

  async function restoreTeam(teamId) {
    const res = await fetch(`/api/manager/teams/${teamId}/restore`, { method: 'PATCH' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error((data && data.message) || 'Could not restore team');
  }

  function wireMemberActions(container, onChanged, opts) {
    if (!container || !opts || !opts.allowMemberEdit) return;
    container.querySelectorAll('.btn-delete-team').forEach((btn) => {
      if (btn.dataset.wired === '1') return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', async () => {
        const teamId = btn.getAttribute('data-team-id');
        if (!teamId) return;
        if (!window.confirm('Deactivate this team? Production history will be kept.')) return;
        btn.disabled = true;
        try {
          await deactivateTeam(teamId);
          if (onChanged) await onChanged();
        } catch (err) {
          alert(err.message || 'Could not delete team.');
          btn.disabled = false;
        }
      });
    });
    container.querySelectorAll('.btn-restore-team').forEach((btn) => {
      if (btn.dataset.wired === '1') return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', async () => {
        const teamId = btn.getAttribute('data-team-id');
        const teamName = btn.getAttribute('data-team-name') || 'this team';
        if (!teamId) return;
        if (!window.confirm(`Restore ${teamName} to active workflow?`)) return;
        btn.disabled = true;
        try {
          await restoreTeam(teamId);
          if (onChanged) await onChanged();
        } catch (err) {
          alert(err.message || 'Could not restore team.');
          btn.disabled = false;
        }
      });
    });
    container.querySelectorAll('.btn-member-details').forEach((btn) => {
      if (btn.dataset.wired === '1') return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', () => {
        const teamId = btn.getAttribute('data-team-id');
        const memberId = btn.getAttribute('data-member-id');
        if (!teamId || !memberId || !root.TeamMemberDetails) return;
        root.TeamMemberDetails.open(teamId, memberId);
      });
    });
    container.querySelectorAll('.btn-remove-member').forEach((btn) => {
      if (btn.dataset.wired === '1') return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', async () => {
        const teamId = btn.getAttribute('data-team-id');
        const memberId = btn.getAttribute('data-member-id');
        if (!teamId || !memberId) return;
        if (!window.confirm('Remove this employee from this team?')) return;
        btn.disabled = true;
        try {
          await removeMember(teamId, memberId);
          if (onChanged) await onChanged();
        } catch (err) {
          alert(err.message || 'Could not remove member.');
          btn.disabled = false;
        }
      });
    });
  }

  function mount(containerId, opts) {
    const el = document.getElementById(containerId);
    if (!el) return null;
    const options = opts || {};
    const showInactiveControl = options.inactiveToggleId ? document.getElementById(options.inactiveToggleId) : null;

    function syncTeams(visibleTeams) {
      let wrap = el.querySelector('.team-dashboard-grid-wrap');
      const signature = visibleTeams.map((t) => Number(t.id)).join(',');
      if (!wrap || el.dataset.teamSignature !== signature) {
        el.innerHTML = `<div class="team-dashboard-grid-wrap">${visibleTeams.map((t) => renderTeamCard(t, options)).join('')}</div>`;
        el.dataset.teamSignature = signature;
        wrap = el.querySelector('.team-dashboard-grid-wrap');
      } else {
        visibleTeams.forEach((t) => {
          const cardEl = wrap.querySelector(`.team-dashboard-card[data-team-id="${Number(t.id)}"]`);
          if (cardEl) updateTeamCardInPlace(cardEl, t, options);
        });
      }
      wireMemberActions(el, refresh, options);
      wirePickers(el, refresh);
      wireTankActivityButtons(el);
      wireSessionDetailsButtons(el);
    }

    async function refresh() {
      try {
        const teams = await fetchTeams();
        const includeInactive = !!(showInactiveControl && showInactiveControl.checked);
        const visibleTeams = includeInactive ? teams : teams.filter((t) => t.active);
        if (!visibleTeams.length) {
          el.innerHTML = '<p class="muted">No teams configured. <a href="/teams">Manage Teams</a> to add one.</p>';
          el.dataset.teamSignature = '';
          return;
        }
        syncTeams(visibleTeams);
      } catch (err) {
        el.dataset.teamSignature = '';
        el.innerHTML = renderLoadError(err.message || 'Could not load teams');
        const btn = el.querySelector('[data-retry]');
        if (btn) btn.addEventListener('click', () => {
          el.innerHTML = '<p class="muted">Loading teams…</p>';
          void refresh();
        });
      }
    }

    void refresh();
    if (showInactiveControl)
      showInactiveControl.addEventListener('change', () => {
        el.dataset.teamSignature = '';
        void refresh();
      });
    const timer = setInterval(() => void refresh(), POLL_MS);
    return { refresh, stop: () => clearInterval(timer) };
  }

  root.TeamDashboard = { mount, fetchTeams, renderTeamCard };
})(window);
