import { useState, useEffect, useRef } from 'preact/hooks';
import { PhotoGrid } from './PhotoGrid';
import { TagFilter } from './TagFilter';
import { PersonList } from './PersonList';
import { DateFilter } from './DateFilter';
import { resetFilters } from '../state/filters';
import { api } from '../api/client';
import type { Photo } from '../api/client';
import type { RoutableProps } from 'preact-router';

export function HomePage(_props: RoutableProps) {
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [fullImageSrc, setFullImageSrc] = useState<string | null>(null);
  const [fullImageLoaded, setFullImageLoaded] = useState(false);
  const preloadRef = useRef<HTMLImageElement | null>(null);

  // Load full-res image when modal opens
  useEffect(() => {
    if (!selectedPhoto) {
      setFullImageSrc(null);
      setFullImageLoaded(false);
      if (preloadRef.current) {
        preloadRef.current.src = '';
        preloadRef.current = null;
      }
      return;
    }

    let cancelled = false;

    api.photos.getFullImageUrl(selectedPhoto.id).then((url) => {
      if (cancelled) return;

      // Preload the full image in the background
      const img = new Image();
      preloadRef.current = img;
      img.onload = () => {
        if (!cancelled) {
          setFullImageSrc(url);
          setFullImageLoaded(true);
        }
      };
      img.onerror = () => {
        // Silently stay on thumbnail if S3 fetch fails
      };
      img.src = url;
    }).catch(() => {
      // Stay on thumbnail if presigned URL fetch fails
    });

    return () => {
      cancelled = true;
      if (preloadRef.current) {
        preloadRef.current.src = '';
        preloadRef.current = null;
      }
    };
  }, [selectedPhoto]);

  return (
    <div class="home-page">
      <div class="app-content">
        <aside class="sidebar">
          <button class="reset-filters" onClick={resetFilters}>
            Clear Filters
          </button>
          <PersonList />
          <TagFilter />
          <DateFilter />
        </aside>

        <main class="main-content">
          <PhotoGrid onPhotoClick={setSelectedPhoto} />
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
              <img
                src={fullImageLoaded && fullImageSrc ? fullImageSrc : (selectedPhoto.placeholder || selectedPhoto.thumbnailUrl)}
                alt={selectedPhoto.description || 'Photo'}
                class={`modal-image ${fullImageLoaded ? 'modal-image--full' : 'modal-image--thumbnail'}`}
              />
            </div>
            <div class="modal-info">
              {selectedPhoto.description && (
                <p class="description">{selectedPhoto.description}</p>
              )}
              {selectedPhoto.takenAt && (
                <p class="date">
                  Taken: {new Date(selectedPhoto.takenAt).toLocaleString()}
                </p>
              )}
              {selectedPhoto.location && (
                <p class="location">
                  Location: {selectedPhoto.location.name ||
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
