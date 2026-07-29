import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { Prisma } from '../../generated/prisma/client';
import { ClickupService } from '../clickup/clickup.service';
import { PrismaService } from '../prisma/prisma.service';

const MAX_ROWS = 1000; // matches the discovery doc's stated CSV import cap (Section 5.2)
const CLIENT_CODE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_CODE_GENERATION_ATTEMPTS = 5;
const MAX_SITE_CODE_ATTEMPTS = 5;

/**
 * Header aliases, not exact-match-only: the real client CSV format
 * isn't known yet (Open Decision #4, still unresolved), so this is a
 * best-effort default template (confirmed with the user 2026-07-28)
 * that's reasonably tolerant of common header wording instead of
 * requiring one exact spelling. Adjusting this map is the expected,
 * contained way to slot in the client's real format once it arrives -
 * nothing else in this file should need to change for that.
 */
const HEADER_ALIASES: Record<string, keyof CsvRow> = {
  'client name': 'clientName',
  'business name': 'clientName',
  'client code': 'clientCode',
  'contact email': 'contactEmail',
  email: 'contactEmail',
  'contact phone': 'contactPhone',
  phone: 'contactPhone',
  mobile: 'contactPhone',
  'site name': 'siteName',
  location: 'siteName',
  address: 'address',
};

interface CsvRow {
  clientName: string;
  clientCode: string;
  contactEmail: string;
  contactPhone: string;
  siteName: string;
  address: string;
}

