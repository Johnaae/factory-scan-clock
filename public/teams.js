'use strict';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const teamsBody = document.getElementById('teamsBody');
const teamHint = document.getElementById('teamHint');
const newTeamName = document.getElementById('newTeamName');
const newTeamBarcode = document.getElementById('newTeamBarcode');
const btnAddTeam = document.getElementById('btnAddTeam');
const logoutBtn = document.getElementById('logoutBtn');
const showInactiveTeams = document.getElementById('showInactiveTeams');

async function api(url, opts) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function hint(msg, isError) {
  if (!teamHint) return;
  teamHint.textContent = msg || '';
  teamHint.className = `toastline manager-alert${isError ? ' manager-alert--error' : ''}`;
}

function memberNameHtml(m) {
  if (window.TeamMemberPicker && window.TeamMemberPicker.memberNameHtml) {
    return window.TeamMemberPicker.memberNameHtml(m);
  }
  return escapeHtml(m.employee_name || m.name || '—');
}

function renderTeams(teams) {
  const includeInactive = !!(showInactiveTeams && showInactiveTeams.checked);
  const visibleTeams = includeInactive ? teams : teams.filter((t) => Number(t.active) !== 0);
  if (!visibleTeams.length) {
    teamsBody.innerHTML = includeInactive
      ? '<p class="muted">No teams yet.</p>'
      : '<p class="muted">No active teams. Check “Show inactive teams” to view deactivated teams.</p>';
    return;
  }
  teamsBody.innerHTML = visibleTeams
    .map((t) => {
      const isActive = Number(t.active) !== 0;
      const members = (t.members || [])
        .filter((m) => Number(m.active) !== 0)
        .map(
          (m) => `<li class="team-member-row">
          <span>${memberNameHtml(m)}${m.role ? ` <span class="muted">(${escapeHtml(m.role)})</span>` : ''}</span>
          <button type="button" class="btn btn-sm btn-remove-member" data-team-id="${Number(t.id)}" data-member-id="${Number(m.id)}">Remove</button>
        </li>`
        )
        .join('');
      const addForm =
        isActive && window.TeamMemberPicker && window.TeamMemberPicker.renderAddMemberForm
          ? window.TeamMemberPicker.renderAddMemberForm(t.id)
          : '';
      const teamActions = isActive
        ? `<button type="button" class="btn btn-sm btn-delete-team" data-team-id="${Number(t.id)}" data-team-name="${escapeHtml(t.name)}">Delete Team</button>`
        : `<button type="button" class="btn btn-sm btn-restore-team" data-team-id="${Number(t.id)}" data-team-name="${escapeHtml(t.name)}">Restore Team</button>`;
      return `<article class="team-card${isActive ? '' : ' team-card--inactive'}" data-team-id="${Number(t.id)}">
        <div class="team-card-head">
          <div class="field" style="flex:1;margin:0">
            <label>Name</label>
            <input class="team-name-input" type="text" value="${escapeHtml(t.name)}" data-team-id="${Number(t.id)}" ${isActive ? '' : 'disabled'} />
          </div>
          <div class="field" style="flex:1;margin:0">
            <label>Barcode</label>
            <input class="team-barcode-input" type="text" value="${escapeHtml(t.barcode)}" data-team-id="${Number(t.id)}" ${isActive ? '' : 'disabled'} />
          </div>
          <button type="button" class="btn btn-sm btn-save-team" data-team-id="${Number(t.id)}" ${isActive ? '' : 'disabled'}>Save</button>
          ${teamActions}
        </div>
        <div class="team-members">
          <h4>Members <span class="muted">(from Employee Directory)</span>${isActive ? '' : ' <span class="muted">· Inactive team</span>'}</h4>
          <ul class="team-member-list">${members || '<li class="muted">No active members.</li>'}</ul>
          ${addForm ? `<div class="team-add-member">${addForm}</div>` : ''}
        </div>
      </article>`;
    })
    .join('');
  if (window.TeamMemberPicker) {
    window.TeamMemberPicker.wireAllPickers(teamsBody, loadTeams);
  }
}

