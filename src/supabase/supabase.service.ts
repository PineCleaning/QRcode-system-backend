import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private readonly client: SupabaseClient;

  constructor(config: ConfigService) {
    this.client = createClient(config.getOrThrow('SUPABASE_URL'), config.getOrThrow('SUPABASE_SERVICE_KEY'), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Verifies an access token's signature locally against Supabase's cached
   * JWKS (this project uses asymmetric ES256 signing) instead of always
   * calling the Auth server the way getUser() does - measured ~1-2ms here
   * vs ~220-700ms for getUser(), on every cache-miss request in
   * SupabaseAuthGuard. Returns the verified claims (claims.sub is the
   * user id, the only field SupabaseAuthGuard actually needs) or null if
   * invalid/expired.
   */
  async getClaimsFromToken(accessToken: string) {
    const { data, error } = await this.client.auth.getClaims(accessToken);
    if (error || !data?.claims) {
      return null;
    }
    return data.claims;
  }

  /** Admin API - creates a real Supabase Auth account, pre-confirmed (no email-verification step). Used by AdminUsersService when provisioning a new admin/supervisor. */
  async createAuthUser(email: string, password: string): Promise<{ id: string }> {
    const { data, error } = await this.client.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data?.user) {
      throw new Error(error?.message ?? 'Failed to create Supabase Auth user');
    }
    return { id: data.user.id };
  }

  /** Admin API - rollback path: deletes an Auth account that was just created if the follow-up admin_users insert fails, so a failed create never leaves an orphaned Auth-only account. */
  async deleteAuthUser(id: string): Promise<void> {
    await this.client.auth.admin.deleteUser(id);
  }

  /** Admin API - overwrites a user's password immediately. Used by AdminUsersService.resetPassword; the old password stops working the instant this call succeeds. */
  async updateUserPassword(id: string, password: string): Promise<void> {
    const { error } = await this.client.auth.admin.updateUserById(id, { password });
    if (error) {
      throw new Error(error.message);
    }
  }
}
