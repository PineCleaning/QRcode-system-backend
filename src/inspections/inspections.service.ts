import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import {
  ALLOWED_IMAGE_FORMATS,
  ALLOWED_VIDEO_FORMATS,
  formatMb,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  MAX_VIDEO_BYTES,
  MAX_VIDEOS_PER_SUBMISSION,
} from '../cloudinary/media-limits';
import { PrismaService } from '../prisma/prisma.service';
import {
  MAX_ATTACHMENTS,
  CreateInspectionItemDto,
} from './dto/create-inspection-item.dto';
import { InspectionMediaDto } from './dto/inspection-media.dto';
import { UpdateInspectionItemDto } from './dto/update-inspection-item.dto';

interface InspectionMediaCreateData {
  cloudinaryPublicId: string;
  resourceType: 'IMAGE' | 'VIDEO';
  originalFilename: string | null;
  mimeType: string;
  sizeBytes: number;
  status: 'VERIFIED' | 'REJECTED';
}

/**
 * Percentage band each rating validates against - confirmed with the user
 * 2026-09-05 (Discovery doc §1.5, Quality-Control Scoring). "Not Applicable"
 * items skip this entirely, since they have no rating/percentage at all.
 */
const RATING_RANGES: Record<string, [number, number]> = {
  EXCELLENT: [95, 100],
  ABOVE_AVERAGE: [85, 94],
  AVERAGE: [65, 84],
  BELOW_AVERAGE: [40, 64],
  VERY_POOR: [0, 39],
};

/** Minimum average score (%) to pass an inspection - updated from the original 85% (Discovery doc, Week 3 Tue). */
const MEETS_STANDARD_THRESHOLD = 80;

@Injectable()
export class InspectionsService {
  private readonly logger = new Logger(InspectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  /**
   * "Open or resume" - returns the site's existing OPEN session if one
   * exists rather than erroring, so a staff member can always just hit
   * this endpoint to continue where they left off across multiple
   * visits/days. The partial unique index (uq_site_open_inspection) is
   * the real guarantee against two OPEN sessions for the same site under
   * concurrent requests - the findFirst check below is just the
   * common-case fast path, not a lock. Verified live 2026-09-16: firing
   * 5 truly concurrent calls for a site with no OPEN session, 4 of them
   * hit the unique constraint - the catch block below is what turns
   * that into "join the session the winner just created" instead of a
   * raw 500. Before this fix, that race produced exactly that 500.
   */
  async openOrResume(siteId: string, adminId: string) {
    // Check for an existing OPEN session first - this is the common
    // case on every repeat call while a staff member is actively
    // working through a session (this endpoint is re-hit on every page
    // load and on every item mutation's revalidation), so it shouldn't
    // pay for a separate site-existence check first. The site-existence
    // check only matters for the rarer "starting a brand new session"
    // path below, where it's needed to give a friendly 404 instead of
    // a raw foreign-key error from the create.
    const existing = await this.prisma.siteInspection.findFirst({
      where: { siteId, status: 'OPEN' },
      include: {
        items: { include: { media: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (existing) {
      return this.mapInspectionMedia(existing);
    }

    // Starting a brand-new session (measured 2026-09-16: this cold-start
    // path - separate site-existence check, then create - cost 3
    // sequential round trips total with the findFirst above, most
    // visible right after "Finish Inspection" when the page immediately
    // needs a fresh session). The site-existence check is folded into
    // the INSERT's own guard instead of a separate query, and the
    // response is built from what was just inserted rather than reading
    // it back - a session this instant old always has zero items.
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{
          id: string;
          siteId: string;
          status: string;
          averageScore: number | null;
          meetsStandard: boolean | null;
          createdBy: string | null;
          completedBy: string | null;
          startedAt: Date;
          completedAt: Date | null;
        }>
      >`
        INSERT INTO site_inspections (id, site_id, status, created_by, started_at)
        SELECT gen_random_uuid(), ${siteId}::uuid, 'OPEN', ${adminId}::uuid, now()
        WHERE EXISTS (SELECT 1 FROM sites WHERE id = ${siteId}::uuid)
        RETURNING id, site_id AS "siteId", status, average_score AS "averageScore",
          meets_standard AS "meetsStandard", created_by AS "createdBy", completed_by AS "completedBy",
          started_at AS "startedAt", completed_at AS "completedAt"
      `;

      if (rows.length === 0) {
        throw new NotFoundException(`Site ${siteId} not found`);
      }

      return this.mapInspectionMedia({ ...rows[0], items: [] });
    } catch (err) {
      // Two (or more) concurrent requests can each pass the findFirst
      // check above believing no OPEN session exists yet, then all
      // attempt to create one - uq_site_open_inspection lets exactly
      // one succeed and rejects the rest with a unique-constraint
      // violation. Whoever loses that race just fetches and joins the
      // session the winner created, instead of surfacing a raw 500.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.siteInspection.findFirst({
          where: { siteId, status: 'OPEN' },
          include: {
            items: { include: { media: true }, orderBy: { createdAt: 'asc' } },
          },
        });
        if (existing) {
          return this.mapInspectionMedia(existing);
        }
      }
      throw err;
    }
  }

  async findAllForSite(siteId: string) {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) {
      throw new NotFoundException(`Site ${siteId} not found`);
    }
    return this.prisma.siteInspection.findMany({
      where: { siteId },
      orderBy: { startedAt: 'desc' },
    });
  }

  /**
   * The last 10 COMPLETED sessions for a site (Week 3 Wed) - older ones
   * stay fully in the database, simply not returned here. Deliberately
   * lightweight (summary fields + item count, no items/media) since this
   * backs a list view; GET /inspections/:id already returns full detail
   * for whichever one gets clicked into.
   */
  async findCompletedForSite(siteId: string) {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) {
      throw new NotFoundException(`Site ${siteId} not found`);
    }
    const inspections = await this.prisma.siteInspection.findMany({
      where: { siteId, status: 'COMPLETED' },
      orderBy: { completedAt: 'desc' },
      take: 10,
      include: {
        _count: { select: { items: true } },
        completedByUser: { select: { fullName: true, email: true } },
        createdByUser: { select: { fullName: true, email: true } },
      },
    });
    return inspections.map(({ _count, completedByUser, createdByUser, ...inspection }) => {
      // "Who did the inspection" - the admin who finished it if the
      // session has one, otherwise whoever opened it (a completed
      // session should normally have both, but older data or a
      // since-deleted admin account can leave completedByUser null).
      const inspector = completedByUser ?? createdByUser;
      return {
        ...inspection,
        itemCount: _count.items,
        inspectedBy: inspector ? inspector.fullName || inspector.email : null,
      };
    });
  }

