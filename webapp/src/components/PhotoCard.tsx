import { useState, useCallback, useEffect } from 'preact/hooks';
import { api, type Photo } from '../api/client';
import { formatPhotoDate } from '../lib/photoDate';

interface PhotoCardProps {
  photo: Photo;
  onClick?: (thumbnailSrc: string | null) => void;
}

export function PhotoCard({ photo, onClick }: PhotoCardProps) {
  const [loaded, setLoaded] = useState(false);
  const [placeholderVisible, setPlaceholderVisible] = useState(true);
  const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    setLoaded(false);
    setPlaceholderVisible(true);
    setThumbnailSrc(null);

    api.photos.getThumbnail(photo.id).then((blob) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setThumbnailSrc(objectUrl);
    }).catch(() => {
      // Keep the placeholder visible when the thumbnail cannot be loaded.
    });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [photo.id]);

  // Remove the placeholder from the DOM once the opacity transition ends.
  const handleTransitionEnd = useCallback((e: TransitionEvent) => {
    if (e.propertyName === 'opacity') {
      setPlaceholderVisible(false);
    }
  }, []);

  const placeholderSrc = photo.placeholder || undefined;

  return (
    <div class="photo-card" onClick={() => onClick?.(thumbnailSrc)}>
      {placeholderSrc && placeholderVisible && (
        <img
          src={placeholderSrc}
          alt=""
          class="photo-card-placeholder"
          aria-hidden="true"
        />
      )}
      {thumbnailSrc && (
        <img
          src={thumbnailSrc}
          alt={photo.description || 'Photo'}
          class={`photo-card-image ${loaded ? 'photo-card-image--loaded' : ''}`}
          decoding="async"
          onLoad={() => setLoaded(true)}
          onTransitionEnd={handleTransitionEnd}
        />
      )}
      {!placeholderSrc && !loaded && <div class="photo-card-empty" />}
      <div class="photo-card-overlay">
        {photo.faceCount > 0 && (
          <span class="face-badge">{photo.faceCount} face{photo.faceCount > 1 ? 's' : ''}</span>
        )}
        <span class="date-badge">{formatPhotoDate(photo)}</span>
      </div>
    </div>
  );
}
