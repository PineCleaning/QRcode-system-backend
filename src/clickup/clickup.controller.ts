import { BadRequestException, Body, Controller, Get, NotFoundException, Post, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AdminUser } from '../../generated/prisma/client';
import { CurrentAdmin } from '../auth/current-admin.decorator';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { ClickupApiClient, type ClickupTeam } from './clickup-api.client';
import { ClickupConnectionService } from './clickup-connection.service';
import { ReconnectClickupDto } from './dto/reconnect-clickup.dto';
import { SetupClickupDto } from './dto/setup-clickup.dto';
import { RailwayEnvSyncService } from './railway-env-sync.service';

const DEFAULT_CLIENT_FIELD_NAME = 'CLIENT NAME';
const DEFAULT_REQUEST_DETAILS_FIELD_NAME = 'REQUEST DETAILS';
const DEFAULT_REQUEST_TYPE_FIELD_NAME = 'REQUEST TYPE';
const DEFAULT_REQUEST_TYPE_OPTION_NAME = 'Other';
const DEFAULT_COMPANY_CLIENT_ID_FIELD_NAME = 'CLIENT ID';

@Controller('clickup')
export class ClickupController {
  constructor(
    private readonly api: ClickupApiClient,
    private readonly connections: ClickupConnectionService,
    private readonly config: ConfigService,
    private readonly railwaySync: RailwayEnvSyncService,
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

    const fields = await this.api.getListFields(existing.accessToken, dto.ticketsListId);
    const findField = (name: string) => fields.find((f) => f.name.trim().toLowerCase() === name.trim().toLowerCase());

    const clientFieldName = dto.clientFieldName ?? DEFAULT_CLIENT_FIELD_NAME;
    const clientField = findField(clientFieldName);
    if (!clientField) {
      throw new BadRequestException(
        `No field named "${clientFieldName}" found on list ${dto.ticketsListId}. Found: ${fields.map((f) => f.name).join(', ') || '(none)'}`,
      );
    }

    const requestDetailsFieldName = dto.requestDetailsFieldName ?? DEFAULT_REQUEST_DETAILS_FIELD_NAME;
    const requestDetailsField = findField(requestDetailsFieldName);
    if (!requestDetailsField) {
      throw new BadRequestException(
        `No field named "${requestDetailsFieldName}" found on list ${dto.ticketsListId}. Found: ${fields.map((f) => f.name).join(', ') || '(none)'}`,
      );
    }

    const requestTypeFieldName = dto.requestTypeFieldName ?? DEFAULT_REQUEST_TYPE_FIELD_NAME;
    const requestTypeField = findField(requestTypeFieldName);
    if (!requestTypeField) {
      throw new BadRequestException(
        `No field named "${requestTypeFieldName}" found on list ${dto.ticketsListId}. Found: ${fields.map((f) => f.name).join(', ') || '(none)'}`,
      );
    }

    const requestTypeOptionName = dto.requestTypeOptionName ?? DEFAULT_REQUEST_TYPE_OPTION_NAME;
    const requestTypeOption = requestTypeField.type_config?.options?.find(
      (o) => o.name.trim().toLowerCase() === requestTypeOptionName.trim().toLowerCase(),
    );
    if (!requestTypeOption) {
      const available = requestTypeField.type_config?.options?.map((o) => o.name).join(', ') || '(none)';
      throw new BadRequestException(
        `No option named "${requestTypeOptionName}" found on field "${requestTypeField.name}". Found: ${available}`,
      );
    }

    // Best-effort, not required: if the Companies list has no CLIENT ID
    // field, matching just falls back to name-only (see
    // ClickupService.resolveClientEntityId) - don't block setup over it.
    const companyFields = await this.api.getListFields(existing.accessToken, dto.companiesListId);
    const companyClientIdFieldName = dto.companyClientIdFieldName ?? DEFAULT_COMPANY_CLIENT_ID_FIELD_NAME;
    const companyClientIdField = companyFields.find(
      (f) => f.name.trim().toLowerCase() === companyClientIdFieldName.trim().toLowerCase(),
    );

    const connection = await this.connections.setListConfig({
      workspaceId: existing.connection.workspaceId,
      ticketsListId: dto.ticketsListId,
      companiesListId: dto.companiesListId,
      clientFieldId: clientField.id,
      requestDetailsFieldId: requestDetailsField.id,
      requestTypeFieldId: requestTypeField.id,
      requestTypeOtherOptionId: requestTypeOption.id,
      companyClientIdFieldId: companyClientIdField?.id ?? null,
    });

    return {
      configured: true,
      ticketsListId: connection.ticketsListId,
      companiesListId: connection.companiesListId,
      clientFieldId: connection.clientFieldId,
      clientFieldName: clientField.name,
      requestDetailsFieldId: connection.requestDetailsFieldId,
      requestDetailsFieldName: requestDetailsField.name,
      requestTypeFieldId: connection.requestTypeFieldId,
      requestTypeFieldName: requestTypeField.name,
      requestTypeOtherOptionId: connection.requestTypeOtherOptionId,
      requestTypeOptionName: requestTypeOption.name,
      companyClientIdFieldId: connection.companyClientIdFieldId,
      companyClientIdFieldName: companyClientIdField?.name ?? null,
    };
  }

