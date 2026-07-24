import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ClickupConnection } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decryptToken, encryptToken } from './clickup-crypto.util';

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

@Injectable()
export class ClickupConnectionService {
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.encryptionKey = config.getOrThrow('CLICKUP_TOKEN_ENCRYPTION_KEY');
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
    connectedBy: string;
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
