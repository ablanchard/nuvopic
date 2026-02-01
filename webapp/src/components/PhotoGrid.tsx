import { useState } from 'preact/hooks';
import { useSignalEffect } from '@preact/signals';
import { api } from '../api/client';
import type { Photo, PhotoListResponse } from '../api/client';
import { filters, setPage } from '../state/filters';
import { PhotoCard } from './PhotoCard';

interface PhotoGridProps {
  onPhotoClick?: (photo: Photo) => void;
}

export function PhotoGrid({ onPhotoClick }: PhotoGridProps) {
  const [data, setData] = useState<PhotoListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useSignalEffect(() => {
    const currentFilters = filters.value;
    setLoading(true);
    setError(null);

    api.photos.list(currentFilters)
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  });

  if (loading && !data) {
    return <div class="loading">Loading photos...</div>;
  }

  if (error) {
    return <div class="error">Error: {error}</div>;
  }

  if (!data || data.photos.length === 0) {
    return <div class="empty">No photos found</div>;
  }

  return (
    <div class="photo-grid-container">
      <div class="photo-grid">
        {data.photos.map((photo) => (
          <PhotoCard
            key={photo.id}
            photo={photo}
            onClick={() => onPhotoClick?.(photo)}
          />
        ))}
      </div>

      {data.pagination.total > data.pagination.limit && (
        <div class="pagination">
          <button
            disabled={data.pagination.page <= 1}
            onClick={() => setPage(data.pagination.page - 1)}
          >
            Previous
          </button>
          <span>
            Page {data.pagination.page} of{' '}
            {Math.ceil(data.pagination.total / data.pagination.limit)}
          </span>
          <button
            disabled={!data.pagination.hasMore}
            onClick={() => setPage(data.pagination.page + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
