import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { ClickupService } from '../clickup/clickup.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';

@Injectable()
export class ClientsService {
  private readonly logger = new Logger(ClientsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clickup: ClickupService,
  ) {}

  async create(dto: CreateClientDto, createdBy: string) {
    const clientCode = dto.clientCode.trim().toLowerCase();

    let client;
    try {
      client = await this.prisma.client.create({
        data: {
          clientCode,
          name: dto.name.trim(),
          contactEmail: dto.contactEmail ?? null,
          contactPhone: dto.contactPhone ?? null,
          createdBy,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`A client with clientCode "${clientCode}" already exists`);
      }
      throw err;
    }

    await this.syncToClickup(client.id, client);
    // A brand-new client always has 0 sites - attach that directly
    // instead of a second DB round-trip (findOne) just to compute a
    // count that can only ever be zero here.
    return { ...client, _count: { sites: 0 } };
  }

  async findAll() {
    return this.prisma.client.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { sites: true } } },
    });
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

    const client = await this.prisma.client.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.contactEmail !== undefined && { contactEmail: dto.contactEmail }),
        ...(dto.contactPhone !== undefined && { contactPhone: dto.contactPhone }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
    });

    await this.syncToClickup(id, client);
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

  /**
   * Non-blocking: a ClickUp outage or missing connection never fails the
   * client CRUD operation. Every update re-attempts the sync, so a
   * previously-failed create sync self-heals on the next edit.
   */
  private async syncToClickup(clientId: string, client: { clickupEntityId: string | null; name: string; contactEmail: string | null; contactPhone: string | null; status: string }) {
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
        await this.prisma.client.update({ where: { id: clientId }, data: { clickupEntityId: clickupTaskId } });
      }
    } catch (err) {
      this.logger.warn(`ClickUp sync failed for client ${clientId}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
