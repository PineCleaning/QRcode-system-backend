import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSiteDto } from './dto/create-site.dto';
import { UpdateSiteDto } from './dto/update-site.dto';

const MAX_CREATE_ATTEMPTS = 5;

@Injectable()
export class SitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async create(clientId: string, dto: CreateSiteDto) {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) {
      throw new NotFoundException(`Client ${clientId} not found`);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
      const siteCode = await this.nextSiteCode(clientId);
      const slug = `${client.clientCode}-${siteCode}`;
      try {
        return await this.prisma.site.create({
          data: {
            clientId,
            siteCode,
            slug,
            siteName: dto.siteName.trim(),
            address: dto.address ?? null,
          },
        });
      } catch (err) {
        lastError = err;
        // Concurrent create picked the same siteCode/slug - recompute and retry.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  async findAllForClient(clientId: string) {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) {
      throw new NotFoundException(`Client ${clientId} not found`);
    }
    return this.prisma.site.findMany({ where: { clientId }, orderBy: { siteCode: 'asc' } });
  }

  async findOne(id: string) {
    const site = await this.prisma.site.findUnique({ where: { id } });
    if (!site) {
      throw new NotFoundException(`Site ${id} not found`);
    }
    return site;
  }

  /** Used for the QR PDF caption, which shows client name alongside the site. */
  async findOneWithClient(id: string) {
    const site = await this.prisma.site.findUnique({ where: { id }, include: { client: true } });
    if (!site) {
      throw new NotFoundException(`Site ${id} not found`);
    }
    return site;
  }

  async update(id: string, dto: UpdateSiteDto) {
    await this.findOne(id); // 404s if missing

    return this.prisma.site.update({
      where: { id },
      data: {
        ...(dto.siteName !== undefined && { siteName: dto.siteName.trim() }),
        ...(dto.address !== undefined && { address: dto.address }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
    });
  }

  async findFeedbackForSite(id: string) {
    await this.findOne(id); // 404s if missing

    const submissions = await this.prisma.feedbackSubmission.findMany({
      where: { siteId: id },
      orderBy: { submittedAt: 'desc' },
      include: { media: true },
    });

    // Delivery URL is derived from cloud_name + public_id at read time,
    // never persisted (see feedback_media schema notes).
    return submissions.map((submission) => ({
      ...submission,
      media: submission.media.map((item) => ({
        ...item,
        url:
          item.status === 'VERIFIED'
            ? this.cloudinary.buildDeliveryUrl(item.cloudinaryPublicId, item.resourceType.toLowerCase() as 'image' | 'video')
            : null,
      })),
    }));
  }

  /** Hard delete. Blocked at the DB level (ON DELETE RESTRICT) if this site has feedback history. */
  async remove(id: string) {
    await this.findOne(id); // 404s if missing

    try {
      await this.prisma.site.delete({ where: { id } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        throw new ConflictException(
          'Cannot delete this site: it has feedback history. Deactivate it instead (PUT with status: INACTIVE).',
        );
      }
      throw err;
    }
  }

  /** Next sequential site_code for a client, zero-padded to at least 2 digits (e.g. "01", "02", ... "100"). */
  private async nextSiteCode(clientId: string): Promise<string> {
    const existing = await this.prisma.site.findMany({ where: { clientId }, select: { siteCode: true } });
    const maxNum = existing.reduce((max, s) => Math.max(max, Number.parseInt(s.siteCode, 10) || 0), 0);
    return String(maxNum + 1).padStart(2, '0');
  }
}
