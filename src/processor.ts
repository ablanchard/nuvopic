import { getObjectAsBuffer, getS3Path } from "./s3/client.js";
import {
  extractExif,
  generateThumbnail,
  generateCaption,
  detectFaces,
  parseDateFromFilename,
} from "./extractors/index.js";
import {
  analyzeWithModal,
  isModalEnabled,
} from "./extractors/modal-client.js";
import {
  insertPhoto,
  insertFace,
  deleteFacesByPhotoId,
  getPhotoByS3Path,
} from "./db/queries.js";
import { logger } from "./logger.js";
import { PROCESS_VERSION } from "./version.js";

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

  let exif: { takenAt: Date | null; location: { lat: number; lng: number } | null };
  let thumbnail: { buffer: Buffer; width: number; height: number; format: string } | null;
  let caption: string | null;
  let faces: Array<{ boundingBox: { x: number; y: number; width: number; height: number }; embedding: number[]; confidence: number }>;

  if (isModalEnabled()) {
    // --- Modal mode: GPU-accelerated captioning + face detection ---
    // EXIF + thumbnail stay local (fast, no GPU needed).
    // Caption + faces go to Modal as a single HTTP call (non-blocking I/O).
    const [exifResult, thumbnailResult, modalResult] =
      await Promise.allSettled([
        extractExif(imageBuffer),
        generateThumbnail(imageBuffer),
        analyzeWithModal(imageBuffer),
      ]);

    exif =
      exifResult.status === "fulfilled"
        ? exifResult.value
        : (errors.push(`EXIF: ${exifResult.reason}`), logger.error("EXIF error:", exifResult.reason), { takenAt: null, location: null });

    thumbnail =
      thumbnailResult.status === "fulfilled"
        ? thumbnailResult.value
        : (errors.push(`Thumbnail: ${thumbnailResult.reason}`), logger.error("Thumbnail error:", thumbnailResult.reason), null);

    if (modalResult.status === "fulfilled") {
      caption = modalResult.value.caption;
      faces = modalResult.value.faces.map((f) => ({
        boundingBox: f.bbox,
        embedding: f.embedding,
        confidence: f.confidence,
      }));
    } else {
      errors.push(`Modal analysis: ${modalResult.reason}`);
      logger.error("Modal analysis error:", modalResult.reason);
      caption = null;
      faces = [];
    }
  } else {
    // --- Local mode: CPU-based processing (fallback) ---
    const [exifResult, thumbnailResult, captionResult, facesResult] =
      await Promise.allSettled([
        extractExif(imageBuffer),
        generateThumbnail(imageBuffer),
        generateCaption(imageBuffer),
        detectFaces(imageBuffer),
      ]);

    exif =
      exifResult.status === "fulfilled"
        ? exifResult.value
        : (errors.push(`EXIF: ${exifResult.reason}`), logger.error("EXIF error:", exifResult.reason), { takenAt: null, location: null });

    thumbnail =
      thumbnailResult.status === "fulfilled"
        ? thumbnailResult.value
        : (errors.push(`Thumbnail: ${thumbnailResult.reason}`), logger.error("Thumbnail error:", thumbnailResult.reason), null);

    caption =
      captionResult.status === "fulfilled"
        ? captionResult.value
        : (errors.push(`Caption: ${captionResult.reason}`), logger.error("Caption error:", captionResult.reason), null);

    faces =
      facesResult.status === "fulfilled"
        ? facesResult.value
        : (errors.push(`Faces: ${facesResult.reason}`), logger.error("Faces error:", facesResult.reason), []);
  }

  // Use EXIF date, falling back to date parsed from filename
  const takenAt = exif.takenAt ?? parseDateFromFilename(s3Key);

  // Check if photo already exists
  const existingPhoto = await getPhotoByS3Path(s3Path);

  // Insert or update photo record
  const photoId = await insertPhoto({
    s3Path,
    takenAt,
    locationLat: exif.location?.lat,
    locationLng: exif.location?.lng,
    description: caption,
    thumbnail: thumbnail?.buffer,
    processVersion: PROCESS_VERSION,
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
    takenAt,
    location: exif.location,
    description: caption,
    facesDetected: faces.length,
    thumbnailSize: thumbnail?.buffer.length ?? 0,
    errors,
  };

  logger.info(`Processed ${s3Path}:`, {
    photoId,
    mode: isModalEnabled() ? "modal" : "local",
    takenAt: takenAt?.toISOString(),
    hasLocation: !!exif.location,
    description: caption?.substring(0, 50),
    facesDetected: faces.length,
    thumbnailSize: thumbnail?.buffer.length,
    errorCount: errors.length,
  });

  return output;
}
