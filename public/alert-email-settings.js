'use strict';

(function initAlertEmailSettings() {
  const qaQcHint = document.getElementById('qaQcHint');
  const maintHint = document.getElementById('maintHint');
  const smtpStatus = document.getElementById('smtpStatus');
  const qaQcBody = document.getElementById('qaQcBody');
  const maintBody = document.getElementById('maintBody');

  function showHint(el, message, isError) {
    if (!el) return;
    el.textContent = message || '';
    el.className = `toastline manager-alert${isError ? ' is-error' : message ? ' is-success' : ''}`;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString();
  }

  function renderRows(tbody, rows, alertType) {
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="muted">No recipients yet.</td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map(
        (r) => `<tr>
        <td>${escapeHtml(r.email)}</td>
        <td>${fmtDate(r.created_at)}</td>
        <td><button type="button" class="btn btn-sm btn-danger btn-remove-recipient" data-id="${Number(r.id)}" data-type="${alertType}">Remove</button></td>
      </tr>`
      )
      .join('');
    tbody.querySelectorAll('.btn-remove-recipient').forEach((btn) => {
      btn.addEventListener('click', () => void removeRecipient(btn.getAttribute('data-id'), btn.getAttribute('data-type')));
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function loadRecipients() {
    const res = await fetch('/api/manager/alert-email-recipients', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error((data && data.message) || 'Could not load settings.');
    if (smtpStatus) {
      smtpStatus.className = `manager-smtp-value${data.smtp_configured ? ' is-ok' : ' is-error'}`;
      smtpStatus.textContent = data.smtp_configured
        ? '✔ SMTP configured successfully.'
        : '❌ SMTP not configured.';
    }
    const all = data.recipients || [];
    renderRows(
      qaQcBody,
      all.filter((r) => r.alert_type === 'qa_qc'),
      'qa_qc'
    );
    renderRows(
      maintBody,
      all.filter((r) => r.alert_type === 'maintenance'),
      'maintenance'
    );
  }

  async function addRecipient(alertType, email, hintEl, inputEl) {
    showHint(hintEl, '', false);
    const res = await fetch('/api/manager/alert-email-recipients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alert_type: alertType, email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      showHint(hintEl, (data && data.message) || 'Could not add recipient.', true);
      return;
    }
    if (inputEl) inputEl.value = '';
    showHint(hintEl, 'Recipient added.', false);
    await loadRecipients();
  }

  async function removeRecipient(id, alertType) {
    const hintEl = alertType === 'maintenance' ? maintHint : qaQcHint;
    showHint(hintEl, '', false);
    const res = await fetch(`/api/manager/alert-email-recipients/${Number(id)}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      showHint(hintEl, (data && data.message) || 'Could not remove recipient.', true);
      return;
    }
    showHint(hintEl, 'Recipient removed.', false);
    await loadRecipients();
  }

  async function sendTest(alertType, hintEl) {
    showHint(hintEl, 'Sending test email…', false);
    const res = await fetch('/api/manager/alert-email-recipients/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alert_type: alertType }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      showHint(hintEl, (data && data.message) || 'Test email failed.', true);
      return;
    }
    showHint(hintEl, data.message || 'Test email sent.', false);
  }

  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/manager-login';
  });

  document.getElementById('btnAddQaQc')?.addEventListener('click', () => {
    const input = document.getElementById('qaQcEmail');
    void addRecipient('qa_qc', input ? input.value : '', qaQcHint, input);
  });

  document.getElementById('btnAddMaint')?.addEventListener('click', () => {
    const input = document.getElementById('maintEmail');
    void addRecipient('maintenance', input ? input.value : '', maintHint, input);
  });

  document.getElementById('btnTestQaQc')?.addEventListener('click', () => void sendTest('qa_qc', qaQcHint));
  document.getElementById('btnTestMaint')?.addEventListener('click', () => void sendTest('maintenance', maintHint));

  void loadRecipients().catch((err) => {
    if (smtpStatus) {
      smtpStatus.className = 'manager-smtp-value is-error';
      smtpStatus.textContent = err.message || 'Could not load settings.';
    }
  });
})();
