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
  const cardRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingRef.current && !imageSrc) {
          loadingRef.current = true;
          // Fetch presigned S3 URL and preload the image
          api.photos.getFullImageUrl(photo.id).then((url) => {
            const img = new Image();
            img.onload = () => {
              setImageSrc(url);
              setLoaded(true);
            };
            img.onerror = () => {
              // Fallback to the DB thumbnail if S3 fails
              setImageSrc(photo.thumbnailUrl);
              setLoaded(true);
            };
            img.src = url;
          }).catch(() => {
            // Fallback to the DB thumbnail if presigned URL fetch fails
            setImageSrc(photo.thumbnailUrl);
            setLoaded(true);
          });
        }
      },
      { rootMargin: '200px' }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [photo.id, photo.thumbnailUrl, imageSrc]);

  const placeholderSrc = photo.placeholder || undefined;

  return (
    <div class="photo-card" onClick={onClick} ref={cardRef}>
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
