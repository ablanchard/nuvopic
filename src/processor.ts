import { getObjectAsBuffer, getS3Path } from "./s3/client.js";
import {
  extractExif,
  generateThumbnail,
  generateCaption,
  detectFaces,
} from "./extractors/index.js";
import {
  insertPhoto,
  insertFace,
  deleteFacesByPhotoId,
  getPhotoByS3Path,
} from "./db/queries.js";
import { logger } from "./logger.js";

export interface ProcessPhotoInput {
  s3Bucket: string;
  s3Key: string;
}

export interface ProcessPhotoOutput {
  photoId: string;
  s3Path: string;
  takenAt: Date | null;
  location: { lat: number; lng: number } | null;
  description: string | null;
  facesDetected: number;
  thumbnailSize: number;
  errors: string[];
}

export async function processPhoto(
  input: ProcessPhotoInput
): Promise<ProcessPhotoOutput> {
  const { s3Bucket, s3Key } = input;
  const s3Path = getS3Path(s3Bucket, s3Key);
  const errors: string[] = [];

  logger.info(`Processing photo: ${s3Path}`);

  // Download image from S3
  const imageBuffer = await getObjectAsBuffer(s3Bucket, s3Key);
  logger.debug(`Downloaded ${imageBuffer.length} bytes`);

  // Run extractors in parallel where possible
  const [exifResult, thumbnailResult, captionResult, facesResult] =
    await Promise.allSettled([
      extractExif(imageBuffer),
      generateThumbnail(imageBuffer),
      generateCaption(imageBuffer),
      detectFaces(imageBuffer),
    ]);

  // Extract results, collecting errors
  const exif =
    exifResult.status === "fulfilled"
      ? exifResult.value
      : (errors.push(`EXIF: ${exifResult.reason}`), logger.error("EXIF error:", exifResult.reason), { takenAt: null, location: null });

  const thumbnail =
    thumbnailResult.status === "fulfilled"
      ? thumbnailResult.value
      : (errors.push(`Thumbnail: ${thumbnailResult.reason}`), logger.error("Thumbnail error:", thumbnailResult.reason), null);

  const caption =
    captionResult.status === "fulfilled"
      ? captionResult.value
      : (errors.push(`Caption: ${captionResult.reason}`), logger.error("Caption error:", captionResult.reason), null);

  const faces =
    facesResult.status === "fulfilled"
      ? facesResult.value
      : (errors.push(`Faces: ${facesResult.reason}`), logger.error("Faces error:", facesResult.reason), []);

  // Check if photo already exists
  const existingPhoto = await getPhotoByS3Path(s3Path);

  // Insert or update photo record
  const photoId = await insertPhoto({
    s3Path,
    takenAt: exif.takenAt,
    locationLat: exif.location?.lat,
    locationLng: exif.location?.lng,
    description: caption,
    thumbnail: thumbnail?.buffer,
  });

  // Delete existing faces if updating
  if (existingPhoto) {
    await deleteFacesByPhotoId(photoId);
  }

  // Insert face records
  for (const face of faces) {
    await insertFace({
      photoId,
      boundingBox: face.boundingBox,
      embedding: face.embedding,
    });
  }

  const output: ProcessPhotoOutput = {
    photoId,
    s3Path,
    takenAt: exif.takenAt,
    location: exif.location,
    description: caption,
    facesDetected: faces.length,
    thumbnailSize: thumbnail?.buffer.length ?? 0,
    errors,
  };

  logger.info(`Processed ${s3Path}:`, {
    photoId,
    takenAt: exif.takenAt?.toISOString(),
    hasLocation: !!exif.location,
    description: caption?.substring(0, 50),
    facesDetected: faces.length,
    thumbnailSize: thumbnail?.buffer.length,
    errorCount: errors.length,
  });

  return output;
}
