const empBody = document.getElementById('empBody');
const search = document.getElementById('search');
const adminHint = document.getElementById('adminHint');

const modalBackdrop = document.getElementById('modalBackdrop');
const modalTitle = document.getElementById('modalTitle');
const modalHint = document.getElementById('modalHint');
const fCode = document.getElementById('fCode');
const fName = document.getElementById('fName');
const fRate = document.getElementById('fRate');
const fStatus = document.getElementById('fStatus');

const btnAdd = document.getElementById('btnAdd');
const btnCloseModal = document.getElementById('btnCloseModal');
const btnCancel = document.getElementById('btnCancel');
const btnSave = document.getElementById('btnSave');
const logoutBtn = document.getElementById('logoutBtn');

let employees = [];
let editingId = null;
let searchTimer = null;

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalizeEmployee(e) {
  if (!e) return e;
  return {
    ...e,
    id: Number(e.id),
    is_active: !!e.is_active,
    hourly_rate: Number.isFinite(Number(e.hourly_rate)) ? Number(e.hourly_rate) : 20,
  };
}

async function apiJson(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function formatMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(v);
}

function parseRateInput() {
  const n = Number(String(fRate.value || '').trim());
  if (!Number.isFinite(n) || n < 0) return 20;
  return Math.round(n * 100) / 100;
}

function openModal() {
  modalBackdrop.classList.add('show');
  modalBackdrop.setAttribute('aria-hidden', 'false');
}

function closeModal() {
  modalBackdrop.classList.remove('show');
  modalBackdrop.setAttribute('aria-hidden', 'true');
  editingId = null;
  modalHint.textContent = '';
}

function render() {
  const q = search.value.trim().toLowerCase();
  const rows = employees
    .filter((e) => {
      if (!q) return true;
      return e.code.toLowerCase().includes(q) || e.name.toLowerCase().includes(q);
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .map((e) => {
      const st = e.is_active ? '<span class="badge badge-in">Active</span>' : '<span class="badge badge-muted">Inactive</span>';
      const rate = formatMoney(e.hourly_rate != null ? e.hourly_rate : 20);
      const eid = escapeHtml(String(e.id));
      return `<tr>
        <td><strong>${escapeHtml(e.code)}</strong></td>
        <td>${escapeHtml(e.name)}</td>
        <td class="td-num">${escapeHtml(rate)}</td>
        <td>${st}</td>
        <td>
          <div class="toolbar" style="justify-content:flex-start">
            <button class="btn btn-sm edit-employee-btn" type="button" data-id="${eid}" data-employee-id="${eid}">Edit</button>
            <button class="btn btn-sm" type="button" data-act="toggle" data-id="${eid}">${e.is_active ? 'Deactivate' : 'Activate'}</button>
            <button class="btn btn-danger btn-sm" type="button" data-act="del" data-id="${eid}">Delete</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');

  empBody.innerHTML = rows || '<tr><td colspan="5" class="muted">No employees found.</td></tr>';
}

async function load() {
  adminHint.textContent = 'Loading…';
  const { res, data } = await apiJson('/api/employees');
  if (!res.ok) {
    adminHint.textContent = 'Could not load employees.';
    return;
  }
  employees = (data.employees || []).map(normalizeEmployee);
  adminHint.textContent = `${employees.length} employee${employees.length === 1 ? '' : 's'} loaded.`;
  render();
}

function startCreate() {
  editingId = null;
  modalTitle.textContent = 'Add employee';
  fCode.value = '';
  fName.value = '';
  fRate.value = '20';
  fStatus.value = 'ACTIVE';
  fCode.disabled = false;
  modalHint.textContent = '';
  openModal();
  window.setTimeout(() => fCode.focus(), 0);
}

async function openEmployeeEditModal(rawId) {
  console.log('Opening edit modal');
  const idNum = Number(rawId);
  if (!Number.isFinite(idNum) || idNum <= 0) {
    return;
  }
  let e = employees.find((x) => x.id === idNum);
  if (!e) {
    const { res, data } = await apiJson(`/api/employees/${idNum}`);
    if (!res.ok || !data.employee) {
      adminHint.textContent = (data && data.message) || 'Could not load employee.';
      return;
    }
    e = normalizeEmployee(data.employee);
  }
  editingId = idNum;
  modalTitle.textContent = 'Edit employee';
  fCode.value = e.code;
  fName.value = e.name;
  fRate.value = String(Number.isFinite(Number(e.hourly_rate)) ? Number(e.hourly_rate) : 20);
  fStatus.value = e.is_active ? 'ACTIVE' : 'INACTIVE';
  fCode.disabled = false;
  modalHint.textContent = '';
  openModal();
  window.setTimeout(() => fName.focus(), 0);
}

async function save() {
  const code = String(fCode.value || '').trim().replace(/\s+/g, '').toUpperCase();
  const name = String(fName.value || '').trim();
  const hourly_rate = parseRateInput();
  const status = String(fStatus.value || 'ACTIVE').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
  if (!code || !name) {
    modalHint.textContent = 'Code and name are required.';
    return;
  }

  btnSave.disabled = true;
  modalHint.textContent = 'Saving…';
  try {
    if (!editingId) {
      const { res, data } = await apiJson('/api/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, name, hourly_rate, status }),
      });
      if (!res.ok) {
        modalHint.textContent = (data && data.message) || 'Could not create employee.';
        return;
      }
    } else {
      console.log('Saving employee');
      const { res, data } = await apiJson(`/api/employees/${editingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, name, hourly_rate, status }),
      });
      if (!res.ok) {
        modalHint.textContent = (data && data.message) || (data && data.error) || 'Could not update employee.';
        return;
      }
      console.log('Employee saved');
    }
    await load();
    closeModal();
  } finally {
    btnSave.disabled = false;
  }
}

async function toggleActive(id) {
  const { res, data } = await apiJson(`/api/employees/${id}/toggle-active`, { method: 'PATCH' });
  if (!res.ok) {
    adminHint.textContent = (data && data.message) || 'Toggle failed.';
    return;
  }
  await load();
}

async function delEmp(id) {
  const ok = window.confirm('Delete this employee? This cannot be undone.');
  if (!ok) return;
  const { res, data } = await apiJson(`/api/employees/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    adminHint.textContent = (data && data.message) || 'Delete failed.';
    return;
  }
  await load();
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.edit-employee-btn');
  if (!btn) return;
  e.preventDefault();
  const raw = btn.getAttribute('data-id') || btn.getAttribute('data-employee-id');
  console.log('Edit clicked', raw);
  await openEmployeeEditModal(raw);
});

empBody.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.getAttribute('data-id'));
  const act = btn.getAttribute('data-act');
  if (!Number.isFinite(id)) return;
  if (act === 'toggle') void toggleActive(id);
  if (act === 'del') void delEmp(id);
});

btnAdd.addEventListener('click', () => startCreate());
btnCloseModal.addEventListener('click', () => closeModal());
btnCancel.addEventListener('click', () => closeModal());
btnSave.addEventListener('click', () => void save());

modalBackdrop.addEventListener('click', (e) => {
  if (e.target === modalBackdrop) closeModal();
});

search.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => render(), 120);
});

window.addEventListener('load', () => {
  void load();
  window.setInterval(() => {
    void load();
  }, 8000);
});

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    await apiJson('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  });
}
