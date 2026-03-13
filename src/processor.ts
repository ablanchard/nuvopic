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
  type GpuCaptionResult,
  type GpuFacesResult,
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
import { PROCESS_VERSION, CAPTION_VERSION, FACES_VERSION } from "./version.js";
import sharp from "sharp";

// ---------------------------------------------------------------------------
// Processing modes: what GPU work to do
// ---------------------------------------------------------------------------

export type GpuMode =
  | "all"           // Run both caption + faces (default for new photos)
  | "caption-only"  // Only run captioning (face detection skipped)
  | "faces-only"    // Only run face detection (captioning skipped)
  | "skip";         // Skip all GPU work (local extraction only)

export interface ProcessPhotoInput {
  s3Bucket: string;
  s3Key: string;
  /** @deprecated Use gpuMode instead. Skip GPU work (captioning + face detection). Only run local extraction (EXIF, thumbnail, dimensions). */
  skipModal?: boolean;
  /** Controls which GPU work to run. Defaults to "all". Overrides skipModal when set. */
  gpuMode?: GpuMode;
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
  /** When true, skip caption update (caption is null by design). */
  skipCaption?: boolean;
  /** Version strings to write to DB. null = don't update (COALESCE preserves). */
  captionVersion?: string | null;
  facesVersion?: string | null;
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
    description: data.skipCaption ? undefined : caption,
    thumbnail: thumbnail?.buffer,
    width,
    height,
    processVersion: PROCESS_VERSION,
    captionVersion: data.captionVersion,
    facesVersion: data.facesVersion,
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
        confidence: face.confidence,
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
// Resolve the effective GPU mode from input flags
// ---------------------------------------------------------------------------
function resolveGpuMode(input: ProcessPhotoInput): GpuMode {
  if (input.gpuMode) return input.gpuMode;
  if (input.skipModal) return "skip";
  return "all";
}

// ---------------------------------------------------------------------------
// Parse GPU results into our internal formats
// ---------------------------------------------------------------------------
function parseCaptionResult(
  result: PromiseSettledResult<GpuCaptionResult>,
  errors: string[]
): string | null {
  if (result.status === "fulfilled") return result.value.caption;
  errors.push(`GPU caption: ${result.reason}`);
  logger.error("GPU caption error:", result.reason);
  return null;
}

function parseFacesResult(
  result: PromiseSettledResult<GpuFacesResult>,
  errors: string[]
): ExtractedData["faces"] {
  if (result.status === "fulfilled") {
    return result.value.faces.map((f) => ({
      boundingBox: f.bbox,
      embedding: f.embedding,
      confidence: f.confidence,
    }));
  }
  errors.push(`GPU faces: ${result.reason}`);
  logger.error("GPU faces error:", result.reason);
  return [];
}

/** Parse combined /analyze result (backward compat for local mode). */
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
  const gpuMode = resolveGpuMode(input);

  logger.info(`Processing photo: ${s3Path} (gpuMode=${gpuMode})`);

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
  let skipCaption = false;
  let captionVersion: string | null = null;
  let facesVersion: string | null = null;

