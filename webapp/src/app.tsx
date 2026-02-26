import { useState, useEffect, useRef } from 'preact/hooks';
import { SearchBar } from './components/SearchBar';
import { PhotoGrid } from './components/PhotoGrid';
import { TagFilter } from './components/TagFilter';
import { PersonList } from './components/PersonList';
import { DateFilter } from './components/DateFilter';
import { resetFilters, photoSize } from './state/filters';
import { api } from './api/client';
import type { Photo } from './api/client';
import './app.css';

export function App() {
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
    <div class="app">
      <header class="app-header">
        <h1>NuvoPic</h1>
        <SearchBar />
        <div class="size-slider">
          <label>Size</label>
          <input
            type="range"
            min="100"
            max="400"
            step="25"
            value={photoSize.value}
            onInput={(e) => {
              photoSize.value = parseInt((e.target as HTMLInputElement).value);
            }}
          />
        </div>
      </header>

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
            <button class="modal-close" onClick={() => setSelectedPhoto(null)}>
              &times;
            </button>
            <div class="modal-image-container">
              <img
                src={fullImageLoaded && fullImageSrc ? fullImageSrc : selectedPhoto.thumbnailUrl}
                alt={selectedPhoto.description || 'Photo'}
                class={`modal-image ${fullImageLoaded ? 'modal-image--full' : 'modal-image--thumbnail'}`}
              />
              {!fullImageLoaded && (
                <div class="modal-image-loading">Loading full resolution...</div>
              )}
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