/** Same rules as the frontend's ClientForm.tsx slugify() - kept in sync manually, matches CLIENT_CODE_PATTERN. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 46); // leaves room for "-" + 4 digits within the 50-char clientCode limit
}

@Injectable()
export class CsvImportService {
  private readonly logger = new Logger(CsvImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clickup: ClickupService,
  ) {}

  async processFile(fileBuffer: Buffer, filename: string, uploadedBy: string) {
    const rows = this.parseCsv(fileBuffer);

    const batch = await this.prisma.csvImportBatch.create({
      data: { filename, uploadedBy, totalRows: rows.length, status: 'PROCESSING' },
    });

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 2; // header is row 1
      try {
        const { clientId, siteId } = await this.processRow(rows[i]);
        successCount++;
        await this.prisma.csvImportRow.create({
          data: { batchId: batch.id, rowNumber, clientId, siteId, status: 'SUCCESS' },
        });
      } catch (err) {
        errorCount++;
        const errorMessage = err instanceof Error ? err.message : String(err);
        await this.prisma.csvImportRow.create({
          data: { batchId: batch.id, rowNumber, status: 'ERROR', errorMessage },
        });
      }
    }

    const updatedBatch = await this.prisma.csvImportBatch.update({
      where: { id: batch.id },
      data: { status: 'COMPLETED', successCount, errorCount },
    });

    const savedRows = await this.prisma.csvImportRow.findMany({
      where: { batchId: batch.id },
      orderBy: { rowNumber: 'asc' },
    });

    return { batch: updatedBatch, rows: savedRows };
  }

  private parseCsv(buffer: Buffer): CsvRow[] {
    let records: Record<string, string>[];
    try {
      records = parse(buffer, { columns: true, skip_empty_lines: true, trim: true });
    } catch (err) {
      throw new BadRequestException(`Could not parse CSV file: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (records.length === 0) {
      throw new BadRequestException('CSV file has no data rows');
    }
    if (records.length > MAX_ROWS) {
      throw new BadRequestException(`CSV has ${records.length} rows - maximum is ${MAX_ROWS}`);
    }

    return records.map((record) => {
      const row: Partial<CsvRow> = {};
      for (const [header, value] of Object.entries(record)) {
        const key = HEADER_ALIASES[header.trim().toLowerCase()];
        if (key) row[key] = (value ?? '').trim();
      }
      return {
        clientName: row.clientName ?? '',
        clientCode: row.clientCode ?? '',
        contactEmail: row.contactEmail ?? '',
        contactPhone: row.contactPhone ?? '',
        siteName: row.siteName ?? '',
        address: row.address ?? '',
      };
    });
  }

  /** One row = one client+site pair. Never throws for a "row already handled" case - only genuine validation/DB errors. */
  private async processRow(row: CsvRow): Promise<{ clientId: string; siteId: string }> {
    if (!row.clientName) throw new Error('Client Name is required');
    if (!row.siteName) throw new Error('Site Name is required');

    const client = await this.resolveClient(row);
    const site = await this.resolveSite(client, row);

    return { clientId: client.id, siteId: site.id };
  }

  /** Matched by clientCode when provided (create-or-update); auto-generated (matching the admin portal's own auto-gen) when blank. */
  private async resolveClient(row: CsvRow) {
    if (row.clientCode) {
      const code = row.clientCode.trim().toLowerCase();
      if (!CLIENT_CODE_PATTERN.test(code)) {
        throw new Error(`Invalid Client Code "${row.clientCode}" - use lowercase letters, numbers, and hyphens only`);
      }

      const existing = await this.prisma.client.findUnique({ where: { clientCode: code } });
      if (existing) {
        const updated = await this.prisma.client.update({
          where: { id: existing.id },
          data: {
            name: row.clientName,
            ...(row.contactEmail && { contactEmail: row.contactEmail }),
            ...(row.contactPhone && { contactPhone: row.contactPhone }),
          },
        });
        await this.syncClientToClickup(updated);
        return updated;
      }

      return this.createClient(code, row);
    }

    const generatedCode = await this.generateUniqueClientCode(row.clientName);
    return this.createClient(generatedCode, row);
  }

  private async createClient(clientCode: string, row: CsvRow) {
    const created = await this.prisma.client.create({
      data: {
        clientCode,
        name: row.clientName,
        contactEmail: row.contactEmail || null,
        contactPhone: row.contactPhone || null,
      },
    });
    await this.syncClientToClickup(created);
    return created;
  }

  /** Non-blocking, same reasoning as ClientsService.syncToClickup - never fails the row over a ClickUp outage. */
  private async syncClientToClickup(client: {
    id: string;
    clickupEntityId: string | null;
    name: string;
    contactEmail: string | null;
    contactPhone: string | null;
    status: string;
  }) {
    const input = {
      name: client.name,
      contactEmail: client.contactEmail,
      contactPhone: client.contactPhone,
      status: client.status,
    };

    try {
      if (client.clickupEntityId) {
        await this.clickup.updateCompany(client.clickupEntityId, input);
      } else {
        const clickupTaskId = await this.clickup.createCompany(input);
        await this.prisma.client.update({ where: { id: client.id }, data: { clickupEntityId: clickupTaskId } });
      }
    } catch (err) {
      this.logger.warn(`ClickUp sync failed for client ${client.id} during CSV import: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async generateUniqueClientCode(name: string): Promise<string> {
    const base = slugify(name) || 'client';
    for (let attempt = 0; attempt < MAX_CODE_GENERATION_ATTEMPTS; attempt++) {
      const suffix = String(Math.floor(1000 + Math.random() * 9000));
      const code = `${base}-${suffix}`;
      const exists = await this.prisma.client.findUnique({ where: { clientCode: code } });
      if (!exists) return code;
    }
    throw new Error('Could not generate a unique client code - please provide one manually for this row');
  }

  /**
   * Sites have no CSV-provided key (site_code/slug are always
   * system-generated, never admin-provided, same rule as the portal
   * UI) - matched by clientId + siteName (case-insensitive) instead,
   * so re-running the same CSV updates rather than duplicates sites.
   */
  private async resolveSite(client: { id: string; clientCode: string }, row: CsvRow) {
    const existing = await this.prisma.site.findFirst({
      where: { clientId: client.id, siteName: { equals: row.siteName, mode: 'insensitive' } },
    });
    if (existing) {
      if (row.address && row.address !== existing.address) {
        return this.prisma.site.update({ where: { id: existing.id }, data: { address: row.address } });
      }
      return existing;
    }

    return this.createSiteWithRetry(client, row);
  }

  /** Same generate-try-retry-on-collision shape as SitesService.create - duplicated here rather than reused, since that method's DTO/404 shape is tied to a single-client HTTP request, not this per-row batch loop. */
  private async createSiteWithRetry(client: { id: string; clientCode: string }, row: CsvRow) {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_SITE_CODE_ATTEMPTS; attempt++) {
      const siteCode = await this.nextSiteCode(client.id);
      const slug = `${client.clientCode}-${siteCode}`;
      try {
        return await this.prisma.site.create({
          data: { clientId: client.id, siteCode, slug, siteName: row.siteName, address: row.address || null },
        });
      } catch (err) {
        lastError = err;
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }
    throw lastError;
  }

  private async nextSiteCode(clientId: string): Promise<string> {
    const existing = await this.prisma.site.findMany({ where: { clientId }, select: { siteCode: true } });
    const maxNum = existing.reduce((max, s) => Math.max(max, Number.parseInt(s.siteCode, 10) || 0), 0);
    return String(maxNum + 1).padStart(2, '0');
  }
}
