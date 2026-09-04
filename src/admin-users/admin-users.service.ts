import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
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

    if ((dto.role === 'SUPERVISOR' || dto.status === 'INACTIVE') && admin.role === 'ADMIN' && admin.status === 'ACTIVE') {
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
