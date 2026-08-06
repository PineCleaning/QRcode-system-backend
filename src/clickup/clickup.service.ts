import { Injectable, Logger } from '@nestjs/common';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';
import { ClickupApiClient } from './clickup-api.client';
import { ClickupConnectionService } from './clickup-connection.service';

interface TicketClient {
  id: string;
  clientId: string;
  clientName: string;
  clickupEntityId: string | null;
}

interface TicketMedia {
  cloudinaryPublicId: string;
  resourceType: 'IMAGE' | 'VIDEO';
}

export interface TicketInput {
  /** Our own client row - used to resolve (read-only) and cache its matching Company, never to write one. */
  client: TicketClient;
  businessName: string;
  /** The site's own address - Location on the ticket is an automatic rollup from the linked Company, not something we write, so this goes into Request Details instead (see Phase 0 findings). */
  address: string | null;
  feedback: string;
  mobileNumber: string | null;
  /** VERIFIED attachments only - the caller filters out REJECTED ones before this point. */
  media: TicketMedia[];
}

/**
 * High-level ClickUp operations for this app's domain. Talks to
 * ClickupApiClient (raw REST) using the connection cached by
 * ClickupConnectionService. Never creates Lists/Folders/Spaces/custom
 * fields - only reads and writes to structure that already exists in
 * the client's workspace (Open Decision #3, resolved 2026-07-24 - see
 * CLAUDE.md Section 7 / "ClickUp Structure Mapping").
 *
 * Deliberately never writes to the Companies list at all - not create,
 * not update. That was this service's original design (see git
 * history for createCompany/updateCompany, removed here), but the
 * client restricted the integration to "only insert feedback as
 * tickets" - so linking a ticket to its Company is now a read-only
 * lookup (see ClickupService.findCompanyByName, added alongside this
 * change) rather than something this service ever creates or edits.
 */
@Injectable()
export class ClickupService {
  private readonly logger = new Logger(ClickupService.name);

  constructor(
    private readonly api: ClickupApiClient,
    private readonly connections: ClickupConnectionService,
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  /**
   * Creates a Task in the TICKETS list for a feedback submission.
   * Request Type and Request Details are set directly on creation (both
   * text/dropdown fields, reliably supported in ClickUp's bulk
   * custom_fields array). Location is deliberately never written here -
   * it's an automatic rollup ClickUp computes from whichever Company
   * ends up linked via CLIENT NAME, not a field this app can set (see
   * Phase 0 findings) - so the site's own address goes into Request
   * Details instead, alongside the feedback text and attachment links.
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
      name: `${input.client.clientName} — ${input.businessName}`,
      custom_fields: [
        { id: connection.requestDetailsFieldId!, value: this.buildRequestDetails(input) },
        { id: connection.requestTypeFieldId!, value: connection.requestTypeOtherOptionId! },
      ],
    });

    const clientEntityId = await this.resolveClientEntityId(input.client);
    if (clientEntityId) {
      try {
        await this.api.setCustomFieldValue(accessToken, task.id, connection.clientFieldId!, {
          add: [clientEntityId],
        });
      } catch (err) {
        this.logger.warn(
          `Ticket ${task.id} created but failed to link Company ${clientEntityId} via the CLIENT NAME field: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return task.id;
  }

  /**
   * Read-only: never creates or updates a Company record (the client
   * restricted this integration to "only insert feedback as tickets").
   * Returns the linked Company's task id, or null if there's nothing
   * safe to link to.
   *
   * Cache-aside: a client's clickupEntityId, once matched, is cached
   * on our own client row so this search only runs once per client -
   * NOT re-searched on every ticket. A miss is never cached (no
   * negative caching) - a Company added to ClickUp later is picked up
   * on the very next ticket for that client, with no other action
   * needed.
   *
   * Two matching strategies, tried in order:
   *  1. By the Companies list's own "CLIENT ID" field (our unique
   *     client_id) - unambiguous by construction, since client_id is
   *     unique in our database. Only used if that field was found
   *     during POST /clickup/setup (companyClientIdFieldId set).
   *  2. By exact, case-insensitive name match - the original strategy,
   *     used as a fallback when no CLIENT ID field exists or no
   *     Company has a value in it yet.
   * Either way: if more than one Company matches, that's ambiguous -
   * never guess which one is "right". Leave the ticket unlinked and
   * log a warning rather than risk silently linking to the wrong
   * business's Company record.
   */
  private async resolveClientEntityId(client: TicketClient): Promise<string | null> {
    if (client.clickupEntityId) return client.clickupEntityId;

    const { connection, accessToken } = await this.connections.getReadyConnection();
    const companies = await this.api.getListTasks(accessToken, connection.companiesListId!);

    if (connection.companyClientIdFieldId) {
      const byClientId = companies.filter((c) => {
        const field = c.custom_fields?.find((f) => f.id === connection.companyClientIdFieldId);
        const value = typeof field?.value === 'string' ? field.value.trim().toLowerCase() : null;
        return value && value === client.clientId.trim().toLowerCase();
      });
      if (byClientId.length === 1) {
        return this.cacheMatch(client.id, byClientId[0].id);
      }
      if (byClientId.length > 1) {
        this.logger.warn(
          `Client ${client.id} (${client.clientId}) matched ${byClientId.length} Companies by CLIENT ID - ambiguous, leaving ticket unlinked.`,
        );
        return null;
      }
      // No CLIENT ID match - fall through to name matching below.
    }

    const byName = companies.filter((c) => c.name.trim().toLowerCase() === client.clientName.trim().toLowerCase());
    if (byName.length === 1) {
      return this.cacheMatch(client.id, byName[0].id);
    }
    if (byName.length > 1) {
      this.logger.warn(
        `Client ${client.id} ("${client.clientName}") matched ${byName.length} Companies by name - ambiguous, leaving ticket unlinked.`,
      );
    }
    return null;
  }

  /**
   * Used by reconciliation to recover a feedback stuck at SUBMITTED with
   * no clickupTaskId recorded, whose delivery may have actually
   * succeeded before something (a deploy, a dropped connection, a
   * process restart) interrupted the request before the DB write that
   * records that success ran. Searches for a ticket with the exact
   * expected title, created within a window around when the feedback
   * was submitted, rather than trusting our own (possibly incomplete)
   * records. Ambiguous (more than one candidate) is never guessed at -
   * same reasoning as resolveClientEntityId below - left for a human to
   * sort out instead of silently adopting the wrong ticket.
   */
  async findExistingTicketForFeedback(clientName: string, businessName: string, submittedAt: Date): Promise<string | null> {
    const { connection, accessToken } = await this.connections.getReadyConnection();
    const windowMs = 30 * 60_000; // generous enough to survive any real delivery delay, tight enough to avoid an unrelated later ticket with the same title
    const since = submittedAt.getTime() - windowMs;
    const until = submittedAt.getTime() + windowMs;

    const tasks = await this.api.getListTasksCreatedBetween(accessToken, connection.ticketsListId!, since, until);
    const expectedName = `${clientName} — ${businessName}`;
    const matches = tasks.filter((t) => t.name === expectedName);

    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) {
      this.logger.warn(
        `Reconciliation: found ${matches.length} candidate tickets titled "${expectedName}" near ${submittedAt.toISOString()} - ambiguous, not adopting any.`,
      );
    }
    return null;
  }

