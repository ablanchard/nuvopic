import { useState } from 'preact/hooks';
import { SearchBar } from './components/SearchBar';
import { PhotoGrid } from './components/PhotoGrid';
import { TagFilter } from './components/TagFilter';
import { PersonList } from './components/PersonList';
import { DateFilter } from './components/DateFilter';
import { resetFilters, photoSize } from './state/filters';
import type { Photo } from './api/client';
import './app.css';

export function App() {
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);

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
            <img
              src={selectedPhoto.thumbnailUrl}
              alt={selectedPhoto.description || 'Photo'}
              class="modal-image"
            />
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
