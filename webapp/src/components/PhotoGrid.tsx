import { useState, useRef, useCallback, useEffect } from 'preact/hooks';
import { useSignalEffect } from '@preact/signals';
import { api } from '../api/client';
import type { Photo } from '../api/client';
import { filters, filterVersion, photoSize } from '../state/filters';
import { PhotoCard } from './PhotoCard';

const PAGE_SIZE = 40;

interface PhotoGridProps {
  onPhotoClick?: (photo: Photo) => void;
}

export function PhotoGrid({ onPhotoClick }: PhotoGridProps) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const pageRef = useRef(1);
  const loadingRef = useRef(false);
  const hasMoreRef = useRef(true);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Load a page of photos. If page===1, replace; otherwise append.
  const loadPage = useCallback(async (page: number, currentFilters: Record<string, unknown>) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      const data = await api.photos.list({
        ...currentFilters,
        page,
        limit: PAGE_SIZE,
      });

      if (page === 1) {
        setPhotos(data.photos);
      } else {
        setPhotos((prev) => [...prev, ...data.photos]);
      }

      setTotal(data.pagination.total);
      hasMoreRef.current = data.pagination.hasMore;
      pageRef.current = page;
      setError(null);
    } catch (err) {
      if (page === 1) {
        setError(err instanceof Error ? err.message : 'Failed to load photos');
      }
    } finally {
      loadingRef.current = false;
      setLoading(false);
      setInitialLoad(false);
    }
  }, []);

  // When filters change, reset and load page 1
  useSignalEffect(() => {
    const currentFilters = filters.value;
    // Access filterVersion to subscribe to filter resets
    void filterVersion.value;

    setPhotos([]);
    setTotal(0);
    setInitialLoad(true);
    hasMoreRef.current = true;
    pageRef.current = 1;

    loadPage(1, currentFilters);
  });

  // Load next page (called by IntersectionObserver)
  const loadMore = useCallback(() => {
    if (loadingRef.current || !hasMoreRef.current) return;
    loadPage(pageRef.current + 1, filters.peek());
  }, [loadPage]);

  // IntersectionObserver for infinite scroll sentinel
  useEffect(() => {
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMore();
        }
      },
      { rootMargin: '400px' }
    );

    if (sentinelRef.current) {
      observerRef.current.observe(sentinelRef.current);
    }

    return () => observerRef.current?.disconnect();
  }, [loadMore]);

  // Re-observe sentinel whenever photos change (sentinel gets re-rendered)
  useEffect(() => {
    if (observerRef.current && sentinelRef.current) {
      observerRef.current.disconnect();
      observerRef.current.observe(sentinelRef.current);
    }
  }, [photos]);

  if (initialLoad) {
    return <div class="loading">Loading photos...</div>;
  }

  if (error && photos.length === 0) {
    return <div class="error">Error: {error}</div>;
  }

  if (photos.length === 0) {
    return <div class="empty">No photos found</div>;
  }

  return (
    <div class="photo-grid-container">
      <div class="photo-grid-count">{total} photos</div>
      <div
        class="photo-grid"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${photoSize.value}px, 1fr))` }}
      >
        {photos.map((photo) => (
          <PhotoCard
            key={photo.id}
            photo={photo}
            onClick={() => onPhotoClick?.(photo)}
          />
        ))}
      </div>

      {hasMoreRef.current && (
        <div ref={sentinelRef} class="scroll-sentinel">
          {loading && <div class="loading-more">Loading more photos...</div>}
        </div>
      )}
    </div>
  );
}
