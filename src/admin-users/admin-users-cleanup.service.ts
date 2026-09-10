import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AdminUsersService } from './admin-users.service';

/** Confirmed with the user 2026-09-10: based on last login, not deactivation status - a user who's never logged in at all falls back to their created_at. */
const INACTIVITY_DAYS = 21;

/**
 * Auto-deletes any non-Admin user (Supervisor/Manager/Admin Support)
 * who hasn't logged in for 21+ days - or never logged in at all and
 * was created 21+ days ago. Runs daily; cheap at this app's real
 * scale, same reasoning as RetryWorkerService running every minute.
 *
 * The Admin account can never be a candidate - AdminUsersService both
 * excludes it from the query and would refuse to remove() it anyway,
 * so this is defense-in-depth, not the only thing standing between a
 * quiet cron and deleting the one Admin account.
 *
 * Each user is deleted independently (try/catch per row) so one
 * failure doesn't block the rest of the batch - same per-row
 * resilience philosophy as CSV bulk import.
 */
@Injectable()
export class AdminUsersCleanupService {
  private readonly logger = new Logger(AdminUsersCleanupService.name);

  constructor(private readonly adminUsers: AdminUsersService) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async removeInactiveUsers() {
    const cutoff = new Date(Date.now() - INACTIVITY_DAYS * 24 * 60 * 60 * 1000);
    const candidates = await this.adminUsers.findInactiveNonAdmin(cutoff);
    if (candidates.length === 0) return;

    this.logger.log(`Auto-deleting ${candidates.length} user(s) inactive for ${INACTIVITY_DAYS}+ days`);

    for (const user of candidates) {
      try {
        await this.adminUsers.remove(user.id);
        this.logger.log(`Auto-deleted inactive user ${user.email} (${user.id})`);
      } catch (err) {
        this.logger.warn(`Failed to auto-delete inactive user ${user.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
