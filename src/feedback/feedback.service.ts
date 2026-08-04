import { Injectable, NotFoundException } from '@nestjs/common';
import { ClickupService } from '../clickup/clickup.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import {
  ALLOWED_IMAGE_FORMATS,
  ALLOWED_VIDEO_FORMATS,
  formatMb,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  MAX_VIDEO_BYTES,
  MAX_VIDEOS_PER_SUBMISSION,
} from '../cloudinary/media-limits';
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
    const rejectionReasons: (string | null)[] = [];
    let totalVerifiedBytes = 0;
    let verifiedVideoCount = 0;

    for (const item of dto.media ?? []) {
      const resourceTypeLower = item.resourceType.toLowerCase() as 'image' | 'video';
      // Trust nothing the client claimed about the file beyond its
      // public_id - verifyResource() fetches the real format/bytes from
      // Cloudinary itself, which is what every check below runs against.
      const resource = await this.cloudinary.verifyResource(item.cloudinaryPublicId, resourceTypeLower);

      let reason: string | null = null;
      if (!resource) {
        reason = 'Could not verify this file. Please try uploading it again.';
      } else if (resourceTypeLower === 'image' && !ALLOWED_IMAGE_FORMATS.includes(resource.format)) {
        reason = 'Unsupported photo format. Use JPEG, PNG, WebP, HEIC, or HEIF.';
      } else if (resourceTypeLower === 'video' && !ALLOWED_VIDEO_FORMATS.includes(resource.format)) {
        reason = 'Unsupported video format. Use MP4, MOV, or WebM.';
      } else if (resourceTypeLower === 'image' && resource.bytes > MAX_IMAGE_BYTES) {
        reason = `Photo is too large (max ${formatMb(MAX_IMAGE_BYTES)}).`;
      } else if (resourceTypeLower === 'video' && resource.bytes > MAX_VIDEO_BYTES) {
        reason = `Video is too large (max ${formatMb(MAX_VIDEO_BYTES)}).`;
      } else if (resourceTypeLower === 'video' && verifiedVideoCount >= MAX_VIDEOS_PER_SUBMISSION) {
        reason = 'Only one video can be attached per submission.';
      } else if (totalVerifiedBytes + resource.bytes > MAX_TOTAL_BYTES) {
        reason = `Attachments exceed the ${formatMb(MAX_TOTAL_BYTES)} total limit for this submission.`;
      }

      if (!reason && resource) {
        totalVerifiedBytes += resource.bytes;
        if (resourceTypeLower === 'video') verifiedVideoCount += 1;
      }

      rejectionReasons.push(reason);
      mediaCreates.push({
        cloudinaryPublicId: item.cloudinaryPublicId,
        resourceType: item.resourceType,
        originalFilename: item.originalFilename ?? null,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        status: reason ? ('REJECTED' as const) : ('VERIFIED' as const),
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

    const final = await this.prisma.feedbackSubmission.findUniqueOrThrow({
      where: { id: submission.id },
      include: { media: true },
    });

    // rejectionReason is deliberately not a DB column (schema v1.5 only
    // has PENDING/VERIFIED/REJECTED status) - it's attached here purely
    // so the public form's immediate response can show a specific
    // message instead of a silent drop. Prisma's nested create preserves
    // input array order, so index-zipping against rejectionReasons is
    // safe for this one response.
    return {
      ...final,
      media: final.media.map((m, i) => ({ ...m, rejectionReason: rejectionReasons[i] ?? null })),
    };
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
    site: { businessName: string; client: { name: string; clickupEntityId: string | null } },
  ) {
    const job = await this.integrationJobs.createInitialJob(feedbackId);

    try {
      const clickupTaskId = await this.clickup.createTicket({
        clientName: site.client.name,
        clientEntityId: site.client.clickupEntityId,
        businessName: site.businessName,
        feedback,
        mobileNumber,
      });
      await this.integrationJobs.recordSuccess(job.id, feedbackId, clickupTaskId);
    } catch (err) {
      await this.integrationJobs.recordFailure(job.id, feedbackId, job.attemptCount, err);
    }
  }
}
