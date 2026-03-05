import { useRef, useEffect, useState } from 'preact/hooks';

interface FaceCropProps {
  thumbnailUrl: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  photoWidth: number | null;
  photoHeight: number | null;
  size?: number;
}

/**
 * Renders a cropped face from a photo thumbnail using canvas.
 * The bounding box is in absolute pixel coordinates of the original photo.
 * We scale it to thumbnail coordinates and crop the face region.
 */
export function FaceCrop({ thumbnailUrl, boundingBox, photoWidth, photoHeight, size = 80 }: FaceCropProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      const thumbW = img.naturalWidth;
      const thumbH = img.naturalHeight;

      // Scale bounding box from original photo coords to thumbnail coords
      const scaleX = photoWidth ? thumbW / photoWidth : 1;
      const scaleY = photoHeight ? thumbH / photoHeight : 1;

      let bx = boundingBox.x * scaleX;
      let by = boundingBox.y * scaleY;
      let bw = boundingBox.width * scaleX;
      let bh = boundingBox.height * scaleY;

      // Add padding around face (20%)
      const padX = bw * 0.2;
      const padY = bh * 0.2;
      bx = Math.max(0, bx - padX);
      by = Math.max(0, by - padY);
      bw = Math.min(thumbW - bx, bw + padX * 2);
      bh = Math.min(thumbH - by, bh + padY * 2);

      // Make it square (use the larger dimension)
      const side = Math.max(bw, bh);
      const cx = bx + bw / 2;
      const cy = by + bh / 2;
      const sx = Math.max(0, Math.min(thumbW - side, cx - side / 2));
      const sy = Math.max(0, Math.min(thumbH - side, cy - side / 2));
      const sideW = Math.min(side, thumbW - sx);
      const sideH = Math.min(side, thumbH - sy);

      canvas.width = size;
      canvas.height = size;
      ctx.drawImage(img, sx, sy, sideW, sideH, 0, 0, size, size);
      setLoaded(true);
    };

    img.onerror = () => {
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

    img.src = thumbnailUrl;
  }, [thumbnailUrl, boundingBox, photoWidth, photoHeight, size]);

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
