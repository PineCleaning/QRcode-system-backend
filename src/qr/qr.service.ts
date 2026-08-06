import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as QRCode from 'qrcode';

// pdfkit's and sharp's real CJS exports are callable functions/classes
// themselves (`export =`). `import * as X` under esModuleInterop wraps
// that as { default: X }, which breaks calling it directly at runtime
// even though it type-checks - `import ... = require(...)` gets the
// raw, unwrapped export instead.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import PDFDocument = require('pdfkit');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import sharp = require('sharp');

export type QrPageSize = 'A4' | 'A5';

export interface QrPrintInfo {
  slug: string;
  businessName: string;
  clientName: string;
}

export interface CachedQrAsset {
  buffer: Buffer;
  etag: string;
}

/**
 * Branded "Scan Me" template (src/qr/assets/qr-template.png, 1410x2000)
 * with a placeholder square where the real QR gets composited in.
 * Measured directly from the source file's pixels (scanned for the
 * white rounded-square region), not eyeballed - see the placeholder
 * rect below.
 *
 * Resolved from process.cwd() (the project root), not __dirname:
 * `nest start --watch` (dev) compiles to dist/src/qr/..., while
 * `nest build` (prod) compiles to dist/qr/... - two different output
 * layouts for the exact same source. A __dirname-relative path only
 * matches one of them; process.cwd() is the project root either way
 * (both `npm run start:dev` and `npm run start:prod` are invoked from
 * there), so this asset can just live in src/ and never needs the
 * nest-cli asset-copy step at all.
 */
const TEMPLATE_PATH = join(process.cwd(), 'src', 'qr', 'assets', 'qr-template.png');
const QR_PLACEHOLDER = { left: 385, top: 1043, width: 638, height: 711 };

/**
 * QR codes are generated on demand from the site's slug - nothing is
 * cached or stored (no qr_code_url column in v1.5). PNG only, not JPG:
 * JPEG's lossy compression can introduce artifacts that make a QR code
 * fail to scan, so there's no upside to offering it alongside PNG.
 */
@Injectable()
export class QrService {
  constructor(private readonly config: ConfigService) {}

  /**
   * A site's QR content is fully deterministic from its slug (immutable
   * once created) plus format/size - it never needs to expire or be
   * invalidated, only grow. At this app's real scale (hundreds of
   * sites, a handful of format/size combos each, buffers in the
   * tens-to-low-hundreds of KB) that's a few MB total for the life of
   * the process - a non-issue, no eviction needed. inFlight dedupes a
   * burst of concurrent requests for the same not-yet-cached QR to one
   * real sharp/pdfkit render instead of each paying that cost.
   */
  private readonly cache = new Map<string, CachedQrAsset>();
  private readonly inFlight = new Map<string, Promise<CachedQrAsset>>();

  private async getOrRender(key: string, render: () => Promise<Buffer>): Promise<CachedQrAsset> {
    const cached = this.cache.get(key);
    if (cached) return cached;

    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = render()
        .then((buffer) => {
          const asset: CachedQrAsset = { buffer, etag: `"${createHash('sha1').update(key).digest('hex')}"` };
          this.cache.set(key, asset);
          return asset;
        })
        .finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  buildTargetUrl(slug: string): string {
    const baseDomain = this.config.get<string>('BASE_DOMAIN') || 'http://localhost:3000';
    return `${baseDomain.replace(/\/+$/, '')}/qrfeedback/${slug}`;
  }

  /**
   * Composites a real QR (encoding the site's URL) onto the branded
   * template, sized/centered to sit inside the template's placeholder
   * square without covering its corner-bracket frame or the "SCAN ME"
   * tab beneath it.
   */
  private async compositeOntoTemplate(slug: string): Promise<Buffer> {
    const url = this.buildTargetUrl(slug);
    const qrSize = Math.round(Math.min(QR_PLACEHOLDER.width, QR_PLACEHOLDER.height) * 0.85);

    const qrBuffer = await QRCode.toBuffer(url, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: qrSize,
    });

    const left = Math.round(QR_PLACEHOLDER.left + (QR_PLACEHOLDER.width - qrSize) / 2);
    // Biased above center (not a plain vertical center) so the QR sits
    // clear of the "SCAN ME" tab beneath the placeholder - the smaller
    // 0.85 scale (was 0.92) alone left it sitting almost flush against
    // the bottom edge.
    const top = Math.round(QR_PLACEHOLDER.top + (QR_PLACEHOLDER.height - qrSize) / 2 - 30);

    return sharp(TEMPLATE_PATH)
      .composite([{ input: qrBuffer, left, top }])
      .png()
      .toBuffer();
  }

  async getPng(slug: string): Promise<CachedQrAsset> {
    return this.getOrRender(`png:${slug}`, () => this.compositeOntoTemplate(slug));
  }

  /** Full-bleed A4/A5 PDF of the branded template with the real QR composited in. */
  async getPdf(info: QrPrintInfo, size: QrPageSize): Promise<CachedQrAsset> {
    return this.getOrRender(`pdf:${size}:${info.slug}`, () => this.renderPdf(info, size));
  }

  private async renderPdf(info: QrPrintInfo, size: QrPageSize): Promise<Buffer> {
    const composited = await this.compositeOntoTemplate(info.slug);

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size, margin: 0 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.image(composited, 0, 0, {
        fit: [doc.page.width, doc.page.height],
        align: 'center',
        valign: 'center',
      });

      doc.end();
    });
  }
}
