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
  type ModalAnalysisResult,
} from "./extractors/modal-client.js";
import {
  insertPhoto,
  insertFace,
  deleteFacesByPhotoId,
  getPhotoByS3Path,
} from "./db/queries.js";
import { logger } from "./logger.js";
import { PROCESS_VERSION } from "./version.js";
import sharp from "sharp";

export interface ProcessPhotoInput {
  s3Bucket: string;
  s3Key: string;
  /** Skip Modal GPU work (captioning + face detection). Only run local extraction (EXIF, thumbnail, dimensions). */
  skipModal?: boolean;
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

// ---------------------------------------------------------------------------
// Internal: save extracted data to DB (shared by single + batch paths)
// ---------------------------------------------------------------------------
interface ExtractedData {
  s3Path: string;
  s3Key: string;
  width: number | null;
  height: number | null;
  exif: { takenAt: Date | null; location: { lat: number; lng: number } | null };
  thumbnail: { buffer: Buffer; width: number; height: number; format: string } | null;
  caption: string | null;
  faces: Array<{ boundingBox: { x: number; y: number; width: number; height: number }; embedding: number[]; confidence: number }>;
  errors: string[];
  /** When true, skip face delete+reinsert (faces array is empty by design). */
  skipFaces?: boolean;
}

async function saveToDb(data: ExtractedData): Promise<ProcessPhotoOutput> {
  const { s3Path, s3Key, width, height, exif, thumbnail, caption, faces, errors } = data;

  const takenAt = exif.takenAt ?? parseDateFromFilename(s3Key);
  const existingPhoto = await getPhotoByS3Path(s3Path);

  const photoId = await insertPhoto({
    s3Path,
    takenAt,
    locationLat: exif.location?.lat,
    locationLng: exif.location?.lng,
    description: caption,
    thumbnail: thumbnail?.buffer,
    width,
    height,
    processVersion: PROCESS_VERSION,
  });

  if (!data.skipFaces) {
    if (existingPhoto) {
      await deleteFacesByPhotoId(photoId);
    }

    for (const face of faces) {
      await insertFace({
        photoId,
        boundingBox: face.boundingBox,
        embedding: face.embedding,
      });
    }
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

// ---------------------------------------------------------------------------
// Parse Modal analysis result into our internal face format
// ---------------------------------------------------------------------------
function parseModalResult(
  modalResult: PromiseSettledResult<ModalAnalysisResult>,
  errors: string[]
): { caption: string | null; faces: ExtractedData["faces"] } {
  if (modalResult.status === "fulfilled") {
    return {
      caption: modalResult.value.caption,
      faces: modalResult.value.faces.map((f) => ({
        boundingBox: f.bbox,
        embedding: f.embedding,
        confidence: f.confidence,
      })),
    };
  }
  errors.push(`Modal analysis: ${modalResult.reason}`);
  logger.error("Modal analysis error:", modalResult.reason);
  return { caption: null, faces: [] };
}

// ---------------------------------------------------------------------------
// Parse local extraction results (EXIF, thumbnail) with error handling
// ---------------------------------------------------------------------------
function parseExifResult(
  result: PromiseSettledResult<{ takenAt: Date | null; location: { lat: number; lng: number } | null }>,
  errors: string[]
): ExtractedData["exif"] {
  if (result.status === "fulfilled") return result.value;
  errors.push(`EXIF: ${result.reason}`);
  logger.error("EXIF error:", result.reason);
  return { takenAt: null, location: null };
}

function parseThumbnailResult(
  result: PromiseSettledResult<{ buffer: Buffer; width: number; height: number; format: string }>,
  errors: string[]
): ExtractedData["thumbnail"] {
  if (result.status === "fulfilled") return result.value;
  errors.push(`Thumbnail: ${result.reason}`);
  logger.error("Thumbnail error:", result.reason);
  return null;
}

// ---------------------------------------------------------------------------
// Single-photo processing (original API, used by import + local mode)
// ---------------------------------------------------------------------------
export async function processPhoto(
  input: ProcessPhotoInput
): Promise<ProcessPhotoOutput> {
  const { s3Bucket, s3Key } = input;
  const s3Path = getS3Path(s3Bucket, s3Key);
  const errors: string[] = [];

  logger.info(`Processing photo: ${s3Path}${input.skipModal ? " (skipModal)" : ""}`);

  const imageBuffer = await getObjectAsBuffer(s3Bucket, s3Key);
  logger.debug(`Downloaded ${imageBuffer.length} bytes`);

  // Extract original image dimensions
  let width: number | null = null;
  let height: number | null = null;
  try {
    const meta = await sharp(imageBuffer).metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
  } catch (err) {
    errors.push(`Dimensions: ${err}`);
    logger.error("Dimensions error:", err);
  }

  let exif: ExtractedData["exif"];
  let thumbnail: ExtractedData["thumbnail"];
  let caption: string | null;
  let faces: ExtractedData["faces"];
  let skipFaces = false;

  if (input.skipModal) {
    // skipModal: only run local extraction (EXIF + thumbnail + dimensions)
    const [exifResult, thumbnailResult] = await Promise.allSettled([
      extractExif(imageBuffer),
      generateThumbnail(imageBuffer),
    ]);

    exif = parseExifResult(exifResult, errors);
    thumbnail = parseThumbnailResult(thumbnailResult, errors);
    caption = null;   // null → COALESCE preserves existing DB value
    faces = [];
    skipFaces = true; // don't delete+reinsert faces
  } else if (isModalEnabled()) {
    const [exifResult, thumbnailResult, modalResult] =
      await Promise.allSettled([
        extractExif(imageBuffer),
        generateThumbnail(imageBuffer),
        analyzeWithModal(imageBuffer),
      ]);

    exif = parseExifResult(exifResult, errors);
    thumbnail = parseThumbnailResult(thumbnailResult, errors);
    ({ caption, faces } = parseModalResult(modalResult, errors));
  } else {
    const [exifResult, thumbnailResult, captionResult, facesResult] =
      await Promise.allSettled([
        extractExif(imageBuffer),
        generateThumbnail(imageBuffer),
        generateCaption(imageBuffer),
        detectFaces(imageBuffer),
      ]);

    exif = parseExifResult(exifResult, errors);
    thumbnail = parseThumbnailResult(thumbnailResult, errors);

    caption =
      captionResult.status === "fulfilled"
        ? captionResult.value
        : (errors.push(`Caption: ${captionResult.reason}`), logger.error("Caption error:", captionResult.reason), null);

    faces =
      facesResult.status === "fulfilled"
        ? facesResult.value
        : (errors.push(`Faces: ${facesResult.reason}`), logger.error("Faces error:", facesResult.reason), []);
  }

  return saveToDb({ s3Path, s3Key, width, height, exif, thumbnail, caption, faces, errors, skipFaces });
}

// ---------------------------------------------------------------------------
// Batch processing: fire all Modal calls upfront so the GPU stays saturated
// while local work (S3 download, EXIF, thumbnail) runs in parallel.
// ---------------------------------------------------------------------------

/** Max concurrent S3 downloads + local processing to bound memory usage. */
const LOCAL_CONCURRENCY = 5;

/** Max photos per chunk — bounds peak memory (image buffers + Modal promises). */
const CHUNK_SIZE = 20;

export async function processPhotoBatch(
  inputs: ProcessPhotoInput[],
  onProgress?: (completed: number, total: number) => void
): Promise<ProcessPhotoOutput[]> {
  if (inputs.length === 0) return [];

  const useModal = isModalEnabled();
  const total = inputs.length;
  let completed = 0;

  logger.info(
    `Batch processing ${total} photos (mode=${useModal ? "modal" : "local"}, localConcurrency=${LOCAL_CONCURRENCY}, chunkSize=${CHUNK_SIZE})`
  );

  if (!useModal) {
    // Local mode (or skipModal): just run processPhoto with local concurrency
    return runLocalConcurrency(inputs, LOCAL_CONCURRENCY, async (input) => {
      const result = await processPhoto(input);
      completed++;
      onProgress?.(completed, total);
      return result;
    });
  }

  // If all inputs have skipModal, use the local path (processPhoto handles it)
  const allSkipModal = inputs.every((i) => i.skipModal);
  if (allSkipModal) {
    return runLocalConcurrency(inputs, LOCAL_CONCURRENCY, async (input) => {
      const result = await processPhoto(input);
      completed++;
      onProgress?.(completed, total);
      return result;
    });
  }

  // --- Modal mode: chunked pipeline approach ---
  // Process photos in chunks of CHUNK_SIZE. Each chunk runs the full pipeline:
  //   Phase 1: Download images from S3 (bounded by LOCAL_CONCURRENCY), fire Modal
  //            calls eagerly, start local EXIF+thumbnail in parallel.
  //   Phase 2: Await Modal + local results for each photo, save to DB.
  // This bounds peak memory to ~CHUNK_SIZE image buffers at a time.

  const allResults: ProcessPhotoOutput[] = [];
  const numChunks = Math.ceil(inputs.length / CHUNK_SIZE);

  for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
    const chunkStart = chunkIdx * CHUNK_SIZE;
    const chunkInputs = inputs.slice(chunkStart, chunkStart + CHUNK_SIZE);

    logger.info(`Processing chunk ${chunkIdx + 1}/${numChunks} (${chunkInputs.length} photos)`);

    const chunkResults = await processChunk(chunkInputs);

    for (const result of chunkResults) {
      allResults.push(result);
      completed++;
      onProgress?.(completed, total);
    }
  }

  return allResults;
}

/**
 * Process a single chunk of photos through the Modal pipeline.
 * Phase 1: Download + dispatch Modal calls eagerly.
 * Phase 2: Await results + save to DB.
 */
async function processChunk(
  inputs: ProcessPhotoInput[]
): Promise<ProcessPhotoOutput[]> {
  interface PendingPhoto {
    input: ProcessPhotoInput;
    s3Path: string;
    imageBuffer: Buffer;
    modalPromise: Promise<ModalAnalysisResult>;
    localPromise: Promise<{
      exif: PromiseSettledResult<ExtractedData["exif"]>;
      thumbnail: PromiseSettledResult<{ buffer: Buffer; width: number; height: number; format: string }>;
    }>;
  }

  const pending: PendingPhoto[] = [];

  // Phase 1: Download + dispatch (bounded concurrency for downloads)
  await runLocalConcurrency(inputs, LOCAL_CONCURRENCY, async (input) => {
    const { s3Bucket, s3Key } = input;
    const s3Path = getS3Path(s3Bucket, s3Key);

    logger.info(`Downloading: ${s3Path}`);
    const imageBuffer = await getObjectAsBuffer(s3Bucket, s3Key);
    logger.debug(`Downloaded ${imageBuffer.length} bytes`);

    // Fire Modal call immediately (don't await — let it queue on Modal's side)
    const modalPromise = analyzeWithModal(imageBuffer);

    // Start local work (EXIF + thumbnail) in parallel
    const localPromise = Promise.allSettled([
      extractExif(imageBuffer),
      generateThumbnail(imageBuffer),
    ]).then(([exif, thumbnail]) => ({ exif, thumbnail }));

    pending.push({ input, s3Path, imageBuffer, modalPromise, localPromise });
  });

  logger.info(`Chunk: ${pending.length} Modal calls dispatched, awaiting results...`);

  // Phase 2: Collect results and save to DB
  const results: ProcessPhotoOutput[] = [];

  for (const item of pending) {
    const errors: string[] = [];
    const { s3Path } = item;
    const s3Key = item.input.s3Key;

    try {
      // Extract original image dimensions
      let width: number | null = null;
      let height: number | null = null;
      try {
        const meta = await sharp(item.imageBuffer).metadata();
        width = meta.width ?? null;
        height = meta.height ?? null;
      } catch (err) {
        errors.push(`Dimensions: ${err}`);
        logger.error("Dimensions error:", err);
      }

      const [modalSettled, local] = await Promise.all([
        Promise.allSettled([item.modalPromise]),
        item.localPromise,
      ]);

      const exif = parseExifResult(local.exif, errors);
      const thumbnail = parseThumbnailResult(local.thumbnail, errors);
      const { caption, faces } = parseModalResult(modalSettled[0], errors);

      const output = await saveToDb({ s3Path, s3Key, width, height, exif, thumbnail, caption, faces, errors });
      results.push(output);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Batch item failed for ${s3Path}:`, err);
      results.push({
        photoId: "",
        s3Path,
        takenAt: null,
        location: null,
        description: null,
        facesDetected: 0,
        thumbnailSize: 0,
        errors: [message],
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Simple local concurrency helper (worker-pool pattern)
// ---------------------------------------------------------------------------
async function runLocalConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}
