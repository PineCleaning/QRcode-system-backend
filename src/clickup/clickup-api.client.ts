import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';

export interface ClickupField {
  id: string;
  name: string;
  type: string;
}

export interface ClickupTeam {
  id: string;
  name: string;
}

export interface ClickupCustomFieldValue {
  id: string;
  value: unknown;
}

export interface ClickupTaskPayload {
  name?: string;
  description?: string;
  status?: string;
  custom_fields?: ClickupCustomFieldValue[];
}

/**
 * Thin wrapper around the raw ClickUp REST API (v2). No business logic here -
 * that lives in ClickupService. Never creates Lists/Folders/Spaces/custom
 * fields - only reads and writes to structure that already exists.
 */
@Injectable()
export class ClickupApiClient {
  private readonly clientId: string;
  private readonly clientSecret: string;

  /**
   * Optional, not getOrThrow: this app now primarily connects via a
   * personal API token (buildAuthorizeUrl/exchangeCodeForToken below
   * are unused in that flow) - requiring an OAuth app's client
   * id/secret to even boot would be a pointless hard dependency on a
   * path this single-workspace deployment doesn't use.
   */
  constructor(config: ConfigService) {
    this.clientId = config.get('CLICKUP_CLIENT_ID') ?? '';
    this.clientSecret = config.get('CLICKUP_CLIENT_SECRET') ?? '';
  }

  buildAuthorizeUrl(redirectUri: string, state: string): string {
    const url = new URL('https://app.clickup.com/api');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCodeForToken(code: string): Promise<string> {
    const res = await fetch(`${CLICKUP_API_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, code }),
    });
    const body = await this.parseJson(res, 'exchange code for token');
    if (!body.access_token) {
      throw new InternalServerErrorException('ClickUp did not return an access token');
    }
    return body.access_token as string;
  }

  async getAuthorizedTeams(accessToken: string): Promise<ClickupTeam[]> {
    const res = await fetch(`${CLICKUP_API_BASE}/team`, {
      headers: this.authHeaders(accessToken),
    });
    const body = await this.parseJson(res, 'fetch authorized teams');
    return (body.teams ?? []) as ClickupTeam[];
  }

  async getListFields(accessToken: string, listId: string): Promise<ClickupField[]> {
    const res = await fetch(`${CLICKUP_API_BASE}/list/${listId}/field`, {
      headers: this.authHeaders(accessToken),
    });
    const body = await this.parseJson(res, `fetch fields for list ${listId}`);
    return (body.fields ?? []) as ClickupField[];
  }

  async createTask(accessToken: string, listId: string, payload: ClickupTaskPayload): Promise<{ id: string }> {
    const res = await fetch(`${CLICKUP_API_BASE}/list/${listId}/task`, {
      method: 'POST',
      headers: { ...this.authHeaders(accessToken), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await this.parseJson(res, `create task in list ${listId}`);
    return { id: body.id as string };
  }

  async updateTask(accessToken: string, taskId: string, payload: ClickupTaskPayload): Promise<{ id: string }> {
    const res = await fetch(`${CLICKUP_API_BASE}/task/${taskId}`, {
      method: 'PUT',
      headers: { ...this.authHeaders(accessToken), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await this.parseJson(res, `update task ${taskId}`);
    return { id: body.id as string };
  }

  async setCustomFieldValue(accessToken: string, taskId: string, fieldId: string, value: unknown): Promise<void> {
    const res = await fetch(`${CLICKUP_API_BASE}/task/${taskId}/field/${fieldId}`, {
      method: 'POST',
      headers: { ...this.authHeaders(accessToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    await this.parseJson(res, `set custom field ${fieldId} on task ${taskId}`);
  }

  private authHeaders(accessToken: string): Record<string, string> {
    // ClickUp expects the raw token in Authorization, no "Bearer " prefix -
    // true for both personal API tokens and OAuth access tokens.
    return { Authorization: accessToken };
  }

  private async parseJson(res: Response, action: string): Promise<Record<string, any>> {
    const text = await res.text();
    let body: Record<string, any> = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new InternalServerErrorException(`ClickUp returned a non-JSON response while trying to ${action}`);
    }
    if (!res.ok) {
      const message = body?.err ?? res.statusText;
      throw new InternalServerErrorException(`ClickUp API error while trying to ${action}: ${message}`);
    }
    return body;
  }
}
