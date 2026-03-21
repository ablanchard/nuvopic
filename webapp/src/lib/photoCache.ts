import { api } from '../api/client';
import type { Photo, PhotoFilters } from '../api/client';

/** Max number of month sections to keep in cache */
const MAX_CACHED_SECTIONS = 30;

interface CacheEntry {
  photos: Photo[];
  lastAccessed: number;
}

/**
 * Manages fetching and caching photo data by month section.
 * Photos are fetched per-month using date range filters and cached
 * in a bounded LRU-style map.
 */
export class PhotoCache {
  private cache = new Map<string, CacheEntry>();
  private pending = new Map<string, Promise<Photo[]>>();
  private baseFilters: Omit<PhotoFilters, 'page' | 'limit' | 'from' | 'to'> = {};

  setFilters(filters: Omit<PhotoFilters, 'page' | 'limit' | 'from' | 'to'>) {
    // If filters changed, clear everything
    const key = JSON.stringify(filters);
    const prevKey = JSON.stringify(this.baseFilters);
    if (key !== prevKey) {
      this.cache.clear();
      this.pending.clear();
      this.baseFilters = filters;
    }
  }

  /**
   * Get photos for a section. Returns cached data immediately if available,
   * otherwise triggers a fetch and returns null.
   */
  get(sectionKey: string): Photo[] | null {
    const entry = this.cache.get(sectionKey);
    if (entry) {
      entry.lastAccessed = Date.now();
      return entry.photos;
    }
    return null;
  }

  /**
   * Ensure a section is being fetched. If not cached and not pending,
   * starts a fetch. Returns a promise that resolves when data is available.
   */
  async ensure(sectionKey: string, photoCount: number): Promise<Photo[]> {
    // Already cached
    const cached = this.get(sectionKey);
    if (cached) return cached;

    // Already fetching
    const pending = this.pending.get(sectionKey);
    if (pending) return pending;

    // Start fetch
    const promise = this.fetchSection(sectionKey, photoCount);
    this.pending.set(sectionKey, promise);

    try {
      const photos = await promise;
      this.cache.set(sectionKey, { photos, lastAccessed: Date.now() });
      this.evict();
      return photos;
    } finally {
      this.pending.delete(sectionKey);
    }
  }

  /**
   * Request prefetch for a section (fire and forget).
   */
  prefetch(sectionKey: string, photoCount: number) {
    if (this.cache.has(sectionKey) || this.pending.has(sectionKey)) return;
    this.ensure(sectionKey, photoCount).catch(() => {/* ignore prefetch errors */});
  }

  /**
   * Check if a section is currently being fetched.
   */
  isPending(sectionKey: string): boolean {
    return this.pending.has(sectionKey);
  }

  clear() {
    this.cache.clear();
    this.pending.clear();
  }

  private async fetchSection(sectionKey: string, photoCount: number): Promise<Photo[]> {
    if (sectionKey === 'undated') {
      // Fetch photos with no taken_at -- use a special filter
      // The backend sorts by taken_at DESC NULLS LAST, so undated photos
      // are at the end. We fetch them by requesting a large page.
      // For a proper solution we'd need a backend param, but we can
      // approximate by using a very old from date + limit.
      const data = await api.photos.list({
        ...this.baseFilters,
        page: 1,
        limit: Math.min(photoCount, 100),
      });
      // Filter client-side for those without takenAt
      return data.photos.filter((p) => !p.takenAt);
    }

    // Parse "YYYY-MM" key
    const [yearStr, monthStr] = sectionKey.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);

    // Build date range for the month
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const to = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}T23:59:59`;

    // Fetch all photos for this month (may need multiple pages)
    const allPhotos: Photo[] = [];
    let page = 1;
    const pageSize = 100;

    while (allPhotos.length < photoCount) {
      const data = await api.photos.list({
        ...this.baseFilters,
        from,
        to,
        page,
        limit: pageSize,
      });

      allPhotos.push(...data.photos);

      if (!data.pagination.hasMore || data.photos.length === 0) break;
      page++;
    }

    return allPhotos;
  }

  private evict() {
    if (this.cache.size <= MAX_CACHED_SECTIONS) return;

    // Remove the least recently accessed entries
    const entries = Array.from(this.cache.entries())
      .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

    const toRemove = entries.slice(0, this.cache.size - MAX_CACHED_SECTIONS);
    for (const [key] of toRemove) {
      this.cache.delete(key);
    }
  }
}
