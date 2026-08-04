import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ClickupConnection } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ClickupApiClient } from './clickup-api.client';
import { decryptToken, encryptToken } from './clickup-crypto.util';

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

@Injectable()
export class ClickupConnectionService implements OnModuleInit {
  private readonly logger = new Logger(ClickupConnectionService.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly api: ClickupApiClient,
    private readonly config: ConfigService,
  ) {
    this.encryptionKey = config.getOrThrow('CLICKUP_TOKEN_ENCRYPTION_KEY');
  }

  /**
   * Self-activating, same pattern as Cloudinary/ClickUp elsewhere in this
   * app: no-op until CLICKUP_API_TOKEN is set in .env, then connects
   * automatically on the next boot - no admin API call needed. Chosen
   * over the OAuth flow originally built (still present, unused) because
   * ClickUp's self-service "Create an App" OAuth registration wasn't
   * available in this workspace's dashboard; a personal API token is
   * ClickUp's own recommended path for a single-workspace integration
   * like this one anyway. Runs on every boot (idempotent upsert), so
   * rotating the token in .env and restarting is all that's needed to
   * pick up a new one.
   */
  async onModuleInit() {
    const token = this.config.get<string>('CLICKUP_API_TOKEN');
    if (!token) return;

    try {
      const teams = await this.api.getAuthorizedTeams(token);
      if (teams.length === 0) {
        this.logger.warn('CLICKUP_API_TOKEN is set but ClickUp returned no authorized workspace for it');
        return;
      }

      // A personal token can be valid for more than one workspace (e.g.
      // the admin's own personal workspace plus the business one) -
      // CLICKUP_WORKSPACE_ID pins which one to use rather than silently
      // picking whichever ClickUp's API happens to list first.
      const targetWorkspaceId = this.config.get<string>('CLICKUP_WORKSPACE_ID');
      const team = targetWorkspaceId ? teams.find((t) => t.id === targetWorkspaceId) : teams[0];
      if (!team) {
        this.logger.warn(
          `CLICKUP_WORKSPACE_ID=${targetWorkspaceId} not found among this token's authorized workspaces (${teams.map((t) => `${t.name} (${t.id})`).join(', ')})`,
        );
        return;
      }
      await this.upsertConnection({
        workspaceId: team.id,
        workspaceName: team.name ?? null,
        accessToken: token,
        connectedBy: null,
      });
      this.logger.log(`ClickUp connected via CLICKUP_API_TOKEN to workspace "${team.name}" (${team.id})`);
    } catch (err) {
      this.logger.warn(`Failed to auto-connect ClickUp from CLICKUP_API_TOKEN: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Signs a short-lived OAuth `state` value tied to the initiating admin, with no server-side session store needed. */
  signState(adminId: string): string {
    const payload = `${adminId}.${Date.now()}`;
    const signature = createHmac('sha256', this.encryptionKey).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  /** Verifies a `state` value produced by signState(); returns the admin id, or null if invalid/expired. */
  verifyState(state: string): string | null {
    const parts = state.split('.');
    if (parts.length !== 3) return null;
    const [adminId, tsStr, signature] = parts;
    const payload = `${adminId}.${tsStr}`;
    const expected = createHmac('sha256', this.encryptionKey).update(payload).digest('base64url');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }
    const ts = Number(tsStr);
    if (!Number.isFinite(ts) || Date.now() - ts > STATE_TTL_MS) {
      return null;
    }
    return adminId;
  }

  async upsertConnection(params: {
    workspaceId: string;
    workspaceName: string | null;
    accessToken: string;
    /** Null for a connection established automatically from CLICKUP_API_TOKEN, with no initiating admin. */
    connectedBy: string | null;
  }): Promise<ClickupConnection> {
    const encryptedAccessToken = encryptToken(params.accessToken, this.encryptionKey);
    return this.prisma.clickupConnection.upsert({
      where: { workspaceId: params.workspaceId },
      create: {
        workspaceId: params.workspaceId,
        workspaceName: params.workspaceName,
        encryptedAccessToken,
        status: 'CONNECTED',
        connectedBy: params.connectedBy,
      },
      update: {
        workspaceName: params.workspaceName,
        encryptedAccessToken,
        status: 'CONNECTED',
        connectedBy: params.connectedBy,
        connectedAt: new Date(),
      },
    });
  }

  async setListConfig(params: {
    workspaceId: string;
    ticketsListId: string;
    companiesListId: string;
    clientFieldId: string;
  }): Promise<ClickupConnection> {
    return this.prisma.clickupConnection.update({
      where: { workspaceId: params.workspaceId },
      data: {
        ticketsListId: params.ticketsListId,
        companiesListId: params.companiesListId,
        clientFieldId: params.clientFieldId,
      },
    });
  }

  /** Returns the single active connection (single-tenant - one workspace), fully configured. */
  async getReadyConnection(): Promise<{ connection: ClickupConnection; accessToken: string }> {
    const connection = await this.prisma.clickupConnection.findFirst({
      where: { status: 'CONNECTED' },
      orderBy: { connectedAt: 'desc' },
    });
    if (!connection) {
      throw new NotFoundException(
        'No ClickUp connection found. An admin needs to connect ClickUp via GET /clickup/oauth/authorize first.',
      );
    }
    if (!connection.ticketsListId || !connection.companiesListId || !connection.clientFieldId) {
      throw new NotFoundException(
        'ClickUp is connected but not fully configured. Call POST /clickup/setup with ticketsListId and companiesListId first.',
      );
    }
    return { connection, accessToken: decryptToken(connection.encryptedAccessToken, this.encryptionKey) };
  }

  async getAnyConnection(): Promise<{ connection: ClickupConnection; accessToken: string } | null> {
    const connection = await this.prisma.clickupConnection.findFirst({
      where: { status: 'CONNECTED' },
      orderBy: { connectedAt: 'desc' },
    });
    if (!connection) return null;
    return { connection, accessToken: decryptToken(connection.encryptedAccessToken, this.encryptionKey) };
  }
}
