import { Global, Module } from '@nestjs/common';
import { AdminUsersModule } from '../admin-users/admin-users.module';
import { AuthCacheService } from './auth-cache.service';
import { AuthController } from './auth.controller';
import { SupabaseAuthGuard } from './supabase-auth.guard';

/**
 * @Global() so every module gets the SAME SupabaseAuthGuard/AuthCacheService
 * instance regardless of whether it explicitly imports AuthModule - several
 * modules (admin-users, admin-media, admin-feedback, csv-import) didn't,
 * which meant they were resolving their own separate guard instance with
 * an independent cache. That's how a real gap slipped through: demoting a
 * user via AdminUsersService couldn't invalidate a cache entry created by
 * a different instance guarding a different controller. Confirmed and
 * fixed 2026-09-02.
 */
@Global()
@Module({
  imports: [AdminUsersModule],
  controllers: [AuthController],
  providers: [SupabaseAuthGuard, AuthCacheService],
  exports: [SupabaseAuthGuard, AuthCacheService],
})
export class AuthModule {}
