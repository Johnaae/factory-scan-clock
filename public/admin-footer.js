'use strict';

(function initAdminFooter() {
  const footer = document.getElementById('adminFooter');
  if (!footer) return;

  function formatLocalDate(iso) {
    if (!iso) return 'None';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'None';
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function render(data) {
    const version = data.app_version || '—';
    const lastBackup = formatLocalDate(data.last_backup_at);
    const latestFile = data.latest_backup_file || 'None';

    footer.innerHTML =
      '<div class="app-footer-inner">' +
      '<span class="app-footer-label">Factory Scan Clock</span>' +
      '<span class="app-footer-item">Version <strong>' +
      escapeHtml(version) +
      '</strong></span>' +
      '<span class="app-footer-item">Last backup <strong>' +
      escapeHtml(lastBackup) +
      '</strong></span>' +
      '<span class="app-footer-item">Latest file <strong>' +
      escapeHtml(latestFile) +
      '</strong></span>' +
      '<a class="app-footer-link" href="/system">System</a>' +
      '</div>';
    footer.hidden = false;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  fetch('/api/admin/system/info', { credentials: 'same-origin' })
    .then((res) => {
      if (!res.ok) return null;
      return res.json();
    })
    .then((data) => {
      if (data && data.ok) render(data);
    })
    .catch(() => {
      /* admin-only footer — hide when not authorized */
    });
})();
