/**
 * Recent Finished Jobs — self-initializing module for Main + Manager dashboards.
 * Uses GET /api/dashboard/finished-jobs
 */
(function initFinishedJobsDashboardModule(root) {
  const FINISHED_JOBS_API = '/api/dashboard/finished-jobs';
  const DEFAULT_VISIBLE = 5;

  const PANELS = [
    {
      bodyId: 'mainFinishedJobsBody',
      areaFilterId: 'mainFinishedJobsAreaFilter',
      todayOnlyId: 'mainFinishedJobsTodayOnly',
      refreshBtnId: 'mainRefreshFinishedJobsBtn',
      apiBase: FINISHED_JOBS_API,
      logPrefix: '[main-dashboard finished jobs]',
    },
    {
      bodyId: 'finishedJobsBody',
      areaFilterId: 'finishedJobsAreaFilter',
      todayOnlyId: 'finishedJobsTodayOnly',
      refreshBtnId: 'refreshFinishedJobsBtn',
      apiBase: FINISHED_JOBS_API,
      logPrefix: '[manager-dashboard finished jobs]',
    },
  ];

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

  function compactSummary(job) {
    const time = formatFinishClock(job.finishedAt);
    const dur = formatDurationMinutes(job.durationMinutes);
    return `${job.employeeName} · ${job.activityName} · Tank ${job.tankNumber} · ${time} · ${dur}`;
  }

  function renderJobRow(job, expandedKeys) {
    const key = jobKey(job);
    const isOpen = expandedKeys.has(key);
    const time = formatFinishClock(job.finishedAt);
    const dur = formatDurationMinutes(job.durationMinutes);
    return `<article class="fj-row" data-fj-key="${escapeHtml(key)}">
      <button class="fj-row-head" type="button" aria-expanded="${isOpen ? 'true' : 'false'}">
        <span class="fj-row-summary">${escapeHtml(compactSummary(job))}</span>
        <span class="fj-row-chevron${isOpen ? ' is-open' : ''}" aria-hidden="true">▼</span>
      </button>
      <div class="fj-row-details"${isOpen ? '' : ' hidden'}>
        <p><span class="fj-detail-label">Employee Code:</span> ${escapeHtml(job.employeeCode)}</p>
        <p><span class="fj-detail-label">Area:</span> ${escapeHtml(job.area || '—')}</p>
        <p><span class="fj-detail-label">Finished:</span> ${escapeHtml(time)}</p>
        <p><span class="fj-detail-label">Duration:</span> ${escapeHtml(dur)}</p>
      </div>
    </article>`;
  }

  function renderJobList(bodyEl, jobs, todayOnly) {
    if (!jobs.length) {
      bodyEl.innerHTML = `<p class="muted">${todayOnly ? 'No finished jobs today' : 'No finished jobs match this filter'}</p>`;
      return;
    }

    bodyEl._fjLastJobs = jobs;
    bodyEl._fjTodayOnly = todayOnly;

    const showAll = !!bodyEl._fjShowAll;
    const expandedKeys = bodyEl._fjExpandedKeys || new Set();
    const hiddenCount = jobs.length - DEFAULT_VISIBLE;

    const rows = jobs
      .map((job, idx) => ({ job, idx }))
      .filter(({ idx }) => showAll || idx < DEFAULT_VISIBLE)
      .map(({ job }) => renderJobRow(job, expandedKeys))
      .join('');

    let footer = '';
    if (!showAll && hiddenCount > 0) {
      footer = `<div class="fj-show-more-wrap">
        <button class="btn btn-sm fj-show-more" type="button">Show more (${hiddenCount} more)</button>
      </div>`;
    } else if (showAll && jobs.length > DEFAULT_VISIBLE) {
      footer = `<div class="fj-show-more-wrap">
        <button class="btn btn-sm fj-show-less" type="button">Show less</button>
      </div>`;
    }

    bodyEl.innerHTML = `<div class="fj-compact-list">${rows}${footer}</div>`;
  }

  function bindJobListInteractions(bodyEl) {
    if (bodyEl.dataset.fjClickBound === '1') return;
    bodyEl.dataset.fjClickBound = '1';
    bodyEl._fjShowAll = false;
    bodyEl._fjExpandedKeys = new Set();

    bodyEl.addEventListener('click', (e) => {
      if (e.target.closest('.fj-show-more')) {
        bodyEl._fjShowAll = true;
        renderJobList(bodyEl, bodyEl._fjLastJobs || [], bodyEl._fjTodayOnly);
        return;
      }
      if (e.target.closest('.fj-show-less')) {
        bodyEl._fjShowAll = false;
        renderJobList(bodyEl, bodyEl._fjLastJobs || [], bodyEl._fjTodayOnly);
        return;
      }

      const head = e.target.closest('.fj-row-head');
      if (!head) return;
      const row = head.closest('.fj-row');
      if (!row) return;
      const key = row.getAttribute('data-fj-key');
      if (!key) return;

      const isOpen = head.getAttribute('aria-expanded') === 'true';
      const details = row.querySelector('.fj-row-details');
      const chevron = head.querySelector('.fj-row-chevron');

      if (isOpen) {
        bodyEl._fjExpandedKeys.delete(key);
        head.setAttribute('aria-expanded', 'false');
        if (details) details.hidden = true;
        if (chevron) chevron.classList.remove('is-open');
      } else {
        bodyEl._fjExpandedKeys.add(key);
        head.setAttribute('aria-expanded', 'true');
        if (details) details.hidden = false;
        if (chevron) chevron.classList.add('is-open');
      }
    });
  }

  function showLoading(bodyEl) {
    bodyEl.innerHTML = '<p class="muted">Loading finished jobs…</p>';
  }

  function showError(bodyEl, errMsg) {
    bodyEl.innerHTML = `<p class="muted manager-finish-jobs-error">Unable to load finished jobs: ${escapeHtml(errMsg)}</p>`;
  }

  function initPanel(cfg) {
    const bodyEl = document.getElementById(cfg.bodyId);
    const logPrefix = cfg.logPrefix;

    if (!bodyEl) return null;
    if (bodyEl.dataset.fjInit === '1') return bodyEl._fjRefresh || null;
    bodyEl.dataset.fjInit = '1';

    bindJobListInteractions(bodyEl);

    const areaFilterEl = document.getElementById(cfg.areaFilterId);
    const todayOnlyEl = document.getElementById(cfg.todayOnlyId);
    const refreshBtnEl = document.getElementById(cfg.refreshBtnId);
    const pollMs = 5000;
    let loading = false;

    async function refresh() {
      if (loading) return;
      loading = true;

      const area = areaFilterEl ? areaFilterEl.value : 'ALL';
      const todayOnly = todayOnlyEl ? todayOnlyEl.checked : true;
      const params = new URLSearchParams({
        limit: '30',
        today_only: todayOnly ? '1' : '0',
      });
      if (area && area !== 'ALL') params.set('area', area);
      const url = `${cfg.apiBase}?${params}`;

      console.log('[dashboard finished jobs] fetching...', url);
      showLoading(bodyEl);

      try {
        const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        console.log('[dashboard finished jobs] status:', res.status, logPrefix);

        const data = await res.json().catch((parseErr) => {
          const msg = parseErr && parseErr.message ? parseErr.message : 'Invalid JSON response';
          console.error('[dashboard finished jobs] error:', msg);
          throw new Error(msg);
        });

        console.log('[dashboard finished jobs] data:', data);

        if (!res.ok || !data.success) {
          throw new Error((data && data.message) || `HTTP ${res.status}`);
        }

        const jobs = Array.isArray(data.jobs) ? data.jobs : [];
        renderJobList(bodyEl, jobs, todayOnly);
      } catch (err) {
        const errMsg = err && err.message ? err.message : String(err);
        console.error('[dashboard finished jobs] error:', errMsg);
        showError(bodyEl, errMsg);
      } finally {
        loading = false;
      }
    }

    bodyEl._fjRefresh = refresh;

    if (refreshBtnEl) refreshBtnEl.addEventListener('click', () => void refresh());
    if (areaFilterEl) {
      areaFilterEl.addEventListener('change', () => {
        bodyEl._fjShowAll = false;
        void refresh();
      });
    }
    if (todayOnlyEl) {
      todayOnlyEl.addEventListener('change', () => {
        bodyEl._fjShowAll = false;
        void refresh();
      });
    }

    void refresh();
    window.setInterval(() => void refresh(), pollMs);

    return refresh;
  }

  function bootAllPanels() {
    for (const cfg of PANELS) {
      try {
        initPanel(cfg);
      } catch (err) {
        console.error('[dashboard finished jobs] panel init error', cfg.bodyId, err);
        const bodyEl = document.getElementById(cfg.bodyId);
        if (bodyEl) {
          showError(bodyEl, err && err.message ? err.message : String(err));
        }
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
