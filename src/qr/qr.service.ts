import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as QRCode from 'qrcode';

// pdfkit's real CJS export is the PDFDocument class itself (`export =`).
// `import * as X` under esModuleInterop wraps it as { default: Class },
// which breaks `new X(...)` at runtime even though it type-checks -
// `import ... = require(...)` gets the raw, unwrapped export instead.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import PDFDocument = require('pdfkit');

export type QrPageSize = 'A4' | 'A5';

export interface QrPrintInfo {
  slug: string;
  siteName: string;
  clientName: string;
}

/**
 * QR codes are generated on demand from the site's slug - nothing is
 * cached or stored (no qr_code_url column in v1.5). PNG only, not JPG:
 * JPEG's lossy compression can introduce artifacts that make a QR code
 * fail to scan, so there's no upside to offering it alongside PNG.
 */
@Injectable()
export class QrService {
  constructor(private readonly config: ConfigService) {}

  buildTargetUrl(slug: string): string {
    const baseDomain = this.config.get<string>('BASE_DOMAIN') || 'http://localhost:3000';
    return `${baseDomain.replace(/\/+$/, '')}/${slug}`;
  }

  async generatePng(slug: string): Promise<Buffer> {
    const url = this.buildTargetUrl(slug);
    return QRCode.toBuffer(url, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 1024,
    });
  }

  /** A4/A5-sized PDF: just the raw QR code plus a small identifying caption - card/sticker design is out of scope. */
  async generatePdf(info: QrPrintInfo, size: QrPageSize): Promise<Buffer> {
    const qrPng = await this.generatePng(info.slug);

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size, margin: 36 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const qrSize = Math.min(doc.page.width, doc.page.height) * 0.5;
      const x = (doc.page.width - qrSize) / 2;
      const y = (doc.page.height - qrSize) / 2 - 30;

      doc.image(qrPng, x, y, { width: qrSize, height: qrSize });

      doc
        .fontSize(14)
        .text(info.clientName, 0, y + qrSize + 16, { align: 'center' })
        .fontSize(11)
        .text(info.siteName, { align: 'center' })
        .fontSize(9)
        .fillColor('#666666')
        .text(info.slug, { align: 'center' });

      doc.end();
    });
  }
}
