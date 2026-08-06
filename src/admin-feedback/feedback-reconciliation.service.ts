import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ClickupService } from '../clickup/clickup.service';
import { IntegrationJobsService } from '../integration-jobs/integration-jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminFeedbackService } from './admin-feedback.service';

/**
 * ClickUp -> Dashboard direction of the two-way feedback/ticket sync (the
 * other direction, Dashboard -> ClickUp, is AdminFeedbackController's
 * DELETE :id, which calls the same AdminFeedbackService.remove() this
 * cron ends up calling too - either direction always goes through one
 * place, so the two sides can't drift apart).
 *
 * There's no ClickUp webhook here on purpose: a webhook needs a publicly
 * reachable HTTPS endpoint (fine on Railway, not locally without a
 * tunnel) plus signature verification - real extra surface for a problem
 * a cheap periodic check already solves. ClickUp's rate limit is a
 * rolling 100 req/min per token, not a daily quota, so checking every
 * DELIVERED feedback's ticket every 10 minutes never "runs out" - at
 * this app's real scale (low hundreds of delivered feedback rows even
 * at a mature pilot) that's a handful of requests/min, nowhere near the
 * limit.
 *
 * Also covers a second, real gap found in production 2026-08-06: a
 * feedback submission whose ClickUp API call actually succeeded, but
 * something (a dropped client connection, a deploy, a process restart)
 * interrupted the request before the DB write recording that success
 * ran - leaving feedback_submissions.status stuck at SUBMITTED with no
 * clickup_task_id, and its integration_jobs row stuck at PROCESSING
 * forever (not RETRYING, so RetryWorkerService's findDueRetries() never
 * sees it either). See reconcileStuckSubmissions() below.
 */
const BATCH_SIZE = 15;
/**
 * A normal synchronous delivery attempt takes at most a few seconds -
 * this is long enough that any genuinely-still-in-flight request has
 * certainly finished (success or failure) by the time reconciliation
 * looks at it, so a still-PROCESSING job this old is a real stuck job,
 * not a race with an active request.
 */
const STUCK_THRESHOLD_MS = 5 * 60_000;

@Injectable()
export class FeedbackReconciliationService {
  private readonly logger = new Logger(FeedbackReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clickup: ClickupService,
    private readonly adminFeedback: AdminFeedbackService,
    private readonly integrationJobs: IntegrationJobsService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async reconcile() {
    if (!(await this.clickup.isConnected())) return;

    await this.reconcileDeliveredTickets();
    await this.reconcileStuckSubmissions();
  }

  /** ClickUp -> Dashboard: a DELIVERED feedback whose ticket was deleted directly in ClickUp gets removed locally too. */
  private async reconcileDeliveredTickets() {
    const delivered = await this.prisma.feedbackSubmission.findMany({
      where: { status: 'DELIVERED', clickupTaskId: { not: null } },
      select: { id: true, clickupTaskId: true },
    });
    if (delivered.length === 0) return;

    // Concurrency-capped batches rather than all-at-once or one-at-a-time -
    // still comfortably under ClickUp's rolling 100 req/min limit even as
    // feedback volume grows, without the linear wall-clock cost of a
    // strictly sequential loop.
    let removedCount = 0;
    for (let i = 0; i < delivered.length; i += BATCH_SIZE) {
      const batch = delivered.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((feedback) => this.checkAndReconcile(feedback)));
      removedCount += results.filter(Boolean).length;
    }

    if (removedCount > 0) {
      this.logger.log(`Reconciliation: removed ${removedCount} feedback record(s) whose ClickUp ticket was deleted externally`);
    }
  }

