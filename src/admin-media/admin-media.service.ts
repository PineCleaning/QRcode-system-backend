import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Media library for the admin "Assets" page - every VERIFIED attachment
 * across all clients/sites/feedback, with delete support. Deliberately
 * VERIFIED-only (confirmed with the user): these are the same real
 * attachments already reflected on the Feedback page. Rejected/orphaned
 * Cloudinary cleanup is a separate, unbuilt concern - out of scope here.
 */
@Injectable()
export class AdminMediaService {
  private readonly logger = new Logger(AdminMediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async findAll(clientCode?: string, siteId?: string) {
    const items = await this.prisma.feedbackMedia.findMany({
      where: {
        status: 'VERIFIED',
        ...(siteId && { feedback: { siteId } }),
        ...(clientCode && { feedback: { site: { clientCode } } }),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        feedback: {
          select: {
            id: true,
            site: {
              select: {
                id: true,
                businessName: true,
                slug: true,
                client: { select: { id: true, name: true, clientId: true } },
              },
            },
          },
        },
      },
    });

    // Every row here is VERIFIED (hard-filtered above), so a delivery
    // URL always exists.
    return items.map((item) => ({
      ...item,
      url: this.cloudinary.buildDeliveryUrl(item.cloudinaryPublicId, item.resourceType.toLowerCase() as 'image' | 'video'),
    }));
  }

  async remove(id: string): Promise<void> {
    const media = await this.prisma.feedbackMedia.findUnique({ where: { id } });
    if (!media) {
      throw new NotFoundException(`Media ${id} not found`);
    }

    try {
      await this.cloudinary.destroy(media.cloudinaryPublicId, media.resourceType.toLowerCase() as 'image' | 'video');
    } catch (err) {
      // Don't let a Cloudinary-side hiccup (already-gone asset, transient
      // API error) leave this row permanently undeletable - same
      // non-blocking-failure reasoning already used for ClickUp sync.
      this.logger.warn(`Cloudinary destroy failed for media ${id}: ${err instanceof Error ? err.message : err}`);
    }

    await this.prisma.feedbackMedia.delete({ where: { id } });
  }
}
