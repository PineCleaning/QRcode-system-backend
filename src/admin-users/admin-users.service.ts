import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { AuthCacheService } from '../auth/auth-cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateAdminUserDto } from './dto/create-admin-user.dto';
import { UpdateAdminUserDto } from './dto/update-admin-user.dto';

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
    private readonly authCache: AuthCacheService,
  ) {}

  findAll() {
    return this.prisma.adminUser.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, fullName: true, role: true, status: true, createdAt: true, lastLoginAt: true },
    });
  }

  /** Best-effort, called once right after a successful sign-in (see AuthController) - never blocks or fails the login itself. */
  async recordLogin(id: string) {
    await this.prisma.adminUser.update({ where: { id }, data: { lastLoginAt: new Date() } }).catch((err) => {
      this.logger.warn(`Failed to record last login for ${id}: ${err instanceof Error ? err.message : err}`);
    });
  }

  async findOne(id: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!admin) throw new NotFoundException('Admin user not found');
    return admin;
  }

  /**
   * Two-step creation (Supabase Auth account, then the admin_users
   * profile row) with rollback: if the DB insert fails after the Auth
   * account was already created, the just-created Auth account is
   * deleted so a failed create never leaves an orphaned Auth-only
   * account with no matching profile (which would otherwise be able to
   * get a valid session but fail every request, and couldn't be
   * recreated later without hitting a duplicate-email error).
   *
   * Password is system-generated (confirmed with the user 2026-09-01,
   * not admin-typed) - returned once in the response so the Admin can
   * copy/share it; never stored anywhere beyond this one response.
   */
  async create(dto: CreateAdminUserDto) {
    const existing = await this.prisma.adminUser.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }

    const password = generatePassword();
    const { id } = await this.supabase.createAuthUser(dto.email, password);

    try {
      const adminUser = await this.prisma.adminUser.create({
        data: { id, email: dto.email, fullName: dto.fullName, role: dto.role, status: 'ACTIVE' },
      });
      return { ...adminUser, temporaryPassword: password };
    } catch (err) {
      this.logger.warn(`admin_users insert failed after Auth account ${id} was created - rolling back: ${err instanceof Error ? err.message : err}`);
      await this.supabase.deleteAuthUser(id).catch((rollbackErr) => {
        // Rollback itself failing is a genuine orphan - logged loudly since
        // there's no further automatic recovery path for this case.
        this.logger.error(`Rollback failed - Auth account ${id} is now orphaned and needs manual cleanup: ${rollbackErr instanceof Error ? rollbackErr.message : rollbackErr}`);
      });
      throw err;
    }
  }

  async update(id: string, dto: UpdateAdminUserDto) {
    const admin = await this.findOne(id);

    // dto.role can never literally be 'ADMIN' (see UpdateAdminUserDto),
    // so any role value here is an attempted demotion - checked against
    // any of the three non-Admin roles, not just SUPERVISOR, now that
    // there are more than one.
    if ((dto.role !== undefined || dto.status === 'INACTIVE') && admin.role === 'ADMIN' && admin.status === 'ACTIVE') {
      await this.assertNotLastActiveAdmin(id);
    }

    const updated = await this.prisma.adminUser.update({
      where: { id },
      data: { fullName: dto.fullName, role: dto.role, status: dto.status },
    });

    // Without this, a just-demoted or just-deactivated user's already-
    // cached token keeps their OLD role/status for up to 30s (the
    // SupabaseAuthGuard cache TTL) - confirmed as a real gap via a live
    // test 2026-09-02 before this fix existed. Invalidated on every
    // update, not just role/status changes, since it's cheap and this
    // is the one place all three fields can change.
    this.authCache.invalidateUser(id);

    return updated;
  }

  /**
   * Overwrites the user's password immediately via Supabase's Admin API -
   * the old password stops working the instant this succeeds. No
   * confirmation step or "pending" state: matches the Create flow's
   * one-time-reveal pattern (generated, shown once, never stored as
   * plaintext anywhere) rather than a two-step generate-then-save that
   * would mean holding a plaintext password in the request/response
   * longer than necessary.
   */
  async resetPassword(id: string) {
    await this.findOne(id);
    const password = generatePassword();
    await this.supabase.updateUserPassword(id, password);
    return { temporaryPassword: password };
  }

  /**
   * Hard-deletes a user's admin_users row and their real Supabase Auth
   * login credential - used both by the manual Delete button and the
   * 21-days-inactive auto-delete cron (AdminUsersCleanupService), so
   * both directions can never drift apart on what "delete" actually
   * does, same philosophy as AdminFeedbackService.remove() being
   * shared between the dashboard delete button and the ClickUp
   * reconciliation cron.
   *
   * The Admin account can never be deleted this way, manually or
   * automatically - there is exactly one, permanently (also enforced
   * at the DB level by uq_admin_users_single_admin, but checked here
   * too so the error is a clear 403 rather than a generic failure).
   *
   * Auth-account deletion happens first, best-effort (logged, never
   * blocks) - same "best-effort external cleanup first, guaranteed DB
   * delete last" order AdminFeedbackService.remove() already uses for
   * ClickUp/Cloudinary. If the Auth deletion fails, the leftover
   * credential can never grant real access anyway once the admin_users
   * row is gone (SupabaseAuthGuard requires a matching row) - the only
   * downside is it needs manual cleanup in the Supabase dashboard.
   *
   * Idempotent by design (P2025 "record not found" is swallowed, not
   * thrown) - same "deleting something already gone is success, not an
   * error" philosophy as ClickupApiClient.deleteTicket. This matters
   * because remove() is reachable from two independent triggers (the
   * manual Delete button and the nightly auto-delete cron) that could
   * race on the same id, and a caller here only ever wants "this user
   * is gone" to be true, not "I personally performed the delete."
   */
  async remove(id: string): Promise<void> {
    const admin = await this.findOne(id);
    if (admin.role === 'ADMIN') {
      throw new ForbiddenException('The Admin account cannot be deleted.');
    }

    await this.supabase.deleteAuthUser(id).catch((err) => {
      this.logger.warn(`Failed to delete Supabase Auth account for ${id} - admin_users row will still be removed: ${err instanceof Error ? err.message : err}`);
    });

    try {
      await this.prisma.adminUser.delete({ where: { id } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        this.authCache.invalidateUser(id);
        return;
      }
      throw err;
    }

    this.authCache.invalidateUser(id);
  }

  /**
   * Non-Admin users who haven't logged in since `cutoff` - or who
   * never logged in at all and were created before `cutoff` - for the
   * 21-days-inactive auto-delete cron. 'role: not ADMIN' is the same
   * protection remove() itself already enforces, checked again here so
   * the Admin account is never even considered a candidate in the
   * first place.
   */
  findInactiveNonAdmin(cutoff: Date) {
    return this.prisma.adminUser.findMany({
      where: {
        role: { not: 'ADMIN' },
        OR: [{ lastLoginAt: { lt: cutoff } }, { lastLoginAt: null, createdAt: { lt: cutoff } }],
      },
      select: { id: true, email: true },
    });
  }

  /** Prevents demoting/deactivating the last active ADMIN, which would leave nobody able to manage users, clients, or deletions at all. */
  private async assertNotLastActiveAdmin(excludingId: string) {
    const otherActiveAdmins = await this.prisma.adminUser.count({
      where: { role: 'ADMIN', status: 'ACTIVE', id: { not: excludingId } },
    });
    if (otherActiveAdmins === 0) {
      throw new ForbiddenException('Cannot remove the last active Admin - promote another user to Admin first');
    }
  }
}

/** URL-safe, no ambiguous-character concerns since it's copy-pasted, not hand-typed. ~72 bits of entropy. */
function generatePassword(): string {
  return randomBytes(9).toString('base64url');
}
