/**
 * Shared status badge / pill class mapping for Factory Scan Clock UIs.
 */
(function initFactoryStatus(root) {
  const STATUS = {
    IN: { badgeClass: 'badge-in', pillClass: 'pill-in', avatarClass: 'is-in', scanClass: 'in', label: 'IN' },
    OUT: { badgeClass: 'badge-out', pillClass: 'pill-out', avatarClass: 'is-out', scanClass: 'out', label: 'OUT' },
    STOP: { badgeClass: 'badge-stop', pillClass: 'pill-stop', avatarClass: 'is-stop', scanClass: 'stop', label: 'STOP' },
    ERROR: { badgeClass: 'badge-err', pillClass: 'pill-err', avatarClass: 'is-out', scanClass: 'out', label: 'ERROR' },
  };

  function normalizeStatus(value) {
    const u = String(value || '').toUpperCase();
    if (u === 'IN' || u === 'OUT' || u === 'STOP') return u;
    if (u === 'ERROR' || u === 'INVALID' || u === 'ERR') return 'ERROR';
    return 'OUT';
  }

  function statusMeta(value) {
    return STATUS[normalizeStatus(value)] || STATUS.OUT;
  }

  function statusBadgeHtml(value, options) {
    const opts = options || {};
    const meta = statusMeta(value);
    const lg = opts.large ? ' badge-lg' : '';
    const label = opts.label != null ? String(opts.label) : meta.label;
    return `<span class="badge${lg} ${meta.badgeClass}">${label}</span>`;
  }

  function statusScanBadgeHtml(value) {
    const meta = statusMeta(value);
    return `<span class="status-badge ${meta.scanClass}">${meta.label}</span>`;
  }

  function scanStateClass(value) {
    const st = normalizeStatus(value);
    if (st === 'IN') return 'state-in';
    if (st === 'STOP') return 'state-stop';
    if (st === 'ERROR') return 'state-err';
    return 'state-out';
  }

  root.FactoryStatus = {
    STATUS,
    normalizeStatus,
    statusMeta,
    statusBadgeHtml,
    statusScanBadgeHtml,
    scanStateClass,
  };
})(typeof window !== 'undefined' ? window : globalThis);