  if (gpuMode === "skip") {
    // Skip all GPU work: only run local extraction (EXIF + thumbnail + dimensions)
    const [exifResult, thumbnailResult] = await Promise.allSettled([
      extractExif(imageBuffer),
      generateThumbnail(imageBuffer),
    ]);

    exif = parseExifResult(exifResult, errors);
    thumbnail = parseThumbnailResult(thumbnailResult, errors);
    caption = null;
    faces = [];
    skipFaces = true;
    skipCaption = true;
  } else if (gpuEnabled) {
    // Get or create a GPU client
    const client =
      gpuClient ?? (await createGpuClient(getRealtimeGpuProvider()));

    if (gpuMode === "caption-only") {
      // Caption only — skip face detection
      const [exifResult, thumbnailResult, captionResult] =
        await Promise.allSettled([
          extractExif(imageBuffer),
          generateThumbnail(imageBuffer),
          client.caption(imageBuffer),
        ]);

      exif = parseExifResult(exifResult, errors);
      thumbnail = parseThumbnailResult(thumbnailResult, errors);
      caption = parseCaptionResult(captionResult, errors);
      faces = [];
      skipFaces = true;
      // Only stamp version if GPU call succeeded
      captionVersion = captionResult.status === "fulfilled" ? CAPTION_VERSION : null;
    } else if (gpuMode === "faces-only") {
      // Face detection only — skip captioning
      const [exifResult, thumbnailResult, facesResult] =
        await Promise.allSettled([
          extractExif(imageBuffer),
          generateThumbnail(imageBuffer),
          client.faces(imageBuffer),
        ]);

      exif = parseExifResult(exifResult, errors);
      thumbnail = parseThumbnailResult(thumbnailResult, errors);
      caption = null;
      skipCaption = true;
      faces = parseFacesResult(facesResult, errors);
      // Only stamp version if GPU call succeeded
      facesVersion = facesResult.status === "fulfilled" ? FACES_VERSION : null;
    } else {
      // Full processing: both caption + faces (separate calls for independent versioning)
      const [exifResult, thumbnailResult, captionResult, facesResult] =
        await Promise.allSettled([
          extractExif(imageBuffer),
          generateThumbnail(imageBuffer),
          client.caption(imageBuffer),
          client.faces(imageBuffer),
        ]);

      exif = parseExifResult(exifResult, errors);
      thumbnail = parseThumbnailResult(thumbnailResult, errors);
      caption = parseCaptionResult(captionResult, errors);
      faces = parseFacesResult(facesResult, errors);
      // Only stamp version if the respective GPU call succeeded
      captionVersion = captionResult.status === "fulfilled" ? CAPTION_VERSION : null;
      facesVersion = facesResult.status === "fulfilled" ? FACES_VERSION : null;
    }
  } else {
    // Local mode (no GPU): use CPU-based extractors
    if (gpuMode === "caption-only") {
      const [exifResult, thumbnailResult, captionResult] =
        await Promise.allSettled([
          extractExif(imageBuffer),
          generateThumbnail(imageBuffer),
          generateCaption(imageBuffer),
        ]);

      exif = parseExifResult(exifResult, errors);
      thumbnail = parseThumbnailResult(thumbnailResult, errors);
      caption =
        captionResult.status === "fulfilled"
          ? captionResult.value
          : (errors.push(`Caption: ${captionResult.reason}`), logger.error("Caption error:", captionResult.reason), null);
      faces = [];
      skipFaces = true;
      captionVersion = captionResult.status === "fulfilled" ? CAPTION_VERSION : null;
    } else if (gpuMode === "faces-only") {
      const [exifResult, thumbnailResult, facesResult] =
        await Promise.allSettled([
          extractExif(imageBuffer),
          generateThumbnail(imageBuffer),
          detectFaces(imageBuffer),
        ]);

      exif = parseExifResult(exifResult, errors);
      thumbnail = parseThumbnailResult(thumbnailResult, errors);
      caption = null;
      skipCaption = true;
      faces =
        facesResult.status === "fulfilled"
          ? facesResult.value
          : (errors.push(`Faces: ${facesResult.reason}`), logger.error("Faces error:", facesResult.reason), []);
      facesVersion = facesResult.status === "fulfilled" ? FACES_VERSION : null;
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

      captionVersion = captionResult.status === "fulfilled" ? CAPTION_VERSION : null;
      facesVersion = facesResult.status === "fulfilled" ? FACES_VERSION : null;
    }
  }

  return saveToDb({ s3Path, s3Key, width, height, exif, thumbnail, caption, faces, errors, skipFaces, skipCaption, captionVersion, facesVersion });
}

// ---------------------------------------------------------------------------
// Batch processing: manage GPU lifecycle + fire all GPU calls upfront
// ---------------------------------------------------------------------------

/** Max concurrent S3 downloads + local processing to bound memory usage. */
const LOCAL_CONCURRENCY = 5;

/** Max photos per chunk — bounds peak memory (image buffers + GPU promises). */
const CHUNK_SIZE = 20;

/** Max times to re-provision a new GPU instance after eviction within one batch. */
const MAX_REPROVISIONS = parseInt(
  process.env.VAST_MAX_REPROVISIONS ?? "3",
  10
);

