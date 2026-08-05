import { BadRequestException, Body, Controller, Get, NotFoundException, Post, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AdminUser } from '../../generated/prisma/client';
import { CurrentAdmin } from '../auth/current-admin.decorator';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { ClickupApiClient } from './clickup-api.client';
import { ClickupConnectionService } from './clickup-connection.service';
import { SetupClickupDto } from './dto/setup-clickup.dto';

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
}
