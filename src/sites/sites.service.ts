import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';
import { QrService } from '../qr/qr.service';
import { CreateSiteDto } from './dto/create-site.dto';
import { UpdateSiteDto } from './dto/update-site.dto';

const MAX_CREATE_ATTEMPTS = 5;

@Injectable()
export class SitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
    private readonly qr: QrService,
  ) {}

  /**
   * Same URL QrService.buildTargetUrl bakes into every generated QR
   * image - computed from BASE_DOMAIN server-side rather than left for
   * the frontend to guess from window.location.origin, which would be
   * wrong whenever the admin portal and public form aren't on the same
   * host.
   */
  private withFeedbackUrl<T extends { slug: string }>(site: T): T & { feedbackUrl: string } {
    return { ...site, feedbackUrl: this.qr.buildTargetUrl(site.slug) };
  }

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
        const site = await this.prisma.site.create({
          data: {
            clientId,
            siteCode,
            slug,
            siteName: dto.siteName.trim(),
            address: dto.address ?? null,
          },
        });
        return this.withFeedbackUrl(site);
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

  /**
   * No page/pageSize -> unchanged full-array response (the Feedback/Assets
   * site filter dropdown relies on this shape and never sends these
   * params). Either param present -> paginated { data, total, page,
   * pageSize } shape instead, matching ClientsService.findAll's pattern.
   */
  async findAllForClient(clientId: string, page?: number, pageSize?: number) {
    if (!page && !pageSize) {
      // Client-existence check and the sites list are independent queries -
      // running them in parallel instead of sequentially halves the fixed
      // network round-trip cost to the DB (each round trip to this project's
      // Supabase pooler is ~200-300ms from a dev machine; two sequential
      // round trips was ~450-500ms of pure wait for what should be one).
      const [client, sites] = await Promise.all([
        this.prisma.client.findUnique({ where: { id: clientId } }),
        this.prisma.site.findMany({ where: { clientId }, orderBy: { siteCode: 'asc' } }),
      ]);
      if (!client) {
        throw new NotFoundException(`Client ${clientId} not found`);
      }
      return sites.map((site) => this.withFeedbackUrl(site));
    }

    const currentPage = page ?? 1;
    const size = pageSize ?? 50;

    const [client, sites, total] = await Promise.all([
      this.prisma.client.findUnique({ where: { id: clientId } }),
      this.prisma.site.findMany({
        where: { clientId },
        orderBy: { siteCode: 'asc' },
        skip: (currentPage - 1) * size,
        take: size,
      }),
      this.prisma.site.count({ where: { clientId } }),
    ]);
    if (!client) {
      throw new NotFoundException(`Client ${clientId} not found`);
    }
    return { data: sites.map((site) => this.withFeedbackUrl(site)), total, page: currentPage, pageSize: size };
  }

  async findOne(id: string) {
    const site = await this.prisma.site.findUnique({ where: { id } });
    if (!site) {
      throw new NotFoundException(`Site ${id} not found`);
    }
    return this.withFeedbackUrl(site);
  }

  /** Used for the QR PDF caption, which shows client name alongside the site. */
  async findOneWithClient(id: string) {
    const site = await this.prisma.site.findUnique({ where: { id }, include: { client: true } });
    if (!site) {
      throw new NotFoundException(`Site ${id} not found`);
    }
    return this.withFeedbackUrl(site);
  }

  async update(id: string, dto: UpdateSiteDto) {
    await this.findOne(id); // 404s if missing

    const site = await this.prisma.site.update({
      where: { id },
      data: {
        ...(dto.siteName !== undefined && { siteName: dto.siteName.trim() }),
        ...(dto.address !== undefined && { address: dto.address }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
    });
    return this.withFeedbackUrl(site);
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
