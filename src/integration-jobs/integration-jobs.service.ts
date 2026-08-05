import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Minutes to wait before each retry, indexed by (failed attempt number - 1). Last entry repeats if somehow exceeded. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 180];
export const MAX_DELIVERY_ATTEMPTS = BACKOFF_MINUTES.length;

/**
 * Shared success/failure recording for ClickUp ticket-creation jobs,
 * used by both the synchronous first attempt (FeedbackService) and the
 * background RetryWorkerService (Day 4 Hr 6) - one place owns the
 * backoff schedule and the FeedbackStatus/IntegrationJobStatus
 * transitions, so the two callers can't drift out of sync.
 */
@Injectable()
export class IntegrationJobsService {
  private readonly logger = new Logger(IntegrationJobsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createInitialJob(feedbackId: string) {
    return this.prisma.integrationJob.create({
      data: { feedbackId, jobType: 'clickup_task_creation', status: 'PROCESSING', attemptCount: 1 },
    });
  }

  async recordSuccess(jobId: string, feedbackId: string, clickupTaskId: string) {
    await this.prisma.$transaction([
      this.prisma.integrationJob.update({
        where: { id: jobId },
        data: { status: 'SUCCEEDED', externalId: clickupTaskId },
      }),
      this.prisma.feedbackSubmission.update({
        where: { id: feedbackId },
        data: { status: 'DELIVERED', clickupTaskId, deliveredAt: new Date() },
      }),
    ]);
  }

  /** attemptCount = the attempt number that just failed (1-indexed). */
  async recordFailure(jobId: string, feedbackId: string, attemptCount: number, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = attemptCount >= MAX_DELIVERY_ATTEMPTS;

    if (exhausted) {
      this.logger.warn(`ClickUp delivery permanently failed for feedback ${feedbackId} after ${attemptCount} attempts: ${message}`);
      await this.prisma.$transaction([
        this.prisma.integrationJob.update({
          where: { id: jobId },
          data: { status: 'FAILED', attemptCount, lastError: message, nextAttemptAt: null },
        }),
        this.prisma.feedbackSubmission.update({ where: { id: feedbackId }, data: { status: 'DELIVERY_FAILED' } }),
      ]);
      return;
    }

    const delayMinutes = BACKOFF_MINUTES[attemptCount - 1] ?? BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1];
    const nextAttemptAt = new Date(Date.now() + delayMinutes * 60_000);

    this.logger.warn(
      `ClickUp delivery failed for feedback ${feedbackId} (attempt ${attemptCount}/${MAX_DELIVERY_ATTEMPTS}), retrying at ${nextAttemptAt.toISOString()}: ${message}`,
    );

    await this.prisma.$transaction([
      this.prisma.integrationJob.update({
        where: { id: jobId },
        data: { status: 'RETRYING', attemptCount, lastError: message, nextAttemptAt },
      }),
      this.prisma.feedbackSubmission.update({ where: { id: feedbackId }, data: { status: 'DELIVERY_PENDING' } }),
    ]);
  }

  /** Jobs due for a retry attempt right now. */
  async findDueRetries(limit: number) {
    return this.prisma.integrationJob.findMany({
      where: { status: 'RETRYING', nextAttemptAt: { lte: new Date() } },
      take: limit,
      include: {
        feedback: { include: { site: { include: { client: true } }, media: true } },
      },
    });
  }

  /**
   * Manual retry (admin "Feedbacks" page): only meaningful for a
   * permanently FAILED job - resets the attempt counter back to 0 and
   * marks it due immediately, so the very next EVERY_MINUTE tick of
   * RetryWorkerService picks it up and runs the exact same 5-attempt
   * backoff cycle from the start. No changes needed to the worker
   * itself - it already just looks for anything RETRYING and due.
   */
  async resetForRetry(feedbackId: string): Promise<void> {
    const job = await this.prisma.integrationJob.findFirst({
      where: { feedbackId, jobType: 'clickup_task_creation' },
      orderBy: { createdAt: 'desc' },
    });
    if (!job) {
      throw new NotFoundException(`No delivery job found for feedback ${feedbackId}`);
    }
    if (job.status !== 'FAILED') {
      throw new ConflictException('Only a permanently failed delivery can be retried');
    }

    await this.prisma.$transaction([
      this.prisma.integrationJob.update({
        where: { id: job.id },
        data: { status: 'RETRYING', attemptCount: 0, nextAttemptAt: new Date() },
      }),
      this.prisma.feedbackSubmission.update({ where: { id: feedbackId }, data: { status: 'DELIVERY_PENDING' } }),
    ]);
  }
}
