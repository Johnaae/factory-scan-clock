'use strict';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const machinesBody = document.getElementById('machinesBody');
const machineHint = document.getElementById('machineHint');
const logoutBtn = document.getElementById('logoutBtn');
const showInactiveMachines = document.getElementById('showInactiveMachines');
const removeMachineModal = document.getElementById('removeMachineModal');
const removeMachineTitle = document.getElementById('removeMachineTitle');
const removeMachineBody = document.getElementById('removeMachineBody');
const btnCancelRemoveMachine = document.getElementById('btnCancelRemoveMachine');
const btnConfirmRemoveMachine = document.getElementById('btnConfirmRemoveMachine');

let pendingRemove = null;

async function api(url, opts) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function hint(msg, isError) {
  if (!machineHint) return;
  machineHint.textContent = msg || '';
  machineHint.className = `toastline manager-alert${isError ? ' manager-alert--error' : ''}`;
}

function closeRemoveModal() {
  pendingRemove = null;
  if (!removeMachineModal) return;
  removeMachineModal.classList.remove('show');
  removeMachineModal.hidden = true;
}

function openRemoveModal(machine) {
  pendingRemove = machine;
  if (!removeMachineModal) return;
  if (removeMachineTitle) removeMachineTitle.textContent = `Remove ${machine.name}?`;
  if (removeMachineBody) {
    removeMachineBody.textContent =
      'If this machine was never used, it will be permanently deleted. If it has production history, it will be deactivated instead and kept for reports.';
  }
  removeMachineModal.hidden = false;
  removeMachineModal.classList.add('show');
}

async function loadMachines() {
  const showInactive = showInactiveMachines && showInactiveMachines.checked;
  const q = showInactive ? '?show_inactive=1' : '?show_inactive=0';
  const { res, data } = await api(`/api/manager/machine-areas${q}`);
  if (!res.ok || !data.ok) {
    machinesBody.innerHTML = `<tr><td colspan="5" class="muted">${escapeHtml((data && data.message) || 'Load failed')}</td></tr>`;
    return;
  }
  const rows = data.machines || [];
  if (!rows.length) {
    machinesBody.innerHTML = `<tr><td colspan="5" class="muted">${
      showInactive ? 'No machines configured.' : 'No active machines. Enable “Show inactive machines” to view deactivated ones.'
    }</td></tr>`;
    return;
  }
  machinesBody.innerHTML = rows
    .map((m) => {
      const inactive = !m.active;
      return `<tr data-machine-id="${Number(m.id)}" data-machine-name="${escapeHtml(m.name)}" class="${
        inactive ? 'ma-inactive-row' : ''
      }">
      <td>
        <input class="ma-name" type="text" value="${escapeHtml(m.name)}" />
        ${inactive ? '<span class="ma-badge ma-badge--inactive">Inactive</span>' : ''}
      </td>
      <td><a class="ma-kiosk-link" href="${escapeHtml(m.kiosk_url)}" target="_blank" rel="noopener">${escapeHtml(
        m.kiosk_url
      )}</a></td>
      <td><label class="manager-inline-check"><input class="ma-active" type="checkbox"${
        m.active ? ' checked' : ''
      } /> Active</label></td>
      <td><input class="ma-sort" type="number" value="${Number(m.sort_order) || 0}" style="width:72px" /></td>
      <td class="ma-actions">
        <button type="button" class="btn btn-sm btn-save-machine">Save</button>
        <button type="button" class="btn btn-sm btn-remove-machine">${inactive ? 'Delete' : 'Remove'}</button>
      </td>
    </tr>`;
    })
    .join('');
}

machinesBody.addEventListener('click', async (e) => {
  const saveBtn = e.target.closest('.btn-save-machine');
  if (saveBtn) {
    const row = saveBtn.closest('tr');
    const id = row.getAttribute('data-machine-id');
    const { res, data } = await api(`/api/manager/machine-areas/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: row.querySelector('.ma-name').value.trim(),
        sort_order: Number(row.querySelector('.ma-sort').value) || 0,
        active: row.querySelector('.ma-active').checked,
      }),
    });
    hint(res.ok ? 'Machine saved.' : (data && data.message) || 'Save failed.', !res.ok);
    if (res.ok) void loadMachines();
    return;
  }

  const removeBtn = e.target.closest('.btn-remove-machine');
  if (removeBtn) {
    const row = removeBtn.closest('tr');
    openRemoveModal({
      id: Number(row.getAttribute('data-machine-id')),
      name: row.getAttribute('data-machine-name') || row.querySelector('.ma-name').value.trim(),
    });
  }
});

if (btnCancelRemoveMachine) {
  btnCancelRemoveMachine.addEventListener('click', () => closeRemoveModal());
}
if (removeMachineModal) {
  removeMachineModal.addEventListener('click', (e) => {
    if (e.target === removeMachineModal) closeRemoveModal();
  });
}
if (btnConfirmRemoveMachine) {
  btnConfirmRemoveMachine.addEventListener('click', async () => {
    if (!pendingRemove || !pendingRemove.id) return;
    const { res, data } = await api(`/api/manager/machine-areas/${pendingRemove.id}/remove`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    closeRemoveModal();
    hint(res.ok ? data.message || 'Machine removed.' : (data && data.message) || 'Remove failed.', !res.ok);
    if (res.ok) void loadMachines();
  });
}

if (showInactiveMachines) {
  showInactiveMachines.addEventListener('change', () => void loadMachines());
}

const btnAddMachine = document.getElementById('btnAddMachine');
if (btnAddMachine) {
  btnAddMachine.addEventListener('click', async () => {
    const name = document.getElementById('newMachineName').value.trim();
    if (!name) {
      hint('Machine name is required.', true);
      return;
    }
    const { res, data } = await api('/api/manager/machine-areas', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    if (res.ok && data.machine) {
      hint(`Machine added. Kiosk URL: ${data.machine.kiosk_url}`, false);
      document.getElementById('newMachineName').value = '';
      void loadMachines();
      return;
    }
    hint((data && data.message) || 'Could not add machine.', true);
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    window.location.href = '/manager-login';
  });
}

void loadMachines();
