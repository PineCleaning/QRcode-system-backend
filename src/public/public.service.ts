import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PublicService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Used by the (not-yet-built, Day 4) public form to decide whether to
   * render the real form or a friendly "this isn't available" fallback.
   * Same generic-404 approach as the feedback API: identical response
   * whether the slug is unknown or just deactivated, so a leftover
   * physical QR sticker can't be used to probe which slugs are real.
   */
  async resolveSlug(slug: string) {
    const site = await this.prisma.site.findUnique({ where: { slug }, include: { client: true } });

    if (!site || site.status !== 'ACTIVE' || site.client.status !== 'ACTIVE') {
      throw new NotFoundException('This QR code is not currently active.');
    }

    return {
      slug: site.slug,
      siteName: site.siteName,
      clientName: site.client.name,
    };
  }
}
