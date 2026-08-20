import { useRef, useEffect, useState } from 'preact/hooks';
import { whenNearViewport } from '../lib/nearViewport';
import { loadFaceThumbnail } from '../lib/faceThumbnailLoader';

interface FaceCropProps {
  faceId: string;
  photoId: string;
  size?: number;
}

/**
 * Loads a small, authenticated face crop generated and cached by the backend.
 * Fetching starts only when the image is close to the viewport.
 */
export function FaceCrop({ faceId, photoId, size = 80 }: FaceCropProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const image = imageRef.current;
    if (!image) return;

    return whenNearViewport(image, () => setNearViewport(true));
  }, []);

  useEffect(() => {
    if (!nearViewport) return;
    const controller = new AbortController();
    let cancelled = false;
    let objectUrl: string | null = null;
    setLoaded(false);
    setSrc(null);

    loadFaceThumbnail(photoId, faceId, Math.max(size, 96), controller.signal)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [nearViewport, photoId, faceId, size]);

  return (
    <img
      ref={imageRef}
      class={`face-crop ${loaded ? 'face-crop--loaded' : ''}`}
      src={src ?? undefined}
      alt="Face"
      decoding="async"
      width={size}
      height={size}
      style={{ width: `${size}px`, height: `${size}px` }}
      onLoad={() => setLoaded(true)}
      onError={() => setLoaded(false)}
    />
  );
}
