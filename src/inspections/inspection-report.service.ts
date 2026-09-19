import { join } from 'node:path';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import PDFDocument = require('pdfkit');

// Resolved from process.cwd() rather than __dirname - same reasoning as
// QrService's TEMPLATE_PATH: `nest start --watch` and `nest build`
// compile to different dist/ layouts, but both run from the project
// root, so an asset under src/ needs a cwd-relative path to be found
// under either.
const LOGO_PATH = join(process.cwd(), 'src', 'inspections', 'assets', 'pine-cleaning-logo.png');
// Converted from the frontend's own pine-cleaning-logo.webp (the same
// asset used in the app's sidebar/login screen) - pdfkit's .image()
// only decodes PNG/JPEG, not WebP, so this PNG copy lives here rather
// than loading the frontend's file directly at runtime.
const LOGO_ASPECT_RATIO = 328 / 1462;

const RATING_LABELS: Record<string, string> = {
  EXCELLENT: 'Exceptional',
  ABOVE_AVERAGE: 'Above Average',
  AVERAGE: 'Average',
  BELOW_AVERAGE: 'Below Average',
  VERY_POOR: 'Very Poor',
};

// Palette taken from the admin portal's own design tokens (globals.css)
// so the report reads as part of the same product: warm off-white page,
// white cards, brand navy for headings, brand green as the accent.
const PAGE_BG = '#f6f6f3';
const CARD_BG = '#ffffff';
const CARD_BORDER = '#e7e6e1';
const INK = '#17181c';
const MUTED = '#6f7278';
const NAVY = '#2d3660';
const GREEN = '#16a34a';
const GREEN_DARK = '#15803d';
const CORAL = '#dc2626';
const CORAL_DARK = '#b91c1c';
const BAR_TRACK = '#ecebe6';
const ATTENTION_CARD_BG = '#fff7f4';
const ATTENTION_CARD_BORDER = '#f6cfc2';

/** Same green/amber/orange/red scale the portal's status badges use - fill is the bar color, tint is the pill background, text is the pill label (darker than fill so it stays readable on the tint). */
const RATING_STYLES: Record<string, { fill: string; tint: string; text: string }> = {
  EXCELLENT: { fill: '#16a34a', tint: '#dcf3e4', text: '#15803d' },
  ABOVE_AVERAGE: { fill: '#22a75a', tint: '#dcf3e4', text: '#15803d' },
  AVERAGE: { fill: '#f59e0b', tint: '#fdf0d3', text: '#b45309' },
  BELOW_AVERAGE: { fill: '#f97316', tint: '#fde5d3', text: '#c2410c' },
  VERY_POOR: { fill: '#dc2626', tint: '#fbdcdc', text: '#b91c1c' },
};
const NEUTRAL_STYLE = { fill: '#9ca3af', tint: '#eeeeea', text: '#6f7278' };

const PAGE_LEFT = 40;
const PAGE_RIGHT = 555;
const PAGE_WIDTH = PAGE_RIGHT - PAGE_LEFT;

/** Ratings that put a card in "needs attention" territory - warm-tinted card, matching the reference design's treatment of only the worst two tiers. */
const ATTENTION_RATINGS = new Set(['BELOW_AVERAGE', 'VERY_POOR']);

/**
 * Renders a completed inspection session as a PDF - a summary card
 * (inspector/completed + an overall-score pie chart + a
 * one-line spread of highest/lowest spaces) followed by one card per
 * inspected space (rating pill, colored progress bar, notes, photo
 * thumbnails), with cards that need attention tinted warm. Originally styled after a reference inspection-app
 * screenshot the client shared (2026-09-15), then restyled to the
 * admin portal's own palette (off-white page, white cards, navy/green
 * accents). Each space maps to one card since this app's data has one
 * rating per space rather than the reference's nested room-then-
 * checklist-items structure.
 *
 * Reuses the same pdfkit buffer-via-events pattern as QrService.getPdf
 * - see that file for why `import ... = require('pdfkit')` is needed
 * instead of a normal import.
 *
 * Only ever called for COMPLETED sessions - items become read-only the
 * moment a session finishes (see InspectionsService.assertOpenInspection),
 * so a completed inspection's report content never changes. That makes
 * an in-memory cache keyed by inspectionId safe with no invalidation
 * logic, same rationale as QrService's cache for a site's immutable
 * slug-derived QR image.
 */
