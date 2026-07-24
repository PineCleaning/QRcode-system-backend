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

  /** Verifies an access token against Supabase Auth and returns the user, or null if invalid. */
  async getUserFromToken(accessToken: string) {
    const { data, error } = await this.client.auth.getUser(accessToken);
    if (error || !data.user) {
      return null;
    }
    return data.user;
  }
}
