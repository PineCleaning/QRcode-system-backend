import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import type { AdminUser } from '../../generated/prisma/client';
import { AdminUsersService } from '../admin-users/admin-users.service';
import { CurrentAdmin } from './current-admin.decorator';
import { UpdateOwnProfileDto } from './dto/update-own-profile.dto';
import { SupabaseAuthGuard } from './supabase-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly adminUsers: AdminUsersService) {}

  @Get('me')
  @UseGuards(SupabaseAuthGuard)
  me(@CurrentAdmin() adminUser: AdminUser) {
    return adminUser;
  }

  /**
   * Self-service profile edit - deliberately separate from
   * AdminUsersController's PATCH /admin-users/:id (Admin-only, manages
   * OTHER users). This one has no role restriction and always acts on
   * the caller's own id, never an :id param - so a Supervisor can edit
   * their own name without needing any elevated access, while "manage
   * someone else" stays fully gated. Reuses AdminUsersService.update()
   * so this gets the same auth-cache invalidation for free.
   */
  @Patch('me')
  @UseGuards(SupabaseAuthGuard)
  updateMe(@CurrentAdmin() adminUser: AdminUser, @Body() dto: UpdateOwnProfileDto) {
    return this.adminUsers.update(adminUser.id, { fullName: dto.fullName });
  }

  /**
   * Called once by the frontend login Server Action, right after
   * `signInWithPassword` succeeds (login itself is a direct
   * Supabase Auth call and never touches this backend otherwise).
   * Powers User Management's "Last Login" column. Best-effort on the
   * service side - never blocks login if it fails.
   */
  @Post('record-login')
  @UseGuards(SupabaseAuthGuard)
  async recordLogin(@CurrentAdmin() adminUser: AdminUser) {
    await this.adminUsers.recordLogin(adminUser.id);
    return { ok: true };
  }
}
