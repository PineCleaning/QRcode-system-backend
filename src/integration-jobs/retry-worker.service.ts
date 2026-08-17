import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ClickupService } from '../clickup/clickup.service';
import { IntegrationJobsService } from './integration-jobs.service';

const BATCH_SIZE = 20;

/**
 * Day 4 Hr 6: background retry/backoff for ClickUp ticket-creation jobs
 * that failed on their first (synchronous) attempt. Runs every minute -
 * cheap at this app's scale (a handful of clients), and simple beats a
 * more elaborate queue system nobody needs yet.
 *
 * Self-activating like the rest of the ClickUp integration: this will
 * genuinely retry and succeed once ClickUp is connected. Until then, a
 * seeded RETRYING job (see backend/CLAUDE.md for how this was tested)
 * just cycles through the same "not connected" failure, which is
 * expected and correct - retrying isn't itself broken.
 */
@Injectable()
export class RetryWorkerService {
  private readonly logger = new Logger(RetryWorkerService.name);

  constructor(
    private readonly jobs: IntegrationJobsService,
    private readonly clickup: ClickupService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async processRetries() {
    const due = await this.jobs.findDueRetries(BATCH_SIZE);
    if (due.length === 0) return;

    this.logger.log(`Retrying ${due.length} due ClickUp delivery job(s)`);

    for (const job of due) {
      const nextAttemptCount = job.attemptCount + 1;
      // True on exactly the first retry-worker-driven attempt for this job
      // - either right after the synchronous initial attempt failed
      // (attemptCount 1 -> 2) or right after a manual Retry-button reset
      // (attemptCount 0 -> 1). Guards against the case where a prior
      // attempt actually created the ClickUp ticket but we never found
      // out (a timeout right as it succeeded, a process crash between
      // ClickUp confirming and our own recordSuccess() write, etc.) -
      // reuses the same search-by-title-and-time-window lookup already
      // proven in FeedbackReconciliationService's stuck-job recovery,
      // instead of blindly calling createTicket() and risking a
      // duplicate. Deliberately scoped to just the first retry attempt,
      // not every one.
      const isFirstRetryAttempt = job.attemptCount <= 1;

      try {
        let clickupTaskId: string | null = null;

        if (isFirstRetryAttempt) {
          clickupTaskId = await this.clickup.findExistingTicketForFeedback(
            job.feedback.site.client.clientName,
            job.feedback.site.businessName,
            job.feedback.submittedAt,
          );
        }

        if (!clickupTaskId) {
          clickupTaskId = await this.clickup.createTicket({
            client: job.feedback.site.client,
            businessName: job.feedback.site.businessName,
            address: job.feedback.site.address,
            feedback: job.feedback.feedback,
            mobileNumber: job.feedback.mobileNumber,
            media: job.feedback.media
              .filter((m) => m.status === 'VERIFIED')
              .map((m) => ({ cloudinaryPublicId: m.cloudinaryPublicId, resourceType: m.resourceType })),
          });
        }

        await this.jobs.recordSuccess(job.id, job.feedbackId, clickupTaskId);
      } catch (err) {
        await this.jobs.recordFailure(job.id, job.feedbackId, nextAttemptCount, err);
      }
    }
  }
}
