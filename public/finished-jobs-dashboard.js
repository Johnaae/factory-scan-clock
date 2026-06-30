/**
 * Recent Finished Jobs — full-width dashboard table with silent polling.
 */
(function initFinishedJobsDashboardModule(root) {
  const FINISHED_JOBS_API = '/api/dashboard/finished-jobs';
  const VISIBLE_LIMIT = 5;
  const POLL_MS = 12000;

  const PANELS = [
    {
      bodyId: 'mainFinishedJobsBody',
      areaFilterId: 'mainFinishedJobsAreaFilter',
      todayOnlyId: 'mainFinishedJobsTodayOnly',
      refreshBtnId: 'mainRefreshFinishedJobsBtn',
      apiBase: FINISHED_JOBS_API,
    },
    {
      bodyId: 'finishedJobsBody',
      areaFilterId: 'finishedJobsAreaFilter',
      todayOnlyId: 'finishedJobsTodayOnly',
      refreshBtnId: 'refreshFinishedJobsBtn',
      apiBase: FINISHED_JOBS_API,
    },
  ];

  const CHECK_ICON =
    '<span class="fj-check" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatDurationMinutes(mins) {
    const m = Math.max(0, Number(mins) || 0);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h}h ${r}m` : `${h}h`;
  }

  function formatFinishClock(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function jobKey(job) {
    return `${job.employeeCode || ''}|${job.finishedAt || ''}|${job.tankNumber || ''}|${job.activityName || ''}`;
  }

  function createPanelState(cfg, bodyEl) {
    return {
      cfg,
      bodyEl,
      hasLoaded: false,
      fetching: false,
      allJobs: [],
      knownKeys: new Set(),
      tbodyEl: null,
      tablePanelEl: null,
      emptyEl: null,
      historyBtn: null,
      errorEl: null,
      modalBackdrop: null,
      todayOnly: true,
    };
  }

  function tableHeadHtml() {
    return `<thead>
      <tr>
        <th class="fj-th fj-th-check" scope="col"><span class="sr-only">Status</span></th>
        <th class="fj-th" scope="col">Activity</th>
        <th class="fj-th" scope="col">Tank #</th>
        <th class="fj-th" scope="col">Employee</th>
        <th class="fj-th" scope="col">Area</th>
        <th class="fj-th" scope="col">Finished</th>
        <th class="fj-th fj-th-duration" scope="col">Duration</th>
      </tr>
    </thead>`;
  }

  function buildShell(state) {
    const { bodyEl } = state;
    bodyEl.innerHTML = '';
    bodyEl.classList.add('fj-dashboard');

    const panel = document.createElement('div');
    panel.className = 'fj-panel';

    state.errorEl = document.createElement('p');
    state.errorEl.className = 'fj-error manager-finish-jobs-error';
    state.errorEl.hidden = true;

    state.tablePanelEl = document.createElement('div');
    state.tablePanelEl.className = 'fj-table-panel table-panel';
    state.tablePanelEl.innerHTML = `<div class="table-wrap">
      <table class="fj-table">
        ${tableHeadHtml()}
        <tbody class="fj-tbody"></tbody>
      </table>
    </div>`;
    state.tbodyEl = state.tablePanelEl.querySelector('.fj-tbody');

    state.emptyEl = document.createElement('p');
    state.emptyEl.className = 'fj-empty muted';
    state.emptyEl.hidden = true;
    state.emptyEl.textContent = 'No finished jobs today';

    state.historyBtn = document.createElement('button');
    state.historyBtn.type = 'button';
    state.historyBtn.className = 'fj-view-all-btn btn btn-sm';
    state.historyBtn.hidden = true;

    panel.appendChild(state.errorEl);
    panel.appendChild(state.tablePanelEl);
    panel.appendChild(state.emptyEl);
    panel.appendChild(state.historyBtn);
    bodyEl.appendChild(panel);

    const modalId = `fj-modal-${state.cfg.bodyId}`;
    let backdrop = document.getElementById(modalId);
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = modalId;
      backdrop.className = 'modal-backdrop fj-history-modal';
      backdrop.innerHTML = `<div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="${modalId}-title">
        <div class="modal-head">
          <h2 class="modal-title" id="${modalId}-title">All Finished Jobs</h2>
          <button type="button" class="btn btn-sm fj-modal-close" aria-label="Close">Close</button>
        </div>
        <div class="modal-body fj-modal-table-wrap"></div>
      </div>`;
      document.body.appendChild(backdrop);
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop || e.target.closest('.fj-modal-close')) {
          closeHistoryModal(state);
        }
      });
    }
    state.modalBackdrop = backdrop;
  }

  function createRow(job, options) {
    const opts = options || {};
    const key = jobKey(job);
    const tr = document.createElement('tr');
    tr.className = 'fj-row';
    if (opts.isNew) tr.classList.add('fj-row--new');
    tr.dataset.fjKey = key;

    const activity = escapeHtml(job.activityName || '—');
    const tank = escapeHtml(job.tankNumber || '—');
    const employee = escapeHtml(job.employeeName || '—');
    const area = escapeHtml(job.area || '—');
    const finished = escapeHtml(formatFinishClock(job.finishedAt));
    const duration = escapeHtml(formatDurationMinutes(job.durationMinutes));

    tr.innerHTML = `<td class="fj-td fj-td-check" data-label="">${CHECK_ICON}</td>
      <td class="fj-td fj-td-activity" data-label="Activity">${activity}</td>
      <td class="fj-td" data-label="Tank #">${tank}</td>
      <td class="fj-td" data-label="Employee">${employee}</td>
      <td class="fj-td" data-label="Area">${area}</td>
      <td class="fj-td fj-td-time" data-label="Finished">${finished}</td>
      <td class="fj-td fj-td-duration" data-label="Duration">${duration}</td>`;

    if (opts.isNew) {
      window.setTimeout(() => tr.classList.remove('fj-row--new'), 1400);
    }
    return tr;
  }

  function buildTableHtml(jobs) {
    const rows = jobs.map((job) => {
      const activity = escapeHtml(job.activityName || '—');
      const tank = escapeHtml(job.tankNumber || '—');
      const employee = escapeHtml(job.employeeName || '—');
      const area = escapeHtml(job.area || '—');
      const finished = escapeHtml(formatFinishClock(job.finishedAt));
      const duration = escapeHtml(formatDurationMinutes(job.durationMinutes));
      const key = escapeHtml(jobKey(job));
      return `<tr class="fj-row" data-fj-key="${key}">
        <td class="fj-td fj-td-check">${CHECK_ICON}</td>
        <td class="fj-td fj-td-activity">${activity}</td>
        <td class="fj-td">${tank}</td>
        <td class="fj-td">${employee}</td>
        <td class="fj-td">${area}</td>
        <td class="fj-td fj-td-time">${finished}</td>
        <td class="fj-td fj-td-duration">${duration}</td>
      </tr>`;
    });
    return `<div class="table-wrap"><table class="fj-table">${tableHeadHtml()}<tbody>${rows.join('')}</tbody></table></div>`;
  }

  function openHistoryModal(state) {
    if (!state.modalBackdrop) return;
    const wrap = state.modalBackdrop.querySelector('.fj-modal-table-wrap');
    if (!wrap) return;
    wrap.innerHTML = buildTableHtml(state.allJobs);
    state.modalBackdrop.classList.add('show');
  }

  function closeHistoryModal(state) {
    if (state.modalBackdrop) state.modalBackdrop.classList.remove('show');
  }

  function updateViewAllButton(state) {
    const total = state.allJobs.length;
    if (total > VISIBLE_LIMIT) {
      state.historyBtn.hidden = false;
      state.historyBtn.textContent = 'View all finished jobs';
    } else {
      state.historyBtn.hidden = true;
    }
  }

  function syncVisibleRows(state, options) {
    const opts = options || {};
    const jobs = state.allJobs;
    const visible = jobs.slice(0, VISIBLE_LIMIT);
    const { tbodyEl, tablePanelEl, emptyEl } = state;

    const hasJobs = jobs.length > 0;
    emptyEl.hidden = hasJobs;
    emptyEl.textContent = state.todayOnly ? 'No finished jobs today' : 'No finished jobs match this filter';
    tablePanelEl.hidden = !hasJobs;

    if (!hasJobs) return;

    const domMap = new Map();
    tbodyEl.querySelectorAll('.fj-row').forEach((el) => domMap.set(el.dataset.fjKey, el));

    const desiredKeys = visible.map(jobKey);
    const brandNewKeys = opts.brandNewKeys || new Set();

    for (const key of [...domMap.keys()]) {
      if (!desiredKeys.includes(key)) {
        domMap.get(key).remove();
        domMap.delete(key);
      }
    }

    visible.forEach((job, index) => {
      const key = jobKey(job);
      let row = domMap.get(key);
      if (!row) {
        row = createRow(job, { isNew: brandNewKeys.has(key) });
        tbodyEl.insertBefore(row, tbodyEl.children[index] || null);
        domMap.set(key, row);
      } else {
        const ref = tbodyEl.children[index];
        if (ref !== row) tbodyEl.insertBefore(row, ref || null);
      }
    });

    updateViewAllButton(state);
  }

  function mergeJobs(state, incoming) {
    const brandNewKeys = new Set();
    for (const job of incoming) {
      const key = jobKey(job);
      if (!state.knownKeys.has(key)) brandNewKeys.add(key);
      state.knownKeys.add(key);
    }
    state.allJobs = incoming.slice();
    return brandNewKeys;
  }

  function showInitialLoading(state) {
    state.bodyEl.innerHTML = '<p class="fj-initial-load muted">Loading finished jobs…</p>';
  }

  function showFatalError(state, message) {
    if (!state.tbodyEl) buildShell(state);
    state.errorEl.hidden = false;
    state.errorEl.textContent = `Unable to load finished jobs: ${message}`;
    state.tablePanelEl.hidden = true;
    state.emptyEl.hidden = true;
    state.historyBtn.hidden = true;
  }

  async function fetchJobs(state) {
    const { cfg } = state;
    const areaFilterEl = document.getElementById(cfg.areaFilterId);
    const todayOnlyEl = document.getElementById(cfg.todayOnlyId);
    const area = areaFilterEl ? areaFilterEl.value : 'ALL';
    const todayOnly = todayOnlyEl ? todayOnlyEl.checked : true;
    state.todayOnly = todayOnly;

    const params = new URLSearchParams({
      limit: '50',
      today_only: todayOnly ? '1' : '0',
    });
    if (area && area !== 'ALL') params.set('area', area);

    const res = await fetch(`${cfg.apiBase}?${params}`, { credentials: 'same-origin', cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      throw new Error((data && data.message) || `HTTP ${res.status}`);
    }
    return Array.isArray(data.jobs) ? data.jobs : [];
  }

  function initPanel(cfg) {
    const bodyEl = document.getElementById(cfg.bodyId);
    if (!bodyEl) return null;
    if (bodyEl.dataset.fjInit === '1') return bodyEl._fjRefresh || null;
    bodyEl.dataset.fjInit = '1';

    const state = createPanelState(cfg, bodyEl);
    showInitialLoading(state);

    async function refresh(forceRebuild) {
      if (state.fetching) return;
      state.fetching = true;
      try {
        const jobs = await fetchJobs(state);
        if (!state.hasLoaded || forceRebuild) {
          buildShell(state);
          state.knownKeys = new Set(jobs.map(jobKey));
          state.allJobs = jobs.slice();
          state.errorEl.hidden = true;
          syncVisibleRows(state, { brandNewKeys: new Set() });
          state.hasLoaded = true;
          state.historyBtn.onclick = () => openHistoryModal(state);
        } else {
          const brandNewKeys = mergeJobs(state, jobs);
          state.errorEl.hidden = true;
          syncVisibleRows(state, { brandNewKeys });
        }
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        if (!state.hasLoaded) showFatalError(state, msg);
      } finally {
        state.fetching = false;
      }
    }

    bodyEl._fjRefresh = refresh;

    const areaFilterEl = document.getElementById(cfg.areaFilterId);
    const todayOnlyEl = document.getElementById(cfg.todayOnlyId);
    const refreshBtnEl = document.getElementById(cfg.refreshBtnId);

    if (refreshBtnEl) refreshBtnEl.addEventListener('click', () => void refresh(false));
    if (areaFilterEl) {
      areaFilterEl.addEventListener('change', () => {
        state.knownKeys.clear();
        void refresh(true);
      });
    }
    if (todayOnlyEl) {
      todayOnlyEl.addEventListener('change', () => {
        state.knownKeys.clear();
        void refresh(true);
      });
    }

    void refresh(true);
    window.setInterval(() => void refresh(false), POLL_MS);

    return refresh;
  }

  function bootAllPanels() {
    for (const cfg of PANELS) {
      try {
        initPanel(cfg);
      } catch (err) {
        console.error('[dashboard finished jobs] panel init error', cfg.bodyId, err);
      }
    }
  }

  root.FinishedJobsDashboard = { init: initPanel, boot: bootAllPanels };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootAllPanels);
  } else {
    bootAllPanels();
  }
})(typeof window !== 'undefined' ? window : globalThis);
