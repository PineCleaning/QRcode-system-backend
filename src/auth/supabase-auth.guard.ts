import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import type { AdminUser } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';

export interface AuthenticatedRequest extends Request {
  adminUser: AdminUser;
}

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  adminUser: AdminUser;
  expiresAt: number;
}

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  /**
   * Every guarded request used to pay two full network round-trips
   * before doing any real work: a call to Supabase Auth's getUser()
   * (~200-300ms) plus a DB lookup for the matching admin_users row
   * (~250-300ms, this project's baseline DB round-trip time) - ~500ms
   * of fixed tax on every single admin API call, even hitting the same
   * page twice in a row with the same still-valid token. Caching the
   * validated result per-token for a short window collapses that to
   * one in-memory lookup for the common case (an admin clicking around
   * the portal) without meaningfully weakening security: 30s is short
   * enough that a revoked/expired token or a deactivated admin is
   * caught almost immediately, and this is a low-traffic internal tool,
   * not a public API where that window matters much.
   *
   * inFlight dedupes concurrent cache-miss lookups for the same token:
   * every admin page in this app fires several parallel requests at
   * once (Clients/Feedback/Assets all Promise.all several endpoints),
   * all carrying the same bearer token. Without this, N simultaneous
   * requests landing before the first one populates the cache would
   * each independently pay the full Supabase+DB verification cost;
   * with it, they share one real verification and the rest just await
   * the same in-flight promise.
   */
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<AdminUser>>();

  constructor(
    private readonly supabase: SupabaseService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const cached = this.cache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
      request.adminUser = cached.adminUser;
      return true;
    }

    let pending = this.inFlight.get(token);
    if (!pending) {
      // Chaining .finally() returns a *new* promise - if it isn't the
      // one stored/awaited, a rejection from verifyToken() produces an
      // untracked floating promise that Node reports as an unhandled
      // rejection and crashes the process. Storing the .finally()
      // result itself (not the bare verifyToken() promise) means the
      // only promise anyone ever awaits is the one whose rejection is
      // actually handled by every caller's `await pending` below.
      pending = this.verifyToken(token).finally(() => this.inFlight.delete(token));
      this.inFlight.set(token, pending);
    }

    request.adminUser = await pending;
    return true;
  }

  /** The actual Supabase + DB verification, shared by all concurrent callers via inFlight. */
  private async verifyToken(token: string): Promise<AdminUser> {
    const supabaseUser = await this.supabase.getUserFromToken(token);
    if (!supabaseUser) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const adminUser = await this.prisma.adminUser.findUnique({ where: { id: supabaseUser.id } });
    if (!adminUser || adminUser.status !== 'ACTIVE') {
      throw new UnauthorizedException('Not an active admin user');
    }

    this.cache.set(token, { adminUser, expiresAt: Date.now() + CACHE_TTL_MS });
    this.pruneExpired();
    return adminUser;
  }

  /** Tokens rotate (Supabase refresh) and old ones are never reused again - without this the map would grow forever over a long-running process. Runs on every cache miss, which is cheap at this app's scale. */
  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }

  private extractToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return null;
    }
    return header.slice('Bearer '.length).trim() || null;
  }
}
