import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';
// Every ClickUp call is awaited synchronously within the customer-facing
// feedback request (see FeedbackService.deliverToClickup) - without a cap,
// a slow/rate-limited ClickUp response leaves that request hanging with no
// upper bound. A failure here is already handled gracefully by the retry
// worker, so it's safe to fail fast.
const REQUEST_TIMEOUT_MS = 10_000;

export interface ClickupField {
  id: string;
  name: string;
  type: string;
  /** Only present for type: 'drop_down' fields. */
  type_config?: { options?: { id: string; name: string }[] };
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

export interface ClickupListTask {
  id: string;
  name: string;
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
    const res = await this.timedFetch(`${CLICKUP_API_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, code }),
    }, 'exchange code for token');
    const body = await this.parseJson(res, 'exchange code for token');
    if (!body.access_token) {
      throw new InternalServerErrorException('ClickUp did not return an access token');
    }
    return body.access_token as string;
  }

  async getAuthorizedTeams(accessToken: string): Promise<ClickupTeam[]> {
    const res = await this.timedFetch(`${CLICKUP_API_BASE}/team`, {
      headers: this.authHeaders(accessToken),
    }, 'fetch authorized teams');
    const body = await this.parseJson(res, 'fetch authorized teams');
    return (body.teams ?? []) as ClickupTeam[];
  }

  /** Read-only - fetches every task in a list (paginated), including custom field values. Used to search the Companies list; never writes anything. */
  async getListTasks(accessToken: string, listId: string): Promise<ClickupListTask[]> {
    const all: ClickupListTask[] = [];
    let page = 0;
    for (;;) {
      const res = await this.timedFetch(`${CLICKUP_API_BASE}/list/${listId}/task?page=${page}`, {
        headers: this.authHeaders(accessToken),
      }, `fetch tasks for list ${listId}`);
      const body = await this.parseJson(res, `fetch tasks for list ${listId}`);
      const tasks = (body.tasks ?? []) as ClickupListTask[];
      all.push(...tasks);
      if (body.last_page || tasks.length === 0) break;
      page++;
    }
    return all;
  }

  /**
   * Read-only, narrowed by ClickUp's own date_created_gt/date_created_lt
   * filters (Unix ms) rather than fetching the whole list - used by
   * reconciliation to search for a ticket that may already exist for a
   * specific feedback, without the cost of paging through every ticket
   * ever created as the list grows over time.
   */
  async getListTasksCreatedBetween(accessToken: string, listId: string, sinceMs: number, untilMs: number): Promise<ClickupListTask[]> {
    const all: ClickupListTask[] = [];
    let page = 0;
    for (;;) {
      const res = await this.timedFetch(
        `${CLICKUP_API_BASE}/list/${listId}/task?page=${page}&date_created_gt=${sinceMs}&date_created_lt=${untilMs}&include_closed=true`,
        { headers: this.authHeaders(accessToken) },
        `fetch tasks for list ${listId} created between ${sinceMs} and ${untilMs}`,
      );
      const body = await this.parseJson(res, `fetch tasks for list ${listId} created between ${sinceMs} and ${untilMs}`);
      const tasks = (body.tasks ?? []) as ClickupListTask[];
      all.push(...tasks);
      if (body.last_page || tasks.length === 0) break;
      page++;
    }
    return all;
  }

  async getListFields(accessToken: string, listId: string): Promise<ClickupField[]> {
    const res = await this.timedFetch(`${CLICKUP_API_BASE}/list/${listId}/field`, {
      headers: this.authHeaders(accessToken),
    }, `fetch fields for list ${listId}`);
    const body = await this.parseJson(res, `fetch fields for list ${listId}`);
    return (body.fields ?? []) as ClickupField[];
  }

  async createTask(accessToken: string, listId: string, payload: ClickupTaskPayload): Promise<{ id: string }> {
    const res = await this.timedFetch(`${CLICKUP_API_BASE}/list/${listId}/task`, {
      method: 'POST',
      headers: { ...this.authHeaders(accessToken), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, `create task in list ${listId}`);
    const body = await this.parseJson(res, `create task in list ${listId}`);
    return { id: body.id as string };
  }

  async updateTask(accessToken: string, taskId: string, payload: ClickupTaskPayload): Promise<{ id: string }> {
    const res = await this.timedFetch(`${CLICKUP_API_BASE}/task/${taskId}`, {
      method: 'PUT',
      headers: { ...this.authHeaders(accessToken), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, `update task ${taskId}`);
    const body = await this.parseJson(res, `update task ${taskId}`);
    return { id: body.id as string };
  }

  async setCustomFieldValue(accessToken: string, taskId: string, fieldId: string, value: unknown): Promise<void> {
    const res = await this.timedFetch(`${CLICKUP_API_BASE}/task/${taskId}/field/${fieldId}`, {
      method: 'POST',
      headers: { ...this.authHeaders(accessToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    }, `set custom field ${fieldId} on task ${taskId}`);
    await this.parseJson(res, `set custom field ${fieldId} on task ${taskId}`);
  }

  /** Returns null (not a thrown error) for a 404 - "does this task still exist" is a normal, expected outcome here, used by the reconciliation worker to detect a ticket deleted directly in ClickUp. */
  async getTask(accessToken: string, taskId: string): Promise<{ id: string } | null> {
    const res = await this.timedFetch(`${CLICKUP_API_BASE}/task/${taskId}`, {
      headers: this.authHeaders(accessToken),
    }, `fetch task ${taskId}`);
    if (res.status === 404) return null;
    const body = await this.parseJson(res, `fetch task ${taskId}`);
    return { id: body.id as string };
  }

  /** Idempotent - a 404 (already deleted) is treated as success, not an error, so this is safe to call on a ticket that might already be gone. */
  async deleteTask(accessToken: string, taskId: string): Promise<void> {
    const res = await this.timedFetch(`${CLICKUP_API_BASE}/task/${taskId}`, {
      method: 'DELETE',
      headers: this.authHeaders(accessToken),
    }, `delete task ${taskId}`);
    if (res.status === 404 || res.ok) return;
    const text = await res.text();
    throw new InternalServerErrorException(`ClickUp API error while trying to delete task ${taskId}: ${text || res.statusText}`);
  }

  private authHeaders(accessToken: string): Record<string, string> {
    // ClickUp expects the raw token in Authorization, no "Bearer " prefix -
    // true for both personal API tokens and OAuth access tokens.
    return { Authorization: accessToken };
  }

  /**
   * fetch() has no built-in time limit - left alone, a slow/rate-limited
   * ClickUp response can hang far longer than any caller wants to wait
   * (see REQUEST_TIMEOUT_MS comment above). Wraps every call with an
   * AbortSignal.timeout() and turns the resulting AbortError into the same
   * InternalServerErrorException shape every other failure in this class
   * already throws, so callers don't need to special-case timeouts.
   */
  private async timedFetch(url: string, init: RequestInit, action: string): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new InternalServerErrorException(
          `ClickUp API timed out (>${REQUEST_TIMEOUT_MS / 1000}s) while trying to ${action}`,
        );
      }
      throw err;
    }
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
