'use strict';

/**
 * Dedicated production PDF layouts (PDFKit) — not HTML print.
 * Letter-optimized with margins that also fit A4 when printed/scaled.
 */

const PDFDocument = require('pdfkit');

const COL = {
  title: '#0f172a',
  body: '#334155',
  muted: '#64748b',
  faint: '#94a3b8',
  border: '#cbd5e1',
  rule: '#e2e8f0',
  accent: '#1e3a5f',
  thead: '#f1f5f9',
  stripe: '#f8fafc',
};

function moneyishHours(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0.00';
  return v.toFixed(2);
}

function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function createDoc(title) {
  const M = { top: 48, left: 42, right: 42, bottom: 48 };
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: M,
    bufferPages: true,
    autoFirstPage: true,
    info: { Title: title, Author: 'Factory Scan Clock' },
  });
  return { doc, M, contentW: () => doc.page.width - M.left - M.right };
}

function finalizePdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(range.start + i);
      const bottom = doc.page.height - 28;
      doc.font('Helvetica').fontSize(8).fillColor(COL.faint);
      doc.text(`Page ${i + 1} of ${range.count}`, 42, bottom, {
        width: doc.page.width - 84,
        align: 'center',
        lineBreak: false,
      });
    }
    doc.end();
  });
}

function drawTitleBlock(doc, M, contentW, opts) {
  let y = M.top;
  doc.font('Helvetica-Bold').fontSize(16).fillColor(COL.title).text(opts.title, M.left, y, { width: contentW });
  y = doc.y + 2;
  doc.font('Helvetica').fontSize(10).fillColor(COL.accent).text(opts.subtitle || '', M.left, y, { width: contentW });
  y = doc.y + 6;
  doc.font('Helvetica').fontSize(8).fillColor(COL.muted).text(opts.metaLine || '', M.left, y, { width: contentW });
  y = doc.y + 10;
  doc.moveTo(M.left, y).lineTo(M.left + contentW, y).strokeColor(COL.rule).lineWidth(1).stroke();
  return y + 12;
}

function ensureSpace(doc, M, y, need) {
  if (y + need > doc.page.height - M.bottom - 12) {
    doc.addPage();
    return M.top;
  }
  return y;
}

/**
 * Draw a simple key/value info grid.
 */
function drawInfoGrid(doc, M, contentW, y, items, cols = 2) {
  const gap = 10;
  const colW = (contentW - gap * (cols - 1)) / cols;
  const rowH = 36;
  let i = 0;
  while (i < items.length) {
    y = ensureSpace(doc, M, y, rowH + 4);
    for (let c = 0; c < cols && i < items.length; c += 1, i += 1) {
      const item = items[i];
      const x = M.left + c * (colW + gap);
      doc.roundedRect(x, y, colW, rowH - 4, 4).fill(COL.thead);
      doc.font('Helvetica').fontSize(7).fillColor(COL.muted).text(String(item.label || ''), x + 8, y + 6, {
        width: colW - 16,
        lineBreak: false,
      });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(COL.title).text(String(item.value ?? '—'), x + 8, y + 16, {
        width: colW - 16,
        lineBreak: false,
      });
    }
    y += rowH;
  }
  return y + 4;
}

function drawSectionHeading(doc, M, contentW, y, title) {
  y = ensureSpace(doc, M, y, 28);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(COL.accent).text(title, M.left, y, { width: contentW });
  y = doc.y + 4;
  doc.moveTo(M.left, y).lineTo(M.left + contentW, y).strokeColor(COL.rule).lineWidth(0.8).stroke();
  return y + 8;
}

/**
 * Table with automatic page breaks and repeated headers.
 * columns: [{ key, label, width, align? }]
 */
