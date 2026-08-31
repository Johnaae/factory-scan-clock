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

  function renderAddMemberForm(teamId, opts = {}) {
    const id = Number(teamId);
    const floatDropdown = Boolean(opts.floatDropdown);
    return `<div class="team-employee-picker" data-team-id="${id}"${floatDropdown ? ' data-float-dropdown="1"' : ''}>
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

  function getPickerRefs(picker) {
    return {
      listEl: picker._listEl || picker.querySelector('.team-emp-combobox-list'),
      combobox: picker._combobox || picker.querySelector('.team-emp-combobox'),
      inputEl: picker._inputEl || picker.querySelector('.team-emp-combobox-input'),
    };
  }

  function getDropdownShell(picker, combobox) {
    const refs = picker ? getPickerRefs(picker) : { listEl: null };
    if (refs.listEl) return refs.listEl;
    if (!combobox) return null;
    return combobox.querySelector('.team-emp-combobox-list');
  }

  function usesFloatingDropdown(picker) {
    return Boolean(picker && picker.dataset.floatDropdown === '1');
  }

  function attachFloatingShell(shell) {
    if (!shell || shell.dataset.floatingAttached === '1') return;
    shell._floatHome = { parent: shell.parentNode, next: shell.nextSibling };
    document.body.appendChild(shell);
    shell.dataset.floatingAttached = '1';
    shell.classList.add('team-emp-combobox-list--floating');
  }

  function detachFloatingShell(shell) {
    if (!shell || shell.dataset.floatingAttached !== '1') return;
    const home = shell._floatHome;
    if (home && home.parent) {
      home.parent.insertBefore(shell, home.next || null);
    }
    shell.classList.remove('team-emp-combobox-list--floating');
    delete shell.dataset.floatingAttached;
    delete shell._floatHome;
  }

  function isDropdownOpen(picker, combobox) {
    const shell = getDropdownShell(picker, combobox);
    return Boolean(shell && !shell.hidden);
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

  function resetDropdownListPosition(shell) {
    if (!shell) return;
    shell.style.position = '';
    shell.style.top = '';
    shell.style.bottom = '';
    shell.style.left = '';
    shell.style.width = '';
    shell.style.right = '';
    shell.style.maxHeight = '';
    shell.style.overflowY = '';
    shell.style.zIndex = '';
  }

  function positionDropdownList(picker, combobox, listEl, inputEl) {
    if (!inputEl || !listEl || !combobox) return;
    const shell = getDropdownShell(picker, combobox);
    if (!shell) return;

    const floating = usesFloatingDropdown(picker);
    const rect = inputEl.getBoundingClientRect();
    const gap = 2;
    const maxPreferred = 260;
    const minVisible = 48;
    const spaceBelow = window.innerHeight - rect.bottom - gap - 8;
    const spaceAbove = rect.top - gap - 8;

    if (floating) attachFloatingShell(shell);
    resetDropdownListPosition(shell);

    const openUp = spaceBelow < minVisible && spaceAbove > spaceBelow + 80;
    const maxHeight = Math.max(120, Math.min(maxPreferred, openUp ? spaceAbove : spaceBelow));

    if (floating || openUp) {
      shell.style.position = 'fixed';
      shell.style.left = `${Math.max(8, rect.left)}px`;
      shell.style.width = `${rect.width}px`;
      shell.style.maxHeight = `${maxHeight}px`;
      shell.style.zIndex = floating ? '5000' : '1200';
      if (openUp) {
        shell.style.top = 'auto';
        shell.style.bottom = `${window.innerHeight - rect.top + gap}px`;
      } else {
        shell.style.top = `${rect.bottom + gap}px`;
        shell.style.bottom = 'auto';
      }
      return;
    }

    shell.style.maxHeight = `${maxHeight}px`;
  }

  function closeList(picker, combobox, listEl, inputEl) {
    const shell = getDropdownShell(picker, combobox);
    if (listEl) listEl.innerHTML = '';
    if (shell) {
      resetDropdownListPosition(shell);
      if (usesFloatingDropdown(picker)) detachFloatingShell(shell);
      shell.hidden = true;
    }
    combobox.classList.remove('team-emp-combobox--open');
    combobox.setAttribute('aria-expanded', 'false');
    if (inputEl) inputEl.setAttribute('aria-expanded', 'false');
  }

  function openList(picker, combobox, listEl, inputEl) {
    const shell = getDropdownShell(picker, combobox);
    positionDropdownList(picker, combobox, listEl, inputEl);
    if (shell) shell.hidden = false;
    combobox.classList.add('team-emp-combobox--open');
    combobox.setAttribute('aria-expanded', 'true');
    if (inputEl) inputEl.setAttribute('aria-expanded', 'true');
  }

  function bindDropdownReposition(picker, combobox, listEl, inputEl) {
    if (picker._repositionBound) return;
    picker._repositionBound = true;
    const reposition = () => {
      if (!isDropdownOpen(picker, combobox)) return;
      positionDropdownList(picker, combobox, listEl, inputEl);
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    picker._repositionDropdown = reposition;
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
    const { inputEl, listEl, combobox } = getPickerRefs(picker);
    const hidden = picker.querySelector('.team-employee-selected-id');
    if (hidden) hidden.value = '';
    if (inputEl) {
      inputEl.value = '';
      inputEl.dataset.selectedLabel = '';
    }
    if (listEl && combobox) closeList(picker, combobox, listEl, inputEl);
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
    const { listEl, combobox, inputEl } = getPickerRefs(picker);
    if (!listEl || !combobox || !inputEl) return;
    try {
      const all = await loadEmployeeCache(picker);
      const filtered = filterEmployees(all, query);
      renderOptions(listEl, filtered, (emp) => selectEmployee(picker, emp));
      openList(picker, combobox, listEl, inputEl);
    } catch (err) {
      listEl.innerHTML = `<li class="team-emp-combobox-option team-emp-combobox-option--empty muted" role="presentation">${escapeHtml(err.message || 'Could not load employees.')}</li>`;
      openList(picker, combobox, listEl, inputEl);
    }
  }

  function selectEmployee(picker, emp) {
    const hidden = picker.querySelector('.team-employee-selected-id');
    const { inputEl, listEl, combobox } = getPickerRefs(picker);
    const label = formatEmployeeLabel(emp);
    if (hidden) hidden.value = String(emp.id);
    if (inputEl) {
      inputEl.value = label;
      inputEl.dataset.selectedLabel = label;
    }
    setHint(picker, '');
    if (listEl && combobox) closeList(picker, combobox, listEl, inputEl);
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

    picker._listEl = listEl;
    picker._combobox = combobox;
    picker._inputEl = inputEl;

    bindDropdownReposition(picker, combobox, listEl, inputEl);

    async function toggleDropdown(forceOpen) {
      const openNow = isDropdownOpen(picker, combobox);
      const shouldOpen = forceOpen != null ? forceOpen : !openNow;
      if (!shouldOpen) {
        closeList(picker, combobox, listEl, inputEl);
        return;
      }
      await showFilteredOptions(picker, inputEl.value.trim());
    }

    toggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void toggleDropdown();
    });

    inputEl.addEventListener('focus', () => {
      if (!isDropdownOpen(picker, combobox) && !hiddenId.value) {
        void showFilteredOptions(picker, inputEl.value.trim());
      }
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
        void showFilteredOptions(picker, current);
      }, 120);
    });

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeList(picker, combobox, listEl, inputEl);
      }
    });

    document.addEventListener('click', (e) => {
      const shell = getDropdownShell(picker, combobox);
      if (picker.contains(e.target)) return;
      if (shell && shell.contains(e.target)) return;
      if (!isDropdownOpen(picker, combobox)) return;
      closeList(picker, combobox, listEl, inputEl);
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
