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

async function loadMachines() {
  const { res, data } = await api('/api/manager/machine-areas');
  if (!res.ok || !data.ok) {
    machinesBody.innerHTML = `<tr><td colspan="5" class="muted">${escapeHtml((data && data.message) || 'Load failed')}</td></tr>`;
    return;
  }
  const rows = data.machines || [];
  if (!rows.length) {
    machinesBody.innerHTML = '<tr><td colspan="5" class="muted">No machines configured.</td></tr>';
    return;
  }
  machinesBody.innerHTML = rows
    .map(
      (m) => `<tr data-machine-id="${Number(m.id)}">
      <td><input class="ma-name" type="text" value="${escapeHtml(m.name)}" /></td>
      <td><a class="ma-kiosk-link" href="${escapeHtml(m.kiosk_url)}" target="_blank" rel="noopener">${escapeHtml(m.kiosk_url)}</a></td>
      <td><label class="manager-inline-check"><input class="ma-active" type="checkbox"${m.active ? ' checked' : ''} /> Active</label></td>
      <td><input class="ma-sort" type="number" value="${Number(m.sort_order) || 0}" style="width:72px" /></td>
      <td><button type="button" class="btn btn-sm btn-save-machine">Save</button></td>
    </tr>`
    )
    .join('');
}

machinesBody.addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-save-machine');
  if (!btn) return;
  const row = btn.closest('tr');
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
});

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
