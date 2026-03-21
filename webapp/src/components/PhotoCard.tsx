import { useRef, useState, useEffect } from 'preact/hooks';
import { api } from '../api/client';
import type { Photo } from '../api/client';

interface PhotoCardProps {
  photo: Photo;
  onClick?: () => void;
}

export function PhotoCard({ photo, onClick }: PhotoCardProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const loadingRef = useRef(false);

  // Wait 500ms after mount before loading the full image from S3.
  // This prevents firing S3 requests for cards that are only briefly
  // visible while the user is actively scrolling.
  useEffect(() => {
    let cancelled = false;

    const timer = setTimeout(() => {
      if (cancelled || loadingRef.current) return;
      loadingRef.current = true;

      api.photos.getFullImageUrl(photo.id).then((url) => {
        if (cancelled) return;
        const img = new Image();
        img.onload = () => {
          if (!cancelled) {
            setImageSrc(url);
            setLoaded(true);
          }
        };
        img.onerror = () => {
          if (!cancelled) {
            setImageSrc(photo.thumbnailUrl);
            setLoaded(true);
          }
        };
        img.src = url;
      }).catch(() => {
        if (!cancelled) {
          setImageSrc(photo.thumbnailUrl);
          setLoaded(true);
        }
      });
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      loadingRef.current = false;
    };
  }, [photo.id, photo.thumbnailUrl]);

  const placeholderSrc = photo.placeholder || undefined;

  return (
    <div class="photo-card" onClick={onClick}>
      {placeholderSrc && !loaded && (
        <img
          src={placeholderSrc}
          alt=""
          class="photo-card-placeholder"
          aria-hidden="true"
        />
      )}
      {imageSrc && (
        <img
          src={imageSrc}
          alt={photo.description || 'Photo'}
          class={`photo-card-image ${loaded ? 'photo-card-image--loaded' : ''}`}
        />
      )}
      {!placeholderSrc && !imageSrc && (
        <div class="photo-card-empty" />
      )}
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
