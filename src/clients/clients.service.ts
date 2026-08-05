import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
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
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateClientDto, createdBy: string) {
    const clientId = dto.clientId.trim().toLowerCase();

    let client;
    try {
      client = await this.prisma.client.create({
        data: {
          clientId,
          clientName: dto.clientName.trim(),
          contactEmail: dto.contactEmail ?? null,
          contactPhone: dto.contactPhone ?? null,
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
        ...(dto.contactEmail !== undefined && { contactEmail: dto.contactEmail }),
        ...(dto.contactPhone !== undefined && { contactPhone: dto.contactPhone }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
    });

    return this.findOne(id);
  }

  /** Hard delete. Blocked at the DB level (ON DELETE RESTRICT via sites -> feedback_submissions) if any site under this client has feedback history. */
  async remove(id: string) {
    await this.findOne(id); // 404s if missing

    try {
      await this.prisma.client.delete({ where: { id } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        throw new ConflictException(
          'Cannot delete this client: one or more of its sites have feedback history. Deactivate the client instead (PUT with status: INACTIVE).',
        );
      }
      throw err;
    }
  }
}
