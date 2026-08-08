import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AdminFeedbackService } from '../admin-feedback/admin-feedback.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';

/**
 * Deliberately does not sync clients to ClickUp's Companies list at
 * all (create or update) - the client restricted this integration to
 * "only insert feedback as tickets," so Company records are never
 * touched from here. See ClickupService.findCompanyByName for the
 * read-only lookup used instead, at ticket-creation time.
 */
@Injectable()
export class ClientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminFeedback: AdminFeedbackService,
  ) {}

  async create(dto: CreateClientDto, createdBy: string) {
    const clientId = dto.clientId.trim().toLowerCase();

    let client;
    try {
      client = await this.prisma.client.create({
        data: {
          clientId,
          clientName: dto.clientName.trim(),
          createdBy,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`A client with clientId "${clientId}" already exists`);
      }
      throw err;
    }

    // A brand-new client always has 0 sites - attach that directly
    // instead of a second DB round-trip (findOne) just to compute a
    // count that can only ever be zero here.
    return { ...client, _count: { sites: 0 } };
  }

  /**
   * No page/pageSize -> unchanged full-array response (Feedback/Assets
   * filter dropdowns and the CSV import preview all rely on this shape
   * and never send these params). Either param present -> paginated
   * { data, total, page, pageSize, ...counts } shape instead, with the
   * summary counts computed across *all* clients (not just the current
   * page) via separate lightweight aggregate queries.
   */
  async findAll(page?: number, pageSize?: number) {
    if (!page && !pageSize) {
      return this.prisma.client.findMany({
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { sites: true } } },
      });
    }

    const currentPage = page ?? 1;
    const size = pageSize ?? 50;

    const [data, total, activeCount, totalSites, multiSiteGroups] = await Promise.all([
      this.prisma.client.findMany({
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { sites: true } } },
        skip: (currentPage - 1) * size,
        take: size,
      }),
      this.prisma.client.count(),
      this.prisma.client.count({ where: { status: 'ACTIVE' } }),
      this.prisma.site.count(),
      this.prisma.site.groupBy({
        by: ['clientCode'],
        _count: { clientCode: true },
        having: { clientCode: { _count: { gt: 1 } } },
      }),
    ]);

    return {
      data,
      total,
      page: currentPage,
      pageSize: size,
      activeCount,
      inactiveCount: total - activeCount,
      totalSites,
      multiSiteCount: multiSiteGroups.length,
    };
  }

  async findOne(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: { _count: { select: { sites: true } } },
    });
    if (!client) {
      throw new NotFoundException(`Client ${id} not found`);
    }
    return client;
  }

  async update(id: string, dto: UpdateClientDto) {
    await this.findOne(id); // 404s if missing

    await this.prisma.client.update({
      where: { id },
      data: {
        ...(dto.clientName !== undefined && { clientName: dto.clientName.trim() }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
    });

    return this.findOne(id);
  }

  /**
   * Hard delete - the client, every site under it, and every feedback
   * submission on those sites (with attachments), all permanently
   * removed from the database. Deliberately NOT a plain
   * `prisma.client.delete()` - the DB's own ON DELETE RESTRICT (sites ->
   * feedback_submissions) exists specifically to stop an accidental
   * delete-with-history, so a full wipe has to explicitly clear
   * feedback first, in the same order the database would require
   * anyway.
   *
   * Each feedback row is deleted via AdminFeedbackService.remove() -
   * the exact same method the single-feedback "Delete" button on the
   * Feedback page already uses - so ClickUp ticket deletion and
   * Cloudinary attachment cleanup are handled identically here, both
   * best-effort (a ClickUp/Cloudinary failure is logged, never blocks
   * the delete). The client's ClickUp Company record is never touched
   * either way - this service has never written to the Companies list.
   */
  async remove(id: string) {
    await this.findOne(id); // 404s if missing

    const sites = await this.prisma.site.findMany({ where: { clientCode: id }, select: { id: true } });

    for (const site of sites) {
      const feedback = await this.prisma.feedbackSubmission.findMany({ where: { siteId: site.id }, select: { id: true } });
      for (const item of feedback) {
        await this.adminFeedback.remove(item.id);
      }
    }

    await this.prisma.site.deleteMany({ where: { clientCode: id } });

    try {
      await this.prisma.client.delete({ where: { id } });
    } catch (err) {
      // Defensive fallback only - every site/feedback row above is
      // already gone by this point, so RESTRICT shouldn't fire again.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        throw new ConflictException('Cannot delete this client: some of its data could not be cleared first.');
      }
      throw err;
    }
  }
}
