/**
 * Short-lived in-memory cache mapping photo IDs to their presigned S3 URLs.
 *
 * Presigned URLs expire after 15 minutes, so entries are discarded a little
 * earlier. Reopening a photo during that window can reuse both the URL and the
 * browser's HTTP cache.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  url: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function getImageUrl(photoId: string): string | undefined {
  const entry = cache.get(photoId);
  if (!entry) return undefined;

  if (entry.expiresAt <= Date.now()) {
    cache.delete(photoId);
    return undefined;
  }

  return entry.url;
}

export function setImageUrl(photoId: string, url: string): void {
  cache.set(photoId, {
    url,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}
