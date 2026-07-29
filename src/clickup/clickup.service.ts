import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClickupApiClient } from './clickup-api.client';
import { ClickupConnectionService } from './clickup-connection.service';

export interface CompanySyncInput {
  name: string;
  contactEmail: string | null;
  contactPhone: string | null;
  /** Our client_site_status ('ACTIVE' | 'INACTIVE') - mapped to a ClickUp task status name. */
  status: string;
}

export interface TicketInput {
  clientName: string;
  /** clients.clickup_entity_id of the client this feedback belongs to - null if that client was never synced to ClickUp. */
  clientEntityId: string | null;
  siteName: string;
  feedback: string;
  mobileNumber: string | null;
}

/**
 * High-level ClickUp operations for this app's domain. Talks to
 * ClickupApiClient (raw REST) using the connection cached by
 * ClickupConnectionService. Never creates Lists/Folders/Spaces/custom
 * fields - only reads and writes to structure that already exists in
 * the client's workspace (Open Decision #3, resolved 2026-07-24 - see
 * CLAUDE.md Section 7 / "ClickUp Structure Mapping").
 *
 * Company record writes are partial: only name (task title), status
 * (native task status), and a description block holding contact
 * email/phone are touched. Custom fields on the Company task (Facility
 * Type, Cleaning Frequency, etc.) are never sent in the update payload,
 * so they're structurally impossible for this service to overwrite.
 */
@Injectable()
export class ClickupService {
  private readonly logger = new Logger(ClickupService.name);
  private readonly activeStatusName: string;
  private readonly inactiveStatusName: string;

  constructor(
    private readonly api: ClickupApiClient,
    private readonly connections: ClickupConnectionService,
    config: ConfigService,
  ) {
    this.activeStatusName = config.get('CLICKUP_COMPANY_STATUS_ACTIVE') ?? 'active';
    this.inactiveStatusName = config.get('CLICKUP_COMPANY_STATUS_INACTIVE') ?? 'inactive';
  }

  async createCompany(input: CompanySyncInput): Promise<string> {
    const { connection, accessToken } = await this.connections.getReadyConnection();
    const task = await this.api.createTask(accessToken, connection.companiesListId!, {
      name: input.name,
      description: this.buildDescription(input),
      status: this.mapStatus(input.status),
    });
    return task.id;
  }

  async updateCompany(clickupTaskId: string, input: CompanySyncInput): Promise<void> {
    const { accessToken } = await this.connections.getReadyConnection();
    await this.api.updateTask(accessToken, clickupTaskId, {
      name: input.name,
      description: this.buildDescription(input),
      status: this.mapStatus(input.status),
    });
  }

  /**
   * Creates a Task in the TICKETS list for a feedback submission. Site
   * has no structured ClickUp counterpart (see Structure Mapping) so
   * it's folded into the title/description as plain text, not a field.
   *
   * Task creation itself must succeed or throw (retries are safe here -
   * nothing was created yet). Linking the ticket to its Company via the
   * Relationship field is a separate, best-effort step done AFTER the
   * task exists: ClickUp's bulk `custom_fields` array on task creation
   * doesn't reliably support Relationship-type fields (that's what the
   * dedicated setCustomFieldValue()/PUT-field endpoint is for), and
   * more importantly - since a retry re-runs this whole function from
   * scratch with no memory of a prior partial success, letting the
   * field-set step throw here would create a DUPLICATE ticket on the
   * next retry attempt rather than just a ticket missing its Company
   * link. A missing link is a much smaller problem than a duplicate.
   */
  async createTicket(input: TicketInput): Promise<string> {
    const { connection, accessToken } = await this.connections.getReadyConnection();

    const task = await this.api.createTask(accessToken, connection.ticketsListId!, {
      name: `${input.clientName} — ${input.siteName}`,
      description: this.buildTicketDescription(input),
    });

    if (input.clientEntityId) {
      try {
        await this.api.setCustomFieldValue(accessToken, task.id, connection.clientFieldId!, {
          add: [input.clientEntityId],
        });
      } catch (err) {
        this.logger.warn(
          `Ticket ${task.id} created but failed to link Company ${input.clientEntityId} via the CLIENT NAME field: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return task.id;
  }

  private buildTicketDescription(input: TicketInput): string {
    const lines = [`Site: ${input.siteName}`, '', input.feedback];
    if (input.mobileNumber) lines.push('', `Mobile: ${input.mobileNumber}`);
    return lines.join('\n');
  }

  private buildDescription(input: CompanySyncInput): string {
    const lines = ['Synced from the QR Feedback admin portal. Do not edit this description manually.'];
    if (input.contactEmail) lines.push(`Contact email: ${input.contactEmail}`);
    if (input.contactPhone) lines.push(`Contact phone: ${input.contactPhone}`);
    return lines.join('\n');
  }

  private mapStatus(status: string): string {
    return status === 'ACTIVE' ? this.activeStatusName : this.inactiveStatusName;
  }
}