export async function processPhotoBatch(
  inputs: ProcessPhotoInput[],
  onProgress?: (completed: number, total: number) => void
): Promise<ProcessPhotoOutput[]> {
  if (inputs.length === 0) return [];

  const batchProvider = getBatchGpuProvider();
  const useGpu = batchProvider !== "local";
  const total = inputs.length;
  let completed = 0;

  // Resolve GPU mode from first input (batch should have uniform mode)
  const gpuMode = resolveGpuMode(inputs[0]);

  logger.info(
    `Batch processing ${total} photos (provider=${batchProvider}, gpuMode=${gpuMode}, localConcurrency=${LOCAL_CONCURRENCY}, chunkSize=${CHUNK_SIZE})`
  );

  if (!useGpu) {
    // Local mode (or skip): just run processPhoto with local concurrency
    return runLocalConcurrency(inputs, LOCAL_CONCURRENCY, async (input) => {
      const result = await processPhoto(input);
      completed++;
      onProgress?.(completed, total);
      return result;
    });
  }

  // If all inputs skip GPU, use the local path (processPhoto handles it)
  const allSkipGpu = inputs.every((i) => resolveGpuMode(i) === "skip");
  if (allSkipGpu) {
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
    const inferenceStart = Date.now();
    let reprovisionCount = 0;

    // Build the initial list of inputs to process
    let remainingInputs = [...inputs];

    while (remainingInputs.length > 0) {
      const numChunks = Math.ceil(remainingInputs.length / CHUNK_SIZE);
      const failedInputs: ProcessPhotoInput[] = [];

      for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
        const chunkStart = chunkIdx * CHUNK_SIZE;
        const chunkInputs = remainingInputs.slice(
          chunkStart,
          chunkStart + CHUNK_SIZE
        );

        const chunkStartTime = Date.now();
        logger.info(
          `Processing chunk ${chunkIdx + 1}/${numChunks} (${chunkInputs.length} photos)`
        );

        const chunkResults = await processChunk(chunkInputs, gpuClient);

        const chunkMs = Date.now() - chunkStartTime;
        logger.info(
          `Chunk ${chunkIdx + 1}/${numChunks} done in ${(chunkMs / 1000).toFixed(1)}s ` +
            `(${(chunkMs / chunkInputs.length / 1000).toFixed(2)}s/photo)`
        );

        // Partition results: completed (has caption or faces depending on mode) vs failed
        for (let i = 0; i < chunkResults.length; i++) {
          const result = chunkResults[i];
          const hasGpuFailure =
            result.errors.some(
              (e) =>
                e.includes("GPU") ||
                e.includes("Vast.ai") ||
                e.includes("instance is dead") ||
                e.includes("InstanceDead")
            );

          if (hasGpuFailure) {
            failedInputs.push(chunkInputs[i]);
            // Don't add to allResults yet — we'll retry these
          } else {
            allResults.push(result);
            completed++;
            onProgress?.(completed, total);
          }
        }

        // If instance died mid-chunk, don't process more chunks — break out to reprovision
        if (
          gpuClient.isInterruptible &&
          failedInputs.length > 0 &&
          chunkResults.some((r) =>
            r.errors.some(
              (e) =>
                e.includes("instance is dead") ||
                e.includes("InstanceDead")
            )
          )
        ) {
          // Remaining chunks haven't been attempted yet — add their inputs to failedInputs
          for (
            let remaining = chunkIdx + 1;
            remaining < numChunks;
            remaining++
          ) {
            const start = remaining * CHUNK_SIZE;
            failedInputs.push(
              ...remainingInputs.slice(start, start + CHUNK_SIZE)
            );
          }
          logger.warn(
            `Vast.ai instance died during chunk ${chunkIdx + 1}/${numChunks}. ` +
              `${failedInputs.length} photos need retry.`
          );
          break;
        }
      }

      // If no failures, we're done
      if (failedInputs.length === 0) {
        break;
      }

      // Check if we can reprovision
      if (!gpuClient.isInterruptible) {
        // Non-interruptible provider — no point reprovisioning, just log and save partial results
        logger.warn(
          `${failedInputs.length} photos failed GPU analysis (non-interruptible provider, no retry).`
        );
        // Save failed photos with null caption so they appear in results
        for (const input of failedInputs) {
          allResults.push({
            photoId: "",
            s3Path: getS3Path(input.s3Bucket, input.s3Key),
            takenAt: null,
            location: null,
            description: null,
            facesDetected: 0,
            thumbnailSize: 0,
            errors: ["GPU analysis failed — non-interruptible, no retry"],
          });
          completed++;
          onProgress?.(completed, total);
        }
        break;
      }

      if (reprovisionCount >= MAX_REPROVISIONS) {
        logger.error(
          `Max reprovisions (${MAX_REPROVISIONS}) reached. ` +
            `${failedInputs.length} photos will not be retried.`
        );
        for (const input of failedInputs) {
          allResults.push({
            photoId: "",
            s3Path: getS3Path(input.s3Bucket, input.s3Key),
            takenAt: null,
            location: null,
            description: null,
            facesDetected: 0,
            thumbnailSize: 0,
            errors: [
              `GPU analysis failed — max reprovisions (${MAX_REPROVISIONS}) exhausted`,
            ],
          });
          completed++;
          onProgress?.(completed, total);
        }
        break;
      }

      // Reprovision and retry failed photos
      reprovisionCount++;
      logger.info(
        `Reprovisioning GPU instance (attempt ${reprovisionCount}/${MAX_REPROVISIONS}) ` +
          `to retry ${failedInputs.length} failed photos...`
      );

      const reprovisionStart = Date.now();
      await gpuClient.reprovision();
      const reprovisionMs = Date.now() - reprovisionStart;
      logger.info(
        `Reprovisioning took ${(reprovisionMs / 1000).toFixed(1)}s`
      );

      // Loop again with only the failed inputs
      remainingInputs = failedInputs;
    }

    const inferenceMs = Date.now() - inferenceStart;
    const totalMs = Date.now() - batchStartTime;

    logger.info(
      `Batch complete: ${total} photos in ${(totalMs / 1000).toFixed(1)}s total ` +
        `(provisioning=${(provisionMs / 1000).toFixed(1)}s, ` +
        `inference=${(inferenceMs / 1000).toFixed(1)}s, ` +
        `avg=${(inferenceMs / total / 1000).toFixed(2)}s/photo` +
        (reprovisionCount > 0
          ? `, reprovisions=${reprovisionCount}`
          : "") +
        `)`
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
 *
 * Dispatches caption and faces as independent calls based on gpuMode.
 */
async function processChunk(
  inputs: ProcessPhotoInput[],
  gpuClient: GpuClient
): Promise<ProcessPhotoOutput[]> {
  interface PendingPhoto {
    input: ProcessPhotoInput;
    s3Path: string;
    imageBuffer: Buffer;
    gpuMode: GpuMode;
    captionPromise: Promise<GpuCaptionResult> | null;
    facesPromise: Promise<GpuFacesResult> | null;
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
    const mode = resolveGpuMode(input);

    logger.info(`Downloading: ${s3Path}`);
    const imageBuffer = await getObjectAsBuffer(s3Bucket, s3Key);
    logger.debug(`Downloaded ${imageBuffer.length} bytes`);

    // Dispatch GPU calls based on mode
    let captionPromise: Promise<GpuCaptionResult> | null = null;
    let facesPromise: Promise<GpuFacesResult> | null = null;

    if (mode === "all" || mode === "caption-only") {
      captionPromise = gpuClient.caption(imageBuffer);
      captionPromise.catch(() => {}); // suppress unhandled rejection
    }
    if (mode === "all" || mode === "faces-only") {
      facesPromise = gpuClient.faces(imageBuffer);
      facesPromise.catch(() => {}); // suppress unhandled rejection
    }

    // Start local work (EXIF + thumbnail) in parallel
    const localPromise = Promise.allSettled([
      extractExif(imageBuffer),
      generateThumbnail(imageBuffer),
    ]).then(([exif, thumbnail]) => ({ exif, thumbnail }));

    pending.push({ input, s3Path, imageBuffer, gpuMode: mode, captionPromise, facesPromise, localPromise });
  });

  const dispatchedCaption = pending.filter((p) => p.captionPromise).length;
  const dispatchedFaces = pending.filter((p) => p.facesPromise).length;
  logger.info(`Chunk: ${dispatchedCaption} caption + ${dispatchedFaces} faces calls dispatched, awaiting results...`);

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

      // Await local results
      const local = await item.localPromise;
      const exif = parseExifResult(local.exif, errors);
      const thumbnail = parseThumbnailResult(local.thumbnail, errors);

      // Await GPU results based on mode
      let caption: string | null = null;
      let faces: ExtractedData["faces"] = [];
      let skipFaces = false;
      let skipCaption = false;
      let captionVersion: string | null = null;
      let facesVersion: string | null = null;

      if (item.captionPromise) {
        const [captionSettled] = await Promise.allSettled([item.captionPromise]);
        caption = parseCaptionResult(captionSettled, errors);
        // Only stamp version if GPU call succeeded
        captionVersion = captionSettled.status === "fulfilled" ? CAPTION_VERSION : null;
      } else {
        skipCaption = true;
      }

      if (item.facesPromise) {
        const [facesSettled] = await Promise.allSettled([item.facesPromise]);
        faces = parseFacesResult(facesSettled, errors);
        // Only stamp version if GPU call succeeded
        facesVersion = facesSettled.status === "fulfilled" ? FACES_VERSION : null;
      } else {
        skipFaces = true;
      }

      const output = await saveToDb({ s3Path, s3Key, width, height, exif, thumbnail, caption, faces, errors, skipFaces, skipCaption, captionVersion, facesVersion });
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
