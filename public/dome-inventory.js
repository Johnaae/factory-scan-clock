'use strict';

(function domeInventoryPage() {
  const DI = window.DomeI18n;
  const tr = (key, vars) => (DI ? DI.tr(key, vars) : key);
  const DIAMETERS = [4, 6, 8, 10, 12];
  const TYPES = ['Petro', 'Water'];
  const STATUSES = ['available', 'reserved', 'installed', 'in_production'];

  const $ = (id) => document.getElementById(id);
  const els = {
    totals: $('totals'),
    search: $('search'),
    diameterChips: $('diameterChips'),
    typeFilter: $('typeFilter'),
    statusFilter: $('statusFilter'),
    countLabel: $('countLabel'),
    hint: $('hint'),
    body: $('domesBody'),
    btnRefresh: $('btnRefresh'),
    btnAdd: $('btnAdd'),
    detailsModal: $('detailsModal'),
    detailsTitle: $('detailsTitle'),
    detailsBody: $('detailsBody'),
    btnDetailsEdit: $('btnDetailsEdit'),
    btnDetailsClose: $('btnDetailsClose'),
    formModal: $('formModal'),
    formTitle: $('formTitle'),
    formIntro: $('formIntro'),
    fNumber: $('fNumber'),
    fDiameters: $('fDiameters'),
    fWeight: $('fWeight'),
    fType: $('fType'),
    fTypeLabel: $('fTypeLabel'),
    fNotes: $('fNotes'),
    formHint: $('formHint'),
    btnFormCancel: $('btnFormCancel'),
    btnFormSave: $('btnFormSave'),
    logoutBtn: $('logoutBtn'),
  };

  const state = {
    domes: [],
    totals: null,
    diameter: null,
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

  function weightText(d) {
    return d.weight_lbs != null ? tr('dome.lb', { n: DI ? DI.formatLb(d.weight_lbs) : d.weight_lbs }) : '—';
  }

  function tankText(d) {
    if (!d.installed_tank_number) return '—';
    return tr('dome.tankPiece', { tank: d.installed_tank_number, piece: d.installed_piece_number || '—' });
  }

  function badge(status) {
    return `<span class="di-badge di-badge--${escapeHtml(status)}">${escapeHtml(DI ? DI.inventoryLabel(status) : status)}</span>`;
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

  /* ---------- filters ---------- */

  function renderFilters() {
    const typeVal = els.typeFilter.value;
    els.typeFilter.innerHTML = [
      `<option value="">${escapeHtml(tr('dome.all'))}</option>`,
      ...TYPES.map((t) => `<option value="${t}">${escapeHtml(DI ? DI.typeLabel(t) : t)}</option>`),
      `<option value="unknown">${escapeHtml(tr('dome.type.unknown'))}</option>`,
    ].join('');
    els.typeFilter.value = typeVal;

    const statusVal = els.statusFilter.value;
    els.statusFilter.innerHTML = [
      `<option value="">${escapeHtml(tr('dome.all'))}</option>`,
      ...STATUSES.map((s) => `<option value="${s}">${escapeHtml(tr(`di.totals.${s}`))}</option>`),
    ].join('');
    els.statusFilter.value = statusVal;

    els.diameterChips.innerHTML = '';
    for (const dia of [null, ...DIAMETERS]) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'di-chip' + (state.diameter === dia ? ' is-on' : '');
      chip.textContent = dia == null ? tr('dome.all') : `${dia}'`;
      chip.addEventListener('click', () => {
        state.diameter = dia;
        renderFilters();
        void load();
      });
      els.diameterChips.appendChild(chip);
    }
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
      chip.innerHTML = `<span>${escapeHtml(tr(`di.totals.${key}`))}</span><strong>${Number(t[key]) || 0}</strong>`;
      chip.addEventListener('click', () => {
        els.statusFilter.value = key === 'all' ? '' : key;
        void load();
      });
      els.totals.appendChild(chip);
    }
  }

  /* ---------- list ---------- */

  function renderList() {
    const rows = state.domes;
    if (els.countLabel) els.countLabel.textContent = tr('di.count', { n: rows.length });
    if (!rows.length) {
      els.body.innerHTML = `<tr><td colspan="10" class="muted">${escapeHtml(tr('di.empty'))}</td></tr>`;
      return;
    }
    els.body.innerHTML = rows
      .map(
        (d) => `<tr data-id="${Number(d.id)}">
          <td class="di-num">${escapeHtml(d.dome_number)}</td>
          <td>${escapeHtml(DI ? DI.typeLabel(d.dome_type) : d.dome_type || '—')}</td>
          <td>${escapeHtml(d.diameter_label || '—')}</td>
          <td>${escapeHtml(weightText(d))}</td>
          <td>${escapeHtml(DI ? DI.productionLabel(d) : d.production_status)}</td>
          <td>${badge(d.inventory_status)}</td>
          <td>${escapeHtml(tankText(d))}</td>
          <td>${escapeHtml(fmtDate(d.created_at))}</td>
          <td>${escapeHtml(fmtDate(d.completed_at))}</td>
          <td><button type="button" class="btn btn-sm" data-view="${Number(d.id)}">${escapeHtml(tr('di.view'))}</button></td>
        </tr>`
      )
      .join('');
  }

  async function load() {
    const seq = ++state.loadSeq;
    const params = new URLSearchParams();
    const q = els.search.value.trim();
    if (q) params.set('search', q);
    if (state.diameter != null) params.set('diameter', String(state.diameter));
    if (els.typeFilter.value) params.set('type', els.typeFilter.value);
    if (els.statusFilter.value) params.set('status', els.statusFilter.value);
    const { res, data } = await api(`/api/manager/domes?${params.toString()}`);
    if (seq !== state.loadSeq) return;
    if (!res.ok || !data.ok) {
      setHint(message(data), true);
      return;
    }
    state.domes = data.domes || [];
    state.totals = data.totals || null;
    renderTotals();
    renderList();
  }

  /* ---------- details ---------- */

  function gridItem(label, value) {
    return `<div><div class="k">${escapeHtml(label)}</div><div class="v">${escapeHtml(value == null || value === '' ? '—' : value)}</div></div>`;
  }

  function eventLabel(code) {
    const key = `di.event.${code === 'complete' ? 'completed' : code}`;
    return DI && DI.has(key) ? tr(key) : String(code || '');
  }

  function eventText(e) {
    const label = eventLabel(e.event);
    const d = e.details || {};
    const extra = [];
    if (d.tank_number) extra.push(tr('dome.tankPiece', { tank: d.tank_number, piece: d.piece_number || '—' }));
    if (e.event === 'edited') extra.push(Object.keys(d).join(', '));
    if (d.weight_lbs != null && e.event !== 'edited') extra.push(tr('dome.lb', { n: DI ? DI.formatLb(d.weight_lbs) : d.weight_lbs }));
    if (d.reason) extra.push(`${tr('di.reason')}: ${d.reason}`);
    const who = e.performed_by ? ` · ${e.performed_by}` : '';
    return `${fmtDate(e.performed_at)} — ${label}${extra.length ? ` (${extra.join(' · ')})` : ''}${who}`;
  }

  function renderDetails() {
    const det = state.details;
    if (!det) return;
    const d = det.dome;
    els.detailsTitle.textContent = `${tr('di.details')} — ${tr('dome.label', { dome: d.dome_number })}`;
    const fabs = (d.fabricators || []).map((f) => f.employee_name || f.name).filter(Boolean).join(', ');
    let html = `<div class="di-grid">
      ${gridItem(tr('dome.field.number'), d.dome_number)}
      ${gridItem(tr('dome.field.type'), DI ? DI.typeLabel(d.dome_type) : d.dome_type)}
      ${gridItem(tr('dome.field.diameter'), d.diameter_label)}
      ${gridItem(tr('dome.field.weight'), weightText(d))}
      ${gridItem(tr('dome.field.production'), DI ? DI.productionLabel(d) : d.production_status)}
      ${gridItem(tr('dome.field.inventory'), DI ? DI.inventoryLabel(d.inventory_status) : d.inventory_status)}
      ${gridItem(tr('dome.field.installedOn'), tankText(d))}
      ${gridItem(tr('dome.field.source'), tr(`dome.source.${d.source}`))}
      ${gridItem(tr('dome.field.team'), d.team_name)}
      ${gridItem(tr('dome.field.fabricators'), fabs)}
      ${gridItem(tr('dome.field.productionTime'), d.source === 'manual' ? '—' : d.production_display)}
      ${gridItem(tr('dome.field.labor'), d.source === 'manual' ? '—' : d.labor_display)}
      ${gridItem(tr('dome.field.created'), fmtDate(d.created_at))}
      ${gridItem(tr('dome.field.completed'), fmtDate(d.completed_at))}
    </div>`;
    if (d.notes) html += `<p style="margin:10px 0 0"><strong>${escapeHtml(tr('dome.field.notes'))}:</strong> ${escapeHtml(d.notes)}</p>`;
    if (d.source === 'manual') html += `<p class="muted" style="margin:6px 0 0">${escapeHtml(tr('di.manualNoTime'))}</p>`;

    const labor = d.labor_by_employee || [];
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
          const reason = s.end_reason ? ` (${eventLabel(s.end_reason)})` : '';
          return `<li>${escapeHtml(`${fmtDate(s.started_at)} → ${end}${reason}`)}${
            s.team_name ? ` · ${escapeHtml(s.team_name)}` : ''
          }${names.length ? `<br /><span class="muted">${escapeHtml(tr('di.participants'))}: ${escapeHtml(names.join(', '))}</span>` : ''}</li>`;
        })
        .join('')}</ul></div>`;
    }

    const installs = det.installations || [];
    html += `<div class="di-section"><h4>${escapeHtml(tr('di.section.installs'))}</h4>`;
    html += installs.length
      ? `<ul class="di-list">${installs
          .map((i) => {
            const parts = [
              tr('dome.tankPiece', { tank: i.tank_number, piece: i.piece_number }),
              tr(`di.install.${i.status}`),
              `${fmtDate(i.started_at)} → ${i.finished_at ? fmtDate(i.finished_at) : i.cancelled_at ? fmtDate(i.cancelled_at) : '…'}`,
              `${tr('di.installTime')}: ${i.install_display}`,
            ];
            if (i.machine_name) parts.push(i.machine_name);
            if (i.team_name) parts.push(i.team_name);
            if (i.cancel_reason) parts.push(`${tr('di.reason')}: ${i.cancel_reason}`);
            return `<li>${escapeHtml(parts.join(' · '))}</li>`;
          })
          .join('')}</ul>`
      : `<p class="muted" style="margin:0">${escapeHtml(tr('di.noInstalls'))}</p>`;
    html += '</div>';

    const events = det.events || [];
    html += `<div class="di-section"><h4>${escapeHtml(tr('di.section.events'))}</h4>`;
    html += events.length
      ? `<ul class="di-list">${events.map((e) => `<li>${escapeHtml(eventText(e))}</li>`).join('')}</ul>`
      : `<p class="muted" style="margin:0">${escapeHtml(tr('di.noEvents'))}</p>`;
    html += '</div>';
    els.detailsBody.innerHTML = html;
  }

  async function openDetails(id) {
    const { res, data } = await api(`/api/manager/domes/${Number(id)}`);
    if (!res.ok || !data.ok) {
      setHint(message(data), true);
      return;
    }
    state.details = data;
    renderDetails();
    showModal(els.detailsModal);
  }

  /* ---------- add / edit form ---------- */

  function renderFormDiameters() {
    els.fDiameters.innerHTML = '';
    for (const dia of DIAMETERS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'di-chip' + (state.form && state.form.diameter === dia ? ' is-on' : '');
      chip.textContent = `${dia}'`;
      chip.addEventListener('click', () => {
        state.form.diameter = dia;
        renderFormDiameters();
      });
      els.fDiameters.appendChild(chip);
    }
  }

  function renderFormTypes(selected, allowEmpty) {
    els.fType.innerHTML = [
      allowEmpty ? `<option value="">${escapeHtml(tr('dome.type.unknown'))}</option>` : '',
      ...TYPES.map((t) => `<option value="${t}">${escapeHtml(DI ? DI.typeLabel(t) : t)}</option>`),
    ].join('');
    els.fType.value = selected || '';
  }

  function openForm(dome) {
    const editing = Boolean(dome);
    state.form = { id: editing ? dome.id : null, diameter: editing ? dome.diameter_ft : null, source: editing ? dome.source : 'manual' };
    els.formTitle.textContent = editing ? tr('di.edit.title', { dome: dome.dome_number }) : tr('di.add.title');
    els.formIntro.textContent = editing ? '' : tr('di.add.hint');
    els.formIntro.hidden = editing;
    els.fNumber.value = editing ? dome.dome_number : '';
    els.fWeight.value = editing && dome.weight_lbs != null ? String(dome.weight_lbs) : '';
    els.fNotes.value = editing && dome.notes ? dome.notes : '';
    const typeOptional = !editing || dome.source === 'manual';
    els.fTypeLabel.textContent = typeOptional ? tr('di.add.typeOptional') : tr('dome.field.type');
    renderFormTypes(editing ? dome.dome_type : '', typeOptional);
    renderFormDiameters();
    els.formHint.textContent = '';
    showModal(els.formModal);
    els.fNumber.focus();
  }

  async function saveForm() {
    if (!state.form || state.saving) return;
    const f = state.form;
    const number = els.fNumber.value.trim();
    if (!number) {
      els.formHint.textContent = tr('dome.err.dome_number_required');
      return;
    }
    if (!f.diameter) {
      els.formHint.textContent = tr('dome.err.diameter_required');
      return;
    }
    const weight = Number(els.fWeight.value);
    if (!(weight > 0)) {
      els.formHint.textContent = tr('dome.err.weight_required');
      return;
    }
    const body = {
      dome_number: number,
      diameter_ft: f.diameter,
      weight_lbs: weight,
      dome_type: els.fType.value || null,
      notes: els.fNotes.value.trim() || null,
    };
    state.saving = true;
    els.btnFormSave.disabled = true;
    try {
      const { res, data } = f.id
        ? await api(`/api/manager/domes/${f.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await api('/api/manager/domes', { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok || !data.ok) {
        els.formHint.textContent = message(data, { dome: number });
        return;
      }
      hideModal(els.formModal);
      const savedNumber = (data.dome && data.dome.dome_number) || number;
      setHint(tr(f.id ? 'dome.ok.dome_updated' : 'dome.ok.manual_added', { dome: savedNumber }), false);
      const reopen = f.id && state.details && state.details.dome && state.details.dome.id === f.id;
      state.form = null;
      await load();
      if (reopen) await openDetails(f.id);
    } finally {
      state.saving = false;
      els.btnFormSave.disabled = false;
    }
  }

  /* ---------- events ---------- */

  let searchTimer = null;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void load(), 250);
  });
  els.typeFilter.addEventListener('change', () => void load());
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
    openForm(state.details.dome);
  });
  els.btnFormCancel.addEventListener('click', () => {
    state.form = null;
    hideModal(els.formModal);
  });
  els.btnFormSave.addEventListener('click', () => void saveForm());
  for (const modal of [els.detailsModal, els.formModal]) {
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
