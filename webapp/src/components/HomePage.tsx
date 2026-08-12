import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { PhotoGrid } from './PhotoGrid';
import { SearchBar } from './SearchBar';
import { SizeSlider } from './SizeSlider';
import { TagFilter } from './TagFilter';
import { PersonList } from './PersonList';
import { DateFilter } from './DateFilter';
import { LocationFilter } from './LocationFilter';
import { SmartTagFilter } from './SmartTagFilter';
import { FilteredPhotoActions } from './FilteredPhotoActions';
import {
  DEFAULT_PHOTO_SIZE,
  MOBILE_DEFAULT_PHOTO_SIZE,
  photoSize,
  resetFilters,
  dateUnknown,
  filterVersion,
} from '../state/filters';
import { api } from '../api/client';
import { getImageUrl, setImageUrl } from '../lib/imageUrlCache';
import { formatPhotoDate } from '../lib/photoDate';
import type { Photo } from '../api/client';
import type { RoutableProps } from 'preact-router';

export function HomePage(_props: RoutableProps) {
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null);
  const [fullImageSrc, setFullImageSrc] = useState<string | null>(null);
  const [fullImageLoaded, setFullImageLoaded] = useState(false);
  const [fullImageFailed, setFullImageFailed] = useState(false);
  const [filteredPhotoCount, setFilteredPhotoCount] = useState<number | null>(null);
  const [unknownDateCount, setUnknownDateCount] = useState<number | null>(null);
  const previewObjectUrlRef = useRef<string | null>(null);

  const refreshUnknownDateCount = useCallback(() => {
    api.photos.timeline({ dateUnknown: true }).then((data) => {
      setUnknownDateCount(data.total);
      if (data.total === 0 && dateUnknown.value) {
        dateUnknown.value = false;
        filterVersion.value++;
      }
    }).catch(() => {
      setUnknownDateCount(null);
    });
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('home-route-active');
    refreshUnknownDateCount();

    return () => {
      document.documentElement.classList.remove('home-route-active');
    };
  }, [refreshUnknownDateCount]);

  useEffect(() => {
    const mobileQuery = window.matchMedia('(max-width: 768px)');

    const applyMobileDefault = () => {
      if (
        mobileQuery.matches &&
        (
          photoSize.value === DEFAULT_PHOTO_SIZE ||
          photoSize.value === 150 ||
          photoSize.value === 125 ||
          photoSize.value === 75
        )
      ) {
        photoSize.value = MOBILE_DEFAULT_PHOTO_SIZE;
      }
    };

    applyMobileDefault();
    mobileQuery.addEventListener('change', applyMobileDefault);

    return () => {
      mobileQuery.removeEventListener('change', applyMobileDefault);
    };
  }, []);

  const openPhoto = (photo: Photo, thumbnailSrc: string | null) => {
    setPreviewImageSrc(thumbnailSrc);
    setSelectedPhoto(photo);
  };

  // Keep a lightweight preview visible while the original image downloads.
  useEffect(() => {
    if (!selectedPhoto) {
      setPreviewImageSrc(null);
      setFullImageSrc(null);
      setFullImageLoaded(false);
      setFullImageFailed(false);
      if (previewObjectUrlRef.current) {
        URL.revokeObjectURL(previewObjectUrlRef.current);
        previewObjectUrlRef.current = null;
      }
      return;
    }

    const photoId = selectedPhoto.id;
    let cancelled = false;

    setFullImageLoaded(false);
    setFullImageFailed(false);

    // The clicked card normally supplies its already-loaded thumbnail. If it
    // was clicked before loading, fetch the same cache-friendly preview.
    if (!previewImageSrc) {
      api.photos.getThumbnail(photoId).then((blob) => {
        if (cancelled) return;
        const objectUrl = URL.createObjectURL(blob);
        previewObjectUrlRef.current = objectUrl;
        setPreviewImageSrc(objectUrl);
      }).catch(() => {
        // The tiny embedded placeholder remains available as the first stage.
      });
    }

    // Start the original image request immediately. Rendering it directly lets
    // browsers display progressive JPEG scans while the preview stays beneath.
    const cachedUrl = getImageUrl(selectedPhoto.id);
    if (cachedUrl) {
      setFullImageSrc(cachedUrl);
    } else {
      setFullImageSrc(null);
      api.photos.getFullImageUrl(photoId).then((url) => {
        if (cancelled) return;
        setImageUrl(photoId, url);
        setFullImageSrc(url);
      }).catch(() => {
        if (!cancelled) setFullImageFailed(true);
      });
    }

    return () => {
      cancelled = true;
      if (previewObjectUrlRef.current) {
        URL.revokeObjectURL(previewObjectUrlRef.current);
        previewObjectUrlRef.current = null;
      }
    };
  }, [selectedPhoto?.id]);

  const renderFilterControls = (includePrimaryControls = false) => (
    <>
      {includePrimaryControls && (
        <div class="mobile-primary-controls">
          <SearchBar />
          <SizeSlider />
        </div>
      )}
      <button class="reset-filters" onClick={resetFilters}>
        Clear Filters
      </button>
      <SmartTagFilter />
      <PersonList />
      <TagFilter />
      <LocationFilter />
      <DateFilter hasUnknownDates={(unknownDateCount ?? 0) > 0} />
      <FilteredPhotoActions
        photoCount={filteredPhotoCount}
        onPhotosChanged={refreshUnknownDateCount}
      />
    </>
  );

  return (
    <div class="home-page">
      <div class="app-content">
        <details class="mobile-filter-drawer">
          <summary class="mobile-filter-summary">
            <span>Filters & Search</span>
          </summary>
          <div class="mobile-filter-panel">
            {renderFilterControls(true)}
          </div>
        </details>

        <aside class="sidebar desktop-filters-sidebar">
          {renderFilterControls(false)}
        </aside>

        <main class="main-content">
          <PhotoGrid
            onPhotoClick={openPhoto}
            onTotalChange={setFilteredPhotoCount}
          />
        </main>
      </div>

      {selectedPhoto && (
        <div class="modal-overlay" onClick={() => setSelectedPhoto(null)}>
          <div class="modal" onClick={(e) => e.stopPropagation()}>
            <div
              class="modal-image-container"
              style={selectedPhoto.width && selectedPhoto.height
                ? `aspect-ratio: ${selectedPhoto.width} / ${selectedPhoto.height}`
                : undefined}
            >
              {!fullImageLoaded && (previewImageSrc || selectedPhoto.placeholder) && (
                <img
                  src={previewImageSrc || selectedPhoto.placeholder || undefined}
                  alt={selectedPhoto.description || 'Photo'}
                  class={`modal-image modal-image--preview ${previewImageSrc ? '' : 'modal-image--placeholder'}`}
                />
              )}
              {fullImageSrc && (
                <img
                  src={fullImageSrc}
                  alt={selectedPhoto.description || 'Photo'}
                  class="modal-image modal-image--original"
                  decoding="async"
                  onLoad={() => setFullImageLoaded(true)}
                  onError={() => {
                    setFullImageSrc(null);
                    setFullImageFailed(true);
                  }}
                />
              )}
              {!fullImageLoaded && !fullImageFailed && (
                <span class="modal-image-status" role="status">Loading full resolution…</span>
              )}
              {fullImageFailed && (
                <span class="modal-image-status modal-image-status--error">Full resolution unavailable</span>
              )}
            </div>
            <div class="modal-info">
              {selectedPhoto.description && (
                <p class="description">{selectedPhoto.description}</p>
              )}
              <p class="date">
                Taken: {formatPhotoDate(selectedPhoto, true)}
              </p>
              {selectedPhoto.location && (
                <p class="location">
                  Location: {[
                    selectedPhoto.location.name,
                    selectedPhoto.location.region,
                    selectedPhoto.location.country,
                  ].filter(Boolean).join(', ') ||
                    `${selectedPhoto.location.lat.toFixed(4)}, ${selectedPhoto.location.lng.toFixed(4)}`}
                </p>
              )}
              {selectedPhoto.faceCount > 0 && (
                <p class="faces">
                  {selectedPhoto.faceCount} face{selectedPhoto.faceCount > 1 ? 's' : ''} detected
                </p>
              )}
              {selectedPhoto.tags.length > 0 && (
                <div class="tags">
                  {selectedPhoto.tags.map((tag) => (
                    <span key={tag} class="tag">{tag}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
