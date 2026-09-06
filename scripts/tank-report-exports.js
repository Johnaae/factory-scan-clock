'use strict';

/**
 * Tank Report CSV / Excel exporters.
 * All values come from getTankReportPayload() — no separate labor math.
 */

function dash(v) {
  if (v == null || v === '') return '—';
  return String(v);
}

function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Prefer ms/hours → always "Xh Ym". Do not treat decimal hour digits as minutes. */
function formatDurationHm(opts = {}) {
  let ms = opts.ms != null ? Number(opts.ms) : null;
  if ((!Number.isFinite(ms) || ms < 0) && opts.hours != null) {
    const h = Number(opts.hours);
    if (Number.isFinite(h) && h >= 0) ms = Math.round(h * 3600000);
  }
  if (Number.isFinite(ms) && ms >= 0) {
    const totalMin = Math.round(ms / 60000);
    return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
  }
  if (opts.display != null && String(opts.display).trim() !== '' && String(opts.display) !== '—') {
    return String(opts.display);
  }
  return '—';
}

function numericHours(opts = {}) {
  if (opts.hours != null && Number.isFinite(Number(opts.hours))) {
    return Math.round(Number(opts.hours) * 100) / 100;
  }
  if (opts.ms != null && Number.isFinite(Number(opts.ms))) {
    return Math.round((Number(opts.ms) / 3600000) * 100) / 100;
  }
  return null;
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(cols) {
  return cols.map(csvEscape).join(',');
}

function tankReportBaseName(data, id) {
  const tankNo = (data && data.tank && data.tank.tank_number) || id || 'tank';
  const safe = String(tankNo).replace(/[^\w.-]+/g, '_');
  return `tank_${safe}_report`;
}

function collectPhaseSessions(data) {
  const tank = (data && data.tank) || {};
  const tankNo = tank.tank_number || '';
  const teamProduction = (data && data.team_production) || {};
  const phases = teamProduction.phases || [];
  const rows = [];
  for (const phase of phases) {
    for (const s of phase.sessions || []) {
      const latestEdit = Array.isArray(s.edits) && s.edits.length ? s.edits[0] : null;
      const endRaw =
        s.status === 'running'
          ? ''
          : s.ended_at || s.finished_at || s.stopped_at || '';
      rows.push({
        tank_number: tankNo,
        piece_number: s.piece_number != null ? Number(s.piece_number) : null,
        phase: s.phase_name || phase.phase_name || s.phase_code || phase.phase_code || '',
        phase_code: s.phase_code || phase.phase_code || '',
        team: s.team_name || '',
        machine: s.machine_name || '',
        started_at: s.started_at || '',
        ended_at: endRaw,
        end_display: s.status === 'running' ? 'In progress' : fmtWhen(endRaw),
        duration: formatDurationHm({
          display: s.duration_display,
          hours: s.duration_hours,
        }),
        duration_hours: numericHours({ hours: s.duration_hours }),
        status: s.status_label || s.status || '',
        is_edited: !!s.is_edited,
        edited_by: latestEdit ? latestEdit.edited_by_name || '' : '',
        edit_reason: s.latest_edit_reason || (latestEdit && latestEdit.edit_reason) || '',
      });
    }
  }
  return rows;
}

function overviewFields(data) {
  const tank = (data && data.tank) || {};
  const meta = (data && data.report_meta) || {};
  const laborHours = (data && data.labor_hours) || {};
  const teamProduction = (data && data.team_production) || {};
  const pieces = data.pieces || [];
  const completedPieces = pieces.filter((p) => String(p.status || '').toLowerCase() === 'completed').length;

  const totalLaborHours =
    laborHours.total_labor_hours != null
      ? laborHours.total_labor_hours
      : teamProduction.total_labor_hours != null
        ? teamProduction.total_labor_hours
        : teamProduction.total_hours != null
          ? teamProduction.total_hours
          : 0;
  const totalRunningHours =
    laborHours.total_machine_hours != null
      ? laborHours.total_machine_hours
      : teamProduction.total_machine_hours != null
        ? teamProduction.total_machine_hours
        : teamProduction.total_running_hours != null
          ? teamProduction.total_running_hours
          : totalLaborHours;

  return {
    tank_number: tank.tank_number || '',
    team: meta.team_name || '',
    machine: meta.machine_name || '',
    status: meta.production_status || tank.status || '',
    progress:
      meta.percent_complete != null && meta.percent_complete !== ''
        ? `${meta.percent_complete}%`
        : '',
    total_labor: formatDurationHm({
      ms: teamProduction.total_labor_ms,
      hours: totalLaborHours,
      display: teamProduction.total_labor_display,
    }),
    total_labor_hours: numericHours({
      ms: teamProduction.total_labor_ms,
      hours: totalLaborHours,
    }),
    total_running: formatDurationHm({
      ms: teamProduction.total_running_ms,
      hours: totalRunningHours,
      display: teamProduction.total_running_display || tank.duration_display,
    }),
    total_running_hours: numericHours({
      ms: teamProduction.total_running_ms,
      hours: totalRunningHours,
    }),
    duration: formatDurationHm({
      display: tank.duration_display,
      hours: totalRunningHours,
      ms: teamProduction.total_running_ms,
    }),
    configured_pieces: tank.piece_count != null ? Number(tank.piece_count) : pieces.length || '',
    completed_pieces: completedPieces,
    current_phase: meta.current_phase || '',
    piece_label: meta.piece_label || '',
    customer: tank.customer || '',
    model: tank.model || '',
    description: tank.description || '',
    downtime_total: data.downtime_total_display || meta.downtime_display || '',
    created_at: tank.created_at || '',
    started_at: tank.first_scanned_at || tank.started_at || meta.started_at || '',
    completed_at: tank.completed_at || '',
  };
}

function laborRows(data) {
  const teamProduction = (data && data.team_production) || {};
  return (teamProduction.member_breakdown || []).map((m) => ({
    employee: m.employee_name || '',
    employee_code: m.employee_code || '',
    team: m.team_name || '',
    time_on_tank: formatDurationHm({
      ms: m.total_ms,
      hours: m.total_hours,
      display: m.total_hours_display,
    }),
    hours: numericHours({ ms: m.total_ms, hours: m.total_hours }),
  }));
}

function downtimeAlertRows(data) {
  const tank = (data && data.tank) || {};
  const tankNo = tank.tank_number || '';
  const rows = [];
  for (const d of data.downtime_intervals || []) {
    rows.push({
      tank_number: tankNo,
      piece_number: d.piece_number != null ? Number(d.piece_number) : '',
      type: 'Downtime',
      subtype: d.reason_label || d.reason_code || 'Downtime',
      team: d.team_name || '',
      machine: d.machine_name || '',
      started_at: d.started_at || '',
      ended_at: d.ended_at || '',
      end_display: d.ended_at ? fmtWhen(d.ended_at) : d.open ? 'Open' : '—',
      duration: d.duration_display || '—',
      note: d.reason_note || '',
      status: d.open ? 'Open' : 'Closed',
      resolved_by: '',
      phase: d.phase_name || '',
    });
  }
  for (const q of data.qa_qc_history || []) {
    rows.push({
      tank_number: tankNo,
      piece_number: q.piece_number != null ? Number(q.piece_number) : '',
      type: 'QA/QC',
      subtype: q.phase_name || q.phase_code || 'QA/QC',
      team: q.team_name || '',
      machine: q.machine_name || '',
      started_at: q.reported_at || '',
      ended_at: q.resolved_at || '',
      end_display: q.resolved_at ? fmtWhen(q.resolved_at) : q.status === 'open' ? 'Open' : '—',
      duration: q.duration_display || '—',
      note: [q.issue_note || q.notes || '', q.resolution_note || ''].filter(Boolean).join(' | '),
      status: q.status === 'open' ? 'Open' : 'Resolved',
      resolved_by: q.resolved_by || '',
      phase: q.phase_name || '',
    });
  }
  for (const n of data.production_notes || []) {
    if (String(n.note_type || '').toLowerCase() !== 'correction') continue;
    rows.push({
      tank_number: tankNo,
      piece_number: n.piece_number != null ? Number(n.piece_number) : '',
      type: 'Correction',
      subtype: n.phase_name || 'Correction',
      team: n.team_name || '',
      machine: '',
      started_at: n.created_at || '',
      ended_at: '',
      end_display: '—',
      duration: '—',
      note: n.body || '',
      status: 'Recorded',
      resolved_by: n.operator_name || '',
      phase: n.phase_name || '',
    });
  }
  return rows;
}

/**
 * Flat CSV primarily from piece/phase session history, with overview context columns.
 */
function buildTankReportCsv(data) {
  const overview = overviewFields(data);
  const sessions = collectPhaseSessions(data);
  const header = [
    'Tank #',
    'Piece #',
    'Phase',
    'Team',
    'Machine',
    'Start Time',
    'End Time',
    'Duration',
    'Duration Hours',
    'Status',
    'Edited By',
    'Edit Reason',
    'Tank Status',
    'Tank Total Labor',
    'Tank Total Labor Hours',
    'Tank Total Running',
    'Tank Total Running Hours',
    'Customer',
    'Model',
  ];
  const lines = [csvRow(header)];
  if (!sessions.length) {
    lines.push(
      csvRow([
        overview.tank_number,
        '',
        '',
        overview.team,
        overview.machine,
        fmtWhen(overview.started_at),
        fmtWhen(overview.completed_at),
        overview.duration || overview.total_running,
        overview.total_running_hours != null ? overview.total_running_hours : '',
        overview.status,
        '',
        '',
        overview.status,
        overview.total_labor,
        overview.total_labor_hours != null ? overview.total_labor_hours : '',
        overview.total_running,
        overview.total_running_hours != null ? overview.total_running_hours : '',
        overview.customer,
        overview.model,
      ])
    );
  } else {
    for (const s of sessions) {
      lines.push(
        csvRow([
          s.tank_number,
          s.piece_number != null ? s.piece_number : '',
          s.phase,
          s.team,
          s.machine,
          fmtWhen(s.started_at),
          s.end_display,
          s.duration,
          s.duration_hours != null ? s.duration_hours : '',
          s.status,
          s.edited_by,
          s.edit_reason,
          overview.status,
          overview.total_labor,
          overview.total_labor_hours != null ? overview.total_labor_hours : '',
          overview.total_running,
          overview.total_running_hours != null ? overview.total_running_hours : '',
          overview.customer,
          overview.model,
        ])
      );
    }
  }
  // UTF-8 BOM helps Excel open CSV correctly
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

async function buildTankReportXlsxBuffer(data) {
  let ExcelJS;
  try {
    ExcelJS = require('exceljs');
  } catch (err) {
    const e = new Error('Excel export requires the exceljs package. Run: npm install exceljs');
    e.code = 'EXCELJS_MISSING';
    e.cause = err;
    throw e;
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Factory Scan Clock';
  workbook.created = new Date();

  const overview = overviewFields(data);
  const labor = laborRows(data);
  const sessions = collectPhaseSessions(data);
  const events = downtimeAlertRows(data);

  const sheet1 = workbook.addWorksheet('Overview', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet1.columns = [
    { header: 'Field', key: 'field', width: 28 },
    { header: 'Value', key: 'value', width: 48 },
  ];
  const overviewPairs = [
    ['Tank #', overview.tank_number],
    ['Team', overview.team],
    ['Machine', overview.machine],
    ['Status', overview.status],
    ['Progress', overview.progress],
    ['Total Labor Hours', overview.total_labor],
    ['Total Labor Hours (decimal)', overview.total_labor_hours],
    ['Total Running Time', overview.total_running],
    ['Total Running Hours (decimal)', overview.total_running_hours],
    ['Duration', overview.duration],
    ['Configured Pieces', overview.configured_pieces],
    ['Completed Pieces', overview.completed_pieces],
    ['Current/Final Phase', overview.current_phase],
    ['Piece', overview.piece_label],
    ['Customer', overview.customer],
    ['Model', overview.model],
    ['Description', overview.description],
    ['Downtime Total', overview.downtime_total],
    ['Created', fmtWhen(overview.created_at)],
    ['Started', fmtWhen(overview.started_at)],
    ['Completed', fmtWhen(overview.completed_at)],
  ];
  for (const [field, value] of overviewPairs) {
    sheet1.addRow({ field, value: dash(value) });
  }
  styleHeader(sheet1);

  const sheet2 = workbook.addWorksheet('Labor Breakdown', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet2.columns = [
    { header: 'Employee', key: 'employee', width: 28 },
    { header: 'Employee Code', key: 'employee_code', width: 16 },
    { header: 'Team', key: 'team', width: 36 },
    { header: 'Time on Tank', key: 'time_on_tank', width: 16 },
    { header: 'Hours (decimal)', key: 'hours', width: 16 },
  ];
  if (!labor.length) {
    sheet2.addRow({
      employee: 'No labor membership history',
      employee_code: '',
      team: '',
      time_on_tank: '',
      hours: '',
    });
  } else {
    for (const row of labor) sheet2.addRow(row);
  }
  styleHeader(sheet2);

  const sheet3 = workbook.addWorksheet('Piece & Phase History', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet3.columns = [
    { header: 'Tank #', key: 'tank_number', width: 12 },
    { header: 'Piece #', key: 'piece_number', width: 10 },
    { header: 'Phase', key: 'phase', width: 18 },
    { header: 'Team', key: 'team', width: 18 },
    { header: 'Machine', key: 'machine', width: 22 },
    { header: 'Start Time', key: 'start', width: 22 },
    { header: 'End Time', key: 'end', width: 22 },
    { header: 'Duration', key: 'duration', width: 12 },
    { header: 'Duration Hours', key: 'duration_hours', width: 14 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Edited By', key: 'edited_by', width: 18 },
    { header: 'Edit Reason', key: 'edit_reason', width: 32 },
  ];
  if (!sessions.length) {
    sheet3.addRow({
      tank_number: overview.tank_number,
      piece_number: '',
      phase: '',
      team: overview.team,
      machine: overview.machine,
      start: '',
      end: '',
      duration: '',
      duration_hours: '',
      status: 'No phase sessions',
      edited_by: '',
      edit_reason: '',
    });
  } else {
    for (const s of sessions) {
      sheet3.addRow({
        tank_number: s.tank_number,
        piece_number: s.piece_number != null ? s.piece_number : '',
        phase: s.phase,
        team: s.team,
        machine: s.machine,
        start: fmtWhen(s.started_at),
        end: s.end_display,
        duration: s.duration,
        duration_hours: s.duration_hours != null ? s.duration_hours : '',
        status: s.status,
        edited_by: s.edited_by,
        edit_reason: s.edit_reason,
      });
    }
  }
  styleHeader(sheet3);

  const sheet4 = workbook.addWorksheet('Downtime Alerts QA-QC', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet4.columns = [
    { header: 'Tank #', key: 'tank_number', width: 12 },
    { header: 'Piece #', key: 'piece_number', width: 10 },
    { header: 'Type', key: 'type', width: 12 },
    { header: 'Detail', key: 'subtype', width: 18 },
    { header: 'Team', key: 'team', width: 16 },
    { header: 'Machine', key: 'machine', width: 20 },
    { header: 'Start/Time', key: 'start', width: 22 },
    { header: 'End/Resolved', key: 'end', width: 22 },
    { header: 'Duration', key: 'duration', width: 12 },
    { header: 'Note', key: 'note', width: 40 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Resolved By', key: 'resolved_by', width: 18 },
  ];
  if (!events.length) {
    sheet4.addRow({
      tank_number: overview.tank_number,
      type: '',
      note: 'No downtime, QA/QC, or correction events',
    });
  } else {
    for (const e of events) {
      sheet4.addRow({
        tank_number: e.tank_number,
        piece_number: e.piece_number,
        type: e.type,
        subtype: e.subtype,
        team: e.team,
        machine: e.machine,
        start: fmtWhen(e.started_at),
        end: e.end_display,
        duration: e.duration,
        note: e.note,
        status: e.status,
        resolved_by: e.resolved_by,
      });
    }
  }
  styleHeader(sheet4);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function styleHeader(sheet) {
  const row = sheet.getRow(1);
  row.font = { bold: true };
  row.commit();
}

module.exports = {
  tankReportBaseName,
  buildTankReportCsv,
  buildTankReportXlsxBuffer,
  formatDurationHm,
  collectPhaseSessions,
  overviewFields,
  laborRows,
};