  /**
   * Never throws - a transient failure on one row is logged and treated as
   * "not removed", not a rejection, so it can't abort the rest of its
   * Promise.all batch. Returns true only if this feedback's ticket was
   * confirmed deleted and the local record was removed.
   */
  private async checkAndReconcile(feedback: { id: string; clickupTaskId: string | null }): Promise<boolean> {
    try {
      const exists = await this.clickup.ticketExists(feedback.clickupTaskId!);
      if (!exists) {
        await this.adminFeedback.remove(feedback.id);
        return true;
      }
      return false;
    } catch (err) {
      this.logger.warn(
        `Reconciliation check failed for feedback ${feedback.id} (task ${feedback.clickupTaskId}): ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  /**
   * A feedback stuck at SUBMITTED with its delivery job stuck at
   * PROCESSING: search ClickUp for a ticket that may already exist
   * (adopt it if found, exactly-one-match only) rather than trusting our
   * own possibly-incomplete record; only attempt a real delivery if no
   * matching ticket exists at all, so a genuinely-interrupted-before-
   * ClickUp-was-ever-called submission still gets delivered instead of
   * staying stuck forever.
   */
  private async reconcileStuckSubmissions() {
    const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);
    const stuck = await this.prisma.feedbackSubmission.findMany({
      where: {
        status: 'SUBMITTED',
        integrationJobs: { some: { status: 'PROCESSING', createdAt: { lt: cutoff } } },
      },
      include: {
        integrationJobs: { where: { status: 'PROCESSING' }, orderBy: { createdAt: 'desc' }, take: 1 },
        site: { include: { client: true } },
        media: true,
      },
    });
    if (stuck.length === 0) return;

    let adoptedCount = 0;
    let retriedCount = 0;
    for (let i = 0; i < stuck.length; i += BATCH_SIZE) {
      const batch = stuck.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((feedback) => this.recoverStuckSubmission(feedback)));
      adoptedCount += results.filter((r) => r === 'adopted').length;
      retriedCount += results.filter((r) => r === 'retried').length;
    }

    if (adoptedCount > 0 || retriedCount > 0) {
      this.logger.log(
        `Reconciliation: recovered ${adoptedCount} stuck submission(s) with an already-existing ClickUp ticket, attempted delivery for ${retriedCount} more that genuinely never got one`,
      );
    }
  }

  private async recoverStuckSubmission(feedback: {
    id: string;
    feedback: string;
    mobileNumber: string | null;
    submittedAt: Date;
    integrationJobs: { id: string; attemptCount: number }[];
    site: { businessName: string; address: string | null; client: { id: string; clientId: string; clientName: string; clickupEntityId: string | null } };
    media: { cloudinaryPublicId: string; resourceType: 'IMAGE' | 'VIDEO'; status: string }[];
  }): Promise<'adopted' | 'retried' | 'skipped'> {
    const job = feedback.integrationJobs[0];
    if (!job) return 'skipped'; // shouldn't happen given the query filter, but never assume

    try {
      const existingTicketId = await this.clickup.findExistingTicketForFeedback(
        feedback.site.client.clientName,
        feedback.site.businessName,
        feedback.submittedAt,
      );

      if (existingTicketId) {
        await this.integrationJobs.recordSuccess(job.id, feedback.id, existingTicketId);
        this.logger.log(`Reconciliation: adopted existing ClickUp ticket ${existingTicketId} for stuck feedback ${feedback.id}`);
        return 'adopted';
      }

      // No matching ticket found - it genuinely never got created (e.g.
      // the process died before ever calling ClickUp's API), safe to
      // actually attempt delivery now via the same path RetryWorkerService
      // uses for a normal retry.
      const nextAttemptCount = job.attemptCount + 1;
      try {
        const clickupTaskId = await this.clickup.createTicket({
          client: feedback.site.client,
          businessName: feedback.site.businessName,
          address: feedback.site.address,
          feedback: feedback.feedback,
          mobileNumber: feedback.mobileNumber,
          media: feedback.media
            .filter((m) => m.status === 'VERIFIED')
            .map((m) => ({ cloudinaryPublicId: m.cloudinaryPublicId, resourceType: m.resourceType })),
        });
        await this.integrationJobs.recordSuccess(job.id, feedback.id, clickupTaskId);
      } catch (err) {
        await this.integrationJobs.recordFailure(job.id, feedback.id, nextAttemptCount, err);
      }
      return 'retried';
    } catch (err) {
      this.logger.warn(`Reconciliation: failed to recover stuck feedback ${feedback.id}: ${err instanceof Error ? err.message : err}`);
      return 'skipped';
    }
  }
}
