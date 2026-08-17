import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';
const REQUEST_TIMEOUT_MS = 10_000;

export interface RailwaySyncResult {
  synced: boolean;
  error?: string;
}

/**
 * Best-effort mirror of a freshly reconnected ClickUp token into Railway's
 * own CLICKUP_API_TOKEN variable, so the client (who has no Railway access
 * after handover) never needs an engineer to touch it. Self-activating,
 * same pattern as ClickupConnectionService's CLICKUP_API_TOKEN auto-connect
 * and CloudinaryService elsewhere in this app: a no-op until all four
 * RAILWAY_* env vars are set.
 *
 * Deliberately NOT the source of truth for whether ClickUp works - that's
 * the encrypted DB row (see ClickupConnectionService.upsertConnection),
 * updated synchronously before this ever runs. This is purely a
 * disaster-recovery convenience for the rare case the DB connection row
 * itself gets wiped, so it must never throw or block the real reconnect.
 */
@Injectable()
export class RailwayEnvSyncService {
  private readonly logger = new Logger(RailwayEnvSyncService.name);
  private readonly apiToken?: string;
  private readonly projectId?: string;
  private readonly environmentId?: string;
  private readonly serviceId?: string;

  constructor(config: ConfigService) {
    this.apiToken = config.get<string>('RAILWAY_API_TOKEN');
    this.projectId = config.get<string>('RAILWAY_PROJECT_ID');
    this.environmentId = config.get<string>('RAILWAY_ENVIRONMENT_ID');
    this.serviceId = config.get<string>('RAILWAY_SERVICE_ID');
  }

  isConfigured(): boolean {
    return Boolean(this.apiToken && this.projectId && this.environmentId && this.serviceId);
  }

  /**
   * Updates Railway's CLICKUP_API_TOKEN variable without triggering a
   * redeploy (skipDeploys: true) - the DB write already fixed ClickUp
   * live with zero downtime, so forcing a real backend restart here would
   * only add risk for real users with no functional benefit. This is
   * purely an insurance copy for the next time the process restarts for
   * any other reason.
   */
  async syncClickupToken(token: string): Promise<RailwaySyncResult> {
    if (!this.isConfigured()) {
      return { synced: false, error: 'Railway sync not configured' };
    }

    try {
      const res = await fetch(RAILWAY_API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'mutation($input: VariableUpsertInput!) { variableUpsert(input: $input) }',
          variables: {
            input: {
              projectId: this.projectId,
              environmentId: this.environmentId,
              serviceId: this.serviceId,
              name: 'CLICKUP_API_TOKEN',
              value: token,
              skipDeploys: true,
            },
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const body = await res.json().catch(() => null);
      if (!res.ok || body?.errors?.length) {
        const message = body?.errors?.[0]?.message ?? res.statusText;
        this.logger.warn(`Failed to sync ClickUp token to Railway: ${message}`);
        return { synced: false, error: message };
      }

      this.logger.log('Synced reconnected ClickUp token to Railway (no redeploy triggered).');
      return { synced: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.warn(`Failed to sync ClickUp token to Railway: ${message}`);
      return { synced: false, error: message };
    }
  }
}
