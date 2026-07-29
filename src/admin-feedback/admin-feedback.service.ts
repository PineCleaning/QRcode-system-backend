import { Injectable } from '@nestjs/common';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { IntegrationJobsService } from '../integration-jobs/integration-jobs.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Global feedback list for the admin "Feedbacks" page - every submission
 * across every client/site, optionally narrowed by clientId/siteId. A
 * validly-formatted but nonexistent clientId/siteId just yields zero
 * matching rows (200 []), not a 404 - the real UI only ever sends ids
 * sourced from GET /clients / GET /clients/:id/sites, so there's no
 * legitimate path to a "does this id exist" question here, and no code
 * path in this service throws.
 */
@Injectable()
export class AdminFeedbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
    private readonly integrationJobs: IntegrationJobsService,
  ) {}

  async findAll(clientId?: string, siteId?: string) {
    const submissions = await this.prisma.feedbackSubmission.findMany({
      where: {
        ...(siteId && { siteId }),
        ...(clientId && { site: { clientId } }),
      },
      orderBy: { submittedAt: 'desc' },
      include: {
        media: true,
        site: {
          select: {
            id: true,
            siteName: true,
            slug: true,
            client: { select: { id: true, name: true, clientCode: true } },
          },
        },
      },
    });

    // Delivery URL is derived from cloud_name + public_id at read time,
    // never persisted - same pattern as SitesService.findFeedbackForSite.
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

  /** Manually re-triggers delivery for a permanently FAILED submission (resets the 5-attempt cycle). */
  async retry(feedbackId: string): Promise<void> {
    await this.integrationJobs.resetForRetry(feedbackId);
  }
}
