import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ClickupService } from '../clickup/clickup.service';
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
 */
@Injectable()
export class FeedbackReconciliationService {
  private readonly logger = new Logger(FeedbackReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clickup: ClickupService,
    private readonly adminFeedback: AdminFeedbackService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async reconcile() {
    if (!(await this.clickup.isConnected())) return;

    const delivered = await this.prisma.feedbackSubmission.findMany({
      where: { status: 'DELIVERED', clickupTaskId: { not: null } },
      select: { id: true, clickupTaskId: true },
    });
    if (delivered.length === 0) return;

    let removedCount = 0;
    for (const feedback of delivered) {
      try {
        const exists = await this.clickup.ticketExists(feedback.clickupTaskId!);
        if (!exists) {
          await this.adminFeedback.remove(feedback.id);
          removedCount++;
        }
      } catch (err) {
        // A transient API error on one row shouldn't abort the rest of the
        // batch - it's simply re-checked on the next run.
        this.logger.warn(
          `Reconciliation check failed for feedback ${feedback.id} (task ${feedback.clickupTaskId}): ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (removedCount > 0) {
      this.logger.log(`Reconciliation: removed ${removedCount} feedback record(s) whose ClickUp ticket was deleted externally`);
    }
  }
}
