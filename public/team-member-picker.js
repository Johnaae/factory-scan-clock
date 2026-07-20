'use strict';

/** Compact employee combobox for adding team members from the directory. */
(function initTeamMemberPicker(root) {
  let filterTimer = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatEmployeeLabel(emp) {
    return `${emp.code} — ${emp.name}`;
  }

  async function searchEmployees(query) {
    const q = String(query || '').trim();
    const url = q
      ? `/api/manager/employees/search?q=${encodeURIComponent(q)}`
      : '/api/manager/employees/search';
    const res = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error((data && data.message) || 'Could not search employees.');
    return data.employees || [];
  }

  async function addTeamMember(teamId, employeeId, role, move) {
    const res = await fetch(`/api/manager/teams/${teamId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ employee_id: employeeId, role: role || null, move: !!move }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.error === 'assigned_elsewhere' && !move) {
      return { ok: false, needsMove: true, data };
    }
    if (res.status === 409 && data.error === 'duplicate') {
      throw new Error('Employee already in this team.');
    }
    if (!res.ok || !data.ok) {
      throw new Error((data && data.message) || 'Could not add team member.');
    }
    return { ok: true, data };
  }

  function memberNameHtml(m) {
    const name = m.employee_name || m.name || '—';
    const code = m.employee_code ? `<span class="muted team-member-code">${escapeHtml(m.employee_code)}</span>` : '';
    return `<span class="team-member-detail-name">${escapeHtml(name)}</span>${code}`;
  }

  function renderAddMemberForm(teamId) {
    const id = Number(teamId);
    return `<div class="team-employee-picker" data-team-id="${id}">
      <div class="team-add-member-row">
        <div class="team-emp-combobox" role="combobox" aria-haspopup="listbox" aria-expanded="false">
          <label class="sr-only" for="team-emp-input-${id}">Select employee</label>
          <input
            id="team-emp-input-${id}"
            type="text"
            class="team-emp-combobox-input"
            placeholder="Select employee…"
            data-team-id="${id}"
            autocomplete="off"
            spellcheck="false"
            aria-autocomplete="list"
            aria-controls="team-emp-list-${id}"
          />
          <button type="button" class="team-emp-combobox-toggle" aria-label="Show employees" tabindex="-1">
            <svg class="team-emp-combobox-chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M4.5 6l3.5 3.5L11.5 6z"/></svg>
          </button>
          <ul id="team-emp-list-${id}" class="team-emp-combobox-list" role="listbox" hidden></ul>
          <input type="hidden" class="team-employee-selected-id" value="" />
        </div>
        <input type="text" class="team-member-role-input" placeholder="Position" data-team-id="${id}" autocomplete="off" />
        <button type="button" class="btn btn-sm btn-add-member" data-team-id="${id}">Add Member</button>
      </div>
      <p class="team-emp-combobox-hint muted" hidden aria-live="polite"></p>
    </div>`;
  }

  function filterEmployees(employees, query) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return employees;
    return employees.filter(
      (e) => String(e.code || '').toLowerCase().includes(needle) || String(e.name || '').toLowerCase().includes(needle)
    );
  }

  function setHint(picker, message, isError) {
    const hint = picker.querySelector('.team-emp-combobox-hint');
    if (!hint) return;
    if (!message) {
      hint.textContent = '';
      hint.hidden = true;
      hint.classList.remove('team-emp-combobox-hint--error');
      return;
    }
    hint.textContent = message;
    hint.hidden = false;
    hint.classList.toggle('team-emp-combobox-hint--error', !!isError);
  }

  function closeList(combobox, listEl, inputEl) {
    listEl.hidden = true;
    listEl.innerHTML = '';
    combobox.setAttribute('aria-expanded', 'false');
    if (inputEl) inputEl.setAttribute('aria-expanded', 'false');
  }

  function openList(combobox, listEl, inputEl) {
    listEl.hidden = false;
    combobox.setAttribute('aria-expanded', 'true');
    if (inputEl) inputEl.setAttribute('aria-expanded', 'true');
  }

  function renderOptions(listEl, employees, onSelect) {
    if (!employees.length) {
      listEl.innerHTML = '<li class="team-emp-combobox-option team-emp-combobox-option--empty muted" role="presentation">No matching employees.</li>';
      return;
    }
    listEl.innerHTML = employees
      .map(
        (e) =>
          `<li role="presentation"><button type="button" class="team-emp-combobox-option" role="option" data-employee-id="${Number(e.id)}" data-employee-code="${escapeHtml(e.code)}" data-employee-name="${escapeHtml(e.name)}">${escapeHtml(formatEmployeeLabel(e))}</button></li>`
      )
      .join('');
    listEl.querySelectorAll('.team-emp-combobox-option[data-employee-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        onSelect({
          id: Number(btn.getAttribute('data-employee-id')),
          code: btn.getAttribute('data-employee-code') || '',
          name: btn.getAttribute('data-employee-name') || '',
        });
      });
    });
  }

  function clearPickerSelection(picker) {
    const hidden = picker.querySelector('.team-employee-selected-id');
    const input = picker.querySelector('.team-emp-combobox-input');
    const listEl = picker.querySelector('.team-emp-combobox-list');
    const combobox = picker.querySelector('.team-emp-combobox');
    if (hidden) hidden.value = '';
    if (input) {
      input.value = '';
      input.dataset.selectedLabel = '';
    }
    if (listEl && combobox) closeList(combobox, listEl, input);
    setHint(picker, '');
    picker._employeeCache = null;
  }

  async function loadEmployeeCache(picker) {
    if (picker._employeeCache) return picker._employeeCache;
    const employees = await searchEmployees('');
    picker._employeeCache = employees;
    return employees;
  }

  async function showFilteredOptions(picker, query) {
    const listEl = picker.querySelector('.team-emp-combobox-list');
    const combobox = picker.querySelector('.team-emp-combobox');
    const inputEl = picker.querySelector('.team-emp-combobox-input');
    if (!listEl || !combobox || !inputEl) return;
    try {
      const all = await loadEmployeeCache(picker);
      const filtered = filterEmployees(all, query);
      renderOptions(listEl, filtered, (emp) => selectEmployee(picker, emp));
      openList(combobox, listEl, inputEl);
    } catch (err) {
      listEl.innerHTML = `<li class="team-emp-combobox-option team-emp-combobox-option--empty muted" role="presentation">${escapeHtml(err.message || 'Could not load employees.')}</li>`;
      openList(combobox, listEl, inputEl);
    }
  }

  function selectEmployee(picker, emp) {
    const hidden = picker.querySelector('.team-employee-selected-id');
    const input = picker.querySelector('.team-emp-combobox-input');
    const listEl = picker.querySelector('.team-emp-combobox-list');
    const combobox = picker.querySelector('.team-emp-combobox');
    const label = formatEmployeeLabel(emp);
    if (hidden) hidden.value = String(emp.id);
    if (input) {
      input.value = label;
      input.dataset.selectedLabel = label;
    }
    setHint(picker, '');
    if (listEl && combobox) closeList(combobox, listEl, input);
  }

  function wirePicker(picker, onAdded) {
    if (!picker || picker.dataset.pickerWired === '1') return;
    picker.dataset.pickerWired = '1';
    const teamId = picker.getAttribute('data-team-id');
    const combobox = picker.querySelector('.team-emp-combobox');
    const inputEl = picker.querySelector('.team-emp-combobox-input');
    const toggleBtn = picker.querySelector('.team-emp-combobox-toggle');
    const listEl = picker.querySelector('.team-emp-combobox-list');
    const hiddenId = picker.querySelector('.team-employee-selected-id');
    const roleInput = picker.querySelector('.team-member-role-input');
    const addBtn = picker.querySelector('.btn-add-member');
    if (!teamId || !combobox || !inputEl || !toggleBtn || !listEl || !hiddenId || !addBtn) return;

    let listOpen = false;

    async function toggleDropdown(forceOpen) {
      const shouldOpen = forceOpen != null ? forceOpen : !listOpen;
      if (!shouldOpen) {
        closeList(combobox, listEl, inputEl);
        listOpen = false;
        return;
      }
      await showFilteredOptions(picker, inputEl.value.trim());
      listOpen = true;
    }

    toggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void toggleDropdown();
      inputEl.focus();
    });

    inputEl.addEventListener('input', () => {
      const current = inputEl.value.trim();
      const selected = inputEl.dataset.selectedLabel || '';
      if (current !== selected) {
        hiddenId.value = '';
        inputEl.dataset.selectedLabel = '';
      }
      setHint(picker, '');
      if (filterTimer) clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        void showFilteredOptions(picker, current).then(() => {
          listOpen = true;
        });
      }, 120);
    });

    inputEl.addEventListener('focus', () => {
      if (!listOpen && !hiddenId.value) {
        void showFilteredOptions(picker, inputEl.value.trim()).then(() => {
          listOpen = true;
        });
      }
    });

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeList(combobox, listEl, inputEl);
        listOpen = false;
      }
    });

    document.addEventListener('click', (e) => {
      if (!picker.contains(e.target)) {
        closeList(combobox, listEl, inputEl);
        listOpen = false;
      }
    });

    addBtn.addEventListener('click', async () => {
      const employeeId = Number(hiddenId.value);
      const typed = inputEl.value.trim();
      const selectedLabel = inputEl.dataset.selectedLabel || '';
      if (!Number.isInteger(employeeId) || employeeId <= 0 || typed !== selectedLabel) {
        setHint(picker, 'Select an employee from the directory list.', true);
        inputEl.focus();
        void toggleDropdown(true);
        return;
      }
      const role = roleInput ? roleInput.value.trim() : '';
      addBtn.disabled = true;
      setHint(picker, '');
      try {
        let result = await addTeamMember(teamId, employeeId, role, false);
        if (result.needsMove) {
          const msg = (result.data && result.data.message) || 'Move this employee to this team?';
          if (!window.confirm(msg)) return;
          result = await addTeamMember(teamId, employeeId, role, true);
        }
        if (roleInput) roleInput.value = '';
        clearPickerSelection(picker);
        listOpen = false;
        if (onAdded) await onAdded();
      } catch (err) {
        setHint(picker, err.message || 'Could not add team member.', true);
      } finally {
        addBtn.disabled = false;
      }
    });
  }

  function wireAllPickers(container, onAdded) {
    if (!container) return;
    container.querySelectorAll('.team-employee-picker').forEach((picker) => wirePicker(picker, onAdded));
  }

  root.TeamMemberPicker = {
    renderAddMemberForm,
    wireAllPickers,
    memberNameHtml,
    searchEmployees,
    addTeamMember,
  };
})(window);
