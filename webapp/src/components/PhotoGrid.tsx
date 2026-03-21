import type { VNode } from 'preact';
import { useState, useRef, useCallback, useEffect, useMemo } from 'preact/hooks';
import { useSignalEffect } from '@preact/signals';
import { api } from '../api/client';
import type { Photo } from '../api/client';
import type { TimelineGroup } from '../api/client';
import { filters, filterVersion, photoSize } from '../state/filters';
import { PhotoCard } from './PhotoCard';
import { TimelineScrollbar } from './TimelineScrollbar';
import {
  computeLayout,
  getVisibleRange,
  getRowY,
  getYears,
  SECTION_HEADER_HEIGHT,
  ROW_GAP,
} from '../lib/gridLayout';
import type { GridLayout } from '../lib/gridLayout';
import { PhotoCache } from '../lib/photoCache';

interface PhotoGridProps {
  onPhotoClick?: (photo: Photo) => void;
}

export function PhotoGrid({ onPhotoClick }: PhotoGridProps) {
  const [timelineGroups, setTimelineGroups] = useState<TimelineGroup[]>([]);
  const [totalPhotos, setTotalPhotos] = useState(0);
  const [initialLoad, setInitialLoad] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  // Incrementing counter to force re-render when cache is updated
  const [, setCacheVersion] = useState(0);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const photoCacheRef = useRef(new PhotoCache());
  const rafRef = useRef<number>(0);
  const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Compute column count from container width and photo size
  const columnCount = useMemo(() => {
    if (containerWidth === 0) return 4; // default
    const size = photoSize.value;
    return Math.max(1, Math.floor(containerWidth / size));
  }, [containerWidth, photoSize.value]);

  const rowHeight = photoSize.value;

  // Compute layout from timeline groups
  const layout: GridLayout = useMemo(() => {
    if (timelineGroups.length === 0) {
      return { sections: [], totalHeight: 0, totalPhotos: 0 };
    }
    return computeLayout(timelineGroups, columnCount, rowHeight);
  }, [timelineGroups, columnCount, rowHeight]);

  const years = useMemo(() => getYears(layout), [layout]);

  // Load timeline index when filters change
  useSignalEffect(() => {
    const currentFilters = filters.value;
    void filterVersion.value;

    setInitialLoad(true);
    setTimelineGroups([]);
    setTotalPhotos(0);

    // Update cache filters
    photoCacheRef.current.setFilters({
      search: currentFilters.search || undefined,
      tag: currentFilters.tag || undefined,
      person: currentFilters.person || undefined,
    });

    api.photos.timeline({
      search: currentFilters.search || undefined,
      tag: currentFilters.tag || undefined,
      person: currentFilters.person || undefined,
      from: currentFilters.from || undefined,
      to: currentFilters.to || undefined,
    }).then((data) => {
      setTimelineGroups(data.groups);
      setTotalPhotos(data.total);
      setError(null);
    }).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load timeline');
    }).finally(() => {
      setInitialLoad(false);
    });
  });

  // Observe container size
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setViewportHeight(entry.contentRect.height);
        setContainerWidth(entry.contentRect.width);
      }
    });

    ro.observe(el);
    setViewportHeight(el.clientHeight);
    setContainerWidth(el.clientWidth);

    return () => ro.disconnect();
  }, []);

  // Scroll handler with rAF throttling
  const handleScroll = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const el = scrollContainerRef.current;
      if (el) setScrollTop(el.scrollTop);
    });
  }, []);

  // Compute visible range
  const visibleRange = useMemo(
    () => getVisibleRange(layout, scrollTop, viewportHeight, rowHeight, 5),
    [layout, scrollTop, viewportHeight, rowHeight],
  );

  // Trigger fetches for visible sections + prefetch neighbors.
  // Debounced by 500ms so we only fetch after scrolling settles.
  useEffect(() => {
    if (fetchDebounceRef.current) {
      clearTimeout(fetchDebounceRef.current);
    }

    fetchDebounceRef.current = setTimeout(() => {
      const cache = photoCacheRef.current;
      const visibleKeys = new Set<string>();

      for (const { section } of visibleRange.sections) {
        visibleKeys.add(section.key);

        // Ensure this section's data is loading/loaded
        if (!cache.get(section.key) && !cache.isPending(section.key)) {
          cache.ensure(section.key, section.photoCount).then(() => {
            setCacheVersion((v) => v + 1);
          });
        }
      }

      // Prefetch adjacent sections
      const allKeys = layout.sections.map((s) => s.key);
      for (const { section } of visibleRange.sections) {
        const idx = allKeys.indexOf(section.key);
        for (const offset of [-1, 1]) {
          const neighbor = layout.sections[idx + offset];
          if (neighbor && !visibleKeys.has(neighbor.key)) {
            cache.prefetch(neighbor.key, neighbor.photoCount);
          }
        }
      }
    }, 500);

    return () => {
      if (fetchDebounceRef.current) {
        clearTimeout(fetchDebounceRef.current);
      }
    };
  }, [visibleRange, layout]);

  // Handle scrollbar jump
  const handleScrollTo = useCallback((y: number) => {
    const el = scrollContainerRef.current;
    if (el) {
      el.scrollTop = y;
      setScrollTop(y);
    }
  }, []);

  const cache = photoCacheRef.current;

  // Determine overlay content (shown inside the always-rendered grid container)
  let overlayContent: VNode | null = null;
  if (initialLoad) {
    overlayContent = <div class="loading">Loading photos...</div>;
  } else if (error && timelineGroups.length === 0) {
    overlayContent = <div class="error">Error: {error}</div>;
  } else if (totalPhotos === 0) {
    overlayContent = <div class="empty">No photos found</div>;
  }

  return (
    <div class="photo-grid-container">
      {!overlayContent && <div class="photo-grid-count">{totalPhotos} photos</div>}
      <div class="photo-grid-viewport-wrapper">
        <div
          ref={scrollContainerRef}
          class="photo-grid-viewport"
          onScroll={handleScroll}
        >
          {overlayContent || (
          <div
            class="photo-grid-spacer"
            style={{ height: `${layout.totalHeight}px` }}
          >
            {visibleRange.sections.map(({ section, firstRow, lastRow }) => {
              const photos = cache.get(section.key);
              const isHeaderVisible = (
                section.startY < scrollTop + viewportHeight + 5 * (rowHeight + ROW_GAP) &&
                section.startY + SECTION_HEADER_HEIGHT > scrollTop - 5 * (rowHeight + ROW_GAP)
              );

              return (
                <div key={section.key}>
                  {/* Section header */}
                  {isHeaderVisible && (
                    <div
                      class="grid-section-header"
                      style={{
                        position: 'absolute',
                        top: `${section.startY}px`,
                        left: 0,
                        right: 0,
                        height: `${SECTION_HEADER_HEIGHT}px`,
                      }}
                    >
                      <h3>{section.label}</h3>
                      <span class="grid-section-count">{section.photoCount} photos</span>
                    </div>
                  )}

                  {/* Photo rows */}
                  {firstRow >= 0 && lastRow >= 0 && Array.from(
                    { length: lastRow - firstRow + 1 },
                    (_, i) => {
                      const rowIndex = firstRow + i;
                      const rowY = getRowY(section, rowIndex, rowHeight);
                      const startPhotoIdx = rowIndex * columnCount;
                      const endPhotoIdx = Math.min(startPhotoIdx + columnCount, section.photoCount);

                      return (
                        <div
                          key={`${section.key}-row-${rowIndex}`}
                          class="photo-grid-row"
                          style={{
                            position: 'absolute',
                            top: `${rowY}px`,
                            left: 0,
                            right: 0,
                            height: `${rowHeight}px`,
                            display: 'grid',
                            gridTemplateColumns: `repeat(${columnCount}, ${rowHeight}px)`,
                            gap: `${ROW_GAP}px`,
                          }}
                        >
                          {photos
                            ? Array.from({ length: endPhotoIdx - startPhotoIdx }, (_, j) => {
                              const photo = photos[startPhotoIdx + j];
                              if (!photo) {
                                return <div key={j} class="photo-card-skeleton" />;
                              }
                              return (
                                <PhotoCard
                                  key={photo.id}
                                  photo={photo}
                                  onClick={() => onPhotoClick?.(photo)}
                                />
                              );
                            })
                            : Array.from({ length: endPhotoIdx - startPhotoIdx }, (_, j) => (
                              <div key={j} class="photo-card-skeleton" />
                            ))
                          }
                        </div>
                      );
                    },
                  )}
                </div>
              );
            })}
          </div>
          )}
        </div>
        {!overlayContent && <TimelineScrollbar
          years={years}
          layout={layout}
          scrollTop={scrollTop}
          viewportHeight={viewportHeight}
          onScrollTo={handleScrollTo}
        />}
      </div>
    </div>
  );
}
