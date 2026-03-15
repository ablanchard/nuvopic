import sharp from "sharp";

export interface ThumbnailResult {
  buffer: Buffer;
  width: number;
  height: number;
  format: string;
}

export async function generateThumbnail(
  imageBuffer: Buffer,
  size: number = 300
): Promise<ThumbnailResult> {
  const result = await sharp(imageBuffer)
    .rotate() // Auto-rotate based on EXIF orientation
    .resize(size, size, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({
      quality: 50,
    })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: result.data,
    width: result.info.width,
    height: result.info.height,
    format: result.info.format,
  };
}

/**
 * Generate a tiny placeholder image (16x16 WebP) encoded as a base64 data URI.
 * This captures the dominant colors/shapes of the photo in ~150-300 bytes,
 * suitable for inline embedding in JSON responses as an instant preview.
 */
export async function generatePlaceholder(
  imageBuffer: Buffer,
  size: number = 16
): Promise<string> {
  const buffer = await sharp(imageBuffer)
    .rotate()
    .resize(size, size, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({
      quality: 20,
      nearLossless: false,
      smartSubsample: true,
    })
    .toBuffer();

  return `data:image/webp;base64,${buffer.toString("base64")}`;
}