  /** Cheap pre-check for callers (e.g. the reconciliation cron) that want to skip a whole batch of work when ClickUp isn't connected at all, rather than throwing once per row. */
  async isConnected(): Promise<boolean> {
    return (await this.connections.getAnyConnection()) !== null;
  }

  /** Used by the reconciliation worker to detect a ticket deleted directly in ClickUp (not through this app). */
  async ticketExists(taskId: string): Promise<boolean> {
    const { accessToken } = await this.connections.getReadyConnection();
    const task = await this.api.getTask(accessToken, taskId);
    return task !== null;
  }

  /** Best-effort - deleting a ticket that's already gone is treated as success, not an error, so callers can call this unconditionally without checking existence first. */
  async deleteTicket(taskId: string): Promise<void> {
    const { accessToken } = await this.connections.getReadyConnection();
    await this.api.deleteTask(accessToken, taskId);
  }

  private async cacheMatch(clientId: string, clickupEntityId: string): Promise<string> {
    await this.prisma.client.update({ where: { id: clientId }, data: { clickupEntityId } });
    return clickupEntityId;
  }

  /**
   * Feedback text, then the site's address (Location can't be written
   * directly - see the class-level comment), then mobile number if
   * provided, then a labeled list of only the verified attachment
   * links. Photo/video counters are independent (Photo 1, Photo 2,
   * Video 1, ...) rather than one shared "Attachment N" sequence, since
   * that's clearer to scan when a submission has both.
   */
  private buildRequestDetails(input: TicketInput): string {
    const lines = [input.feedback];

    if (input.address) lines.push('', `Address: ${input.address}`);
    if (input.mobileNumber) lines.push('', `Mobile: ${input.mobileNumber}`);

    if (input.media.length > 0) {
      lines.push('', 'Attachments:');
      let photoCount = 0;
      let videoCount = 0;
      for (const item of input.media) {
        const url = this.cloudinary.buildDeliveryUrl(item.cloudinaryPublicId, item.resourceType === 'IMAGE' ? 'image' : 'video');
        if (item.resourceType === 'IMAGE') {
          photoCount += 1;
          lines.push(`Photo ${photoCount}: ${url}`);
        } else {
          videoCount += 1;
          lines.push(`Video ${videoCount}: ${url}`);
        }
      }
    }

    return lines.join('\n');
  }
}
