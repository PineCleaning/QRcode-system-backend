import { Injectable, NotFoundException } from '@nestjs/common';
import { ClickupService } from '../clickup/clickup.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { IntegrationJobsService } from '../integration-jobs/integration-jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateFeedbackDto } from './dto/create-feedback.dto';

interface FeedbackMediaCreateData {
  cloudinaryPublicId: string;
  resourceType: 'IMAGE' | 'VIDEO';
  originalFilename: string | null;
  mimeType: string;
  sizeBytes: number;
  status: 'VERIFIED' | 'REJECTED';
}

@Injectable()
export class FeedbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clickup: ClickupService,
    private readonly cloudinary: CloudinaryService,
    private readonly integrationJobs: IntegrationJobsService,
  ) {}

  async submit(slug: string, dto: CreateFeedbackDto) {
    const site = await this.prisma.site.findUnique({ where: { slug }, include: { client: true } });

    // Deliberately generic message - don't reveal whether a slug is
    // unknown vs. deactivated. Per Day 4 Hr 5: an inactive site/client
    // must never create a submission or a ticket, either.
    if (!site || site.status !== 'ACTIVE' || site.client.status !== 'ACTIVE') {
      throw new NotFoundException('This QR code is not currently active.');
    }

    const existing = await this.prisma.feedbackSubmission.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
      include: { media: true },
    });
    if (existing) {
      // Idempotent replay: a client-side retry gets the original result,
      // not an error and not a second submission/ticket.
      return existing;
    }

    const mediaCreates: FeedbackMediaCreateData[] = [];
    for (const item of dto.media ?? []) {
      const resourceTypeLower = item.resourceType.toLowerCase() as 'image' | 'video';
      const verified = await this.cloudinary.verifyResource(item.cloudinaryPublicId, resourceTypeLower);
      mediaCreates.push({
        cloudinaryPublicId: item.cloudinaryPublicId,
        resourceType: item.resourceType,
        originalFilename: item.originalFilename ?? null,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        status: verified ? ('VERIFIED' as const) : ('REJECTED' as const),
      });
    }

    const submission = await this.prisma.feedbackSubmission.create({
      data: {
        siteId: site.id,
        idempotencyKey: dto.idempotencyKey,
        feedback: dto.feedback,
        mobileNumber: dto.mobileNumber ?? null,
        status: 'SUBMITTED',
        media: { create: mediaCreates },
      },
      include: { media: true },
    });

    await this.deliverToClickup(submission.id, submission.feedback, submission.mobileNumber, site);

    return this.prisma.feedbackSubmission.findUniqueOrThrow({
      where: { id: submission.id },
      include: { media: true },
    });
  }

  /**
   * First delivery attempt, made synchronously within the request. A
   * failure here never throws back out to submit() - the feedback is
   * already saved regardless. If retries remain, IntegrationJobsService
   * schedules one and the background RetryWorkerService (Day 4 Hr 6)
   * picks it up later - this method doesn't wait for that.
   */
  private async deliverToClickup(
    feedbackId: string,
    feedback: string,
    mobileNumber: string | null,
    site: { siteName: string; client: { name: string; clickupEntityId: string | null } },
  ) {
    const job = await this.integrationJobs.createInitialJob(feedbackId);

    try {
      const clickupTaskId = await this.clickup.createTicket({
        clientName: site.client.name,
        clientEntityId: site.client.clickupEntityId,
        siteName: site.siteName,
        feedback,
        mobileNumber,
      });
      await this.integrationJobs.recordSuccess(job.id, feedbackId, clickupTaskId);
    } catch (err) {
      await this.integrationJobs.recordFailure(job.id, feedbackId, job.attemptCount, err);
    }
  }
}
