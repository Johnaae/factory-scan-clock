'use strict';

/** Winding machine cards + open alerts for main dashboard and manager views. */
(function initMachineDashboard(root) {
  const POLL_MS = 8000;
  const ALERT_POLL_MS = 5000;
  const FETCH_TIMEOUT_MS = 20000;
  /** Tank IDs with Phase Time Summary expanded (survives poll refresh; read-only). */
  const expandedTankIds = new Set();

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function fetchJson(url, opts) {
    const options = opts || {};
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), options.timeoutMs || FETCH_TIMEOUT_MS)
      : null;
    try {
      const res = await fetch(url, {
        cache: 'no-store',
        ...options,
        signal: controller ? controller.signal : undefined,
      });
      const data = await res.json().catch(() => ({}));
      return { res, data };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('Request timed out. The server may still be starting — please retry.');
      }
      throw new Error((err && err.message) || 'Network error');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function renderLoadError(message, retryAttr) {
    return `<div class="manager-load-error" role="alert">
      <p class="manager-load-error-msg">${escapeHtml(message || 'Could not load data.')}</p>
      <button type="button" class="btn btn-sm btn-primary" data-retry="${escapeHtml(retryAttr || 'refresh')}">Retry</button>
    </div>`;
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function formatAlertDetail(a) {
    const parts = [];
    if (a.tank_number) parts.push(`Tank ${a.tank_number}`);
    if (a.piece_number != null) parts.push(`Piece ${a.piece_number}`);
    if (String(a.alert_type || '').toLowerCase() === 'qa_qc' && a.status === 'open') {
      parts.push('QA/QC OPEN');
    }
    if (a.team_name) parts.push(`Team: ${a.team_name}`);
    if (a.machine_name) parts.push(`Machine: ${a.machine_name}`);
    if (String(a.alert_type || '').toLowerCase() === 'qa_qc' && a.phase_name) {
      parts.push(`Phase Paused: ${a.phase_name}`);
    }
    if (a.reported_at) parts.push(`Started: ${fmtDateTime(a.reported_at) || fmtTime(a.reported_at)}`);
    else if (a.machine_name || a.team_name) {
      /* keep legacy fallback shape if timestamps missing */
    }
    if (!parts.length) {
      return `${a.machine_name || '—'} · ${a.team_name || '—'} · Tank ${a.tank_number || '—'} · ${fmtTime(a.reported_at)}`;
    }
    return parts.join(' · ');
  }

  function statusLabel(st, statusLabelText) {
    if (statusLabelText) return statusLabelText;
    if (!st || st === 'idle') return 'Idle';
    if (st === 'running') return 'Running';
    if (st === 'stopped' || st === 'paused') return 'Paused';
    return st.charAt(0).toUpperCase() + st.slice(1);
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

  function phaseStatusLabel(row) {
    if (row && row.status_label) return row.status_label;
    const st = String((row && row.status) || 'not_started');
    if (st === 'running') return 'Running';
    if (st === 'paused') return 'Paused';
    if (st === 'completed') return 'Completed';
    return 'Not Started';
  }

  function renderPhaseSummaryList(summary) {
    const rows = Array.isArray(summary) ? summary : [];
    if (!rows.length) {
      return '<p class="muted machine-tank-phase-empty">No phase summary available yet.</p>';
    }
    return `<ul class="machine-tank-phase-list">
      ${rows
        .map((row) => {
          const st = String(row.status || 'not_started');
          const time = st === 'not_started' ? '—' : escapeHtml(row.total_duration_display || '0m');
          const completed =
            st === 'completed' && row.completed_at
              ? `<span class="machine-tank-phase-completed">${escapeHtml(fmtDateTime(row.completed_at))}</span>`
              : '';
          const notes = row.notes
            ? `<div class="machine-tank-phase-notes">${escapeHtml(row.notes)}</div>`
            : '';
          return `<li class="machine-tank-phase-item machine-tank-phase-item--${escapeHtml(st)}">
            <div class="machine-tank-phase-main">
              <span class="machine-tank-phase-name">${escapeHtml(row.phase_name || row.phase_code || '—')}</span>
              <span class="machine-tank-phase-time">${time}</span>
              <span class="machine-tank-phase-status">${escapeHtml(phaseStatusLabel(row))}</span>
            </div>
            ${completed}
            ${notes}
          </li>`;
        })
        .join('')}
    </ul>`;
  }

  function tankSessionStatusLabel(session) {
    if (!session) return 'Idle';
    if (session.status_label) return session.status_label;
    return statusLabel(session.status, null);
  }

  function sessionStatusClass(session) {
    const st = session.status || 'idle';
    const reason = String(session.stop_reason || '').toLowerCase();
    if (st === 'running') return 'running';
    if (reason === 'downtime') return 'downtime';
    if (reason === 'break') return 'break';
    if (reason === 'lunch') return 'lunch';
    if (st === 'stopped') return 'paused';
    return 'idle';
  }

  function aggregateTankStatus(sessions) {
    const list = Array.isArray(sessions) ? sessions : [];
    if (!list.length) return { label: 'Idle', cls: 'idle' };
    if (list.some((s) => s.status === 'running')) return { label: 'Running', cls: 'running' };
    const priority = ['downtime', 'qa_qc', 'break', 'lunch'];
    for (const key of priority) {
      const match = list.find((s) => String(s.stop_reason || '').toLowerCase() === key);
      if (match) {
        return { label: tankSessionStatusLabel(match), cls: sessionStatusClass(match) };
      }
    }
    const first = list[0];
    return { label: tankSessionStatusLabel(first), cls: sessionStatusClass(first) };
  }

  function pieceStatusLine(session) {
    const phase = session.phase_name || session.activity_name || '—';
    const time = session.running_time_display || session.elapsed_display || '—';
    const status = tankSessionStatusLabel(session);
    if (session.status === 'running') return `${escapeHtml(phase)} — Running ${escapeHtml(time)}`;
    return `${escapeHtml(phase)} — ${escapeHtml(status)}${time && time !== '—' ? ` — ${escapeHtml(time)}` : ''}`;
  }

  function renderActivePieceRow(session, tankId) {
    if (!session) return '';
    const pieceNum = Number(session.piece_number) || 1;
    const stCls = sessionStatusClass(session);
    return `<div class="machine-tank-piece-row machine-tank-piece-row--${stCls}" data-session-id="${Number(session.id)}" data-piece="${pieceNum}">
      <div class="machine-tank-piece-main">
        <div class="machine-tank-piece-head">Piece ${escapeHtml(String(pieceNum))}</div>
        <div class="machine-tank-piece-detail">${pieceStatusLine(session)}</div>
      </div>
      <div class="machine-tank-piece-actions">
        <button type="button" class="btn btn-sm btn-edit-phase-time" data-tank-id="${tankId}" data-piece="${pieceNum}" data-phase="${escapeHtml(session.phase_code || session.activity_code || '')}" data-session-id="${Number(session.id)}">Edit Phase Time</button>
        ${renderSessionDetailsBtn(session.id)}
      </div>
    </div>`;
  }

  function renderActiveTankCard(group, selectedTankId, machineName) {
    const sessions = (group.sessions || []).slice().sort((a, b) => Number(a.piece_number) - Number(b.piece_number));
    if (!sessions.length) return '';
    const primary = sessions[0];
    const tankId = Number(group.tank_id || primary.tank_id);
    const tankNumber = group.tank_number || primary.tank_number || '—';
    const isSelected = selectedTankId != null && tankId === Number(selectedTankId);
    const isExpanded = expandedTankIds.has(tankId);
    const tankStatus = aggregateTankStatus(sessions);
    const summary = primary.phase_time_summary || [];
    const totalDisplay = primary.tank_total_running_time_display || '—';
    const teamName = primary.team_name || '—';

    return `<article class="machine-tank-card machine-tank-card--${tankStatus.cls}${isSelected ? ' machine-tank-card--kiosk-focus' : ''}${isExpanded ? ' is-expanded' : ''}" data-tank-id="${tankId}" data-tank-number="${escapeHtml(tankNumber)}">
      <button type="button" class="machine-tank-card-toggle" data-toggle-phase-summary data-tank-id="${tankId}" aria-expanded="${isExpanded ? 'true' : 'false'}">
        <header class="machine-tank-card-head">
          <h4 class="machine-tank-card-title">Tank ${escapeHtml(tankNumber)} — ${escapeHtml(tankStatus.label)}</h4>
          <span class="machine-tank-card-chevron" aria-hidden="true">${isExpanded ? '▾' : '▸'}</span>
        </header>
      </button>
      <div class="machine-tank-pieces">
        ${sessions.map((s) => renderActivePieceRow(s, tankId)).join('')}
      </div>
      <dl class="machine-tank-card-meta">
        <div><dt>Tank Total Running Time</dt><dd>${escapeHtml(totalDisplay)}</dd></div>
        <div><dt>Team</dt><dd>${escapeHtml(teamName)}</dd></div>
        <div><dt>Machine</dt><dd>${escapeHtml(machineName || primary.machine_name || '—')}</dd></div>
      </dl>
      <div class="machine-tank-card-actions">
        <button type="button" class="btn btn-sm btn-primary btn-view-phase-summary" data-toggle-phase-summary data-tank-id="${tankId}">
          ${isExpanded ? 'Hide Phase Summary' : 'View Phase Summary'}
        </button>
        <button type="button" class="btn btn-sm btn-view-tank-activity" data-tank="${escapeHtml(tankNumber)}">View Tank Activity</button>
      </div>
      <div class="machine-tank-phase-panel" data-phase-panel="${tankId}" ${isExpanded ? '' : 'hidden'}>
        <div class="machine-tank-phase-panel-head">
          <strong>Phase Time Summary</strong>
          <span class="muted">Tank ${escapeHtml(tankNumber)} · read-only</span>
        </div>
        <div class="machine-tank-phase-meta">
          <span>Status: <strong>${escapeHtml(tankStatus.label)}</strong></span>
          <span>Active pieces: <strong>${sessions.length}</strong></span>
          <span>Tank total: <strong>${escapeHtml(totalDisplay)}</strong></span>
        </div>
        ${renderPhaseSummaryList(summary)}
      </div>
    </article>`;
  }

  function renderActiveTanksSection(m) {
    const sessions = Array.isArray(m.open_sessions) ? m.open_sessions : [];
    if (!sessions.length) {
      return `<div class="machine-active-tanks" data-field="active-tanks">
        <p class="machine-active-tanks-empty muted">No active tanks on this machine.</p>
      </div>`;
    }
    const selectedId = m.selected_tank_id != null ? m.selected_tank_id : m.tank_id;
    const byTank = new Map();
    for (const s of sessions) {
      const tankId = Number(s.tank_id);
      const key = Number.isInteger(tankId) && tankId > 0 ? tankId : String(s.tank_number || '');
      if (!byTank.has(key)) {
        byTank.set(key, {
          tank_id: tankId,
          tank_number: s.tank_number,
          sessions: [],
        });
      }
      byTank.get(key).sessions.push(s);
    }
    const groups = Array.from(byTank.values()).sort((a, b) =>
      String(a.tank_number || '').localeCompare(String(b.tank_number || ''), undefined, {
        numeric: true,
        sensitivity: 'base',
      })
    );
    const pieceCount = sessions.length;
    const tankCount = groups.length;
    return `<div class="machine-active-tanks" data-field="active-tanks">
      <div class="machine-active-tanks-label">Active Production (${tankCount} tank${tankCount === 1 ? '' : 's'}, ${pieceCount} piece${pieceCount === 1 ? '' : 's'})</div>
      <div class="machine-active-tanks-list">
        ${groups.map((g) => renderActiveTankCard(g, selectedId, m.name)).join('')}
      </div>
    </div>`;
  }

  function renderCard(m, opts) {
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
          <span>${escapeHtml(formatAlertDetail(a))}</span>
          ${renderEmailStatus(a)}
        </div>
        ${opts && opts.allowResolve ? resolveBtn(a.id) : ''}
      </li>`
          )
          .join('')}</ul>`
      : '';

    const assignedTeam = m.assigned_team || m.current_team || '—';
    const machineStatusText = statusLabel(m.status, m.status_label);

    return `<article class="machine-card ${cardAlertCls}" data-machine-id="${Number(m.id)}">
      <header class="machine-card-head">
        <div>
          <h3 class="machine-card-title">${escapeHtml(m.name)}</h3>
          <p class="machine-card-assigned">Assigned Team: <strong data-field="team">${escapeHtml(assignedTeam)}</strong></p>
        </div>
        <span class="machine-card-status machine-card-status--${escapeHtml(m.status || 'idle')}" data-field="machine-status">${escapeHtml(machineStatusText)}</span>
      </header>
      ${renderActiveTanksSection(m)}
      <div class="machine-card-meta">
        <span data-field="alerts" class="${alertCount ? 'machine-open-alerts-count' : ''}">Open Alerts: ${alertCount}</span>
      </div>
      ${alertList}
    </article>`;
  }

  function wirePhaseSummaryToggles(container) {
    if (!container) return;
    container.querySelectorAll('[data-toggle-phase-summary]').forEach((btn) => {
      if (btn.dataset.wired === '1') return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tankId = Number(btn.getAttribute('data-tank-id'));
        if (!Number.isInteger(tankId) || tankId <= 0) return;
        if (expandedTankIds.has(tankId)) expandedTankIds.delete(tankId);
        else expandedTankIds.add(tankId);
        const card = btn.closest('.machine-tank-card') || btn.closest('.machine-tank-session');
        if (!card) return;
        const expanded = expandedTankIds.has(tankId);
        card.classList.toggle('is-expanded', expanded);
        const panel = card.querySelector(`[data-phase-panel="${tankId}"]`);
        if (panel) panel.hidden = !expanded;
        const toggle = card.querySelector('.machine-tank-card-toggle') || card.querySelector('.machine-tank-session-toggle');
        if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        const chevron = card.querySelector('.machine-tank-card-chevron') || card.querySelector('.machine-tank-session-chevron');
        if (chevron) chevron.textContent = expanded ? '▾' : '▸';
        card.querySelectorAll('.btn-view-phase-summary').forEach((b) => {
          b.textContent = expanded ? 'Hide Phase Summary' : 'View Phase Summary';
        });
      });
    });
  }

  function wireSessionDetailsButtons(container) {
    if (!container) return;
    container.querySelectorAll('.btn-session-details').forEach((btn) => {
      if (btn.dataset.wired === '1') return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
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
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tank = btn.getAttribute('data-tank');
        if (tank && root.TankActivity) root.TankActivity.open(tank);
      });
    });
  }

  function wireEditPhaseTimeButtons(container) {
    if (!container) return;
    container.querySelectorAll('.btn-edit-phase-time').forEach((btn) => {
      if (btn.dataset.wired === '1') return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tankId = Number(btn.getAttribute('data-tank-id'));
        if (!Number.isInteger(tankId) || tankId <= 0 || !root.PhaseTimeEditor) return;
        root.PhaseTimeEditor.open(tankId, {
          pieceNumber: btn.getAttribute('data-piece') ? Number(btn.getAttribute('data-piece')) : null,
          phaseCode: btn.getAttribute('data-phase') || null,
          sessionId: btn.getAttribute('data-session-id') ? Number(btn.getAttribute('data-session-id')) : null,
        });
      });
    });
  }

  function wireTankCardControls(container) {
    wirePhaseSummaryToggles(container);
    wireTankActivityButtons(container);
    wireEditPhaseTimeButtons(container);
    wireSessionDetailsButtons(container);
  }

  function updateCardInPlace(cardEl, m, opts) {
    const alerts = m.open_alerts || [];
    const alertCount = alerts.length;
    const hasQa = alerts.some((a) => a.alert_type === 'qa_qc');
    const hasMaint = alerts.some((a) => a.alert_type === 'maintenance');
    cardEl.classList.toggle('machine-card--alert-qa', hasQa);
    cardEl.classList.toggle('machine-card--alert-maint', !hasQa && hasMaint);

    const setField = (name, html) => {
      const fieldEl = cardEl.querySelector(`[data-field="${name}"]`);
      if (fieldEl && fieldEl.innerHTML !== html) fieldEl.innerHTML = html;
    };

    const assignedTeam = m.assigned_team || m.current_team || '—';
    setField('team', escapeHtml(assignedTeam));
    setField('machine-status', escapeHtml(statusLabel(m.status, m.status_label)));

    const statusEl = cardEl.querySelector('[data-field="machine-status"]');
    if (statusEl) {
      statusEl.className = `machine-card-status machine-card-status--${m.status || 'idle'}`;
    }

    const nextTanksHtml = renderActiveTanksSection(m);
    const tanksEl = cardEl.querySelector('[data-field="active-tanks"]');
    if (tanksEl) {
      const tmp = document.createElement('div');
      tmp.innerHTML = nextTanksHtml;
      const nextEl = tmp.firstElementChild;
      if (nextEl && tanksEl.outerHTML !== nextEl.outerHTML) {
        tanksEl.outerHTML = nextTanksHtml;
        wireTankCardControls(cardEl);
      }
    } else {
      const head = cardEl.querySelector('.machine-card-head');
      if (head) head.insertAdjacentHTML('afterend', nextTanksHtml);
      wireTankCardControls(cardEl);
    }

    const alertsEl = cardEl.querySelector('[data-field="alerts"]');
    if (alertsEl) {
      const html = `Open Alerts: ${alertCount}`;
      if (alertsEl.innerHTML !== html) alertsEl.innerHTML = html;
      alertsEl.classList.toggle('machine-open-alerts-count', alertCount > 0);
    }

    const newAlertList = alerts.length
      ? `<ul class="machine-alert-list">${alerts
          .map(
            (a) => `<li class="machine-alert-item ${a.css_class === 'alert-maint' ? 'alert-maint' : 'alert-qa'}">
        <div class="machine-alert-item-main">
          <strong>${escapeHtml(a.alert_label || a.alert_type)}</strong>
          <span>${escapeHtml(formatAlertDetail(a))}</span>
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
          <span>${escapeHtml(formatAlertDetail(a))}</span>
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
    const { res, data } = await fetchJson('/api/manager/machines');
    if (!res.ok || !data.ok) throw new Error((data && data.message) || 'Could not load machines');
    return data.machines || [];
  }

  async function fetchOpenAlerts() {
    const { res, data } = await fetchJson('/api/manager/alerts?status=open');
    if (!res.ok || !data.ok) throw new Error((data && data.message) || 'Could not load alerts');
    return data.alerts || [];
  }

  async function resolveAlert(id) {
    const { res, data } = await fetchJson(`/api/manager/alerts/${Number(id)}/resolve`, { method: 'PATCH' });
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
      wireTankCardControls(el);
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
        el.dataset.machineSignature = '';
        el.innerHTML = renderLoadError(err.message || 'Could not load machines', 'machines');
        const btn = el.querySelector('[data-retry]');
        if (btn) {
          btn.addEventListener('click', () => {
            el.innerHTML = '<p class="muted">Loading machines…</p>';
            void refresh();
          });
        }
      }
    }

    void refresh();
    const onPhaseEdited = () => {
      void refresh();
    };
    root.addEventListener('factory:phase-time-edited', onPhaseEdited);
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
        root.removeEventListener('factory:phase-time-edited', onPhaseEdited);
      },
    };
  }

  root.MachineDashboard = { mount, fetchMachines, fetchOpenAlerts, renderCard, renderGlobalAlerts, renderEmailStatus };
})(window);
