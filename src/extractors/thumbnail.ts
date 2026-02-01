import sharp from "sharp";

export interface ThumbnailResult {
  buffer: Buffer;
  width: number;
  height: number;
  format: string;
}

export async function generateThumbnail(
  imageBuffer: Buffer,
  size: number = 200
): Promise<ThumbnailResult> {
  const result = await sharp(imageBuffer)
    .rotate() // Auto-rotate based on EXIF orientation
    .resize(size, size, {
      fit: "cover",
      position: "centre",
    })
    .jpeg({
      quality: 80,
      progressive: true,
    })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: result.data,
    width: result.info.width,
    height: result.info.height,
    format: result.info.format,
  };
}
