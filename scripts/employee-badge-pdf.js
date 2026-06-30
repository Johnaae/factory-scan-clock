'use strict';

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');

/** Credit card ID-1 landscape: 3.375" × 2.125" */
const BADGE_W_IN = 3.375;
const BADGE_H_IN = 2.125;
const PT = 72;
const BADGE_W = BADGE_W_IN * PT;
const BADGE_H = BADGE_H_IN * PT;
const RADIUS = 10;

const NAVY = '#1a3a5c';
const BLACK = '#111827';
const WHITE = '#ffffff';
const ACCENT_LINE = '#1a3a5c';

const FOOTER_MOTTO = 'WORK SAFE. WORK SMART. BUILD TOGETHER.';

/** Clear space around barcode bars (pt); nothing may intrude inside this box */
const BARCODE_MARGIN = 15;

const LOGO_PATH = path.join(__dirname, '..', 'public', 'assets', 'fgt-logo.png');

const PAD = 14;
const FOOTER_H = 20;
const PILL_W = 58;
const PILL_H = 26;

/** ~1.5–2× original 138×28 logo; full width, height capped to avoid crop */
const LOGO_MAX_W = BADGE_W - PAD * 2;
const LOGO_MAX_H = 44;
const LOGO_MIN_H = 30;

function resolveLogoPath() {
  if (fs.existsSync(LOGO_PATH)) return LOGO_PATH;
  return null;
}

/** Badge role from employees.badge_role; uppercase on badge; empty → TEAM MEMBER */
function formatBadgeRoleForBadge(employee) {
  const raw =
    employee && employee.badge_role != null && employee.badge_role !== undefined
      ? String(employee.badge_role).trim()
      : '';
  return raw ? raw.toUpperCase() : 'TEAM MEMBER';
}

function splitNameLines(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return { display: 'Employee', first: 'Employee' };
  return { display: parts.join(' '), first: parts[0] };
}

async function code128Png(text) {
  return bwipjs.toBuffer({
    bcid: 'code128',
    text: String(text),
    scale: 3,
    height: 14,
    includetext: false,
    paddingwidth: 12,
    paddingheight: 10,
  });
}

function measureHeaderLayout(logoH) {
  const headerY = 6;
  const ruleY = headerY + logoH + 8;
  const nameY = ruleY + 5;
  const underlineY = nameY + 19;
  const roleY = nameY + 30;
  const roleBottom = roleY + 7;
  return { headerY, ruleY, nameY, underlineY, roleY, roleBottom, logoH };
}

function resolveBarcodePillLayout(roleBottom, footerY) {
  const footerGap = 5;
  const barcodeH = 25;
  const minBarcodeY = roleBottom + BARCODE_MARGIN;
  const maxBarcodeBottom = footerY - footerGap;
  const barcodeW = BADGE_W - PAD * 2 - PILL_W - BARCODE_MARGIN * 3;
  const barcodeX = PAD + BARCODE_MARGIN;
  const pillX = barcodeX + barcodeW + BARCODE_MARGIN;

  let pillY = footerY - footerGap - PILL_H;
  let barcodeY = pillY + (PILL_H - barcodeH) / 2;

  if (barcodeY < minBarcodeY) {
    barcodeY = minBarcodeY;
    pillY = barcodeY + (barcodeH - PILL_H) / 2;
  }
  if (barcodeY + barcodeH > maxBarcodeBottom) {
    barcodeY = maxBarcodeBottom - barcodeH;
    pillY = barcodeY + (barcodeH - PILL_H) / 2;
  }

  return { barcodeH, barcodeY, barcodeW, barcodeX, pillX, pillY, minBarcodeY };
}

function pickLogoHeight(footerY) {
  for (let logoH = LOGO_MAX_H; logoH >= LOGO_MIN_H; logoH -= 2) {
    const header = measureHeaderLayout(logoH);
    const scan = resolveBarcodePillLayout(header.roleBottom, footerY);
    if (scan.barcodeY >= scan.minBarcodeY && scan.barcodeY + scan.barcodeH <= footerY - 5) {
      return { ...header, ...scan, logoH };
    }
  }
  const header = measureHeaderLayout(LOGO_MIN_H);
  const scan = resolveBarcodePillLayout(header.roleBottom, footerY);
  return { ...header, ...scan, logoH: LOGO_MIN_H };
}

function drawHeaderLogo(doc, logoImage, logoH) {
  const headerY = 6;
  if (logoImage) {
    try {
      doc.image(logoImage, PAD, headerY, {
        fit: [LOGO_MAX_W, logoH],
        align: 'left',
        valign: 'top',
      });
    } catch (err) {
      console.warn('[badge pdf] logo render failed:', err.message);
    }
    return;
  }
  doc.font('Helvetica-Bold').fontSize(15).fillColor(NAVY).text('Fiberglass Tank', PAD, headerY + 2);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#3b82c4').text('SOLUTIONS', PAD, headerY + 20);
}

