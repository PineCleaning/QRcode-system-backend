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

/**
 * Direct-signed-upload flow (Open Decision #6, resolved 2026-07-25): the
 * client uploads straight to Cloudinary using a signature this service
 * generates - the API secret never reaches the frontend. After upload,
 * verifyResource() confirms the asset genuinely exists in Cloudinary
 * before the feedback API (Day 2 Hr 6) trusts it and marks
 * feedback_media.status VERIFIED.
 */
@Injectable()
export class CloudinaryService {
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
}
