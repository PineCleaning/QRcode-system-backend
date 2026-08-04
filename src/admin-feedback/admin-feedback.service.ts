import { Injectable } from '@nestjs/common';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { IntegrationJobsService } from '../integration-jobs/integration-jobs.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Global feedback list for the admin "Feedbacks" page - every submission
 * across every client/site, optionally narrowed by clientCode/siteId. A
 * validly-formatted but nonexistent clientCode/siteId just yields zero
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

  /**
   * No page/pageSize -> unchanged full-array response. Either param
   * present -> paginated { data, total, page, pageSize } shape instead,
   * matching ClientsService.findAll's pattern.
   */
  async findAll(clientCode?: string, siteId?: string, page?: number, pageSize?: number) {
    const where = {
      ...(siteId && { siteId }),
      ...(clientCode && { site: { clientCode } }),
    };

    const withMediaUrls = <T extends { media: { status: string; cloudinaryPublicId: string; resourceType: string }[] }>(submission: T) => ({
      ...submission,
      media: submission.media.map((item) => ({
        ...item,
        url:
          item.status === 'VERIFIED'
            ? this.cloudinary.buildDeliveryUrl(item.cloudinaryPublicId, item.resourceType.toLowerCase() as 'image' | 'video')
            : null,
      })),
    });

    const include = {
      media: true,
      site: {
        select: {
          id: true,
          businessName: true,
          slug: true,
          client: { select: { id: true, name: true, clientId: true } },
        },
      },
    } as const;

    if (!page && !pageSize) {
      const submissions = await this.prisma.feedbackSubmission.findMany({
        where,
        orderBy: { submittedAt: 'desc' },
        include,
      });
      // Delivery URL is derived from cloud_name + public_id at read time,
      // never persisted - same pattern as SitesService.findFeedbackForSite.
      return submissions.map(withMediaUrls);
    }

    const currentPage = page ?? 1;
    const size = pageSize ?? 50;

    const [submissions, total] = await Promise.all([
      this.prisma.feedbackSubmission.findMany({
        where,
        orderBy: { submittedAt: 'desc' },
        include,
        skip: (currentPage - 1) * size,
        take: size,
      }),
      this.prisma.feedbackSubmission.count({ where }),
    ]);

    return { data: submissions.map(withMediaUrls), total, page: currentPage, pageSize: size };
  }

  /** Manually re-triggers delivery for a permanently FAILED submission (resets the 5-attempt cycle). */
  async retry(feedbackId: string): Promise<void> {
    await this.integrationJobs.resetForRetry(feedbackId);
  }
}
