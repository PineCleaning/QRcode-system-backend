/**
 * File type/size limits, per the discovery doc's Section 5.2. Attachment
 * count is deliberately 5, not the doc's 3 - explicit user override,
 * confirmed 2026-07-25 (Open Decision #11).
 */
export const ALLOWED_IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];
export const ALLOWED_VIDEO_FORMATS = ['mp4', 'mov', 'webm'];
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
export const MAX_VIDEOS_PER_SUBMISSION = 1;

export function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}
