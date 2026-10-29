'use strict';

(function bulkheadInventoryPage() {
  const DI = window.DomeI18n;
  const tr = (key, vars) => (DI ? DI.tr(key, vars) : key);
  const STATUSES = ['available', 'assigned', 'installed', 'in_production'];

  const $ = (id) => document.getElementById(id);
  const els = {
    totals: $('totals'),
    search: $('search'),
    statusFilter: $('statusFilter'),
    countLabel: $('countLabel'),
    hint: $('hint'),
    body: $('bulkheadsBody'),
    btnRefresh: $('btnRefresh'),
    btnAdd: $('btnAdd'),
    detailsModal: $('detailsModal'),
    detailsTitle: $('detailsTitle'),
    detailsBody: $('detailsBody'),
    btnDetailsEdit: $('btnDetailsEdit'),
    btnDetailsDelete: $('btnDetailsDelete'),
    btnDetailsClose: $('btnDetailsClose'),
    deleteModal: $('deleteModal'),
    deleteIntro: $('deleteIntro'),
    deleteConfirm: $('deleteConfirm'),
    deleteHint: $('deleteHint'),
    btnDeleteCancel: $('btnDeleteCancel'),
    btnDeleteConfirm: $('btnDeleteConfirm'),
    formModal: $('formModal'),
    formTitle: $('formTitle'),
    formIntro: $('formIntro'),
    fNumber: $('fNumber'),
    fType: $('fType'),
    fDiameter: $('fDiameter'),
    fWeight: $('fWeight'),
    fNotes: $('fNotes'),
    formHint: $('formHint'),
    btnFormCancel: $('btnFormCancel'),
    btnFormSave: $('btnFormSave'),
    logoutBtn: $('logoutBtn'),
  };

  const state = {
    bulkheads: [],
    totals: null,
    details: null,
    form: null,
    loadSeq: 0,
    saving: false,
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDate(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(DI && DI.lang() === 'es' ? 'es-MX' : 'en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function badge(status) {
    return `<span class="di-badge di-badge--${escapeHtml(status)}">${escapeHtml(
      DI ? DI.inventoryLabel(status) : status
    )}</span>`;
  }

  async function api(url, opts) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      cache: 'no-store',
      ...opts,
    });
    if (res.status === 401) {
      window.location.href = '/manager-login';
      return { res, data: { ok: false } };
    }
    const data = await res.json().catch(() => ({ ok: false, message: tr('dome.badResponse') }));
    return { res, data };
  }

  function message(data, ctx) {
    return DI ? DI.msg(data, ctx) : (data && data.message) || '';
  }

  function setHint(msg, isError) {
    if (!els.hint) return;
    els.hint.textContent = msg || '';
    els.hint.className = `toastline manager-alert${isError ? ' manager-alert--error' : ''}`;
  }

  function showModal(el) {
    el.hidden = false;
    el.classList.add('show');
  }

  function hideModal(el) {
    el.classList.remove('show');
    el.hidden = true;
  }

  function canDelete(b) {
    if (!b) return false;
    if (b.inventory_status === 'installed' || b.inventory_status === 'assigned') return false;
    if (b.production_status === 'in_progress' || b.production_status === 'paused') return false;
    return true;
  }

  function renderFilters() {
    const statusVal = els.statusFilter.value;
    els.statusFilter.innerHTML = [
      `<option value="">${escapeHtml(tr('dome.all'))}</option>`,
      ...STATUSES.map((s) => `<option value="${s}">${escapeHtml(tr(`bi.totals.${s}`))}</option>`),
    ].join('');
    els.statusFilter.value = statusVal;
  }

  function renderTotals() {
    const t = state.totals;
    if (!t) {
      els.totals.innerHTML = '';
      return;
    }
    const current = els.statusFilter.value;
    els.totals.innerHTML = '';
    for (const key of ['all', ...STATUSES]) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'di-chip di-total' + ((key === 'all' ? '' : key) === current ? ' is-on' : '');
      chip.innerHTML = `<span>${escapeHtml(tr(`bi.totals.${key}`))}</span><strong>${Number(t[key]) || 0}</strong>`;
      chip.addEventListener('click', () => {
        els.statusFilter.value = key === 'all' ? '' : key;
        void load();
      });
      els.totals.appendChild(chip);
    }
  }

  function weightLabel(b) {
    if (b.weight_lbs == null) return '—';
    return tr('dome.lb', { n: DI ? DI.formatLb(b.weight_lbs) : b.weight_lbs });
  }

  function renderList() {
    const rows = state.bulkheads;
    if (els.countLabel) els.countLabel.textContent = tr('di.count', { n: rows.length });
    if (!rows.length) {
      els.body.innerHTML = `<tr><td colspan="10" class="muted">${escapeHtml(tr('bi.empty'))}</td></tr>`;
      return;
    }
    els.body.innerHTML = rows
      .map(
        (b) => `<tr data-id="${Number(b.id)}">
          <td class="di-num">${escapeHtml(b.bulkhead_number)}</td>
          <td>${escapeHtml(DI ? DI.typeLabel(b.bulkhead_type) : b.bulkhead_type || '—')}</td>
          <td>${escapeHtml(b.diameter_label || '—')}</td>
          <td>${escapeHtml(weightLabel(b))}</td>
          <td>${escapeHtml(DI ? DI.productionLabel(b) : b.production_status)}</td>
          <td>${badge(b.inventory_status)}</td>
          <td>${escapeHtml(b.installed_tank_number || '—')}</td>
          <td>${escapeHtml(fmtDate(b.created_at))}</td>
          <td>${escapeHtml(fmtDate(b.completed_at))}</td>
          <td><button type="button" class="btn btn-sm" data-view="${Number(b.id)}">${escapeHtml(tr('di.view'))}</button></td>
        </tr>`
      )
      .join('');
  }

  async function load() {
    const seq = ++state.loadSeq;
    const params = new URLSearchParams();
    const q = els.search.value.trim();
    if (q) params.set('search', q);
    if (els.statusFilter.value) params.set('status', els.statusFilter.value);
    const { res, data } = await api(`/api/manager/bulkheads?${params.toString()}`);
    if (seq !== state.loadSeq) return;
    if (!res.ok || !data.ok) {
      setHint(message(data), true);
      return;
    }
    state.bulkheads = data.bulkheads || [];
    state.totals = data.totals || null;
    renderTotals();
    renderList();
  }

  function gridItem(label, value) {
    return `<div><div class="k">${escapeHtml(label)}</div><div class="v">${escapeHtml(
      value == null || value === '' ? '—' : value
    )}</div></div>`;
  }

  function renderDetails() {
    const det = state.details;
    if (!det) return;
    const b = det.bulkhead;
    els.detailsTitle.textContent = `${tr('bi.details')} — ${tr('bi.label', { n: b.bulkhead_number })}`;
    const workers = (b.workers || []).map((w) => w.employee_name || w.name).filter(Boolean).join(', ');
    let html = `<div class="di-grid">
      ${gridItem(tr('bi.field.number'), b.bulkhead_number)}
      ${gridItem(tr('dome.field.type'), DI ? DI.typeLabel(b.bulkhead_type) : b.bulkhead_type)}
      ${gridItem(tr('dome.field.diameter'), b.diameter_label)}
      ${gridItem(tr('dome.field.weightLb'), b.weight_lbs != null ? weightLabel(b) : null)}
      ${gridItem(tr('dome.field.production'), DI ? DI.productionLabel(b) : b.production_status)}
      ${gridItem(tr('dome.field.inventory'), DI ? DI.inventoryLabel(b.inventory_status) : b.inventory_status)}
      ${gridItem(tr('bi.col.tank'), b.installed_tank_number)}
      ${gridItem(tr('dome.field.source'), tr(`dome.source.${b.source}`))}
      ${gridItem(tr('dome.field.fabricators'), workers)}
      ${gridItem(tr('dome.field.productionTime'), b.source === 'manual' ? '—' : b.production_display)}
      ${gridItem(tr('dome.field.labor'), b.source === 'manual' ? '—' : b.labor_display)}
      ${gridItem(tr('dome.field.created'), fmtDate(b.created_at))}
      ${gridItem(tr('dome.field.completed'), fmtDate(b.completed_at))}
    </div>`;
    if (b.notes) html += `<p style="margin:10px 0 0"><strong>${escapeHtml(tr('dome.field.notes'))}:</strong> ${escapeHtml(b.notes)}</p>`;

    const labor = b.labor_by_employee || [];
    html += `<div class="di-section"><h4>${escapeHtml(tr('di.section.labor'))}</h4>`;
    html += labor.length
      ? `<ul class="di-list">${labor
          .map((e) => `<li>${escapeHtml(e.employee_name || e.employee_code || '—')} — ${escapeHtml(e.labor_display)}</li>`)
          .join('')}</ul>`
      : `<p class="muted" style="margin:0">${escapeHtml(tr('di.noLabor'))}</p>`;
    html += '</div>';

    const sessions = det.labor_sessions || [];
    if (sessions.length) {
      html += `<div class="di-section"><h4>${escapeHtml(tr('di.section.sessions'))}</h4><ul class="di-list">${sessions
        .map((s) => {
          const names = (s.participants || []).map((p) => p.employee_name).filter(Boolean);
          const end = s.ended_at ? fmtDate(s.ended_at) : tr('dome.status.in_progress');
          return `<li>${escapeHtml(`${fmtDate(s.started_at)} → ${end}`)}${
            names.length ? `<br /><span class="muted">${escapeHtml(names.join(', '))}</span>` : ''
          }</li>`;
        })
        .join('')}</ul></div>`;
    }

    const events = det.events || [];
    html += `<div class="di-section"><h4>${escapeHtml(tr('di.section.events'))}</h4>`;
    html += events.length
      ? `<ul class="di-list">${events
          .map((e) => `<li>${escapeHtml(`${fmtDate(e.performed_at)} — ${e.event}`)}${e.performed_by ? ` · ${escapeHtml(e.performed_by)}` : ''}</li>`)
          .join('')}</ul>`
      : `<p class="muted" style="margin:0">${escapeHtml(tr('di.noEvents'))}</p>`;
    html += '</div>';
    els.detailsBody.innerHTML = html;
  }

  async function openDetails(id) {
    const { res, data } = await api(`/api/manager/bulkheads/${Number(id)}`);
    if (!res.ok || !data.ok) {
      setHint(message(data), true);
      return;
    }
    state.details = data;
    renderDetails();
    if (els.btnDetailsDelete) {
      const allowed = canDelete(data.bulkhead);
      els.btnDetailsDelete.disabled = !allowed;
      els.btnDetailsDelete.title = allowed ? '' : tr('bi.delete.blocked');
    }
    showModal(els.detailsModal);
  }

  function openForm(bh) {
    const editing = Boolean(bh);
    state.form = { id: editing ? bh.id : null };
    els.formTitle.textContent = editing ? tr('bi.edit.title', { n: bh.bulkhead_number }) : tr('bi.add.title');
    els.formIntro.textContent = editing ? '' : tr('bi.add.hint');
    els.formIntro.hidden = editing;
    els.fNumber.value = editing ? bh.bulkhead_number : '';
    if (els.fType) els.fType.value = editing && bh.bulkhead_type ? bh.bulkhead_type : '';
    if (els.fDiameter) els.fDiameter.value = editing && bh.diameter_ft != null ? String(bh.diameter_ft) : '';
    if (els.fWeight) els.fWeight.value = editing && bh.weight_lbs != null ? String(bh.weight_lbs) : '';
    els.fNotes.value = editing && bh.notes ? bh.notes : '';
    els.formHint.textContent = '';
    showModal(els.formModal);
    els.fNumber.focus();
  }

  async function saveForm() {
    if (!state.form || state.saving) return;
    const f = state.form;
    const number = els.fNumber.value.trim();
    if (!number) {
      els.formHint.textContent = tr('dome.err.bulkhead_number_required');
      return;
    }
    const body = {
      bulkhead_number: number,
      bulkhead_type: els.fType && els.fType.value ? els.fType.value : null,
      diameter_ft: els.fDiameter && els.fDiameter.value ? Number(els.fDiameter.value) : null,
      weight_lbs: els.fWeight && els.fWeight.value.trim() !== '' ? els.fWeight.value.trim() : null,
      notes: els.fNotes.value.trim() || null,
    };
    state.saving = true;
    els.btnFormSave.disabled = true;
    try {
      const { res, data } = f.id
        ? await api(`/api/manager/bulkheads/${f.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await api('/api/manager/bulkheads', { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok || !data.ok) {
        els.formHint.textContent = message(data) || data.message || '';
        return;
      }
      hideModal(els.formModal);
      setHint(data.message || '', false);
      const reopen = f.id && state.details && state.details.bulkhead && state.details.bulkhead.id === f.id;
      state.form = null;
      await load();
      if (reopen) await openDetails(f.id);
    } finally {
      state.saving = false;
      els.btnFormSave.disabled = false;
    }
  }

  function openDelete() {
    if (!state.details || !state.details.bulkhead) return;
    const b = state.details.bulkhead;
    if (!canDelete(b)) {
      setHint(tr('bi.delete.blocked'), true);
      return;
    }
    els.deleteIntro.textContent = tr('bi.delete.intro', { n: b.bulkhead_number });
    els.deleteConfirm.value = '';
    els.deleteHint.textContent = '';
    hideModal(els.detailsModal);
    showModal(els.deleteModal);
    setTimeout(() => els.deleteConfirm.focus(), 50);
  }

  async function confirmDelete() {
    if (!state.details || !state.details.bulkhead || state.saving) return;
    const b = state.details.bulkhead;
    const typed = els.deleteConfirm.value.trim();
    if (!typed) {
      els.deleteHint.textContent = tr('bi.delete.confirmRequired');
      return;
    }
    state.saving = true;
    els.btnDeleteConfirm.disabled = true;
    try {
      const { res, data } = await api(`/api/manager/bulkheads/${Number(b.id)}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm_bulkhead_number: typed }),
      });
      if (!res.ok || !data.ok) {
        els.deleteHint.textContent = message(data) || data.message || '';
        return;
      }
      hideModal(els.deleteModal);
      state.details = null;
      setHint(data.message || '', false);
      await load();
    } finally {
      state.saving = false;
      els.btnDeleteConfirm.disabled = false;
    }
  }

  let searchTimer = null;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void load(), 250);
  });
  els.statusFilter.addEventListener('change', () => void load());
  els.btnRefresh.addEventListener('click', () => void load());
  els.btnAdd.addEventListener('click', () => openForm(null));
  els.body.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-id]');
    if (row) void openDetails(row.getAttribute('data-id'));
  });
  els.btnDetailsClose.addEventListener('click', () => {
    state.details = null;
    hideModal(els.detailsModal);
  });
  els.btnDetailsEdit.addEventListener('click', () => {
    if (!state.details) return;
    hideModal(els.detailsModal);
    openForm(state.details.bulkhead);
  });
  els.btnDetailsDelete.addEventListener('click', () => openDelete());
  els.btnDeleteCancel.addEventListener('click', () => {
    hideModal(els.deleteModal);
    if (state.details) showModal(els.detailsModal);
  });
  els.btnDeleteConfirm.addEventListener('click', () => void confirmDelete());
  els.btnFormCancel.addEventListener('click', () => {
    state.form = null;
    hideModal(els.formModal);
  });
  els.btnFormSave.addEventListener('click', () => void saveForm());
  for (const modal of [els.detailsModal, els.formModal, els.deleteModal]) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) hideModal(modal);
    });
  }
  if (els.logoutBtn) {
    els.logoutBtn.addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
      window.location.href = '/manager-login';
    });
  }

  window.addEventListener('factory-lang-change', () => {
    renderFilters();
    renderTotals();
    renderList();
    if (state.details && !els.detailsModal.hidden) renderDetails();
  });

  if (window.FactoryI18n) {
    window.FactoryI18n.mountSelector('managerLangMount');
    window.FactoryI18n.applyDom();
  }
  renderFilters();
  void load();
})();
