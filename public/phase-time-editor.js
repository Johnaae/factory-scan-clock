'use strict';

/**
 * Manager / Main Dashboard — Edit Phase Time by Tank + Piece + Phase + Session.
 * Each session expands into editable Start/End date+time fields (not read-only).
 */
(function initPhaseTimeEditor(root) {
  let backdrop = null;
  let titleEl = null;
  let bodyEl = null;
  let tankId = null;
  let state = null;
  let selectedSessionId = null;
  let onSaved = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString([], {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function splitLocal(iso) {
    if (!iso) return { date: '', time: '' };
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { date: '', time: '' };
    const p = (n) => String(n).padStart(2, '0');
    return {
      date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
      time: `${p(d.getHours())}:${p(d.getMinutes())}`,
    };
  }

  function combineLocal(dateStr, timeStr) {
    const d = String(dateStr || '').trim();
    const t = String(timeStr || '').trim();
    if (!d || !t) return null;
    const parsed = new Date(`${d}T${t}:00`);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  }

  function durationLabel(ms) {
    const totalMin = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
    if (totalMin < 1) return '0 minutes';
    if (totalMin < 60) return `${totalMin} minute${totalMin === 1 ? '' : 's'}`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  }

  function clockFromMs(ms) {
    const totalSec = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
    const hh = Math.floor(totalSec / 3600);
    const mm = Math.floor((totalSec % 3600) / 60);
    const ss = totalSec % 60;
    const p = (n) => String(n).padStart(2, '0');
    return `${p(hh)}:${p(mm)}:${p(ss)}`;
  }

  function ensureModal() {
    if (backdrop) return;
    backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop phase-time-editor-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.innerHTML = `
      <div class="modal modal-wide phase-time-editor-modal" role="document">
        <div class="modal-head">
          <h3 id="phaseTimeEditorTitle">Edit Phase Time</h3>
          <div class="toolbar">
            <button type="button" class="btn btn-sm" data-phase-editor-close>Close</button>
          </div>
        </div>
        <div class="modal-body" id="phaseTimeEditorBody"></div>
      </div>`;
    document.body.appendChild(backdrop);
    titleEl = backdrop.querySelector('#phaseTimeEditorTitle');
    bodyEl = backdrop.querySelector('#phaseTimeEditorBody');
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop || e.target.hasAttribute('data-phase-editor-close')) close();
    });
  }

  function open() {
    ensureModal();
    backdrop.classList.add('show');
    backdrop.setAttribute('aria-hidden', 'false');
  }

  function close() {
    if (!backdrop) return;
    backdrop.classList.remove('show');
    backdrop.setAttribute('aria-hidden', 'true');
    tankId = null;
    state = null;
    selectedSessionId = null;
  }

  async function load(piece, phase) {
    const qs = new URLSearchParams();
    if (piece != null && piece !== '') qs.set('piece', String(piece));
    if (phase) qs.set('phase', String(phase));
    const url = `/api/manager/tanks/${tankId}/phase-editor${qs.toString() ? `?${qs}` : ''}`;
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error((data && data.message) || 'Could not load phase editor.');
    state = data;
    if (selectedSessionId != null) {
      const still = (data.sessions || []).some((s) => Number(s.id) === Number(selectedSessionId));
      if (!still) selectedSessionId = null;
    }
    if (selectedSessionId == null && (data.sessions || []).length === 1) {
      selectedSessionId = Number(data.sessions[0].id);
    }
    render();
  }

  function previewPhaseTotalMs(draftSessionId, draftMs) {
    const sessions = state.sessions || [];
    let total = 0;
    for (const s of sessions) {
      if (Number(s.id) === Number(draftSessionId) && draftMs != null) total += draftMs;
      else total += Number(s.duration_ms) || 0;
    }
    return total;
  }

  function updateLiveTotals(form) {
    if (!form || !state) return;
    const start = combineLocal(form.start_date.value, form.start_time.value);
    const end = combineLocal(form.end_date.value, form.end_time.value);
    const sessionTotalEl = form.querySelector('[data-session-total]');
    const phaseTotalEl = bodyEl.querySelector('[data-phase-total-live]');
    const phaseClockEl = bodyEl.querySelector('[data-phase-total-clock]');
    let draftMs = null;
    if (start && end && end.getTime() >= start.getTime()) {
      draftMs = end.getTime() - start.getTime();
    }
    if (sessionTotalEl) {
      sessionTotalEl.textContent =
        draftMs == null ? 'Enter valid Start and End' : durationLabel(draftMs);
    }
    if (phaseTotalEl) {
      const sid = Number(form.getAttribute('data-session-id'));
      const phaseMs = previewPhaseTotalMs(sid, draftMs != null ? draftMs : undefined);
      phaseTotalEl.textContent = durationLabel(phaseMs);
      if (phaseClockEl) phaseClockEl.textContent = clockFromMs(phaseMs);
    }
  }

  function renderSessionCard(s, idx) {
    const expanded = Number(s.id) === Number(selectedSessionId);
    const startParts = splitLocal(s.started_at);
    const endParts = splitLocal(s.ended_at);
    const header = `
      <div class="phase-editor-session-head">
        <div>
          <div class="phase-editor-session-title">Session ${idx + 1}${
            s.is_edited ? ' · <span class="badge badge-warn">Edited</span>' : ''
          }</div>
          <div class="muted">${escapeHtml(fmtDateTime(s.started_at))} → ${escapeHtml(
            s.ended_at ? fmtDateTime(s.ended_at) : 'In progress'
          )} · ${escapeHtml(s.duration_display || durationLabel(s.duration_ms))}</div>
          <div class="muted">${escapeHtml(s.team_name || '')} · ${escapeHtml(s.machine_name || '')}</div>
        </div>
        <button type="button" class="btn btn-sm btn-primary" data-expand-session="${Number(s.id)}">
          ${expanded ? 'Hide Edit' : 'Edit'}
        </button>
      </div>`;

    if (!expanded) {
      return `<div class="phase-editor-session-card" data-session-wrap="${Number(s.id)}">${header}</div>`;
    }

    return `<div class="phase-editor-session-card is-selected is-editing" data-session-wrap="${Number(s.id)}">
      ${header}
      <form class="phase-editor-edit-form" data-session-id="${Number(s.id)}" autocomplete="off">
        <div class="phase-editor-datetime-grid">
          <div class="field">
            <label>Start Date</label>
            <input type="date" name="start_date" value="${escapeHtml(startParts.date)}" required />
          </div>
          <div class="field">
            <label>Start Time</label>
            <input type="time" name="start_time" value="${escapeHtml(startParts.time)}" required />
          </div>
          <div class="field">
            <label>End Date</label>
            <input type="date" name="end_date" value="${escapeHtml(endParts.date)}" required />
          </div>
          <div class="field">
            <label>End Time</label>
            <input type="time" name="end_time" value="${escapeHtml(endParts.time)}" required />
          </div>
        </div>
        <div class="phase-editor-session-total">
          <strong>Total (this session):</strong>
          <span data-session-total>${escapeHtml(durationLabel(s.duration_ms))}</span>
        </div>
        <div class="field">
          <label>Edit Reason</label>
          <input type="text" name="edit_reason" placeholder="Operator forgot to change phase." required maxlength="500" />
        </div>
        <div class="toolbar">
          <button type="button" class="btn btn-sm" data-cancel-edit>Cancel</button>
          <button type="submit" class="btn btn-primary">Save Changes</button>
        </div>
        <div class="toastline" data-hint></div>
      </form>
    </div>`;
  }

  function render() {
    if (!bodyEl || !state) return;
    const tank = state.tank || {};
    if (titleEl) titleEl.textContent = `Edit Phase Time · Tank ${tank.tank_number || tankId}`;

    const pieceOpts = (state.pieces || [])
      .map((p) => {
        const sel = Number(state.selected_piece_number) === Number(p.piece_number) ? ' selected' : '';
        return `<option value="${Number(p.piece_number)}"${sel}>Piece ${Number(p.piece_number)}</option>`;
      })
      .join('');

    const needPiece = state.selected_piece_number == null && (state.pieces || []).length > 1;

    const phaseList = (state.phase_summaries || [])
      .map((p) => {
        const active = p.phase_code === state.selected_phase_code ? ' is-selected' : '';
        const disabled = !p.has_recorded_activity ? ' is-disabled' : '';
        return `<button type="button" class="btn-secondary phase-editor-phase-btn${active}${disabled}" data-phase="${escapeHtml(
          p.phase_code
        )}" ${p.has_recorded_activity ? '' : 'disabled'}>${escapeHtml(p.summary_line || p.phase_name)}</button>`;
      })
      .join('');

    const sessions = state.sessions || [];
    const sessionBlocks = sessions.length
      ? sessions.map((s, idx) => renderSessionCard(s, idx)).join('')
      : '<p class="muted">No recorded intervals for this phase.</p>';

    bodyEl.innerHTML = `
      <p class="muted">Select Piece and Phase, then click <strong>Edit</strong> on a session. Start/End are editable. Totals recalculate from productive intervals (Break/Lunch/Downtime/End Shift are not included).</p>
      <div class="phase-editor-controls">
        <div class="field">
          <label for="phaseEditorPiece">Select Piece</label>
          <select id="phaseEditorPiece">
            ${
              needPiece || state.selected_piece_number == null
                ? '<option value="">— Select piece —</option>'
                : ''
            }
            ${pieceOpts}
          </select>
        </div>
        <div class="field">
          <label>Select Phase</label>
          <div class="phase-editor-phase-list">${
            state.selected_piece_number == null
              ? '<p class="muted">Select a piece to load phase history.</p>'
              : phaseList || '<p class="muted">No phases configured.</p>'
          }</div>
        </div>
      </div>
      ${
        state.selected_phase
          ? `<h4 class="session-details-section-title">Piece ${Number(state.selected_piece_number)} · Phase: ${escapeHtml(
              state.selected_phase.phase_name || ''
            )}</h4>
             <p class="phase-editor-phase-total">
               <strong>TOTAL PHASE TIME</strong>
               <span data-phase-total-live>${escapeHtml(durationLabel(state.phase_total_ms))}</span>
               <span class="muted">(<span data-phase-total-clock>${escapeHtml(
                 state.phase_total_clock || clockFromMs(state.phase_total_ms)
               )}</span> sum of sessions)</span>
             </p>
             <div class="phase-editor-sessions">${sessionBlocks}</div>`
          : ''
      }`;

    const pieceSel = bodyEl.querySelector('#phaseEditorPiece');
    if (pieceSel) {
      pieceSel.addEventListener('change', () => {
        selectedSessionId = null;
        void load(pieceSel.value || null, null).catch((err) => {
          bodyEl.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
        });
      });
    }

    bodyEl.querySelectorAll('[data-phase]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedSessionId = null;
        void load(state.selected_piece_number, btn.getAttribute('data-phase')).catch((err) => {
          bodyEl.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
        });
      });
    });

    bodyEl.querySelectorAll('[data-expand-session]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.getAttribute('data-expand-session'));
        selectedSessionId = Number(selectedSessionId) === id ? null : id;
        render();
        if (selectedSessionId != null) {
          const form = bodyEl.querySelector(
            `form.phase-editor-edit-form[data-session-id="${selectedSessionId}"]`
          );
          if (form) {
            form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            const first = form.querySelector('input[name="start_date"]');
            if (first) first.focus();
          }
        }
      });
    });

    bodyEl.querySelectorAll('form.phase-editor-edit-form').forEach((form) => {
      const onChange = () => updateLiveTotals(form);
      ['start_date', 'start_time', 'end_date', 'end_time'].forEach((name) => {
        const el = form.elements.namedItem(name);
        if (!el || !el.addEventListener) return;
        el.addEventListener('input', onChange);
        el.addEventListener('change', onChange);
      });
      const cancelBtn = form.querySelector('[data-cancel-edit]');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          selectedSessionId = null;
          render();
        });
      }
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        void saveForm(form);
      });
      updateLiveTotals(form);
    });

    // If already expanded (e.g. single session auto-open), keep form on screen.
    if (selectedSessionId != null) {
      const form = bodyEl.querySelector(
        `form.phase-editor-edit-form[data-session-id="${selectedSessionId}"]`
      );
      if (form) form.scrollIntoView({ block: 'nearest' });
    }
  }

  async function saveForm(form) {
    const hint = form.querySelector('[data-hint]');
    const sessionId = Number(form.getAttribute('data-session-id'));
    const reason = String(form.edit_reason.value || '').trim();
    if (!reason) {
      if (hint) hint.textContent = 'Edit reason is required.';
      return;
    }
    const start = combineLocal(form.start_date.value, form.start_time.value);
    const end = combineLocal(form.end_date.value, form.end_time.value);
    if (!start || !end) {
      if (hint) hint.textContent = 'Start and End date/time are required.';
      return;
    }
    if (end.getTime() < start.getTime()) {
      if (hint) hint.textContent = 'End must be after Start.';
      return;
    }
    if (hint) hint.textContent = 'Saving…';
    const res = await fetch(`/api/manager/sessions/${sessionId}/times`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        started_at: start.toISOString(),
        ended_at: end.toISOString(),
        edit_reason: reason,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      if (hint) hint.textContent = (data && data.message) || 'Save failed.';
      return;
    }
    if (hint) hint.textContent = 'Saved.';
    selectedSessionId = sessionId;
    await load(state.selected_piece_number, state.selected_phase_code);
    try {
      root.dispatchEvent(
        new CustomEvent('factory:phase-time-edited', {
          detail: { tankId, sessionId, result: data },
        })
      );
    } catch (_err) {
      /* ignore */
    }
    if (typeof onSaved === 'function') {
      try {
        onSaved({ tankId, sessionId, result: data });
      } catch (_err) {
        /* ignore */
      }
    }
  }

  async function openPhaseTimeEditor(id, opts = {}) {
    const tid = Number(id);
    if (!Number.isInteger(tid) || tid <= 0) return;
    tankId = tid;
    onSaved = typeof opts.onSaved === 'function' ? opts.onSaved : null;
    selectedSessionId = opts.sessionId != null ? Number(opts.sessionId) : null;
    open();
    if (bodyEl) bodyEl.innerHTML = '<p class="muted">Loading phase editor…</p>';
    try {
      await load(opts.pieceNumber != null ? opts.pieceNumber : null, opts.phaseCode || null);
      // Auto-expand when opened with a specific session, or when only one session exists.
      if (selectedSessionId == null && state && (state.sessions || []).length === 1) {
        selectedSessionId = Number(state.sessions[0].id);
        render();
      } else if (selectedSessionId != null) {
        render();
      }
    } catch (err) {
      if (bodyEl) bodyEl.innerHTML = `<p class="muted">${escapeHtml(err.message || 'Could not load.')}</p>`;
    }
  }

  root.PhaseTimeEditor = { open: openPhaseTimeEditor, close };
})(window);
