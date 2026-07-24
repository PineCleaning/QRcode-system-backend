import { BadRequestException, Body, Controller, Get, NotFoundException, Post, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AdminUser } from '../../generated/prisma/client';
import { CurrentAdmin } from '../auth/current-admin.decorator';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { ClickupApiClient } from './clickup-api.client';
import { ClickupConnectionService } from './clickup-connection.service';
import { SetupClickupDto } from './dto/setup-clickup.dto';

const DEFAULT_CLIENT_FIELD_NAME = 'CLIENT NAME';

@Controller('clickup')
export class ClickupController {
  constructor(
    private readonly api: ClickupApiClient,
    private readonly connections: ClickupConnectionService,
    private readonly config: ConfigService,
  ) {}

  /** Step 1: admin calls this (guarded), gets a URL to send the browser to. */
  @Get('oauth/authorize')
  @UseGuards(SupabaseAuthGuard)
  authorize(@CurrentAdmin() admin: AdminUser) {
    const redirectUri = this.config.getOrThrow('CLICKUP_REDIRECT_URI');
    const state = this.connections.signState(admin.id);
    return { url: this.api.buildAuthorizeUrl(redirectUri, state) };
  }

  /** Step 2: ClickUp redirects the browser here after the admin approves access. Not guarded - ClickUp calls it directly; the signed `state` is the auth check. */
  @Get('oauth/callback')
  async callback(@Query('code') code?: string, @Query('state') state?: string) {
    if (!code || !state) {
      throw new BadRequestException('Missing code or state');
    }
    const adminId = this.connections.verifyState(state);
    if (!adminId) {
      throw new BadRequestException('Invalid or expired state - restart the connect flow from the admin portal');
    }

    const accessToken = await this.api.exchangeCodeForToken(code);
    const teams = await this.api.getAuthorizedTeams(accessToken);
    const team = teams[0];
    if (!team) {
      throw new BadRequestException('ClickUp did not return an authorized workspace for this token');
    }

    const connection = await this.connections.upsertConnection({
      workspaceId: team.id,
      workspaceName: team.name ?? null,
      accessToken,
      connectedBy: adminId,
    });

    return {
      connected: true,
      workspaceId: connection.workspaceId,
      workspaceName: connection.workspaceName,
      nextStep: connection.ticketsListId
        ? 'Already configured.'
        : 'Call POST /clickup/setup with ticketsListId and companiesListId to finish setup.',
    };
  }

  /** Step 3 (one-time, after connecting): resolve and cache list/field IDs. Never creates anything in ClickUp - only reads. */
  @Post('setup')
  @UseGuards(SupabaseAuthGuard)
  async setup(@Body() dto: SetupClickupDto) {
    const existing = await this.connections.getAnyConnection();
    if (!existing) {
      throw new NotFoundException('Connect ClickUp first via GET /clickup/oauth/authorize');
    }

    const fieldName = dto.clientFieldName ?? DEFAULT_CLIENT_FIELD_NAME;
    const fields = await this.api.getListFields(existing.accessToken, dto.ticketsListId);
    const clientField = fields.find((f) => f.name.trim().toLowerCase() === fieldName.trim().toLowerCase());
    if (!clientField) {
      throw new BadRequestException(
        `No field named "${fieldName}" found on list ${dto.ticketsListId}. Found: ${fields.map((f) => f.name).join(', ') || '(none)'}`,
      );
    }

    const connection = await this.connections.setListConfig({
      workspaceId: existing.connection.workspaceId,
      ticketsListId: dto.ticketsListId,
      companiesListId: dto.companiesListId,
      clientFieldId: clientField.id,
    });

    return {
      configured: true,
      ticketsListId: connection.ticketsListId,
      companiesListId: connection.companiesListId,
      clientFieldId: connection.clientFieldId,
      clientFieldName: clientField.name,
    };
  }

  @Get('status')
  @UseGuards(SupabaseAuthGuard)
  async status() {
    const existing = await this.connections.getAnyConnection();
    if (!existing) {
      return { connected: false };
    }
    const { connection } = existing;
    return {
      connected: true,
      workspaceId: connection.workspaceId,
      workspaceName: connection.workspaceName,
      status: connection.status,
      configured: Boolean(connection.ticketsListId && connection.companiesListId && connection.clientFieldId),
      ticketsListId: connection.ticketsListId,
      companiesListId: connection.companiesListId,
      clientFieldId: connection.clientFieldId,
    };
  }
}
