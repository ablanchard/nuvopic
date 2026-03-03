import { getObjectAsBuffer, getS3Path } from "./s3/client.js";
import {
  extractExif,
  generateThumbnail,
  generateCaption,
  detectFaces,
  parseDateFromFilename,
} from "./extractors/index.js";
import {
  type GpuClient,
  type GpuAnalysisResult,
  isGpuEnabled,
  getRealtimeGpuProvider,
  getBatchGpuProvider,
  createGpuClient,
} from "./extractors/gpu-client.js";
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
  /** Skip GPU work (captioning + face detection). Only run local extraction (EXIF, thumbnail, dimensions). */
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

  const realtimeProvider = getRealtimeGpuProvider();
  const batchProvider = getBatchGpuProvider();
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
    mode: batchProvider !== "local" ? batchProvider : realtimeProvider,
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
// Parse GPU analysis result into our internal face format
// ---------------------------------------------------------------------------
function parseGpuResult(
  gpuResult: PromiseSettledResult<GpuAnalysisResult>,
  errors: string[]
): { caption: string | null; faces: ExtractedData["faces"] } {
  if (gpuResult.status === "fulfilled") {
    return {
      caption: gpuResult.value.caption,
      faces: gpuResult.value.faces.map((f) => ({
        boundingBox: f.bbox,
        embedding: f.embedding,
        confidence: f.confidence,
      })),
    };
  }
  errors.push(`GPU analysis: ${gpuResult.reason}`);
  logger.error("GPU analysis error:", gpuResult.reason);
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
// Single-photo processing (realtime — used by S3 webhook, single import)
// ---------------------------------------------------------------------------
export async function processPhoto(
  input: ProcessPhotoInput,
  /** Optional pre-created GPU client (used by batch processor to share a client). */
  gpuClient?: GpuClient
): Promise<ProcessPhotoOutput> {
  const { s3Bucket, s3Key } = input;
  const s3Path = getS3Path(s3Bucket, s3Key);
  const errors: string[] = [];
  const gpuEnabled = isGpuEnabled();

  logger.info(`Processing photo: ${s3Path}${input.skipModal ? " (skipGpu)" : ""}`);

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
  } else if (gpuEnabled) {
    // Get or create a GPU client
    const client =
      gpuClient ?? (await createGpuClient(getRealtimeGpuProvider()));

    const [exifResult, thumbnailResult, gpuResult] =
      await Promise.allSettled([
        extractExif(imageBuffer),
        generateThumbnail(imageBuffer),
        client.analyze(imageBuffer),
      ]);

    exif = parseExifResult(exifResult, errors);
    thumbnail = parseThumbnailResult(thumbnailResult, errors);
    ({ caption, faces } = parseGpuResult(gpuResult, errors));
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
// Batch processing: manage GPU lifecycle + fire all GPU calls upfront
// ---------------------------------------------------------------------------

/** Max concurrent S3 downloads + local processing to bound memory usage. */
const LOCAL_CONCURRENCY = 5;

/** Max photos per chunk — bounds peak memory (image buffers + GPU promises). */
const CHUNK_SIZE = 20;

export async function processPhotoBatch(
  inputs: ProcessPhotoInput[],
  onProgress?: (completed: number, total: number) => void
): Promise<ProcessPhotoOutput[]> {
  if (inputs.length === 0) return [];

  const batchProvider = getBatchGpuProvider();
  const useGpu = batchProvider !== "local";
  const total = inputs.length;
  let completed = 0;

  logger.info(
    `Batch processing ${total} photos (provider=${batchProvider}, localConcurrency=${LOCAL_CONCURRENCY}, chunkSize=${CHUNK_SIZE})`
  );

  if (!useGpu) {
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

  // --- GPU mode: create client, manage lifecycle, run chunked pipeline ---
  const gpuClient = await createGpuClient(batchProvider);
  const batchStartTime = Date.now();

  try {
    // Start the GPU backend (no-op for Modal, provisions instance for Vast.ai)
    const provisionStart = Date.now();
    await gpuClient.start();
    const provisionMs = Date.now() - provisionStart;
    logger.info(`GPU provisioning took ${(provisionMs / 1000).toFixed(1)}s`);

    const allResults: ProcessPhotoOutput[] = [];
    const numChunks = Math.ceil(inputs.length / CHUNK_SIZE);
    const inferenceStart = Date.now();

    for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
      const chunkStart = chunkIdx * CHUNK_SIZE;
      const chunkInputs = inputs.slice(chunkStart, chunkStart + CHUNK_SIZE);

      const chunkStartTime = Date.now();
      logger.info(`Processing chunk ${chunkIdx + 1}/${numChunks} (${chunkInputs.length} photos)`);

      const chunkResults = await processChunk(chunkInputs, gpuClient);

      const chunkMs = Date.now() - chunkStartTime;
      logger.info(
        `Chunk ${chunkIdx + 1}/${numChunks} done in ${(chunkMs / 1000).toFixed(1)}s ` +
          `(${(chunkMs / chunkInputs.length / 1000).toFixed(2)}s/photo)`
      );

      for (const result of chunkResults) {
        allResults.push(result);
        completed++;
        onProgress?.(completed, total);
      }
    }

    const inferenceMs = Date.now() - inferenceStart;
    const totalMs = Date.now() - batchStartTime;

    logger.info(
      `Batch complete: ${total} photos in ${(totalMs / 1000).toFixed(1)}s total ` +
        `(provisioning=${(provisionMs / 1000).toFixed(1)}s, ` +
        `inference=${(inferenceMs / 1000).toFixed(1)}s, ` +
        `avg=${(inferenceMs / total / 1000).toFixed(2)}s/photo)`
    );

    return allResults;
  } finally {
    // Always tear down the GPU backend (destroys Vast.ai instance, no-op for Modal)
    const teardownStart = Date.now();
    try {
      await gpuClient.stop();
      logger.info(`GPU teardown took ${((Date.now() - teardownStart) / 1000).toFixed(1)}s`);
    } catch (err) {
      logger.error("Failed to stop GPU client:", err);
    }
    const totalMs = Date.now() - batchStartTime;
    logger.info(`Batch wall time: ${(totalMs / 1000).toFixed(1)}s`);
  }
}

/**
 * Process a single chunk of photos through the GPU pipeline.
 * Phase 1: Download + dispatch GPU calls eagerly.
 * Phase 2: Await results + save to DB.
 */
async function processChunk(
  inputs: ProcessPhotoInput[],
  gpuClient: GpuClient
): Promise<ProcessPhotoOutput[]> {
  interface PendingPhoto {
    input: ProcessPhotoInput;
    s3Path: string;
    imageBuffer: Buffer;
    gpuPromise: Promise<GpuAnalysisResult>;
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

    // Fire GPU call immediately (don't await — let it run while we download more)
    const gpuPromise = gpuClient.analyze(imageBuffer);

    // Start local work (EXIF + thumbnail) in parallel
    const localPromise = Promise.allSettled([
      extractExif(imageBuffer),
      generateThumbnail(imageBuffer),
    ]).then(([exif, thumbnail]) => ({ exif, thumbnail }));

    pending.push({ input, s3Path, imageBuffer, gpuPromise: gpuPromise, localPromise });
  });

  logger.info(`Chunk: ${pending.length} GPU calls dispatched, awaiting results...`);

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

      const [gpuSettled, local] = await Promise.all([
        Promise.allSettled([item.gpuPromise]),
        item.localPromise,
      ]);

      const exif = parseExifResult(local.exif, errors);
      const thumbnail = parseThumbnailResult(local.thumbnail, errors);
      const { caption, faces } = parseGpuResult(gpuSettled[0], errors);

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
