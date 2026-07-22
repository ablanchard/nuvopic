import { useState, useCallback } from 'preact/hooks';
import type { Photo } from '../api/client';

interface PhotoCardProps {
  photo: Photo;
  onClick?: () => void;
}

export function PhotoCard({ photo, onClick }: PhotoCardProps) {
  const [loaded, setLoaded] = useState(false);
  const [placeholderVisible, setPlaceholderVisible] = useState(true);

  // Remove the placeholder from the DOM once the opacity transition ends.
  const handleTransitionEnd = useCallback((e: TransitionEvent) => {
    if (e.propertyName === 'opacity') {
      setPlaceholderVisible(false);
    }
  }, []);

  const placeholderSrc = photo.placeholder || undefined;
  const thumbnailSrc = photo.thumbnailUrl || `/api/v1/photos/${photo.id}/thumbnail?size=512`;

  return (
    <div class="photo-card" onClick={onClick}>
      {placeholderSrc && placeholderVisible && (
        <img
          src={placeholderSrc}
          alt=""
          class="photo-card-placeholder"
          aria-hidden="true"
        />
      )}
      <img
        src={thumbnailSrc}
        alt={photo.description || 'Photo'}
        class={`photo-card-image ${loaded ? 'photo-card-image--loaded' : ''}`}
        decoding="async"
        onLoad={() => setLoaded(true)}
        onTransitionEnd={handleTransitionEnd}
      />
      {!placeholderSrc && !loaded && <div class="photo-card-empty" />}
      <div class="photo-card-overlay">
        {photo.faceCount > 0 && (
          <span class="face-badge">{photo.faceCount} face{photo.faceCount > 1 ? 's' : ''}</span>
        )}
        {photo.takenAt && (
          <span class="date-badge">
            {new Date(photo.takenAt).toLocaleDateString()}
          </span>
        )}
      </div>
    </div>
  );
}
