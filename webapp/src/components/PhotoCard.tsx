import { useRef, useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../api/client';
import type { Photo } from '../api/client';
import { setImageUrl } from '../lib/imageUrlCache';

interface PhotoCardProps {
  photo: Photo;
  onClick?: () => void;
}

export function PhotoCard({ photo, onClick }: PhotoCardProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [placeholderVisible, setPlaceholderVisible] = useState(true);
  const loadingRef = useRef(false);
  const imgRef = useRef<HTMLImageElement>(null);

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
        // Preload using a detached Image so the browser caches the bytes.
        // We never set src on the visible <img> until the data is fully
        // decoded, which avoids any partial-paint flash in Firefox.
        const preload = new Image();
        preload.onload = () => {
          if (cancelled) return;
          setImageUrl(photo.id, url);
          setImageSrc(url);
          // Use double-rAF: the first rAF runs after Preact commits the
          // new src to the DOM, the second runs after the browser has
          // actually painted that frame with opacity:0. Only then do we
          // flip to opacity:1 so the CSS transition is guaranteed to fire.
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (!cancelled) setLoaded(true);
            });
          });
        };
        preload.src = url;
      }).catch(() => {
        // silently fail — keep showing placeholder
      });
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      loadingRef.current = false;
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
    <div class="photo-card" onClick={onClick}>
      {placeholderSrc && placeholderVisible && (
        <img
          src={placeholderSrc}
          alt=""
          class="photo-card-placeholder"
          aria-hidden="true"
        />
      )}
      {imageSrc && (
        <img
          ref={imgRef}
          src={imageSrc}
          alt={photo.description || 'Photo'}
          class={`photo-card-image ${loaded ? 'photo-card-image--loaded' : ''}`}
          onTransitionEnd={handleTransitionEnd}
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