function drawBadgePage(doc, employee, logoImage) {
  const name = String(employee.name || '').trim() || 'Employee';
  const code = String(employee.code || '').trim().toUpperCase() || 'EMP000';
  const role = formatBadgeRoleForBadge(employee);
  const { display, first } = splitNameLines(name);

  doc.save();
  doc.roundedRect(0, 0, BADGE_W, BADGE_H, RADIUS).clip();
  doc.rect(0, 0, BADGE_W, BADGE_H).fill(WHITE);
  doc.restore();

  doc.roundedRect(0.75, 0.75, BADGE_W - 1.5, BADGE_H - 1.5, RADIUS - 1).lineWidth(1).strokeColor('#cbd5e1').stroke();

  const footerY = BADGE_H - FOOTER_H;
  const contentW = BADGE_W - PAD * 2;
  const layout = pickLogoHeight(footerY);

  drawHeaderLogo(doc, logoImage, layout.logoH);
  doc.moveTo(PAD, layout.ruleY).lineTo(BADGE_W - PAD, layout.ruleY).lineWidth(1).strokeColor(NAVY).stroke();

  doc.font('Helvetica-Bold').fontSize(17).fillColor(BLACK).text(display, PAD, layout.nameY, {
    width: contentW,
    lineBreak: false,
  });

  const firstWidth = doc.widthOfString(first, { font: 'Helvetica-Bold', size: 17 });
  const accentW = Math.min(Math.max(firstWidth, 44), contentW - 16);
  doc
    .moveTo(PAD, layout.underlineY)
    .lineTo(PAD + accentW, layout.underlineY)
    .lineWidth(3)
    .strokeColor(ACCENT_LINE)
    .stroke();

  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(NAVY);
  doc.text(role, PAD, layout.roleY, {
    width: contentW,
    characterSpacing: 0.5,
  });

  return code128Png(code).then((barcodeBuf) => {
    doc.image(barcodeBuf, layout.barcodeX, layout.barcodeY, {
      width: layout.barcodeW,
      height: layout.barcodeH,
    });

    doc.roundedRect(layout.pillX, layout.pillY, PILL_W, PILL_H, 6).fill(NAVY);
    doc.font('Helvetica-Bold').fontSize(12).fillColor(WHITE);
    doc.text(code, layout.pillX, layout.pillY + 7, { width: PILL_W, align: 'center' });

    doc
      .moveTo(0, footerY)
      .lineTo(BADGE_W, footerY)
      .lineTo(BADGE_W, BADGE_H - RADIUS)
      .quadraticCurveTo(BADGE_W, BADGE_H, BADGE_W - RADIUS, BADGE_H)
      .lineTo(RADIUS, BADGE_H)
      .quadraticCurveTo(0, BADGE_H, 0, BADGE_H - RADIUS)
      .closePath()
      .fill(NAVY);

    doc.font('Helvetica-Bold').fontSize(5.2).fillColor(WHITE);
    doc.text(FOOTER_MOTTO, PAD, footerY + 6, {
      width: contentW,
      align: 'center',
      characterSpacing: 0.35,
    });
  });
}

/**
 * @param {Array<{ name: string, code: string, badge_role?: string }>} employees
 * @returns {Promise<Buffer>}
 */
async function buildEmployeeBadgesPdfBuffer(employees) {
  const list = Array.isArray(employees) ? employees.filter((e) => e && e.code) : [];
  if (!list.length) {
    throw new Error('No employees to print.');
  }

  let logoImage = resolveLogoPath();

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [BADGE_W, BADGE_H],
      margins: { top: 0, left: 0, right: 0, bottom: 0 },
      autoFirstPage: false,
      info: {
        Title: 'Fiberglass Tank Solutions Employee Badges',
        Author: 'Fiberglass Tank Solutions',
      },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    (async () => {
      try {
        for (let i = 0; i < list.length; i++) {
          doc.addPage({ size: [BADGE_W, BADGE_H], margins: { top: 0, left: 0, right: 0, bottom: 0 } });
          await drawBadgePage(doc, list[i], logoImage);
        }
        doc.end();
      } catch (err) {
        reject(err);
      }
    })();
  });
}

module.exports = {
  buildEmployeeBadgesPdfBuffer,
  BADGE_W,
  BADGE_H,
  BADGE_W_IN,
  BADGE_H_IN,
};
