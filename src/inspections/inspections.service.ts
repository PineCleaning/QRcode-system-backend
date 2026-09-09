import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
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
   * concurrent requests - this check is just the common-case fast path.
   */
  async openOrResume(siteId: string, adminId: string) {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) {
      throw new NotFoundException(`Site ${siteId} not found`);
    }

    const existing = await this.prisma.siteInspection.findFirst({
      where: { siteId, status: 'OPEN' },
      include: {
        items: { include: { media: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (existing) {
      return this.mapInspectionMedia(existing);
    }

    const created = await this.prisma.siteInspection.create({
      data: { siteId, createdBy: adminId },
      include: { items: { include: { media: true } } },
    });
    return this.mapInspectionMedia(created);
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
      include: { _count: { select: { items: true } } },
    });
    return inspections.map(({ _count, ...inspection }) => ({
      ...inspection,
      itemCount: _count.items,
    }));
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
   */
  async finishInspection(inspectionId: string, adminId: string) {
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

    const ratedItems = inspection.items.filter(
      (item) => !item.isNotApplicable && item.percentage !== null,
    );
    if (ratedItems.length === 0) {
      throw new BadRequestException(
        'Add at least one rated space before finishing this inspection.',
      );
    }

    const averageScore = Math.round(
      ratedItems.reduce((sum, item) => sum + item.percentage!, 0) /
        ratedItems.length,
    );
    const meetsStandard = averageScore >= MEETS_STANDARD_THRESHOLD;

    const completed = await this.prisma.siteInspection.update({
      where: { id: inspectionId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        completedBy: adminId,
        averageScore,
        meetsStandard,
      },
      include: {
        items: { include: { media: true }, orderBy: { createdAt: 'asc' } },
      },
    });

    return this.mapInspectionMedia(completed);
  }

  async addItem(
    inspectionId: string,
    dto: CreateInspectionItemDto,
    adminId: string,
  ) {
    const inspection = await this.assertOpenInspection(inspectionId);
    if (!dto.isNotApplicable) {
      this.assertPercentageInRange(dto.rating!, dto.percentage!);
    }

    const { mediaCreates, rejectionReasons } = await this.verifyMedia(
      dto.media,
    );

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

    const { mediaCreates, rejectionReasons } = await this.verifyMedia(
      dto.media,
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
  private async verifyMedia(media: InspectionMediaDto[] | undefined) {
    const mediaCreates: InspectionMediaCreateData[] = [];
    const rejectionReasons: (string | null)[] = [];
    let totalVerifiedBytes = 0;
    let verifiedVideoCount = 0;

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
