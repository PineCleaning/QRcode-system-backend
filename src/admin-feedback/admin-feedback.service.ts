import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ClickupService } from '../clickup/clickup.service';
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
  private readonly logger = new Logger(AdminFeedbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
    private readonly integrationJobs: IntegrationJobsService,
    private readonly clickup: ClickupService,
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
          client: { select: { id: true, clientName: true, clientId: true } },
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

  /**
   * Two-way delete: removing a feedback submission from the dashboard also
   * deletes its ClickUp ticket (if any), and the reconciliation cron
   * (FeedbackReconciliationService) calls this same method when it finds
   * a ticket was deleted directly in ClickUp instead - either direction
   * ends up here, so both sides can never drift out of sync.
   *
   * ClickUp deletion and Cloudinary cleanup are both best-effort: a
   * failure on either (ClickUp not connected, an already-gone ticket, a
   * transient Cloudinary error) is logged and never blocks the local
   * delete - same non-blocking-external-failure pattern already used for
   * ClickUp sync and AdminMediaService.remove()'s Cloudinary cleanup.
   */
  async remove(id: string): Promise<void> {
    const feedback = await this.prisma.feedbackSubmission.findUnique({
      where: { id },
      include: { media: true },
    });
    if (!feedback) {
      throw new NotFoundException(`Feedback ${id} not found`);
    }

    if (feedback.clickupTaskId) {
      try {
        await this.clickup.deleteTicket(feedback.clickupTaskId);
      } catch (err) {
        this.logger.warn(
          `ClickUp ticket delete failed for feedback ${id} (task ${feedback.clickupTaskId}): ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    for (const media of feedback.media) {
      try {
        await this.cloudinary.destroy(media.cloudinaryPublicId, media.resourceType.toLowerCase() as 'image' | 'video');
      } catch (err) {
        this.logger.warn(`Cloudinary destroy failed for media ${media.id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Cascades feedback_media + integration_jobs (onDelete: Cascade in schema.prisma).
    await this.prisma.feedbackSubmission.delete({ where: { id } });
  }
}
