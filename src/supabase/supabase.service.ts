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
}
