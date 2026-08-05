import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { ALLOWED_IMAGE_FORMATS, ALLOWED_VIDEO_FORMATS } from './media-limits';

export interface SignedUploadParams {
  signature: string;
  timestamp: number;
  apiKey: string;
  cloudName: string;
  folder?: string;
  /**
   * Comma-separated formats, signed as part of the request. Cloudinary
   * rejects the upload outright if the file's real format isn't in this
   * list - the frontend must send this exact string back unmodified or
   * the signature won't match. This is the first layer of file-type
   * enforcement; verifyResource() in FeedbackService is the second,
   * re-checking the real bytes/format after upload since a signed
   * request can still be replayed directly, bypassing the browser form.
   */
  allowedFormats: string;
}

export interface CloudinaryResourceInfo {
  publicId: string;
  resourceType: string;
  format: string;
  bytes: number;
}

export interface CloudinaryUsage {
  plan: string;
  storageUsedBytes: number;
  /**
   * The Free/credit-based plan has no dedicated storage cap - "1 credit"
   * covers 1,000 transformations OR 1GB storage OR 1GB bandwidth from the
   * same shared monthly pool (see cloudinary.com/pricing). This is the
   * storage-equivalent ceiling if every credit went to storage, not a
   * real separate allowance - shown for a simple at-a-glance bar, not as
   * a precise guarantee. creditsUsedPercent (overall pool usage) is also
   * returned so a caller can show the fuller picture if needed.
   */
  storageLimitBytes: number;
  creditsUsedPercent: number;
  breakdown: {
    storageCredits: number;
    bandwidthCredits: number;
    bandwidthBytes: number;
    transformationsCredits: number;
    transformationsCount: number;
  };
  totalCreditsUsed: number;
  totalCreditsLimit: number;
}

/**
 * Direct-signed-upload flow (Open Decision #6, resolved 2026-07-25): the
 * client uploads straight to Cloudinary using a signature this service
 * generates - the API secret never reaches the frontend. After upload,
 * verifyResource() confirms the asset genuinely exists in Cloudinary
 * before the feedback API (Day 2 Hr 6) trusts it and marks
 * feedback_media.status VERIFIED.
 */
const USAGE_CACHE_TTL_MS = 60_000;

@Injectable()
export class CloudinaryService {
  /**
   * cloudinary.api.usage() measured at 800-950ms per call - it's an
   * account-wide stat, not per-request data, so hitting it fresh on
   * every single Assets page load (or every parallel request on that
   * page, since the page fires this alongside two other fetches) is
   * pure waste. A 60s cache means storage/bandwidth numbers can be up
   * to a minute stale, which is fine for a dashboard widget - nobody
   * needs sub-minute precision on "how much Cloudinary storage is
   * used." A single in-flight promise is also shared across
   * concurrent callers so simultaneous requests (e.g. two admins with
   * the Assets page open at once) don't each trigger their own call.
   */
  private usageCache: { data: CloudinaryUsage; expiresAt: number } | null = null;
  private usageInFlight: Promise<CloudinaryUsage> | null = null;

  constructor(config: ConfigService) {
    cloudinary.config({
      cloud_name: config.getOrThrow('CLOUDINARY_CLOUD_NAME'),
      api_key: config.getOrThrow('CLOUDINARY_API_KEY'),
      api_secret: config.getOrThrow('CLOUDINARY_API_SECRET'),
    });
  }

  generateSignedUploadParams(folder?: string): SignedUploadParams {
    const timestamp = Math.floor(Date.now() / 1000);
    const allowedFormats = [...ALLOWED_IMAGE_FORMATS, ...ALLOWED_VIDEO_FORMATS].join(',');
    const paramsToSign: Record<string, string | number> = { timestamp, allowed_formats: allowedFormats };
    if (folder) paramsToSign.folder = folder;

    const signature = cloudinary.utils.api_sign_request(paramsToSign, cloudinary.config().api_secret!);

    return {
      signature,
      timestamp,
      apiKey: cloudinary.config().api_key!,
      cloudName: cloudinary.config().cloud_name!,
      folder,
      allowedFormats,
    };
  }

  /**
   * Delivery URL is always derived from cloud_name + public_id, never
   * stored (see feedback_media schema notes). For images, forces
   * fetch_format: 'auto' - without it, a HEIC/HEIF photo (the default
   * format on iPhone, and an accepted upload type per the discovery
   * doc) is delivered as raw HEIC, which no major browser can render in
   * an <img> tag. fetch_format: 'auto' has Cloudinary transcode to
   * whatever format the requesting browser can actually display.
   */
  buildDeliveryUrl(publicId: string, resourceType: 'image' | 'video'): string {
    return cloudinary.url(publicId, {
      resource_type: resourceType,
      secure: true,
      ...(resourceType === 'image' ? { fetch_format: 'auto' } : {}),
    });
  }

  /** Returns null if the resource doesn't exist (e.g. a spoofed/fabricated public_id) rather than throwing. */
  async verifyResource(publicId: string, resourceType: 'image' | 'video'): Promise<CloudinaryResourceInfo | null> {
    try {
      const resource = await cloudinary.api.resource(publicId, { resource_type: resourceType });
      return {
        publicId: resource.public_id,
        resourceType: resource.resource_type,
        format: resource.format,
        bytes: resource.bytes,
      };
    } catch {
      return null;
    }
  }

  /** Permanently deletes the asset from Cloudinary storage (used by the admin Assets page). */
  async destroy(publicId: string, resourceType: 'image' | 'video'): Promise<void> {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  }

  /** Read-only account usage, for the Assets page's storage status widget. Cached - see USAGE_CACHE_TTL_MS above. */
  async getUsage(): Promise<CloudinaryUsage> {
    if (this.usageCache && this.usageCache.expiresAt > Date.now()) {
      return this.usageCache.data;
    }

    // Concurrent callers within the same cache miss share one real
    // Cloudinary call instead of firing N identical requests.
    if (this.usageInFlight) {
      return this.usageInFlight;
    }

    this.usageInFlight = this.fetchUsage();
    try {
      const data = await this.usageInFlight;
      this.usageCache = { data, expiresAt: Date.now() + USAGE_CACHE_TTL_MS };
      return data;
    } finally {
      this.usageInFlight = null;
    }
  }

  private async fetchUsage(): Promise<CloudinaryUsage> {
    const usage = await cloudinary.api.usage();
    const creditsLimit = usage.credits?.limit ?? 25;
    return {
      plan: usage.plan,
      storageUsedBytes: usage.storage.usage,
      storageLimitBytes: creditsLimit * 1024 ** 3,
      creditsUsedPercent: usage.credits?.used_percent ?? 0,
      breakdown: {
        storageCredits: usage.storage.credits_usage ?? 0,
        bandwidthCredits: usage.bandwidth.credits_usage ?? 0,
        bandwidthBytes: usage.bandwidth.usage,
        transformationsCredits: usage.transformations.credits_usage ?? 0,
        transformationsCount: usage.transformations.usage,
      },
      totalCreditsUsed: usage.credits?.usage ?? 0,
      totalCreditsLimit: creditsLimit,
    };
  }
}