function drawTable(doc, M, y, columns, rows, opts = {}) {
  const contentW = columns.reduce((s, c) => s + c.width, 0);
  const headerH = 20;
  const fontSize = opts.fontSize || 8;
  const rowPad = 4;

  function drawHeader(atY) {
    doc.save();
    doc.rect(M.left, atY, contentW, headerH).fill(COL.thead);
    doc.rect(M.left, atY, contentW, headerH).strokeColor(COL.border).lineWidth(0.6).stroke();
    let x = M.left;
    for (const col of columns) {
      doc
        .font('Helvetica-Bold')
        .fontSize(fontSize)
        .fillColor(COL.title)
        .text(col.label, x + 4, atY + 6, {
          width: col.width - 8,
          align: col.align || 'left',
          lineBreak: false,
        });
      x += col.width;
    }
    doc.restore();
    return atY + headerH;
  }

  function measureRow(row) {
    let maxH = 16;
    for (const col of columns) {
      const text = String(row[col.key] == null || row[col.key] === '' ? '—' : row[col.key]);
      const h = doc.heightOfString(text, {
        width: col.width - 8,
        font: 'Helvetica',
        size: fontSize,
      });
      maxH = Math.max(maxH, Math.ceil(h) + rowPad * 2);
    }
    return Math.min(maxH, opts.maxRowH || 48);
  }

  y = ensureSpace(doc, M, y, headerH + 24);
  y = drawHeader(y);

  rows.forEach((row, idx) => {
    const rh = measureRow(row);
    if (y + rh > doc.page.height - M.bottom - 12) {
      doc.addPage();
      y = M.top;
      y = drawHeader(y);
    }
    if (idx % 2 === 1) {
      doc.rect(M.left, y, contentW, rh).fill(COL.stripe);
    }
    doc.rect(M.left, y, contentW, rh).strokeColor(COL.rule).lineWidth(0.4).stroke();
    let x = M.left;
    for (const col of columns) {
      const text = String(row[col.key] == null || row[col.key] === '' ? '—' : row[col.key]);
      doc
        .font('Helvetica')
        .fontSize(fontSize)
        .fillColor(COL.body)
        .text(text, x + 4, y + rowPad, {
          width: col.width - 8,
          align: col.align || 'left',
          height: rh - rowPad,
        });
      x += col.width;
    }
    y += rh;
  });

  if (!rows.length) {
    y = ensureSpace(doc, M, y, 22);
    doc.font('Helvetica').fontSize(8).fillColor(COL.muted).text(opts.emptyText || 'No records.', M.left + 4, y + 4);
    y += 22;
  }
  return y + 8;
}

function buildTankDailySummaryPdfBuffer({ date, tanks }) {
  const { doc, M, contentW } = createDoc(`Tank Daily Summary — ${date}`);
  const w = contentW();
  const generatedAt = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  let y = drawTitleBlock(doc, M, w, {
    title: 'Tank Daily Summary',
    subtitle: 'Production progress by tank',
    metaLine: `Date: ${date}  ·  Tanks: ${(tanks || []).length}  ·  Generated: ${generatedAt}`,
  });

  // Column widths must sum to content width (~528 on Letter with 42px margins).
  const cols = [
    { key: 'tank', label: 'Tank #', width: 52 },
    { key: 'team', label: 'Team', width: 70 },
    { key: 'machine', label: 'Machine', width: 78 },
    { key: 'phase', label: 'Phase', width: 68 },
    { key: 'status', label: 'Status', width: 58 },
    { key: 'phaseTime', label: 'Phase Time', width: 52, align: 'right' },
    { key: 'totalTime', label: 'Total Run', width: 52, align: 'right' },
    { key: 'progress', label: 'Progress', width: 42, align: 'right' },
    { key: 'last', label: 'Last Activity', width: 56 },
  ];

  const rows = (tanks || []).map((t) => ({
    tank: t.tank_number,
    team: t.team_name || '—',
    machine: t.machine_name || '—',
    phase: t.current_phase || '—',
    status: t.production_status || t.status || '—',
    phaseTime: t.current_phase_time_display || '—',
    totalTime: t.tank_total_running_time_display || '—',
    progress: `${Number(t.percent_complete) || 0}%`,
    last: t.last_activity_at ? fmtWhen(t.last_activity_at) : '—',
  }));

  y = drawTable(doc, M, y, cols, rows, { emptyText: 'No tanks worked on this day.' });

  return finalizePdf(doc);
}

