'use strict';

/** Winding machine cards + open alerts for main dashboard and manager views. */
(function initMachineDashboard(root) {
  const POLL_MS = 8000;
  const ALERT_POLL_MS = 5000;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function statusLabel(st, statusLabelText) {
    if (statusLabelText) return statusLabelText;
    if (!st || st === 'idle') return 'Idle';
    if (st === 'running') return 'Running';
    if (st === 'stopped' || st === 'paused') return 'Paused';
    return st.charAt(0).toUpperCase() + st.slice(1);
  }

  function fmtMoney(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return '$' + n.toFixed(2);
  }

  function renderEmailStatus(a) {
    const st = String(a.email_status || '').toLowerCase();
    if (st === 'sent') return '<span class="alert-email-status alert-email-status--sent" title="Notification email sent">Email Sent ✅</span>';
    if (st === 'failed') {
      const tip = a.email_error ? ` title="${escapeHtml(a.email_error)}"` : '';
      return `<span class="alert-email-status alert-email-status--failed"${tip}>Email Failed ❌</span>`;
    }
    return '<span class="alert-email-status alert-email-status--pending muted">Email pending…</span>';
  }

  function renderSessionDetailsBtn(sessionId) {
    const id = Number(sessionId);
    if (!Number.isInteger(id) || id <= 0) return '';
    return `<button type="button" class="btn btn-sm btn-session-details" data-session-id="${id}">Details</button>`;
  }

  function renderPhaseSummaryHtml(summary) {
    if (!summary || !summary.length) return '';
    const items = summary
      .map(
        (row) =>
          `<li class="phase-time-summary-item phase-time-summary-item--${escapeHtml(row.status || 'not_started')}">${escapeHtml(row.summary_line || row.phase_name || '')}</li>`
      )
      .join('');
    return `<div class="phase-time-summary" data-field="phase-summary">
      <h4 class="phase-time-summary-title">Phase Time Summary</h4>
      <ul class="phase-time-summary-list">${items}</ul>
    </div>`;
  }

  function renderTankCell(tank) {
    const t = tank && String(tank).trim();
    if (!t || t === '—') return '—';
    return `<span class="machine-card-tank-line"><span>${escapeHtml(t)}</span>` +
      `<button type="button" class="btn btn-sm btn-view-tank-activity" data-tank="${escapeHtml(t)}">View Tank Activity</button></span>`;
  }

  function renderCard(m, opts) {
    const st = m.status || 'idle';
    const alerts = m.open_alerts || [];
    const alertCount = alerts.length;
    const hasQa = alerts.some((a) => a.alert_type === 'qa_qc');
    const hasMaint = alerts.some((a) => a.alert_type === 'maintenance');
    const cardAlertCls = hasQa ? 'machine-card--alert-qa' : hasMaint ? 'machine-card--alert-maint' : '';
    const resolveBtn =
      opts && opts.allowResolve
        ? (id) =>
            `<button type="button" class="btn btn-sm alert-resolve-btn" data-alert-id="${Number(id)}">Mark Resolved</button>`
        : () => '';

    const alertList = alerts.length
      ? `<ul class="machine-alert-list">${alerts
          .map(
            (a) => `<li class="machine-alert-item ${a.css_class === 'alert-maint' ? 'alert-maint' : 'alert-qa'}">
        <div class="machine-alert-item-main">
          <strong>${escapeHtml(a.alert_label || a.alert_type)}</strong>
          <span>${escapeHtml(m.name)} · ${escapeHtml(a.team_name || '—')} · Tank ${escapeHtml(a.tank_number || '—')} · ${escapeHtml(fmtTime(a.reported_at))}</span>
          ${renderEmailStatus(a)}
        </div>
        ${opts && opts.allowResolve ? resolveBtn(a.id) : ''}
      </li>`
          )
          .join('')}</ul>`
      : '';

    return `<article class="machine-card ${cardAlertCls}" data-machine-id="${Number(m.id)}">
      <header class="machine-card-head">
        <h3 class="machine-card-title">${escapeHtml(m.name)}</h3>
      </header>
      <dl class="machine-card-grid">
        <div><dt>Current Team</dt><dd data-field="team">${escapeHtml(m.current_team || '—')}</dd></div>
        <div><dt>Current Tank</dt><dd data-field="tank">${renderTankCell(m.current_tank)}</dd></div>
        <div><dt>Current Phase</dt><dd data-field="phase">${escapeHtml(m.current_phase || m.current_activity || '—')}</dd></div>
        <div><dt>Status</dt><dd data-field="status">${escapeHtml(statusLabel(st, m.status_label))}</dd></div>
        <div><dt>Running Time</dt><dd class="machine-card-elapsed" data-field="elapsed">${escapeHtml(m.running_time_display || m.elapsed_display || '—')}</dd></div>
        <div><dt>Tank Total Running Time</dt><dd data-field="tank-total">${escapeHtml(m.tank_total_running_time_display || '—')}</dd></div>
        <div><dt>Est. Labor Cost</dt><dd data-field="labor-cost">${m.estimated_labor_cost != null ? escapeHtml(fmtMoney(m.estimated_labor_cost)) : '—'}</dd></div>
        <div><dt>Open Alerts</dt><dd data-field="alerts" class="${alertCount ? 'machine-open-alerts-count' : ''}">${alertCount}</dd></div>
      </dl>
      ${m.phase_time_summary && m.phase_time_summary.length ? renderPhaseSummaryHtml(m.phase_time_summary) : ''}
      <div class="machine-card-session-actions" data-field="session-actions">${renderSessionDetailsBtn(m.session_id)}</div>
      ${alertList}
    </article>`;
  }

  function wireSessionDetailsButtons(container) {
    if (!container) return;
    container.querySelectorAll('.btn-session-details').forEach((btn) => {
      if (btn.dataset.wired === '1') return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', () => {
        const sessionId = btn.getAttribute('data-session-id');
        if (sessionId && root.SessionDetails) root.SessionDetails.open(sessionId);
      });
    });
  }

  function wireTankActivityButtons(container) {
    if (!container) return;
    container.querySelectorAll('.btn-view-tank-activity').forEach((btn) => {
      if (btn.dataset.wired === '1') return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', () => {
        const tank = btn.getAttribute('data-tank');
        if (tank && root.TankActivity) root.TankActivity.open(tank);
      });
    });
  }

  /** Update an existing card's dynamic fields in place to avoid flicker. */
  function updateCardInPlace(cardEl, m, opts) {
    const st = m.status || 'idle';
    const alerts = m.open_alerts || [];
    const alertCount = alerts.length;
    const hasQa = alerts.some((a) => a.alert_type === 'qa_qc');
    const hasMaint = alerts.some((a) => a.alert_type === 'maintenance');
    cardEl.classList.toggle('machine-card--alert-qa', hasQa);
    cardEl.classList.toggle('machine-card--alert-maint', !hasQa && hasMaint);

    const setField = (name, html) => {
      const el = cardEl.querySelector(`[data-field="${name}"]`);
      if (el && el.innerHTML !== html) el.innerHTML = html;
    };
    setField('team', escapeHtml(m.current_team || '—'));
    setField('tank', renderTankCell(m.current_tank));
    setField('phase', escapeHtml(m.current_phase || m.current_activity || '—'));
    setField('status', escapeHtml(statusLabel(st, m.status_label)));
    setField('elapsed', escapeHtml(m.running_time_display || m.elapsed_display || '—'));
    setField('tank-total', escapeHtml(m.tank_total_running_time_display || '—'));
    setField('labor-cost', m.estimated_labor_cost != null ? escapeHtml(fmtMoney(m.estimated_labor_cost)) : '—');
    const phaseSummaryEl = cardEl.querySelector('[data-field="phase-summary"]');
    const nextPhaseSummary =
      m.phase_time_summary && m.phase_time_summary.length ? renderPhaseSummaryHtml(m.phase_time_summary) : '';
    if (phaseSummaryEl && nextPhaseSummary !== phaseSummaryEl.outerHTML) {
      phaseSummaryEl.outerHTML = nextPhaseSummary || '';
    } else if (!phaseSummaryEl && nextPhaseSummary) {
      const actionsEl = cardEl.querySelector('[data-field="session-actions"]');
      if (actionsEl) actionsEl.insertAdjacentHTML('beforebegin', nextPhaseSummary);
    } else if (phaseSummaryEl && !nextPhaseSummary) {
      phaseSummaryEl.remove();
    }
    const sessionActionsEl = cardEl.querySelector('[data-field="session-actions"]');
    if (sessionActionsEl) {
      const nextActions = renderSessionDetailsBtn(m.session_id);
      if (sessionActionsEl.innerHTML !== nextActions) sessionActionsEl.innerHTML = nextActions;
    }
    const alertsEl = cardEl.querySelector('[data-field="alerts"]');
    if (alertsEl) {
      const html = String(alertCount);
      if (alertsEl.innerHTML !== html) alertsEl.innerHTML = html;
      alertsEl.classList.toggle('machine-open-alerts-count', alertCount > 0);
    }

    const newAlertList = alerts.length
      ? `<ul class="machine-alert-list">${alerts
          .map(
            (a) => `<li class="machine-alert-item ${a.css_class === 'alert-maint' ? 'alert-maint' : 'alert-qa'}">
        <div class="machine-alert-item-main">
          <strong>${escapeHtml(a.alert_label || a.alert_type)}</strong>
          <span>${escapeHtml(m.name)} · ${escapeHtml(a.team_name || '—')} · Tank ${escapeHtml(a.tank_number || '—')} · ${escapeHtml(fmtTime(a.reported_at))}</span>
          ${renderEmailStatus(a)}
        </div>
        ${opts && opts.allowResolve ? `<button type="button" class="btn btn-sm alert-resolve-btn" data-alert-id="${Number(a.id)}">Mark Resolved</button>` : ''}
      </li>`
          )
          .join('')}</ul>`
      : '';
    let listEl = cardEl.querySelector('.machine-alert-list');
    const currentListHtml = listEl ? listEl.outerHTML : '';
    if (currentListHtml !== newAlertList) {
      if (listEl) listEl.remove();
      if (newAlertList) cardEl.insertAdjacentHTML('beforeend', newAlertList);
    }
  }

  function renderGlobalAlerts(alerts, opts) {
    if (!alerts || !alerts.length) return '';
    const resolveBtn =
      opts && opts.allowResolve
        ? (id) =>
            `<button type="button" class="btn btn-sm alert-resolve-btn" data-alert-id="${Number(id)}">Mark Resolved</button>`
        : () => '';
    const items = alerts
      .map((a) => {
        const cls = a.css_class === 'alert-maint' ? 'alert-maint' : 'alert-qa';
        return `<div class="dashboard-alert-item ${cls}" data-alert-id="${Number(a.id)}">
        <div class="dashboard-alert-main">
          <strong>${escapeHtml(a.alert_label || a.alert_type)}</strong>
          <span>${escapeHtml(a.machine_name || '—')} · ${escapeHtml(a.team_name || '—')} · Tank ${escapeHtml(a.tank_number || '—')} · ${escapeHtml(fmtTime(a.reported_at))}</span>
          ${renderEmailStatus(a)}
        </div>
        ${opts && opts.allowResolve ? resolveBtn(a.id) : ''}
      </div>`;
      })
      .join('');
    return `<div class="dashboard-alerts-strip" role="alert" aria-live="assertive">
      <div class="dashboard-alerts-head"><strong>Open production alerts</strong></div>
      <div class="dashboard-alerts-list">${items}</div>
    </div>`;
  }

  async function fetchMachines() {
    const res = await fetch('/api/manager/machines', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error((data && data.message) || 'Could not load machines');
    return data.machines || [];
  }

  async function fetchOpenAlerts() {
    const res = await fetch('/api/manager/alerts?status=open', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error((data && data.message) || 'Could not load alerts');
    return data.alerts || [];
  }

  async function resolveAlert(id) {
    const res = await fetch(`/api/manager/alerts/${Number(id)}/resolve`, { method: 'PATCH' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error((data && data.message) || 'Could not resolve alert');
  }

  function wireResolveButtons(container, onResolved) {
    if (!container) return;
    container.querySelectorAll('.alert-resolve-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-alert-id');
        if (!id) return;
        btn.disabled = true;
        try {
          await resolveAlert(id);
          if (onResolved) await onResolved();
          if (root.AlertSound && typeof root.AlertSound.pollNow === 'function') {
            void root.AlertSound.pollNow();
          }
        } catch (err) {
          btn.disabled = false;
          alert(err.message || 'Could not resolve alert.');
        }
      });
    });
  }

  function mount(containerId, opts) {
    const el = document.getElementById(containerId);
    if (!el) return null;
    const options = opts || {};
    const alertStripId = options.alertStripId || null;
    const alertStripEl = alertStripId ? document.getElementById(alertStripId) : null;

    let lastAlertStripHtml = null;

    async function refreshAlerts() {
      if (!alertStripEl && !options.showAlertsOnCards) return;
      try {
        const alerts = await fetchOpenAlerts();
        if (alertStripEl) {
          const html = renderGlobalAlerts(alerts, options);
          if (html !== lastAlertStripHtml) {
            alertStripEl.innerHTML = html;
            lastAlertStripHtml = html;
            wireResolveButtons(alertStripEl, refresh);
          }
        }
      } catch (_err) {
        /* ignore alert strip errors */
      }
    }

    function syncCards(machines) {
      let wrap = el.querySelector('.machine-card-grid-wrap');
      const signature = machines.map((m) => Number(m.id)).join(',');
      if (!wrap || el.dataset.machineSignature !== signature) {
        el.innerHTML = `<div class="machine-card-grid-wrap">${machines.map((m) => renderCard(m, options)).join('')}</div>`;
        el.dataset.machineSignature = signature;
        wrap = el.querySelector('.machine-card-grid-wrap');
      } else {
        machines.forEach((m) => {
          const cardEl = wrap.querySelector(`.machine-card[data-machine-id="${Number(m.id)}"]`);
          if (cardEl) updateCardInPlace(cardEl, m, options);
        });
      }
      wireResolveButtons(el, refresh);
      wireTankActivityButtons(el);
      wireSessionDetailsButtons(el);
    }

    async function refresh() {
      try {
        const machines = await fetchMachines();
        if (!machines.length) {
          el.innerHTML = '<p class="muted">No winding machines configured. Run migrate and seed.</p>';
          el.dataset.machineSignature = '';
          return;
        }
        syncCards(machines);
        if (options.showAlertsOnCards !== false) await refreshAlerts();
      } catch (err) {
        if (!el.querySelector('.machine-card-grid-wrap')) {
          el.innerHTML = `<p class="muted machine-card-error">${escapeHtml(err.message || 'Load failed')}</p>`;
        }
      }
    }

    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    let alertTimer = null;
    if (alertStripEl) {
      void refreshAlerts();
      alertTimer = setInterval(() => void refreshAlerts(), ALERT_POLL_MS);
    }
    return {
      refresh,
      stop: () => {
        clearInterval(timer);
        if (alertTimer) clearInterval(alertTimer);
      },
    };
  }

  root.MachineDashboard = { mount, fetchMachines, fetchOpenAlerts, renderCard, renderGlobalAlerts, renderEmailStatus };
})(window);