async function loadTeams() {
  const { res, data } = await api('/api/manager/teams/full');
  if (!res.ok || !data.ok) {
    teamsBody.innerHTML = `<p class="muted">${escapeHtml((data && data.message) || 'Could not load teams.')}</p>`;
    return;
  }
  renderTeams(data.teams || []);
}

teamsBody.addEventListener('click', async (e) => {
  const saveBtn = e.target.closest('.btn-save-team');
  if (saveBtn) {
    const teamId = saveBtn.getAttribute('data-team-id');
    const card = saveBtn.closest('.team-card');
    const name = card.querySelector('.team-name-input').value.trim();
    const barcode = card.querySelector('.team-barcode-input').value.trim();
    const { res, data } = await api(`/api/manager/teams/${teamId}`, {
      method: 'PUT',
      body: JSON.stringify({ name, barcode }),
    });
    hint(res.ok ? 'Team saved.' : (data && data.message) || 'Save failed.', !res.ok);
    if (res.ok) void loadTeams();
    return;
  }
  const deleteBtn = e.target.closest('.btn-delete-team');
  if (deleteBtn) {
    const teamId = deleteBtn.getAttribute('data-team-id');
    if (!teamId) return;
    if (!window.confirm('Deactivate this team? Production history will be kept.')) return;
    deleteBtn.disabled = true;
    const { res, data } = await api(`/api/manager/teams/${teamId}`, { method: 'DELETE' });
    hint(res.ok ? 'Team deactivated.' : (data && data.message) || 'Could not deactivate team.', !res.ok);
    if (res.ok) void loadTeams();
    else deleteBtn.disabled = false;
    return;
  }
  const restoreBtn = e.target.closest('.btn-restore-team');
  if (restoreBtn) {
    const teamId = restoreBtn.getAttribute('data-team-id');
    const teamName = restoreBtn.getAttribute('data-team-name') || 'this team';
    if (!teamId) return;
    if (!window.confirm(`Restore ${teamName} to active workflow?`)) return;
    restoreBtn.disabled = true;
    const { res, data } = await api(`/api/manager/teams/${teamId}/restore`, { method: 'PATCH' });
    hint(res.ok ? 'Team restored.' : (data && data.message) || 'Could not restore team.', !res.ok);
    if (res.ok) void loadTeams();
    else restoreBtn.disabled = false;
    return;
  }
  const removeBtn = e.target.closest('.btn-remove-member');
  if (removeBtn) {
    const teamId = removeBtn.getAttribute('data-team-id');
    const memberId = removeBtn.getAttribute('data-member-id');
    if (!window.confirm('Remove this employee from this team?')) return;
    removeBtn.disabled = true;
    const { res, data } = await api(`/api/manager/teams/${teamId}/members/${memberId}`, { method: 'DELETE' });
    hint(res.ok ? 'Member removed.' : (data && data.message) || 'Could not remove member.', !res.ok);
    if (res.ok) void loadTeams();
    else removeBtn.disabled = false;
  }
});

if (showInactiveTeams) {
  showInactiveTeams.addEventListener('change', () => void loadTeams());
}

if (btnAddTeam) {
  btnAddTeam.addEventListener('click', async () => {
    const name = newTeamName.value.trim();
    const barcode = newTeamBarcode.value.trim();
    if (!name || !barcode) {
      hint('Team name and barcode are required.', true);
      return;
    }
    const { res, data } = await api('/api/manager/teams', {
      method: 'POST',
      body: JSON.stringify({ name, barcode }),
    });
    hint(res.ok ? 'Team created.' : (data && data.message) || 'Could not create team.', !res.ok);
    if (res.ok) {
      newTeamName.value = '';
      newTeamBarcode.value = '';
      void loadTeams();
    }
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    window.location.href = '/manager-login';
  });
}

void loadTeams();
