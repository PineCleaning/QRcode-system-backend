import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { Prisma } from '../../generated/prisma/client';
import { ClickupService } from '../clickup/clickup.service';
import { PrismaService } from '../prisma/prisma.service';

const MAX_ROWS = 1000; // matches the discovery doc's stated CSV import cap (Section 5.2)
const CLIENT_CODE_PATTERN = /^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$/;
const CONTACT_PHONE_PATTERN = /^[0-9+-]+$/;
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
  'client code': 'clientId',
  'contact email': 'contactEmail',
  email: 'contactEmail',
  'contact phone': 'contactPhone',
  phone: 'contactPhone',
  mobile: 'contactPhone',
  'business name': 'businessName',
  'site name': 'businessName',
  location: 'businessName',
  address: 'address',
};

interface CsvRow {
  clientName: string;
  clientId: string;
  contactEmail: string;
  contactPhone: string;
  businessName: string;
  address: string;
}

/** Same rules as the frontend's ClientForm.tsx slugify() - kept in sync manually, matches CLIENT_CODE_PATTERN. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 46); // leaves room for "-" + 4 digits within the 50-char clientId limit
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
        const { clientCode, siteId } = await this.processRow(rows[i]);
        successCount++;
        await this.prisma.csvImportRow.create({
          data: { batchId: batch.id, rowNumber, clientCode, siteId, status: 'SUCCESS' },
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
        clientId: row.clientId ?? '',
        contactEmail: row.contactEmail ?? '',
        contactPhone: row.contactPhone ?? '',
        businessName: row.businessName ?? '',
        address: row.address ?? '',
      };
    });
  }

  /** One row = one client+site pair. Never throws for a "row already handled" case - only genuine validation/DB errors. */
  private async processRow(row: CsvRow): Promise<{ clientCode: string; siteId: string }> {
    if (!row.clientName) throw new Error('Client Name is required');
    if (!row.businessName) throw new Error('Business Name is required');
    if (!row.address) throw new Error('Address is required');
    if (row.contactPhone && !CONTACT_PHONE_PATTERN.test(row.contactPhone)) {
      throw new Error(`Invalid Contact Phone "${row.contactPhone}" - only digits, + and - are allowed`);
    }

    const client = await this.resolveClient(row);
    const site = await this.resolveSite(client, row);

    return { clientCode: client.id, siteId: site.id };
  }

  /** Matched by clientId when provided (create-or-update); auto-generated (matching the admin portal's own auto-gen) when blank. */
  private async resolveClient(row: CsvRow) {
    if (row.clientId) {
      const code = row.clientId.trim().toLowerCase();
      if (!CLIENT_CODE_PATTERN.test(code)) {
        throw new Error(`Invalid Client Code "${row.clientId}" - use lowercase letters, numbers, and hyphens only`);
      }

      const existing = await this.prisma.client.findUnique({ where: { clientId: code } });
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

    const generatedCode = await this.generateUniqueClientId(row.clientName);
    return this.createClient(generatedCode, row);
  }

  private async createClient(clientId: string, row: CsvRow) {
    const created = await this.prisma.client.create({
      data: {
        clientId,
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

  private async generateUniqueClientId(name: string): Promise<string> {
    const base = slugify(name) || 'client';
    for (let attempt = 0; attempt < MAX_CODE_GENERATION_ATTEMPTS; attempt++) {
      const suffix = String(Math.floor(1000 + Math.random() * 9000));
      const code = `${base}-${suffix}`;
      const exists = await this.prisma.client.findUnique({ where: { clientId: code } });
      if (!exists) return code;
    }
    throw new Error('Could not generate a unique client code - please provide one manually for this row');
  }

  /**
   * Sites have no CSV-provided key (site_code/slug are always
   * system-generated, never admin-provided, same rule as the portal
   * UI) - matched by clientCode + businessName (case-insensitive) instead,
   * so re-running the same CSV updates rather than duplicates sites.
   */
  private async resolveSite(client: { id: string; clientId: string }, row: CsvRow) {
    const existing = await this.prisma.site.findFirst({
      where: { clientCode: client.id, businessName: { equals: row.businessName, mode: 'insensitive' } },
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
  private async createSiteWithRetry(client: { id: string; clientId: string }, row: CsvRow) {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_SITE_CODE_ATTEMPTS; attempt++) {
      const siteCode = await this.nextSiteCode(client.id);
      // Deliberately not derived from clientId/siteCode - see SitesService.create's
      // matching comment. This is the value that ends up on the printed QR code.
      const slug = randomUUID();
      try {
        return await this.prisma.site.create({
          data: { clientCode: client.id, siteCode, slug, businessName: row.businessName, address: row.address || null },
        });
      } catch (err) {
        lastError = err;
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }
    throw lastError;
  }

  private async nextSiteCode(clientCode: string): Promise<string> {
    const existing = await this.prisma.site.findMany({ where: { clientCode }, select: { siteCode: true } });
    const maxNum = existing.reduce((max, s) => Math.max(max, Number.parseInt(s.siteCode, 10) || 0), 0);
    return String(maxNum + 1).padStart(2, '0');
  }
}
