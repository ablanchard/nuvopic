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
