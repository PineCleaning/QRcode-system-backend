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

const INK = '#1a1a1a';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const GREEN = '#16a34a';
const CORAL = '#dc2626';
const BOX_BG = '#f3f4f6';
const NEEDS_ATTENTION_BG = '#fdecea';
const BAR_TRACK = '#dbeafe';
const BAR_FILL = '#2563eb';

const PAGE_LEFT = 40;
const PAGE_RIGHT = 555;
const PAGE_WIDTH = PAGE_RIGHT - PAGE_LEFT;

/** Ratings that put a row in "needs attention" territory - pink row tint + coral text, matching the reference design's treatment of only the worst two tiers. */
const ATTENTION_RATINGS = new Set(['BELOW_AVERAGE', 'VERY_POOR']);

/**
 * Renders a completed inspection session as a PDF - a summary bar
 * (inspector/completed/duration + an overall-score pie chart) followed
 * by one row per inspected space (progress bar, rating, notes, photo
 * thumbnails), with rows that need attention tinted pink and flagged
 * items badged. Styled after a reference inspection-app screenshot the
 * client shared (2026-09-15) - adapted to this app's actual data shape,
 * which has one rating per space rather than the reference's nested
 * room-then-checklist-items structure, so each space maps to one row
 * here rather than a sub-list.
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
    const imageMedia = inspection.items.flatMap((item) =>
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
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      this.drawTitle(doc, inspection);
      this.drawSummaryBox(doc, inspection);
      for (const item of inspection.items) {
        this.drawItem(doc, item, thumbnails);
      }
      this.drawFooter(doc);

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

    doc.fillColor(INK).fontSize(20).font('Helvetica-Bold').text('Site Inspection Report', PAGE_LEFT, logoTop, { width: PAGE_WIDTH - logoWidth - 15 });
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
    doc.moveDown(0.6);
  }

  /**
   * The light-gray summary bar: Inspector/Completed/Duration on the
   * left, a big score number in the middle, a pie chart on the right -
   * styled after the reference screenshot, minus its ID and map/Location
   * fields (dropped per the client's explicit direction 2026-09-15 - no
   * maps integration exists, and a bare numeric ID isn't meaningful
   * here the way the client/site name already is).
   */
  private drawSummaryBox(doc: PDFKit.PDFDocument, inspection: ReportInspection) {
    const boxTop = doc.y;
    const boxHeight = 112;
    doc.roundedRect(PAGE_LEFT, boxTop, PAGE_WIDTH, boxHeight, 10).fill(BOX_BG);

    const startedBy = inspection.createdByUser ? inspection.createdByUser.fullName || inspection.createdByUser.email : null;
    const completedBy = inspection.completedByUser ? inspection.completedByUser.fullName || inspection.completedByUser.email : null;
    // The common case is one admin doing the whole session - "Started
    // by X" and "Completed by X" would just repeat the same name twice.
    const inspector = startedBy && startedBy === completedBy ? startedBy : completedBy || startedBy;

    const completedText = inspection.completedAt
      ? inspection.completedAt.toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' })
      : '—';
    const duration = formatDuration(inspection.startedAt, inspection.completedAt);

    const labelX = PAGE_LEFT + 20;
    const valueX = labelX + 78;
    let rowY = boxTop + 20;
    const rows: [string, string][] = [
      ['Inspector:', inspector ?? '—'],
      ['Completed:', completedText],
      ['Duration:', duration],
    ];
    for (const [label, value] of rows) {
      doc.fontSize(10.5).font('Helvetica-Bold').fillColor(INK).text(label, labelX, rowY, { lineBreak: false });
      doc.fontSize(10.5).font('Helvetica').fillColor(INK).text(value, valueX, rowY, { width: 170, lineBreak: false });
      rowY += 24;
    }

    const scoreX = PAGE_LEFT + 300;
    doc.fontSize(11).font('Helvetica-Bold').fillColor(INK).text('Overall Score:', scoreX, boxTop + 22, { lineBreak: false });
    const pass = inspection.meetsStandard === true;
    doc
      .fontSize(30)
      .font('Helvetica-Bold')
      .fillColor(pass ? GREEN : CORAL)
      .text(inspection.averageScore !== null ? `${inspection.averageScore}%` : '—', scoreX, boxTop + 40, { lineBreak: false });
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor(MUTED)
      .text(pass ? 'Meets the 80% standard' : 'Below the 80% standard', scoreX, boxTop + 82, { lineBreak: false });

    const pieCx = PAGE_RIGHT - 68;
    const pieCy = boxTop + boxHeight / 2;
    this.drawPieChart(doc, pieCx, pieCy, 34, (inspection.averageScore ?? 0) / 100, pass ? GREEN : CORAL);

    doc.y = boxTop + boxHeight;
    doc.moveDown(0.5);

    const flaggedCount = inspection.items.filter((i) => i.flagged).length;
    if (flaggedCount > 0) {
      doc.fillColor(CORAL).fontSize(10).font('Helvetica-Bold').text(`${flaggedCount} item${flaggedCount === 1 ? '' : 's'} flagged for follow-up`, PAGE_LEFT, doc.y);
      doc.moveDown(0.3);
    }
    doc.moveDown(0.4);
  }

  /** A wedge-filled circle, sweeping clockwise from 12 o'clock - built from sampled points rather than relying on pdfkit's SVG arc parsing. */
  private drawPieChart(doc: PDFKit.PDFDocument, cx: number, cy: number, radius: number, fraction: number, filledColor: string) {
    doc.circle(cx, cy, radius).fillAndStroke('#ffffff', LINE);

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
    const barWidth = 70;
    const barHeight = 9;
    const notesX = PAGE_LEFT + 300;
    const notesWidth = 130;
    const thumbSize = 42;
    const thumbGap = 6;

    const images = item.media.filter((m) => m.resourceType === 'IMAGE' && thumbnails.has(m.id));
    const shownImages = images.slice(0, 2);
    const extraCount = images.length - shownImages.length;
    const thumbsWidth = shownImages.length > 0 ? shownImages.length * thumbSize + (shownImages.length - 1) * thumbGap : 0;
    const thumbX = PAGE_RIGHT - thumbsWidth;

    const notesText = item.isNotApplicable ? '' : item.notes || 'No comment';
    const notesHeight = item.isNotApplicable ? 0 : doc.heightOfString(notesText, { width: notesWidth });

    const nameHeight = 18;
    const bodyHeight = item.isNotApplicable ? 14 : Math.max(barHeight + 6, notesHeight, thumbsWidth > 0 ? thumbSize : 0);
    const padding = 10;
    const rowHeight = nameHeight + bodyHeight + padding * 2;

    if (doc.y + rowHeight + 14 > doc.page.height - 60) {
      doc.addPage();
    }

    const needsAttention = !item.isNotApplicable && !!item.rating && ATTENTION_RATINGS.has(item.rating);
    const rowTop = doc.y;

    if (needsAttention) {
      doc.rect(PAGE_LEFT - 10, rowTop - 6, PAGE_WIDTH + 20, rowHeight + 12).fill(NEEDS_ATTENTION_BG);
    }

    doc
      .fontSize(12.5)
      .font('Helvetica-Bold')
      .fillColor(needsAttention ? CORAL : INK)
      .text(item.spaceName, PAGE_LEFT, rowTop, { continued: item.flagged, lineBreak: false });
    if (item.flagged) {
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor(CORAL).text('  FLAGGED', { lineBreak: false });
    }

    const bodyY = rowTop + nameHeight + padding;

    if (item.isNotApplicable) {
      doc.fontSize(10).font('Helvetica').fillColor(MUTED).text('Not Applicable', PAGE_LEFT, bodyY);
    } else if (item.rating) {
      doc.rect(PAGE_LEFT, bodyY + 2, barWidth, barHeight).fill(BAR_TRACK);
      const filledWidth = barWidth * ((item.percentage ?? 0) / 100);
      if (filledWidth > 0) {
        doc.rect(PAGE_LEFT, bodyY + 2, filledWidth, barHeight).fill(BAR_FILL);
      }
      doc
        .fontSize(9.5)
        .font('Helvetica-Bold')
        .fillColor(INK)
        .text(`${item.percentage ?? 0}%`, PAGE_LEFT + barWidth + 8, bodyY, { width: 36, lineBreak: false });
      doc
        .fontSize(10.5)
        .font('Helvetica-Bold')
        .fillColor(needsAttention ? CORAL : INK)
        .text(RATING_LABELS[item.rating] ?? item.rating, PAGE_LEFT + barWidth + 46, bodyY, {
          width: notesX - (PAGE_LEFT + barWidth + 46) - 10,
          lineBreak: false,
        });
    }

    doc.fontSize(9.5).font('Helvetica').fillColor(INK).text(notesText, notesX, bodyY, { width: notesWidth });

    let tx = thumbX;
    for (const m of shownImages) {
      try {
        doc.image(thumbnails.get(m.id)!, tx, bodyY - 2, { fit: [thumbSize, thumbSize] });
      } catch (err) {
        this.logger.warn(`Skipping undecodable thumbnail for media ${m.id}: ${(err as Error).message}`);
      }
      tx += thumbSize + thumbGap;
    }
    if (extraCount > 0) {
      doc.fontSize(8).font('Helvetica').fillColor(MUTED).text(`+${extraCount} more`, thumbX, bodyY + thumbSize + 2, { width: thumbsWidth, align: 'right' });
    }

    const videoCount = item.media.filter((m) => m.resourceType === 'VIDEO').length;
    if (videoCount > 0) {
      doc
        .fontSize(8)
        .font('Helvetica-Oblique')
        .fillColor(MUTED)
        .text(`${videoCount} video${videoCount === 1 ? '' : 's'} attached`, notesX, bodyY + notesHeight + 3, { width: notesWidth });
    }

    doc.y = rowTop + rowHeight;
    doc.moveDown(0.3);
    doc.strokeColor(LINE).moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).stroke();
    doc.moveDown(0.5);
  }

  private drawFooter(doc: PDFKit.PDFDocument) {
    const generated = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' });
    // Drawing text exactly at page.height - bottomMargin overflows the
    // printable area by the text's own line height, which silently
    // triggers pdfkit's automatic page break and leaves a near-blank
    // trailing page with just this line on it - sit comfortably above
    // the margin line instead (lineBreak: false as a second guard,
    // since this line is short and never needs to wrap anyway).
    doc.fontSize(8).font('Helvetica').fillColor(MUTED).text(`Generated ${generated}`, PAGE_LEFT, doc.page.height - 56, { lineBreak: false });
  }
}

function formatDuration(startedAt: Date, completedAt: Date | null): string {
  if (!completedAt) return '—';
  const minutes = Math.max(1, Math.round((completedAt.getTime() - startedAt.getTime()) / 60000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

interface ReportInspection {
  startedAt: Date;
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
  flagged: boolean;
  media: { id: string; resourceType: string }[];
}
