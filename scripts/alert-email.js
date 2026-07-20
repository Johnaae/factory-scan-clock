'use strict';

const nodemailer = require('nodemailer');

const RETRY_DELAY_MS = 30_000;

function normalizeEmail(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (!s || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

function formatAlertDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const date = d.toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${date} ${time}`;
}

function formatDurationMs(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

function alertTypeLabel(alertType) {
  return alertType === 'maintenance' ? 'Maintenance/Tooling' : 'QA/QC';
}

function machineDisplayName(row) {
  return row.machine_name || row.machine_code || 'Unknown Machine';
}

function buildNewAlertSubject(row) {
  const machine = machineDisplayName(row);
  if (row.alert_type === 'maintenance') {
    return `🚨 MAINTENANCE ALERT - ${machine}`;
  }
  return `🚨 QA/QC ALERT - ${machine}`;
}

function buildNewAlertBody(row) {
  const phase = row.phase_name || row.wip_phase_name || '—';
  const tank = row.tank_number ? row.tank_number : '—';
  return [
    'Factory Production Alert',
    '',
    'Alert Type:',
    alertTypeLabel(row.alert_type),
    '',
    'Machine:',
    machineDisplayName(row),
    '',
    'Team:',
    row.team_name || '—',
    '',
    'Tank:',
    tank,
    '',
    'Current Phase:',
    phase,
    '',
    'Reported Time:',
    formatAlertDateTime(row.reported_at),
    '',
    'Status:',
    'OPEN',
    '',
    'Please inspect immediately.',
  ].join('\n');
}

function buildResolveSubject(row) {
  if (row.alert_type === 'maintenance') {
    return '✅ Maintenance Alert Resolved';
  }
  return '✅ QA/QC Alert Resolved';
}

function buildResolveBody(row) {
  const reported = row.reported_at ? new Date(row.reported_at).getTime() : NaN;
  const resolved = row.resolved_at ? new Date(row.resolved_at).getTime() : NaN;
  const duration =
    Number.isFinite(reported) && Number.isFinite(resolved) ? formatDurationMs(resolved - reported) : '—';
  return [
    'Factory Production Alert Resolved',
    '',
    'Alert Type',
    alertTypeLabel(row.alert_type),
    '',
    'Machine',
    machineDisplayName(row),
    '',
    'Tank',
    row.tank_number || '—',
    '',
    'Resolved By',
    row.resolved_by || '—',
    '',
    'Resolved Time',
    formatAlertDateTime(row.resolved_at),
    '',
    'Duration Open',
    duration,
  ].join('\n');
}

function createAlertEmailService({ pool }) {
  function smtpConfig() {
    const host = String(process.env.SMTP_HOST || '').trim();
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';
    const user = String(process.env.SMTP_USER || '').trim();
    const pass = String(process.env.SMTP_PASS || '');
    const from = String(process.env.SMTP_FROM || user || '').trim();
    if (!host || !from) return null;
    return { host, port, secure, user, pass, from };
  }

  function createTransport() {
    const cfg = smtpConfig();
    if (!cfg) return null;
    const options = {
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
    };
    if (cfg.user) {
      options.auth = { user: cfg.user, pass: cfg.pass };
    }
    return { transport: nodemailer.createTransport(options), from: cfg.from };
  }

  async function fetchRecipients(alertType) {
    const { rows } = await pool.query(
      `SELECT id, alert_type, email FROM alert_email_recipients
       WHERE alert_type = $1 ORDER BY email ASC`,
      [String(alertType)]
    );
    return rows.map((r) => normalizeEmail(r.email)).filter(Boolean);
  }

  async function fetchAlertRow(alertId) {
    const { rows } = await pool.query(
      `SELECT ae.*,
              m.name AS machine_name, m.code AS machine_code,
              t.name AS team_name,
              tk.tank_number, tk.wip_phase_name,
              ms.activity_name AS phase_name
       FROM alert_events ae
       LEFT JOIN machines m ON m.id = ae.machine_id
       LEFT JOIN teams t ON t.id = ae.team_id
       LEFT JOIN tanks tk ON tk.id = ae.tank_id
       LEFT JOIN machine_sessions ms ON ms.id = ae.session_id
       WHERE ae.id = $1`,
      [Number(alertId)]
    );
    return rows[0] || null;
  }

  async function updateNewEmailStatus(alertId, status, error) {
    await pool.query(
      `UPDATE alert_events
       SET email_status = $2,
           email_error = $3,
           email_sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE email_sent_at END
       WHERE id = $1`,
      [Number(alertId), status, error || null]
    );
  }

  async function updateResolveEmailStatus(alertId, status, error) {
    await pool.query(
      `UPDATE alert_events
       SET resolve_email_status = $2,
           resolve_email_error = $3,
           resolve_email_sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE resolve_email_sent_at END
       WHERE id = $1`,
      [Number(alertId), status, error || null]
    );
  }

  async function sendMail({ to, subject, text }) {
    const mailer = createTransport();
    if (!mailer) {
      throw new Error('SMTP is not configured (SMTP_HOST and SMTP_FROM required).');
    }
    await mailer.transport.sendMail({
      from: mailer.from,
      to: to.join(', '),
      subject,
      text,
    });
  }

  async function attemptSendNewAlert(alertId, isRetry) {
    const row = await fetchAlertRow(alertId);
    if (!row) return;
    const recipients = await fetchRecipients(row.alert_type);
    if (!recipients.length) {
      const msg = 'No email recipients configured for this alert type.';
      console.error('[alert-email] Email failed', { alertId, reason: msg, retry: isRetry });
      await updateNewEmailStatus(alertId, 'failed', msg);
      return;
    }
    try {
      await sendMail({
        to: recipients,
        subject: buildNewAlertSubject(row),
        text: buildNewAlertBody(row),
      });
      await updateNewEmailStatus(alertId, 'sent', null);
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      console.error('[alert-email] Email failed', { alertId, reason, retry: isRetry });
      await updateNewEmailStatus(alertId, 'failed', reason);
      if (!isRetry) {
        setTimeout(() => {
          void attemptSendNewAlert(alertId, true).catch((retryErr) => {
            console.error('[alert-email] Retry failed', { alertId, reason: retryErr.message || retryErr });
          });
        }, RETRY_DELAY_MS);
      }
    }
  }

  async function attemptSendResolveAlert(alertId, isRetry) {
    const row = await fetchAlertRow(alertId);
    if (!row || row.status !== 'resolved') return;
    const recipients = await fetchRecipients(row.alert_type);
    if (!recipients.length) {
      const msg = 'No email recipients configured for this alert type.';
      console.error('[alert-email] Resolve email failed', { alertId, reason: msg, retry: isRetry });
      await updateResolveEmailStatus(alertId, 'failed', msg);
      return;
    }
    try {
      await sendMail({
        to: recipients,
        subject: buildResolveSubject(row),
        text: buildResolveBody(row),
      });
      await updateResolveEmailStatus(alertId, 'sent', null);
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      console.error('[alert-email] Resolve email failed', { alertId, reason, retry: isRetry });
      await updateResolveEmailStatus(alertId, 'failed', reason);
      if (!isRetry) {
        setTimeout(() => {
          void attemptSendResolveAlert(alertId, true).catch((retryErr) => {
            console.error('[alert-email] Resolve retry failed', { alertId, reason: retryErr.message || retryErr });
          });
        }, RETRY_DELAY_MS);
      }
    }
  }

  function queueNewAlertEmail(alertId) {
    void attemptSendNewAlert(Number(alertId), false);
  }

  function queueResolveAlertEmail(alertId) {
    void attemptSendResolveAlert(Number(alertId), false);
  }

  async function sendTestEmail(alertType, targetEmail) {
    const type = alertType === 'maintenance' ? 'maintenance' : 'qa_qc';
    const to = targetEmail ? [normalizeEmail(targetEmail)].filter(Boolean) : await fetchRecipients(type);
    if (!to.length) {
      return { ok: false, status: 400, message: 'Add at least one recipient or provide a test address.' };
    }
    const sample = {
      alert_type: type,
      machine_name: 'Winding Machine 01',
      team_name: 'Winder 1',
      tank_number: 'TK-1005',
      phase_name: 'Hot Coat',
      reported_at: new Date().toISOString(),
      status: 'open',
    };
    try {
      await sendMail({
        to,
        subject: buildNewAlertSubject(sample),
        text: buildNewAlertBody(sample),
      });
      return { ok: true, message: `Test email sent to ${to.join(', ')}.` };
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      console.error('[alert-email] Test email failed', { reason });
      return { ok: false, status: 500, message: reason };
    }
  }

  async function listRecipients() {
    const { rows } = await pool.query(
      `SELECT id, alert_type, email, created_at
       FROM alert_email_recipients
       ORDER BY alert_type ASC, email ASC`
    );
    return rows.map((r) => ({
      id: Number(r.id),
      alert_type: r.alert_type,
      email: r.email,
      created_at: r.created_at,
    }));
  }

  async function addRecipient(alertType, emailRaw) {
    const type = alertType === 'maintenance' ? 'maintenance' : 'qa_qc';
    const email = normalizeEmail(emailRaw);
    if (!email) {
      return { ok: false, status: 400, message: 'Enter a valid email address.' };
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO alert_email_recipients (alert_type, email)
         VALUES ($1, $2)
         ON CONFLICT (alert_type, email) DO UPDATE SET email = EXCLUDED.email
         RETURNING id, alert_type, email, created_at`,
        [type, email]
      );
      return { ok: true, recipient: rows[0] };
    } catch (err) {
      return { ok: false, status: 500, message: err.message || 'Could not save recipient.' };
    }
  }

  async function removeRecipient(id) {
    const { rowCount } = await pool.query(`DELETE FROM alert_email_recipients WHERE id = $1`, [Number(id)]);
    if (!rowCount) {
      return { ok: false, status: 404, message: 'Recipient not found.' };
    }
    return { ok: true };
  }

  return {
    queueNewAlertEmail,
    queueResolveAlertEmail,
    sendTestEmail,
    listRecipients,
    addRecipient,
    removeRecipient,
    normalizeEmail,
    smtpConfig,
  };
}

module.exports = {
  createAlertEmailService,
  formatAlertDateTime,
  formatDurationMs,
};
