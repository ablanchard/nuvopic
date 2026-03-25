/**
 * Simple in-memory cache mapping photo IDs to their presigned S3 URLs.
 *
 * When PhotoCard loads a full image it stores the URL here. When the modal
 * opens for the same photo it can skip the API call and use the cached URL
 * directly — the browser already has the image bytes for that exact URL in
 * its HTTP cache, so the full image appears instantly.
 */

const cache = new Map<string, string>();

export function getImageUrl(photoId: string): string | undefined {
  return cache.get(photoId);
}

export function setImageUrl(photoId: string, url: string): void {
  cache.set(photoId, url);
}
