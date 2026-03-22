import { useRef, useEffect, useState } from 'preact/hooks';
import { api } from '../api/client';

interface FaceCropProps {
  photoId: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  photoWidth: number | null;
  photoHeight: number | null;
  size?: number;
}

/**
 * Renders a cropped face from a photo using canvas.
 * Fetches the full S3 presigned URL for the photo and crops the face region.
 * The bounding box is in absolute pixel coordinates of the original photo.
 */
export function FaceCrop({ photoId, boundingBox, photoWidth, photoHeight, size = 80 }: FaceCropProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let cancelled = false;

    // Fetch the presigned URL, then load the image
    api.photos.getFullImageUrl(photoId).then((url) => {
      if (cancelled) return;

      const img = new Image();

      img.onload = () => {
        if (cancelled) return;

        const imgW = img.naturalWidth;
        const imgH = img.naturalHeight;

        // Scale bounding box from original photo coords to loaded image coords
        const scaleX = photoWidth ? imgW / photoWidth : 1;
        const scaleY = photoHeight ? imgH / photoHeight : 1;

        let bx = boundingBox.x * scaleX;
        let by = boundingBox.y * scaleY;
        let bw = boundingBox.width * scaleX;
        let bh = boundingBox.height * scaleY;

        // Add padding around face (20%)
        const padX = bw * 0.2;
        const padY = bh * 0.2;
        bx = Math.max(0, bx - padX);
        by = Math.max(0, by - padY);
        bw = Math.min(imgW - bx, bw + padX * 2);
        bh = Math.min(imgH - by, bh + padY * 2);

        // Make it square (use the larger dimension)
        const side = Math.max(bw, bh);
        const cx = bx + bw / 2;
        const cy = by + bh / 2;
        const sx = Math.max(0, Math.min(imgW - side, cx - side / 2));
        const sy = Math.max(0, Math.min(imgH - side, cy - side / 2));
        const sideW = Math.min(side, imgW - sx);
        const sideH = Math.min(side, imgH - sy);

        canvas.width = size;
        canvas.height = size;
        ctx.drawImage(img, sx, sy, sideW, sideH, 0, 0, size, size);
        setLoaded(true);
      };

      img.onerror = () => {
        if (cancelled) return;
        // Show placeholder on error
        canvas.width = size;
        canvas.height = size;
        ctx.fillStyle = '#e0e0e0';
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#999';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('?', size / 2, size / 2 + 4);
      };

      img.src = url;
    }).catch(() => {
      if (cancelled) return;
      // Show placeholder on fetch error
      canvas.width = size;
      canvas.height = size;
      ctx.fillStyle = '#e0e0e0';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#999';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('?', size / 2, size / 2 + 4);
    });

    return () => {
      cancelled = true;
    };
  }, [photoId, boundingBox, photoWidth, photoHeight, size]);

  return (
    <canvas
      ref={canvasRef}
      class={`face-crop ${loaded ? 'face-crop--loaded' : ''}`}
      width={size}
      height={size}
      style={{ width: `${size}px`, height: `${size}px` }}
    />
  );
}