@Injectable()
export class InspectionReportService {
  private readonly logger = new Logger(InspectionReportService.name);
  private readonly cache = new Map<string, Buffer>();
  private readonly inFlight = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async getReportPdf(inspectionId: string): Promise<Buffer> {
    const cached = this.cache.get(inspectionId);
    if (cached) return cached;

    let pending = this.inFlight.get(inspectionId);
    if (!pending) {
      pending = this.render(inspectionId)
        .then((buffer) => {
          this.cache.set(inspectionId, buffer);
          return buffer;
        })
        .finally(() => this.inFlight.delete(inspectionId));
      this.inFlight.set(inspectionId, pending);
    }
    return pending;
  }

  private async render(inspectionId: string): Promise<Buffer> {
    const inspection = await this.prisma.siteInspection.findUnique({
      where: { id: inspectionId },
      include: {
        items: { include: { media: true }, orderBy: { createdAt: 'asc' } },
        site: { include: { client: true } },
        createdByUser: true,
        completedByUser: true,
      },
    });
    if (!inspection) {
      throw new NotFoundException(`Inspection ${inspectionId} not found`);
    }
    if (inspection.status !== 'COMPLETED') {
      throw new BadRequestException('A report is only available once this inspection is finished.');
    }

    // Fetch every verified image's thumbnail bytes up front, in
    // parallel - pdfkit needs real buffers, not URLs. A failed fetch
    // for one photo just gets skipped (logged) rather than failing the
    // whole report; a client shouldn't lose the whole PDF over one
    // flaky Cloudinary fetch.
    // Not Applicable spaces are left out of the report entirely (no card,
    // no photos fetched, not counted in the summary) - there's nothing to
    // report on a space that wasn't inspected.
    const reportItems = inspection.items.filter((item) => !item.isNotApplicable);
    const imageMedia = reportItems.flatMap((item) =>
      item.media.filter((m) => m.status === 'VERIFIED' && m.resourceType === 'IMAGE'),
    );
    const thumbnails = new Map<string, Buffer>();
    await Promise.all(
      imageMedia.map(async (m) => {
        try {
          const url = this.cloudinary.buildReportThumbnailUrl(m.cloudinaryPublicId);
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          thumbnails.set(m.id, Buffer.from(await res.arrayBuffer()));
        } catch (err) {
          this.logger.warn(`Report thumbnail fetch failed for media ${m.id}: ${(err as Error).message}`);
        }
      }),
    );

    return new Promise((resolve, reject) => {
      // bufferPages so the footer's "Page X of Y" can be drawn onto every
      // page after the total is known.
      const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Painted first on every page (before any content is drawn onto it).
      const paintBackground = () => {
        doc.save();
        doc.rect(0, 0, doc.page.width, doc.page.height).fill(PAGE_BG);
        doc.restore();
      };
      paintBackground();
      doc.on('pageAdded', paintBackground);

      const reportInspection = { ...inspection, items: reportItems };
      this.drawTitle(doc, reportInspection);
      this.drawSummaryBox(doc, reportInspection);
      for (const item of reportItems) {
        this.drawItem(doc, item, thumbnails);
      }

      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        this.drawFooter(doc, i + 1, range.count);
      }

      doc.end();
    });
  }

  private drawTitle(doc: PDFKit.PDFDocument, inspection: ReportInspection) {
    const logoWidth = 110;
    const logoHeight = logoWidth * LOGO_ASPECT_RATIO;
    const logoTop = doc.y;
    try {
      doc.image(LOGO_PATH, PAGE_RIGHT - logoWidth, logoTop, { width: logoWidth });
    } catch (err) {
      this.logger.warn(`Skipping report logo, failed to load: ${(err as Error).message}`);
    }

    doc.fillColor(NAVY).fontSize(22).font('Helvetica-Bold').text('Site Inspection Report', PAGE_LEFT, logoTop, { width: PAGE_WIDTH - logoWidth - 15 });
    doc.moveDown(0.3);
    doc
      .fontSize(11)
      .font('Helvetica')
      .fillColor(MUTED)
      .text(`${inspection.site.client.clientName} · ${inspection.site.businessName}`, { width: PAGE_WIDTH - logoWidth - 15 });
    if (inspection.site.address) {
      doc.text(inspection.site.address, { width: PAGE_WIDTH - logoWidth - 15 });
    }

    // The logo can be taller than the title block if the address line
    // wraps short - make sure we don't start the summary box overlapping it.
    doc.y = Math.max(doc.y, logoTop + logoHeight);
    doc.y += 16;
  }

  /**
   * The summary card: Inspector/Completed on the left, a big
   * score number in the middle, a pie chart on the right, and a one-line
   * spread (spaces inspected / highest / lowest) along the bottom. Soft
   * green gradient when the inspection met the standard, soft coral when
   * it didn't - the ID and map/Location fields from the original
   * reference screenshot stay dropped per the client's explicit direction
   * 2026-09-15 (no maps integration exists, and a bare numeric ID isn't
   * meaningful here the way the client/site name already is).
   */
  private drawSummaryBox(doc: PDFKit.PDFDocument, inspection: ReportInspection) {
    const boxTop = doc.y;
    const boxHeight = 132;
    const pass = inspection.meetsStandard === true;

    const gradient = doc.linearGradient(PAGE_LEFT, boxTop, PAGE_RIGHT, boxTop + boxHeight);
    if (pass) {
      gradient.stop(0, '#e9f8ee').stop(1, '#bdeccb');
    } else {
      gradient.stop(0, '#fdefea').stop(1, '#f8d2c4');
    }
    doc.roundedRect(PAGE_LEFT, boxTop, PAGE_WIDTH, boxHeight, 12).fill(gradient);

    const startedBy = inspection.createdByUser ? inspection.createdByUser.fullName || inspection.createdByUser.email : null;
    const completedBy = inspection.completedByUser ? inspection.completedByUser.fullName || inspection.completedByUser.email : null;
    // The common case is one admin doing the whole session - "Started
    // by X" and "Completed by X" would just repeat the same name twice.
    const inspector = startedBy && startedBy === completedBy ? startedBy : completedBy || startedBy;

    const completedText = inspection.completedAt
      ? inspection.completedAt.toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' })
      : '—';

    const labelX = PAGE_LEFT + 22;
    const valueX = labelX + 78;
    let rowY = boxTop + 28;
    const rows: [string, string][] = [
      ['Inspector:', inspector ?? '—'],
      ['Completed:', completedText],
    ];
    for (const [label, value] of rows) {
      doc.fontSize(10.5).font('Helvetica-Bold').fillColor(INK).text(label, labelX, rowY, { lineBreak: false });
      doc.fontSize(10.5).font('Helvetica').fillColor(INK).text(value, valueX, rowY, { width: 170, lineBreak: false });
      rowY += 30;
    }

    const scoreX = PAGE_LEFT + 300;
    doc.fontSize(11).font('Helvetica-Bold').fillColor(INK).text('Overall Score:', scoreX, boxTop + 20, { lineBreak: false });
    doc
      .fontSize(30)
      .font('Helvetica-Bold')
      .fillColor(pass ? GREEN_DARK : CORAL_DARK)
      .text(inspection.averageScore !== null ? `${inspection.averageScore}%` : '—', scoreX, boxTop + 38, { lineBreak: false });
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor(pass ? GREEN_DARK : CORAL_DARK)
      .text(pass ? 'Meets the 80% standard' : 'Below the 80% standard', scoreX, boxTop + 78, { lineBreak: false });

    const pieCx = PAGE_RIGHT - 68;
    const pieCy = boxTop + 50;
    this.drawPieChart(doc, pieCx, pieCy, 32, (inspection.averageScore ?? 0) / 100, pass ? GREEN : CORAL);

    // Divider + one-line spread across the bottom of the card.
    const dividerY = boxTop + 100;
    doc
      .strokeColor(pass ? '#a5dcb8' : '#efbba9')
      .lineWidth(0.8)
      .moveTo(PAGE_LEFT + 22, dividerY)
      .lineTo(PAGE_RIGHT - 22, dividerY)
      .stroke();
    doc.lineWidth(1);

    const rated = inspection.items.filter((i) => i.percentage !== null && i.rating);
    const parts: string[] = [`${inspection.items.length} space${inspection.items.length === 1 ? '' : 's'} inspected`];
    doc.fontSize(9.5).font('Helvetica-Bold');
    // Each name gets a fixed share of the line so one very long space name
    // can't push the whole summary onto a second line.
    const statNameWidth = 120;
    if (rated.length > 0) {
      const highest = rated.reduce((a, b) => ((b.percentage ?? 0) > (a.percentage ?? 0) ? b : a));
      const lowest = rated.reduce((a, b) => ((b.percentage ?? 0) < (a.percentage ?? 0) ? b : a));
      parts.push(`Highest: ${fitText(doc, highest.spaceName, statNameWidth)} (${highest.percentage}%)`);
      if (rated.length > 1) {
        parts.push(`Lowest: ${fitText(doc, lowest.spaceName, statNameWidth)} (${lowest.percentage}%)`);
      }
    }
    doc
      .fillColor(INK)
      .text(parts.join('   ·   '), PAGE_LEFT + 22, dividerY + 10, { width: PAGE_WIDTH - 44, lineBreak: false });

    doc.y = boxTop + boxHeight + 12;
    doc.moveDown(0.5);
  }

  /** A wedge-filled circle, sweeping clockwise from 12 o'clock - built from sampled points rather than relying on pdfkit's SVG arc parsing. */
  private drawPieChart(doc: PDFKit.PDFDocument, cx: number, cy: number, radius: number, fraction: number, filledColor: string) {
    doc.circle(cx, cy, radius).fillAndStroke('#ffffff', CARD_BORDER);

    const clamped = Math.max(0, Math.min(1, fraction));
    if (clamped <= 0) return;

    const startAngle = -Math.PI / 2;
    const sweep = clamped * Math.PI * 2;
    const steps = Math.max(2, Math.ceil(72 * clamped));

    doc.moveTo(cx, cy);
    for (let i = 0; i <= steps; i++) {
      const angle = startAngle + (sweep * i) / steps;
      doc.lineTo(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
    }
    doc.lineTo(cx, cy);
    doc.fill(filledColor);
  }

  private drawItem(doc: PDFKit.PDFDocument, item: ReportItem, thumbnails: Map<string, Buffer>) {
    const innerLeft = PAGE_LEFT + 16;
    const innerRight = PAGE_RIGHT - 16;
    const barWidth = 150;
    const barHeight = 8;
    const notesX = innerLeft + 190;
    const thumbSize = 46;
    const thumbGap = 6;

    const images = item.media.filter((m) => m.resourceType === 'IMAGE' && thumbnails.has(m.id));
    const shownImages = images.slice(0, 2);
    const extraCount = images.length - shownImages.length;
    const thumbsWidth = shownImages.length > 0 ? shownImages.length * thumbSize + (shownImages.length - 1) * thumbGap : 0;
    const thumbX = innerRight - thumbsWidth;
    const notesWidth = innerRight - notesX - (thumbsWidth > 0 ? thumbsWidth + 14 : 0);

    const hasNotes = !!item.notes;
    const notesText = item.notes || 'No comment';
    const notesHeight = doc.fontSize(9.5).font('Helvetica').heightOfString(notesText, { width: notesWidth });

    const padding = 14;
    const nameHeight = 20;
    const bodyGap = 8;
    const thumbsBlockHeight = thumbsWidth > 0 ? thumbSize + (extraCount > 0 ? 14 : 0) : 0;
    const bodyHeight = Math.max(barHeight + 6, notesHeight, thumbsBlockHeight);
    const cardHeight = padding + nameHeight + bodyGap + bodyHeight + padding;

    if (doc.y + cardHeight + 12 > doc.page.height - 66) {
      doc.addPage();
    }

    const needsAttention = !!item.rating && ATTENTION_RATINGS.has(item.rating);
    const style = (item.rating && RATING_STYLES[item.rating]) || NEUTRAL_STYLE;
    const cardTop = doc.y;

    doc
      .roundedRect(PAGE_LEFT, cardTop, PAGE_WIDTH, cardHeight, 10)
      .fillAndStroke(needsAttention ? ATTENTION_CARD_BG : CARD_BG, needsAttention ? ATTENTION_CARD_BORDER : CARD_BORDER);

    const rowTop = cardTop + padding;

    // The name shares its row with the rating pill + percentage (right) -
    // cap its width so a long name is cut with an ellipsis instead of
    // wrapping into the bar underneath.
    doc.fontSize(13).font('Helvetica-Bold');
    const nameText = fitText(doc, item.spaceName, 250);
    doc.fillColor(needsAttention ? CORAL_DARK : INK).text(nameText, innerLeft, rowTop, { lineBreak: false });

    // Rating pill + percentage, right-aligned on the name row.
    if (item.rating) {
      const pctWidth = 40;
      doc
        .fontSize(13)
        .font('Helvetica-Bold')
        .fillColor(style.text)
        .text(`${item.percentage ?? 0}%`, innerRight - pctWidth, rowTop, { width: pctWidth, align: 'right', lineBreak: false });
      this.drawPill(doc, RATING_LABELS[item.rating] ?? item.rating, innerRight - pctWidth - 8, rowTop, style);
    }

    const bodyY = rowTop + nameHeight + bodyGap;

    if (item.rating) {
      doc.roundedRect(innerLeft, bodyY + 2, barWidth, barHeight, barHeight / 2).fill(BAR_TRACK);
      const filledWidth = barWidth * ((item.percentage ?? 0) / 100);
      if (filledWidth > 0) {
        const radius = Math.min(barHeight / 2, filledWidth / 2);
        doc.roundedRect(innerLeft, bodyY + 2, filledWidth, barHeight, radius).fill(style.fill);
      }
    }

    doc
      .fontSize(9.5)
      .font(hasNotes ? 'Helvetica' : 'Helvetica-Oblique')
      .fillColor(hasNotes ? INK : MUTED)
      .text(notesText, notesX, bodyY, { width: notesWidth });

    let tx = thumbX;
    for (const m of shownImages) {
      try {
        doc.save();
        doc.roundedRect(tx, bodyY - 2, thumbSize, thumbSize, 6).clip();
        doc.image(thumbnails.get(m.id)!, tx, bodyY - 2, { cover: [thumbSize, thumbSize] });
        doc.restore();
      } catch (err) {
        doc.restore();
        this.logger.warn(`Skipping undecodable thumbnail for media ${m.id}: ${(err as Error).message}`);
      }
      tx += thumbSize + thumbGap;
    }
    if (extraCount > 0) {
      doc.fontSize(8).font('Helvetica').fillColor(MUTED).text(`+${extraCount} more`, thumbX, bodyY + thumbSize + 2, { width: thumbsWidth, align: 'right', lineBreak: false });
    }

    const videoCount = item.media.filter((m) => m.resourceType === 'VIDEO').length;
    if (videoCount > 0) {
      doc
        .fontSize(8)
        .font('Helvetica-Oblique')
        .fillColor(MUTED)
        .text(`${videoCount} video${videoCount === 1 ? '' : 's'} attached`, notesX, bodyY + notesHeight + 3, { width: notesWidth });
    }

    doc.y = cardTop + cardHeight + 10;
  }

  /** A small rounded label, right edge anchored at `rightX` - used for the rating on each card. */
  private drawPill(doc: PDFKit.PDFDocument, label: string, rightX: number, top: number, style: { tint: string; text: string }) {
    doc.fontSize(9).font('Helvetica-Bold');
    const width = doc.widthOfString(label) + 18;
    const height = 18;
    const x = rightX - width;
    doc.roundedRect(x, top - 1, width, height, height / 2).fill(style.tint);
    doc.fillColor(style.text).text(label, x, top + 3.5, { width, align: 'center', lineBreak: false });
  }

  private drawFooter(doc: PDFKit.PDFDocument, pageNumber: number, pageCount: number) {
    const generated = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' });
    // Drawing text exactly at page.height - bottomMargin overflows the
    // printable area by the text's own line height, which silently
    // triggers pdfkit's automatic page break and leaves a near-blank
    // trailing page with just this line on it - sit comfortably above
    // the margin line instead (lineBreak: false as a second guard,
    // since these lines are short and never need to wrap anyway).
    const y = doc.page.height - 56;
    doc.strokeColor(CARD_BORDER).lineWidth(0.8).moveTo(PAGE_LEFT, y - 10).lineTo(PAGE_RIGHT, y - 10).stroke();
    doc.lineWidth(1);
    doc.fontSize(8).font('Helvetica').fillColor(MUTED).text(`Pine Cleaning Co.  ·  Generated ${generated}`, PAGE_LEFT, y, { lineBreak: false });
    doc.fontSize(8).font('Helvetica').fillColor(MUTED).text(`Page ${pageNumber} of ${pageCount}`, PAGE_LEFT, y, { width: PAGE_WIDTH, align: 'right', lineBreak: false });
  }
}

/** Shortens `text` with an ellipsis until it fits `maxWidth` in the doc's *current* font/size - pdfkit's own `ellipsis` option is ignored when line breaking is off, so this measures instead. */
function fitText(doc: PDFKit.PDFDocument, text: string, maxWidth: number): string {
  if (doc.widthOfString(text) <= maxWidth) return text;
  let clipped = text;
  while (clipped.length > 1 && doc.widthOfString(`${clipped}…`) > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return `${clipped.trimEnd()}…`;
}

interface ReportInspection {
  completedAt: Date | null;
  averageScore: number | null;
  meetsStandard: boolean | null;
  createdByUser: { fullName: string | null; email: string } | null;
  completedByUser: { fullName: string | null; email: string } | null;
  site: { businessName: string; address: string | null; client: { clientName: string } };
  items: ReportItem[];
}

interface ReportItem {
  spaceName: string;
  isNotApplicable: boolean;
  rating: string | null;
  percentage: number | null;
  notes: string | null;
  media: { id: string; resourceType: string }[];
}
