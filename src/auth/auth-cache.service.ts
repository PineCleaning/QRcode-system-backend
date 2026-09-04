import { Injectable } from '@nestjs/common';
import type { AdminUser } from '../../generated/prisma/client';

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  adminUser: AdminUser;
  expiresAt: number;
}

/**
 * Shared, app-wide cache backing SupabaseAuthGuard - extracted into its
 * own service (rather than a private field on the guard) so it can be
 * invalidated from elsewhere, specifically AdminUsersService, when a
 * user's role/status changes. Without this, a just-demoted or just-
 * deactivated user's already-cached token kept working with their OLD
 * permissions for up to CACHE_TTL_MS - confirmed as a real gap via a
 * live test (2026-09-02): a demoted ADMIN successfully created a client
 * with their pre-demotion cached token before this fix existed.
 *
 * AuthModule is @Global() specifically so every module gets the SAME
 * instance of this service (and of SupabaseAuthGuard) - before that
 * change, modules that didn't explicitly import AuthModule (admin-users,
 * admin-media, admin-feedback, csv-import) were resolving a separate
 * guard instance with its own independent cache, which also meant
 * invalidation from one place could never have reached requests routed
 * through those controllers.
 */
@Injectable()
export class AuthCacheService {
  private readonly cache = new Map<string, CacheEntry>();

  get(token: string): AdminUser | null {
    const entry = this.cache.get(token);
    if (entry && entry.expiresAt > Date.now()) {
      return entry.adminUser;
    }
    return null;
  }

  set(token: string, adminUser: AdminUser): void {
    this.cache.set(token, { adminUser, expiresAt: Date.now() + CACHE_TTL_MS });
    this.pruneExpired();
  }

  /** Called by AdminUsersService after any update - cheap and safe to call even when only fullName changed. */
  invalidateUser(userId: string): void {
    for (const [token, entry] of this.cache) {
      if (entry.adminUser.id === userId) {
        this.cache.delete(token);
      }
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }
}
