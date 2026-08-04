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
      try {
        const clickupTaskId = await this.clickup.createTicket({
          clientName: job.feedback.site.client.name,
          clientEntityId: job.feedback.site.client.clickupEntityId,
          businessName: job.feedback.site.businessName,
          feedback: job.feedback.feedback,
          mobileNumber: job.feedback.mobileNumber,
        });
        await this.jobs.recordSuccess(job.id, job.feedbackId, clickupTaskId);
      } catch (err) {
        await this.jobs.recordFailure(job.id, job.feedbackId, nextAttemptCount, err);
      }
    }
  }
}