function buildTankReportPdfBuffer(data) {
  const tank = (data && data.tank) || {};
  const laborHours = (data && data.labor_hours) || {};
  const teamProduction = (data && data.team_production) || null;
  const phaseSummary = (teamProduction && teamProduction.phase_time_summary) || data.phase_time_summary || [];
  const pieces = data.pieces || [];
  const notes = data.production_notes || [];
  const downtime = data.downtime_intervals || [];
  const meta = data.report_meta || {};

  const tankNo = tank.tank_number || '—';
  const { doc, M, contentW } = createDoc(`Tank Report — ${tankNo}`);
  const w = contentW();
  const generatedAt = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  const totalLabor =
    laborHours.total_labor_hours != null
      ? laborHours.total_labor_hours
      : teamProduction && teamProduction.total_hours != null
        ? teamProduction.total_hours
        : 0;
  const totalRunning =
    laborHours.total_machine_hours != null
      ? laborHours.total_machine_hours
      : teamProduction && teamProduction.total_machine_hours != null
        ? teamProduction.total_machine_hours
        : totalLabor;

  // —— Page 1: Overview ——
  let y = drawTitleBlock(doc, M, w, {
    title: `Tank Report — ${tankNo}`,
    subtitle: 'Production overview',
    metaLine: `Generated: ${generatedAt}`,
  });

  y = drawSectionHeading(doc, M, w, y, 'Page 1 — Tank Information');
  y = drawInfoGrid(doc, M, w, y, [
    { label: 'Tank Number', value: tankNo },
    { label: 'Team', value: meta.team_name || '—' },
    { label: 'Machine', value: meta.machine_name || '—' },
    { label: 'Status', value: meta.production_status || tank.status || '—' },
    { label: 'Progress', value: `${meta.percent_complete != null ? meta.percent_complete : '—'}%` },
    { label: 'Total Running Hours', value: moneyishHours(totalRunning) },
    { label: 'Total Labor Hours', value: moneyishHours(totalLabor) },
    { label: 'Current Phase', value: meta.current_phase || '—' },
    { label: 'Piece', value: meta.piece_label || `Piece ${tank.current_piece_number || 1}` },
    { label: 'Started', value: fmtWhen(tank.first_scanned_at || tank.started_at || meta.started_at) },
    { label: 'Customer', value: tank.customer || '—' },
    { label: 'Model', value: tank.model || '—' },
    { label: 'Completed', value: fmtWhen(tank.completed_at) },
    { label: 'Duration', value: tank.duration_display || '—' },
    { label: 'Downtime Total', value: data.downtime_total_display || '00:00' },
    { label: 'Description', value: tank.description || '—' },
  ]);

  // —— Page 2: Phase Summary ——
  doc.addPage();
  y = drawTitleBlock(doc, M, w, {
    title: `Tank Report — ${tankNo}`,
    subtitle: 'Complete phase summary',
    metaLine: `Generated: ${generatedAt}`,
  });
  y = drawSectionHeading(doc, M, w, y, 'Page 2 — Complete Phase Summary');

  const phaseRows = (phaseSummary || []).map((p) => ({
    phase: p.phase_name || p.phase_code || '—',
    status: p.status_label || p.status || '—',
    time: p.total_duration_display || '—',
    detail: p.summary_line || '',
  }));
  y = drawTable(
    doc,
    M,
    y,
    [
      { key: 'phase', label: 'Phase', width: 110 },
      { key: 'status', label: 'Status', width: 70 },
      { key: 'time', label: 'Time', width: 60, align: 'right' },
      { key: 'detail', label: 'Summary', width: 288 },
    ],
    phaseRows,
    { emptyText: 'No phase activity recorded.' }
  );

  const phases = (teamProduction && teamProduction.phases) || [];
  for (const phase of phases) {
    y = drawSectionHeading(doc, M, w, y, `${phase.phase_name || phase.phase_code || 'Phase'} · ${moneyishHours(phase.phase_total_hours)} hrs`);
    const sessionRows = (phase.sessions || []).map((s) => ({
      team: s.team_name || '—',
      start: fmtWhen(s.started_at),
      end:
        s.status === 'running'
          ? 'In progress'
          : fmtWhen(s.ended_at || s.finished_at || s.stopped_at),
      duration: s.duration_display || moneyishHours(s.duration_hours),
      status: s.status_label || s.status || '—',
    }));
    y = drawTable(
      doc,
      M,
      y,
      [
        { key: 'team', label: 'Team', width: 100 },
        { key: 'start', label: 'Start', width: 120 },
        { key: 'end', label: 'End', width: 120 },
        { key: 'duration', label: 'Duration', width: 70, align: 'right' },
        { key: 'status', label: 'Status', width: 118 },
      ],
      sessionRows,
      { emptyText: 'No sessions for this phase.' }
    );
  }

  // —— Page 3: Piece / Notes / Downtime ——
  doc.addPage();
  y = drawTitleBlock(doc, M, w, {
    title: `Tank Report — ${tankNo}`,
    subtitle: 'Piece history, notes, corrections & downtime',
    metaLine: `Generated: ${generatedAt}`,
  });
  y = drawSectionHeading(doc, M, w, y, 'Page 3 — Piece History');
  const pieceReports = data.piece_reports || [];
  if (pieceReports.length) {
    for (const pr of pieceReports) {
      const phaseRows = (pr.phase_time_summary || []).filter(
        (row) =>
          String(row.status || '') !== 'not_started' || (Number(row.total_duration_ms) || 0) > 0
      );
      // Compact PDF: always show piece header; only include phases with activity when available.
      y = drawSectionHeading(
        doc,
        M,
        w,
        y,
        `Piece ${pr.piece_number} · ${pr.status || '—'} · ${pr.total_duration_display || '0m'}${
          pr.completed_at ? ` · Completed ${fmtWhen(pr.completed_at)}` : ''
        }`
      );
      y = drawTable(
        doc,
        M,
        y,
        [
          { key: 'phase', label: 'Phase', width: 160 },
          { key: 'status', label: 'Status', width: 100 },
          { key: 'time', label: 'Time', width: 268, align: 'right' },
        ],
        (phaseRows.length ? phaseRows : pr.phase_time_summary || []).map((row) => ({
          phase: row.phase_name || row.phase_code || '—',
          status: row.status_label || row.status || '—',
          time: row.total_duration_display || '—',
        })),
        { emptyText: 'No phase activity for this piece.' }
      );
    }
  } else {
    y = drawTable(
      doc,
      M,
      y,
      [
        { key: 'piece', label: 'Piece #', width: 54 },
        { key: 'status', label: 'Status', width: 80 },
        { key: 'started', label: 'Started', width: 130 },
        { key: 'completed', label: 'Completed', width: 130 },
        { key: 'operator', label: 'Operator', width: 134 },
      ],
      (pieces || []).map((p) => ({
        piece: String(p.piece_number),
        status: p.status || '—',
        started: fmtWhen(p.started_at),
        completed: fmtWhen(p.completed_at),
        operator: p.operator_name || '—',
      })),
      { emptyText: 'No piece tracking records.' }
    );
  }

  const generalNotes = (notes || []).filter((n) => String(n.note_type || '').toLowerCase() !== 'correction');
  const corrections = (notes || []).filter((n) => String(n.note_type || '').toLowerCase() === 'correction');

  y = drawSectionHeading(doc, M, w, y, 'Notes');
  y = drawTable(
    doc,
    M,
    y,
    [
      { key: 'when', label: 'When', width: 110 },
      { key: 'type', label: 'Type', width: 70 },
      { key: 'piece', label: 'Piece', width: 40, align: 'right' },
      { key: 'team', label: 'Team', width: 80 },
      { key: 'note', label: 'Note', width: 228 },
    ],
    generalNotes.map((n) => ({
      when: fmtWhen(n.created_at),
      type: n.note_type || '—',
      piece: n.piece_number != null ? String(n.piece_number) : '—',
      team: n.team_name || '—',
      note: n.body || '—',
    })),
    { emptyText: 'No notes recorded.' }
  );

  y = drawSectionHeading(doc, M, w, y, 'Corrections');
  y = drawTable(
    doc,
    M,
    y,
    [
      { key: 'when', label: 'When', width: 110 },
      { key: 'piece', label: 'Piece', width: 40, align: 'right' },
      { key: 'team', label: 'Team', width: 90 },
      { key: 'note', label: 'Correction Note', width: 288 },
    ],
    corrections.map((n) => ({
      when: fmtWhen(n.created_at),
      piece: n.piece_number != null ? String(n.piece_number) : '—',
      team: n.team_name || '—',
      note: n.body || '—',
    })),
    { emptyText: 'No corrections recorded.' }
  );

  y = drawSectionHeading(doc, M, w, y, 'Downtime History');
  y = drawTable(
    doc,
    M,
    y,
    [
      { key: 'start', label: 'Start', width: 110 },
      { key: 'end', label: 'End', width: 110 },
      { key: 'duration', label: 'Duration', width: 55, align: 'right' },
      { key: 'reason', label: 'Reason', width: 90 },
      { key: 'note', label: 'Note', width: 90 },
      { key: 'phase', label: 'Phase', width: 73 },
    ],
    (downtime || []).map((d) => ({
      start: fmtWhen(d.started_at),
      end: d.ended_at ? fmtWhen(d.ended_at) : d.open ? 'Open' : '—',
      duration: d.duration_display || '—',
      reason: d.reason_label || d.reason_code || '—',
      note: d.reason_note || '—',
      phase: d.phase_name || '—',
    })),
    { emptyText: 'No downtime recorded.' }
  );

  return finalizePdf(doc);
}

module.exports = {
  buildTankDailySummaryPdfBuffer,
  buildTankReportPdfBuffer,
};