  /**
   * Unlike the other guarded routes here, this reads the latest
   * connection regardless of status (not just CONNECTED) - a
   * disconnected admin still needs to see *which* workspace and *why*,
   * to drive both the dashboard banner and the /settings/clickup guide.
   */
  @Get('status')
  @UseGuards(SupabaseAuthGuard)
  async status() {
    const connection = await this.connections.getLatestConnectionRecord();
    if (!connection) {
      return { connected: false, needsReconnect: false, railwaySyncConfigured: this.railwaySync.isConfigured() };
    }
    return {
      connected: connection.status === 'CONNECTED',
      needsReconnect: connection.status === 'RECONNECT_REQUIRED',
      workspaceId: connection.workspaceId,
      workspaceName: connection.workspaceName,
      status: connection.status,
      lastErrorMessage: connection.lastErrorMessage,
      disconnectedAt: connection.disconnectedAt,
      railwaySyncConfigured: this.railwaySync.isConfigured(),
      configured: Boolean(
        connection.ticketsListId &&
          connection.companiesListId &&
          connection.clientFieldId &&
          connection.requestDetailsFieldId &&
          connection.requestTypeFieldId &&
          connection.requestTypeOtherOptionId,
      ),
      ticketsListId: connection.ticketsListId,
      companiesListId: connection.companiesListId,
      clientFieldId: connection.clientFieldId,
      requestDetailsFieldId: connection.requestDetailsFieldId,
      requestTypeFieldId: connection.requestTypeFieldId,
      requestTypeOtherOptionId: connection.requestTypeOtherOptionId,
      companyClientIdFieldId: connection.companyClientIdFieldId,
    };
  }

  /**
   * Self-service recovery for the "personal token got revoked/regenerated
   * in ClickUp" case (ClickupAuthError flips the connection to
   * RECONNECT_REQUIRED elsewhere - see ClickupService.runClickupCall).
   * An admin regenerates a token in ClickUp and pastes it here instead of
   * an engineer editing Railway env vars. Validates the token actually
   * works and is authorized for the *same* workspace already on file
   * (never silently reconnects to a different workspace) before storing
   * it - reusing upsertConnection() flips status back to CONNECTED and
   * clears lastErrorMessage/disconnectedAt.
   */
  @Post('reconnect-token')
  @UseGuards(SupabaseAuthGuard)
  async reconnectToken(@Body() dto: ReconnectClickupDto, @CurrentAdmin() admin: AdminUser) {
    let teams: ClickupTeam[];
    try {
      teams = await this.api.getAuthorizedTeams(dto.token);
    } catch {
      throw new BadRequestException('That token was rejected by ClickUp - double-check you copied the whole thing.');
    }
    if (teams.length === 0) {
      throw new BadRequestException('That token is not authorized for any ClickUp workspace.');
    }

    const existing = await this.connections.getLatestConnectionRecord();
    const team = existing ? teams.find((t) => t.id === existing.workspaceId) : teams[0];
    if (!team) {
      const authorized = teams.map((t) => `${t.name} (${t.id})`).join(', ');
      throw new BadRequestException(
        `This token isn't authorized for the connected workspace (${existing?.workspaceName ?? existing?.workspaceId}). It's authorized for: ${authorized}. Make sure you generated it from the same ClickUp account.`,
      );
    }

    const connection = await this.connections.upsertConnection({
      workspaceId: team.id,
      workspaceName: team.name ?? null,
      accessToken: dto.token,
      connectedBy: admin.id,
    });

    // Best-effort - the DB write above already made ClickUp work again;
    // a Railway hiccup here must never fail this response (see
    // RailwayEnvSyncService's class comment for why this exists at all).
    const railway = await this.railwaySync.syncClickupToken(dto.token);

    return {
      connected: true,
      needsReconnect: false,
      workspaceId: connection.workspaceId,
      workspaceName: connection.workspaceName,
      railway,
    };
  }
}