  /**
   * Cross-site completed-inspections list for the admin portal's global
   * "Completed Inspections" nav tab - same clientCode/siteId filter and
   * pagination convention as InventoryService.findAllGlobal/
   * AdminFeedbackService.findAll (no page/pageSize -> unpaginated array,
   * either param -> {data, total, page, pageSize}). Unlike
   * findCompletedForSite, this has no per-site cap (that "last 10" limit
   * exists there to keep a single site's own page short, not as a rule
   * about completed inspections in general).
   */
  async findAllCompletedGlobal(clientCode?: string, siteId?: string, page?: number, pageSize?: number) {
    const where: Prisma.SiteInspectionWhereInput = {
      status: 'COMPLETED',
      ...(siteId && { siteId }),
      ...(clientCode && { site: { clientCode } }),
    };
    const include = {
      _count: { select: { items: true } },
      completedByUser: { select: { fullName: true, email: true } },
      createdByUser: { select: { fullName: true, email: true } },
      site: {
        select: {
          id: true,
          businessName: true,
          client: { select: { id: true, clientName: true, clientId: true } },
        },
      },
    } as const;

    const mapRow = <T extends { _count: { items: number }; completedByUser: { fullName: string | null; email: string } | null; createdByUser: { fullName: string | null; email: string } | null }>(
      row: T,
    ) => {
      const { _count, completedByUser, createdByUser, ...rest } = row;
      const inspector = completedByUser ?? createdByUser;
      return { ...rest, itemCount: _count.items, inspectedBy: inspector ? inspector.fullName || inspector.email : null };
    };

    if (!page && !pageSize) {
      const inspections = await this.prisma.siteInspection.findMany({ where, orderBy: { completedAt: 'desc' }, include });
      return inspections.map(mapRow);
    }

    const currentPage = page ?? 1;
    const size = pageSize ?? 50;

    const [inspections, total] = await Promise.all([
      this.prisma.siteInspection.findMany({
        where,
        orderBy: { completedAt: 'desc' },
        include,
        skip: (currentPage - 1) * size,
        take: size,
      }),
      this.prisma.siteInspection.count({ where }),
    ]);

    return { data: inspections.map(mapRow), total, page: currentPage, pageSize: size };
  }

