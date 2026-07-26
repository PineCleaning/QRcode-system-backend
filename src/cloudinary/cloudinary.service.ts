import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';

export interface SignedUploadParams {
  signature: string;
  timestamp: number;
  apiKey: string;
  cloudName: string;
  folder?: string;
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
    const paramsToSign = folder ? { timestamp, folder } : { timestamp };

    const signature = cloudinary.utils.api_sign_request(paramsToSign, cloudinary.config().api_secret!);

    return {
      signature,
      timestamp,
      apiKey: cloudinary.config().api_key!,
      cloudName: cloudinary.config().cloud_name!,
      folder,
    };
  }

  /** Delivery URL is always derived from cloud_name + public_id, never stored (see feedback_media schema notes). */
  buildDeliveryUrl(publicId: string, resourceType: 'image' | 'video'): string {
    return cloudinary.url(publicId, { resource_type: resourceType, secure: true });
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