  async findOne(id: string) {
    const inspection = await this.prisma.siteInspection.findUnique({
      where: { id },
      include: {
        items: { include: { media: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!inspection) {
      throw new NotFoundException(`Inspection ${id} not found`);
    }
    return this.mapInspectionMedia(inspection);
  }

  /**
   * Locks the session (OPEN -> COMPLETED) and computes its final score:
   * the average percentage across every rated item, excluding "Not
   * Applicable" ones entirely (they were never scored in the first
   * place). Requires at least one rated item - finishing an empty or
   * all-N/A session would produce a meaningless score, not a real
   * result.
   *
   * Single guarded UPDATE (measured 2026-09-16: the old two-step
   * version - findUnique to read items for scoring, then a separate
   * update - cost ~3s raw backend time for what should be one write).
   * The average is computed in the same statement via a correlated
   * subquery instead of pulling every item's percentage into Node
   * first, so there's exactly one round trip on the success path. Only
   * the caller (finishInspectionAction) consumes this response, and it
   * only reads averageScore/meetsStandard - not the full item list -
   * so this deliberately returns a lighter shape than findOne's.
   */
  async finishInspection(inspectionId: string, adminId: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        averageScore: number | null;
        meetsStandard: boolean | null;
      }>
    >`
      UPDATE site_inspections si
      SET status = 'COMPLETED',
          completed_at = now(),
          completed_by = ${adminId}::uuid,
          average_score = sub.avg_score,
          meets_standard = sub.avg_score >= ${MEETS_STANDARD_THRESHOLD}
      FROM (
        SELECT ROUND(AVG(percentage))::int AS avg_score, COUNT(*) AS rated_count
        FROM inspection_items
        WHERE inspection_id = ${inspectionId}::uuid
          AND is_not_applicable = false
          AND percentage IS NOT NULL
      ) sub
      WHERE si.id = ${inspectionId}::uuid AND si.status = 'OPEN' AND sub.rated_count > 0
      RETURNING si.id, si.average_score AS "averageScore", si.meets_standard AS "meetsStandard"
    `;

    if (rows.length === 0) {
      // Rare path - something's wrong. Re-check with the original
      // sequential logic purely to reproduce the exact same
      // NotFound/Conflict/BadRequest messages as before.
      const inspection = await this.prisma.siteInspection.findUnique({
        where: { id: inspectionId },
        include: { items: true },
      });
      if (!inspection) {
        throw new NotFoundException(`Inspection ${inspectionId} not found`);
      }
      if (inspection.status !== 'OPEN') {
        throw new ConflictException(
          'This inspection session is already finished.',
        );
      }
      const hasRatedItem = inspection.items.some(
        (item) => !item.isNotApplicable && item.percentage !== null,
      );
      if (!hasRatedItem) {
        throw new BadRequestException(
          'Add at least one rated space before finishing this inspection.',
        );
      }
      throw new ConflictException('Could not finish this inspection - please try again.');
    }

    return rows[0];
  }

  async addItem(
    inspectionId: string,
    dto: CreateInspectionItemDto,
    adminId: string,
  ) {
    if (!dto.isNotApplicable) {
      this.assertPercentageInRange(dto.rating!, dto.percentage!);
    }

    const { mediaCreates, rejectionReasons } = await this.verifyMedia(
      dto.media,
    );

    if (mediaCreates.length === 0) {
      // Fast path (no attachments - the common case measured 2026-09-16
      // taking ~2.2s for what should be simple write): a single guarded
      // INSERT does the "session must still be OPEN" check and the
      // write in one database round trip instead of a separate
      // findUnique first. Only falls back to assertOpenInspection (a
      // second query) on the rare failure path, purely to reproduce
      // the same NotFound/Conflict messages as before.
      const rows = await this.prisma.$queryRaw<
        Array<{
          id: string;
          inspectionId: string;
          spaceName: string;
          isNotApplicable: boolean;
          rating: string | null;
          percentage: number | null;
          notes: string | null;
          flagged: boolean;
          createdBy: string | null;
          createdAt: Date;
          updatedAt: Date;
        }>
      >`
        INSERT INTO inspection_items
          (id, inspection_id, space_name, is_not_applicable, rating, percentage, notes, created_by, created_at, updated_at)
        SELECT gen_random_uuid(), ${inspectionId}::uuid, ${dto.spaceName}, ${dto.isNotApplicable ?? false},
          ${dto.isNotApplicable ? null : dto.rating}::inspection_rating,
          ${dto.isNotApplicable ? null : dto.percentage},
          ${dto.notes ?? null}, ${adminId}::uuid, now(), now()
        WHERE EXISTS (
          SELECT 1 FROM site_inspections WHERE id = ${inspectionId}::uuid AND status = 'OPEN'
        )
        RETURNING
          id, inspection_id AS "inspectionId", space_name AS "spaceName", is_not_applicable AS "isNotApplicable",
          rating, percentage, notes, flagged, created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
      `;

      if (rows.length === 0) {
        await this.assertOpenInspection(inspectionId);
        throw new ConflictException('Could not add this item - please try again.');
      }

      return this.mapItemMedia({ ...rows[0], media: [] });
    }

    // Slower path (photos/videos attached) - unchanged: the media
    // verification/upload cost already dominates this path, so the
    // extra findUnique round trip isn't worth the risk of touching it.
    const inspection = await this.assertOpenInspection(inspectionId);
    const item = await this.prisma.inspectionItem.create({
      data: {
        inspectionId: inspection.id,
        spaceName: dto.spaceName,
        isNotApplicable: dto.isNotApplicable ?? false,
        rating: dto.isNotApplicable ? null : dto.rating,
        percentage: dto.isNotApplicable ? null : dto.percentage,
        notes: dto.notes,
        createdBy: adminId,
        media: { create: mediaCreates },
      },
      include: { media: true },
    });

    return this.mapItemMedia(item, mediaCreates, rejectionReasons);
  }

  /**
   * media on this DTO is additive - new files to attach on top of
   * whatever the item already has, not a replacement list. A space can
   * get photos added across multiple visits within the same open
   * session, same as rating/notes can be revised.
   */
  async updateItem(itemId: string, dto: UpdateInspectionItemDto) {
    const item = await this.prisma.inspectionItem.findUnique({
      where: { id: itemId },
      include: { media: true },
    });
    if (!item) {
      throw new NotFoundException(`Inspection item ${itemId} not found`);
    }
    await this.assertOpenInspection(item.inspectionId);
    if (!dto.isNotApplicable) {
      this.assertPercentageInRange(dto.rating!, dto.percentage!);
    }

    const existingCount = item.media.length;
    if (dto.media && existingCount + dto.media.length > MAX_ATTACHMENTS) {
      throw new BadRequestException(
        `This item already has ${existingCount} attachment(s) - a maximum of ${MAX_ATTACHMENTS} total is allowed.`,
      );
    }

    const existingVideoCount = item.media.filter(
      (m) => m.resourceType === 'VIDEO' && m.status === 'VERIFIED',
    ).length;
    const { mediaCreates, rejectionReasons } = await this.verifyMedia(
      dto.media,
      existingVideoCount,
    );

    const updated = await this.prisma.inspectionItem.update({
      where: { id: itemId },
      data: {
        spaceName: dto.spaceName,
        isNotApplicable: dto.isNotApplicable ?? false,
        rating: dto.isNotApplicable ? null : dto.rating,
        percentage: dto.isNotApplicable ? null : dto.percentage,
        notes: dto.notes,
        media: { create: mediaCreates },
      },
      include: { media: true },
    });

    return this.mapItemMedia(updated, mediaCreates, rejectionReasons);
  }

  /**
   * Toggles the flagged marker - deliberately does NOT go through
   * assertOpenInspection. Unlike rating/notes/photos, a flag is a
   * follow-up marker, not inspection data, so it stays toggleable even
   * after the session is COMPLETED and the rest of the item is
   * read-only (e.g. flagging something noticed while reviewing a
   * finished report, or un-flagging once it's been resolved).
   */
  async setItemFlagged(itemId: string, flagged: boolean) {
    const item = await this.prisma.inspectionItem.findUnique({ where: { id: itemId } });
    if (!item) {
      throw new NotFoundException(`Inspection item ${itemId} not found`);
    }
    const updated = await this.prisma.inspectionItem.update({
      where: { id: itemId },
      data: { flagged },
      include: { media: true },
    });
    return this.mapItemMedia(updated);
  }

  /**
   * Every flagged item across every site/client, for the Flagged tab -
   * joins in just enough site/client context to link back, same shape
   * convention as AdminFeedbackService.findAll's site/client include.
   */
  async findFlaggedItems() {
    const items = await this.prisma.inspectionItem.findMany({
      where: { flagged: true },
      orderBy: { createdAt: 'desc' },
      include: {
        media: true,
        inspection: {
          select: {
            id: true,
            status: true,
            site: {
              select: {
                id: true,
                businessName: true,
                address: true,
                slug: true,
                client: { select: { id: true, clientName: true, clientId: true } },
              },
            },
          },
        },
      },
    });
    return items.map((item) => this.mapItemMedia(item));
  }

  /**
   * Permanently deletes one attachment - from Cloudinary storage and
   * the DB row - same pattern as AdminMediaService.remove() for
   * feedback attachments. A Cloudinary-side failure (already-gone
   * asset, transient API error) never blocks the DB delete, same
   * non-blocking-failure reasoning used everywhere else in this app.
   */
  async removeMedia(mediaId: string): Promise<void> {
    const media = await this.prisma.inspectionMedia.findUnique({
      where: { id: mediaId },
    });
    if (!media) {
      throw new NotFoundException(`Inspection media ${mediaId} not found`);
    }

    try {
      await this.cloudinary.destroy(
        media.cloudinaryPublicId,
        media.resourceType.toLowerCase() as 'image' | 'video',
      );
    } catch (err) {
      this.logger.warn(
        `Cloudinary destroy failed for inspection media ${mediaId}: ${err instanceof Error ? err.message : err}`,
      );
    }

    await this.prisma.inspectionMedia.delete({ where: { id: mediaId } });
  }

  /**
   * Verifies each attachment against Cloudinary (real file exists,
   * format/size/video-count within limits) - same checks and shared
   * media-limits.ts constants FeedbackService uses, so the two flows
   * can't silently drift apart. A failure here never throws; the item
   * is still saved, the offending file is just marked REJECTED with a
   * reason surfaced back in the response (not a DB column, same as
   * FeedbackService.submit).
   */
  /**
   * existingVideoCount lets a caller that's adding media to an item
   * that already has some (updateItem) factor in videos from earlier
   * calls, not just the ones in this one request - addItem's fresh
   * item always passes 0 (the default) since it has no prior media.
   * Bug found 2026-09-16 via exhaustive testing: without this, the
   * "max 1 video per item" rule only ever looked at the current
   * request's media array, so a second video attached in a later,
   * separate edit call sailed through unverified against what the
   * item already had.
   */
  private async verifyMedia(
    media: InspectionMediaDto[] | undefined,
    existingVideoCount = 0,
  ) {
    const mediaCreates: InspectionMediaCreateData[] = [];
    const rejectionReasons: (string | null)[] = [];
    let totalVerifiedBytes = 0;
    let verifiedVideoCount = existingVideoCount;

    const resources = await Promise.all(
      (media ?? []).map((item) =>
        this.cloudinary.verifyResource(
          item.cloudinaryPublicId,
          item.resourceType.toLowerCase() as 'image' | 'video',
        ),
      ),
    );

    (media ?? []).forEach((item, index) => {
      const resourceTypeLower = item.resourceType.toLowerCase() as
        'image' | 'video';
      const resource = resources[index];

      let reason: string | null = null;
      if (!resource) {
        reason = 'Could not verify this file. Please try uploading it again.';
      } else if (
        resourceTypeLower === 'image' &&
        !ALLOWED_IMAGE_FORMATS.includes(resource.format)
      ) {
        reason =
          'Unsupported photo format. Use JPEG, PNG, WebP, HEIC, or HEIF.';
      } else if (
        resourceTypeLower === 'video' &&
        !ALLOWED_VIDEO_FORMATS.includes(resource.format)
      ) {
        reason = 'Unsupported video format. Use MP4, MOV, or WebM.';
      } else if (
        resourceTypeLower === 'image' &&
        resource.bytes > MAX_IMAGE_BYTES
      ) {
        reason = `Photo is too large (max ${formatMb(MAX_IMAGE_BYTES)}).`;
      } else if (
        resourceTypeLower === 'video' &&
        resource.bytes > MAX_VIDEO_BYTES
      ) {
        reason = `Video is too large (max ${formatMb(MAX_VIDEO_BYTES)}).`;
      } else if (
        resourceTypeLower === 'video' &&
        verifiedVideoCount >= MAX_VIDEOS_PER_SUBMISSION
      ) {
        reason = 'Only one video can be attached per upload.';
      } else if (totalVerifiedBytes + resource.bytes > MAX_TOTAL_BYTES) {
        reason = `Attachments exceed the ${formatMb(MAX_TOTAL_BYTES)} total limit.`;
      }

      if (!reason && resource) {
        totalVerifiedBytes += resource.bytes;
        if (resourceTypeLower === 'video') verifiedVideoCount += 1;
      }

      rejectionReasons.push(reason);
      mediaCreates.push({
        cloudinaryPublicId: item.cloudinaryPublicId,
        resourceType: item.resourceType,
        originalFilename: item.originalFilename ?? null,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        status: reason ? ('REJECTED' as const) : ('VERIFIED' as const),
      });
    });

    return { mediaCreates, rejectionReasons };
  }

  /**
   * Derives a delivery url for every VERIFIED media row - never stored,
   * same pattern as feedback_media. rejectionReasons is zipped against
   * mediaCreates/dto.media (both built in the same forEach in
   * verifyMedia) by cloudinaryPublicId rather than array index, since
   * Prisma's returned `media` array order isn't guaranteed to put
   * newly-created rows last relative to pre-existing ones on an update.
   */
  private mapItemMedia<
    T extends {
      media: {
        cloudinaryPublicId: string;
        resourceType: 'IMAGE' | 'VIDEO';
        status: string;
      }[];
    },
  >(
    item: T,
    mediaCreates: InspectionMediaCreateData[] = [],
    rejectionReasons: (string | null)[] = [],
  ) {
    const reasonByPublicId = new Map(
      mediaCreates.map((m, i) => [
        m.cloudinaryPublicId,
        rejectionReasons[i] ?? null,
      ]),
    );
    return {
      ...item,
      media: item.media.map((m) => ({
        ...m,
        url:
          m.status === 'VERIFIED'
            ? this.cloudinary.buildDeliveryUrl(
                m.cloudinaryPublicId,
                m.resourceType.toLowerCase() as 'image' | 'video',
              )
            : null,
        rejectionReason: reasonByPublicId.get(m.cloudinaryPublicId) ?? null,
      })),
    };
  }

  /** Same as mapItemMedia, applied across every item on an inspection session. */
  private mapInspectionMedia<
    T extends {
      items: {
        media: {
          cloudinaryPublicId: string;
          resourceType: 'IMAGE' | 'VIDEO';
          status: string;
        }[];
      }[];
    },
  >(inspection: T) {
    return {
      ...inspection,
      items: inspection.items.map((item) => this.mapItemMedia(item)),
    };
  }

  private async assertOpenInspection(inspectionId: string) {
    const inspection = await this.prisma.siteInspection.findUnique({
      where: { id: inspectionId },
    });
    if (!inspection) {
      throw new NotFoundException(`Inspection ${inspectionId} not found`);
    }
    // A session moves to COMPLETED via finishInspection() - once it does,
    // its items become read-only.
    if (inspection.status !== 'OPEN') {
      throw new ConflictException(
        'This inspection session is already finished - items cannot be added or edited',
      );
    }
    return inspection;
  }

  private assertPercentageInRange(rating: string, percentage: number) {
    const range = RATING_RANGES[rating];
    if (!range) {
      throw new BadRequestException(`Unknown rating: ${rating}`);
    }
    const [min, max] = range;
    if (percentage < min || percentage > max) {
      throw new BadRequestException(
        `${percentage}% is outside ${rating}'s valid range (${min}-${max}%)`,
      );
    }
  }
}
