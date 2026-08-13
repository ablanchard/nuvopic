import crypto from "node:crypto";
import { getObjectAsBuffer, getS3Path } from "./s3/client.js";
import {
  extractExif,
  generatePlaceholder,
  generateCaption,
  detectFaces,
  resolvePhotoDate,
  resolveLocation,
  type PhotoDatePrecision,
  type PhotoDateSource,
} from "./extractors/index.js";
import {
  type GpuClient,
  type GpuAnalysisResult,
  type GpuCaptionResult,
  type GpuFacesResult,
  isGpuEnabled,
  getRealtimeGpuProvider,
  getGpuProviderBatchThreshold,
  GPU_ROUTING_POLICY_VERSION,
  selectBatchGpuProvider,
  createGpuClient,
  type GpuProvider,
} from "./extractors/gpu-client.js";
import {
  beginMeteredGpuJob,
  completeMeteredGpuJob,
  recordGpuOperationUsage,
  recordGpuResourceUsage,
  type MeteringJobContext,
} from "./metering/gpu-metering.js";
import {
  insertPhoto,
  insertFace,
  deleteFacesByPhotoId,
  getPhotoByS3Path,
  updatePhotoGpuFields,
  type PhotoRecord,
} from "./db/queries.js";
import {
  safeCompleteGpuLog,
  safeFailGpuLog,
  safeQueuePhotoStageLogs,
  safeStartPhotoStageLog,
  type PhotoStageLogRef,
} from "./db/gpu-logs.js";
import { logger } from "./logger.js";
import {
  createGpuResourceLifecycleHandlers,
  renewGpuResourceLeases,
} from "./jobs/gpu-resource-leases.js";
import { PROCESS_VERSION, CAPTION_VERSION, FACES_VERSION } from "./version.js";
import sharp from "sharp";

// ---------------------------------------------------------------------------
// Performance timing helper
// ---------------------------------------------------------------------------
function memoryMB(): string {
  const mem = process.memoryUsage();
  return `rss=${(mem.rss / 1024 / 1024).toFixed(0)}MB heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}/${(mem.heapTotal / 1024 / 1024).toFixed(0)}MB`;
}

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
  /** Force the CPU phase once even when its version checkpoint is current. */
  forceCpu?: boolean;
  /** Force requested GPU stages even when their version checkpoints are current. */
  forceGpu?: boolean;
}

export interface ProcessPhotoOutput {
  photoId: string;
  s3Path: string;
  takenAt: Date | null;
  takenAtPrecision: PhotoDatePrecision;
  takenAtSource: PhotoDateSource;
  location: {
    lat: number;
    lng: number;
    name: string | null;
    region: string | null;
    country: string | null;
  } | null;
  description: string | null;
  facesDetected: number;
  errors: string[];
  /** Explicit completion state so durable workers never treat CPU-only data as GPU success. */
  gpuStatus: "completed" | "failed" | "skipped";
  /** Failed GPU work should be attempted again on a fresh provider resource. */
  gpuRetryable: boolean;
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
  placeholder: string | null;
  caption: string | null;
  faces: Array<{ boundingBox: { x: number; y: number; width: number; height: number }; embedding: number[]; confidence: number }>;
  errors: string[];
  provider?: string;
  /** When true, skip face delete+reinsert (faces array is empty by design). */
  skipFaces?: boolean;
  /** When true, skip caption update (caption is null by design). */
  skipCaption?: boolean;
  /** Version strings to write to DB. null = don't update (COALESCE preserves). */
  captionVersion?: string | null;
  facesVersion?: string | null;
  gpuStatus?: ProcessPhotoOutput["gpuStatus"];
}

async function saveToDb(data: ExtractedData): Promise<ProcessPhotoOutput> {
  const { s3Path, s3Key, width, height, exif, placeholder, caption, faces, errors } = data;
  const tSave0 = Date.now();

  const resolvedDate = resolvePhotoDate(exif.takenAt, s3Key);
  const { takenAt } = resolvedDate;
  let resolvedLocation: ReturnType<typeof resolveLocation> = null;
  if (exif.location) {
    try {
      resolvedLocation = resolveLocation(exif.location.lat, exif.location.lng);
    } catch (error) {
      // Location enrichment must never prevent the photo itself from importing.
      logger.warn(`Offline location resolution failed for ${s3Path}:`, error);
    }
  }

  const tLookupStart = Date.now();
  const existingPhoto = await getPhotoByS3Path(s3Path);
  const tLookupMs = Date.now() - tLookupStart;

  const tInsertStart = Date.now();
  const photoId = await insertPhoto({
    s3Path,
    takenAt,
    takenAtPrecision: resolvedDate.precision,
    takenAtSource: resolvedDate.source,
    locationLat: exif.location?.lat,
    locationLng: exif.location?.lng,
    locationName: resolvedLocation?.name,
    locationRegion: resolvedLocation?.region,
    locationCountry: resolvedLocation?.country,
    description: data.skipCaption ? undefined : caption,
    placeholder,
    width,
    height,
    processVersion: PROCESS_VERSION,
    captionVersion: data.captionVersion,
    facesVersion: data.facesVersion,
  });
  const tInsertMs = Date.now() - tInsertStart;

  let tFacesMs = 0;
  if (!data.skipFaces) {
    const tFacesStart = Date.now();
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
    tFacesMs = Date.now() - tFacesStart;
  }

  const tSaveTotal = Date.now() - tSave0;
  if (tSaveTotal > 100) {
    logger.info(`[perf] saveToDb ${s3Key}: total=${tSaveTotal}ms (lookup=${tLookupMs}ms insert=${tInsertMs}ms faces=${tFacesMs}ms)`);
  }

  const output: ProcessPhotoOutput = {
    photoId,
    s3Path,
    takenAt,
    takenAtPrecision: resolvedDate.precision,
    takenAtSource: resolvedDate.source,
    location: exif.location
      ? {
          ...exif.location,
          name: resolvedLocation?.name ?? null,
          region: resolvedLocation?.region ?? null,
          country: resolvedLocation?.country ?? null,
        }
      : null,
    description: caption,
    facesDetected: faces.length,
    errors,
    gpuStatus: data.gpuStatus ?? "skipped",
    gpuRetryable: false,
  };

  logger.info(`Processed ${s3Path}:`, {
    photoId,
    mode: data.provider ?? getRealtimeGpuProvider(),
    takenAt: takenAt?.toISOString(),
    takenAtPrecision: resolvedDate.precision,
    takenAtSource: resolvedDate.source,
    hasLocation: !!exif.location,
    description: caption?.substring(0, 50),
    facesDetected: faces.length,
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

function parsePlaceholderResult(
  result: PromiseSettledResult<string>,
  errors: string[]
): string | null {
  if (result.status === "fulfilled") return result.value;
  errors.push(`Placeholder: ${result.reason}`);
  logger.error("Placeholder error:", result.reason);
  return null;
}

interface CpuPreparedPhoto {
  input: ProcessPhotoInput;
  photo: PhotoRecord;
  output: ProcessPhotoOutput;
}

function outputFromPhoto(
  photo: PhotoRecord,
  errors: string[] = [],
  gpuStatus: ProcessPhotoOutput["gpuStatus"] = "skipped"
): ProcessPhotoOutput {
  return {
    photoId: photo.id,
    s3Path: photo.s3_path,
    takenAt: photo.taken_at,
    takenAtPrecision: photo.taken_at_precision ?? "unknown",
    takenAtSource: photo.taken_at_source ?? "unknown",
    location:
      photo.location_lat !== null && photo.location_lng !== null
        ? {
            lat: photo.location_lat,
            lng: photo.location_lng,
            name: photo.location_name,
            region: photo.location_region,
            country: photo.location_country,
          }
        : null,
    description: photo.description,
    facesDetected: 0,
    errors,
    gpuStatus,
    gpuRetryable: false,
  };
}

function isRetryableGpuFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Invalid/corrupt image bytes and other client errors are deterministic.
  if (/Could not decode image|unsupported image|invalid image/i.test(message)) {
    return false;
  }
  const status = message.match(/returned (\d{3})/i)?.[1];
  if (status) {
    const code = Number.parseInt(status, 10);
    if (code >= 400 && code < 500 && code !== 408 && code !== 429) {
      return false;
    }
  }
  return true;
}

/** Complete and commit all local/CPU work before any GPU is allocated. */
async function prepareCpuPhoto(
  input: ProcessPhotoInput,
  cpuLog?: PhotoStageLogRef
): Promise<CpuPreparedPhoto> {
  const { s3Bucket, s3Key } = input;
  const s3Path = getS3Path(s3Bucket, s3Key);
  const logStarted = await safeStartPhotoStageLog(cpuLog);
  logger.info(`[CPU import] starting ${s3Path}`);

  try {
    const current = await getPhotoByS3Path(s3Path);
    if (!input.forceCpu && current?.process_version === PROCESS_VERSION) {
      logger.info(`[CPU import] checkpoint current ${s3Path}`);
      if (logStarted && cpuLog) {
        await safeCompleteGpuLog(cpuLog.id);
        cpuLog.status = "completed";
      }
      return { input, photo: current, output: outputFromPhoto(current) };
    }

    const errors: string[] = [];
    const startedAt = Date.now();
    const imageBuffer = await getObjectAsBuffer(s3Bucket, s3Key);
    let width: number | null = null;
    let height: number | null = null;
    try {
      const metadata = await sharp(imageBuffer).metadata();
      width = metadata.width ?? null;
      height = metadata.height ?? null;
    } catch (error) {
      errors.push(`Dimensions: ${error}`);
      logger.error("Dimensions error:", error);
    }

    const [exifResult, placeholderResult] = await Promise.allSettled([
      extractExif(imageBuffer),
      generatePlaceholder(imageBuffer),
    ]);
    const output = await saveToDb({
      s3Path,
      s3Key,
      width,
      height,
      exif: parseExifResult(exifResult, errors),
      placeholder: parsePlaceholderResult(placeholderResult, errors),
      caption: null,
      faces: [],
      errors,
      provider: "local",
      skipCaption: true,
      skipFaces: true,
      gpuStatus: "skipped",
    });
    const photo = await getPhotoByS3Path(s3Path);
    if (!photo) throw new Error(`CPU checkpoint was not persisted for ${s3Path}`);
    logger.info(
      `[CPU import] completed ${s3Path} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    );
    if (logStarted && cpuLog) {
      await safeCompleteGpuLog(cpuLog.id);
      cpuLog.status = "completed";
    }
    return { input, photo, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[CPU import] failed ${s3Path}:`, error);
    if (logStarted && cpuLog) {
      await safeFailGpuLog(cpuLog.id, message);
      cpuLog.status = "failed";
    }
    throw error;
  }
}

function requiredGpuMode(
  requested: GpuMode,
  photo: PhotoRecord,
  force = false
): GpuMode {
  if (requested === "skip") return "skip";
  const needsCaption =
    (requested === "all" || requested === "caption-only") &&
    (force || photo.caption_version !== CAPTION_VERSION);
  const needsFaces =
    (requested === "all" || requested === "faces-only") &&
    (force || photo.faces_version !== FACES_VERSION);
  if (needsCaption && needsFaces) return "all";
  if (needsCaption) return "caption-only";
  if (needsFaces) return "faces-only";
  return "skip";
}

// ---------------------------------------------------------------------------
// Single-photo processing. CPU checkpointing always precedes GPU dispatch.
// ---------------------------------------------------------------------------
export async function processPhoto(
  input: ProcessPhotoInput,
  gpuClient?: GpuClient,
  jobLogId?: string | null
): Promise<ProcessPhotoOutput> {
  const s3Path = getS3Path(input.s3Bucket, input.s3Key);
  const cpuLogs = await safeQueuePhotoStageLogs({
    parentId: jobLogId,
    type: "cpu-import",
    provider: "local",
    gpuMode: resolveGpuMode(input),
    s3Paths: [s3Path],
  });
  const prepared = await prepareCpuPhoto(input, cpuLogs.get(s3Path));
  const requestedMode = resolveGpuMode(input);
  const mode = requiredGpuMode(requestedMode, prepared.photo, input.forceGpu);
  if (mode === "skip") {
    return {
      ...prepared.output,
      gpuStatus: requestedMode === "skip" ? "skipped" : "completed",
    };
  }

  if (gpuClient || isGpuEnabled()) {
    const client = gpuClient ?? (await createGpuClient(getRealtimeGpuProvider()));
    const captionLogs = await safeQueuePhotoStageLogs({
      parentId: jobLogId,
      type: "caption",
      provider: client.provider,
      gpuMode: mode,
      s3Paths: mode === "all" || mode === "caption-only" ? [s3Path] : [],
    });
    const facesLogs = await safeQueuePhotoStageLogs({
      parentId: jobLogId,
      type: "faces",
      provider: client.provider,
      gpuMode: mode,
      s3Paths: mode === "all" || mode === "faces-only" ? [s3Path] : [],
    });
    const [result] = await processGpuChunk(
      [{ ...input, gpuMode: mode, forceCpu: false, forceGpu: false }],
      client,
      { caption: captionLogs, faces: facesLogs }
    );
    return result;
  }

  // Development/local fallback: these model calls are still sequenced after
  // the committed CPU checkpoint.
  const captionLogs = await safeQueuePhotoStageLogs({
    parentId: jobLogId,
    type: "caption",
    provider: "local",
    gpuMode: mode,
    s3Paths: mode === "all" || mode === "caption-only" ? [s3Path] : [],
  });
  const facesLogs = await safeQueuePhotoStageLogs({
    parentId: jobLogId,
    type: "faces",
    provider: "local",
    gpuMode: mode,
    s3Paths: mode === "all" || mode === "faces-only" ? [s3Path] : [],
  });
  const captionLog = captionLogs.get(s3Path);
  const facesLog = facesLogs.get(s3Path);
  const captionLogStarted = mode === "all" || mode === "caption-only"
    ? await safeStartPhotoStageLog(captionLog)
    : false;
  const facesLogStarted = mode === "all" || mode === "faces-only"
    ? await safeStartPhotoStageLog(facesLog)
    : false;
  const imageBuffer = await getObjectAsBuffer(input.s3Bucket, input.s3Key);
  const captionSettled =
    mode === "all" || mode === "caption-only"
      ? (await Promise.allSettled([generateCaption(imageBuffer)]))[0]
      : null;
  const facesSettled =
    mode === "all" || mode === "faces-only"
      ? (await Promise.allSettled([detectFaces(imageBuffer)]))[0]
      : null;
  const normalizedCaption = captionSettled
    ? captionSettled.status === "fulfilled"
      ? { status: "fulfilled" as const, value: { caption: captionSettled.value } }
      : captionSettled
    : null;
  const normalizedFaces = facesSettled
    ? facesSettled.status === "fulfilled"
      ? {
          status: "fulfilled" as const,
          value: {
            faces: facesSettled.value.map((face) => ({
              bbox: face.boundingBox,
              embedding: face.embedding,
              confidence: face.confidence,
            })),
          },
        }
      : facesSettled
    : null;
  try {
    const output = await saveGpuResults(
      input,
      "local",
      normalizedCaption,
      normalizedFaces
    );
    if (normalizedCaption && captionLogStarted && captionLog) {
      if (normalizedCaption.status === "fulfilled") await safeCompleteGpuLog(captionLog.id);
      else await safeFailGpuLog(captionLog.id, String(normalizedCaption.reason));
    }
    if (normalizedFaces && facesLogStarted && facesLog) {
      if (normalizedFaces.status === "fulfilled") await safeCompleteGpuLog(facesLog.id);
      else await safeFailGpuLog(facesLog.id, String(normalizedFaces.reason));
    }
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (captionLogStarted && captionLog) await safeFailGpuLog(captionLog.id, message);
    if (facesLogStarted && facesLog) await safeFailGpuLog(facesLog.id, message);
    throw error;
  }
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
  onProgress?: (completed: number, total: number) => void,
  /** Optional parent job log ID — per-photo child logs will reference this. */
  jobLogId?: string | null,
  options?: {
    provider?: GpuProvider;
    externalJobId?: string;
  }
): Promise<ProcessPhotoOutput[]> {
  if (inputs.length === 0) return [];

  const total = inputs.length;
  let completed = 0;

  // Resolve GPU mode from first input (batch should have uniform mode)
  const gpuMode = resolveGpuMode(inputs[0]);
  const batchProvider = options?.provider ?? selectBatchGpuProvider(total, gpuMode);
  const useGpu = batchProvider !== "local";

  logger.info(
    `Batch processing ${total} photos (provider=${batchProvider}, gpuMode=${gpuMode}, localConcurrency=${LOCAL_CONCURRENCY}, chunkSize=${CHUNK_SIZE})`
  );

  if (!useGpu) {
    // Local mode (or skip): just run processPhoto with local concurrency
    return runLocalConcurrency(inputs, LOCAL_CONCURRENCY, async (input) => {
      const result = await processPhoto(input, undefined, jobLogId);
      completed++;
      onProgress?.(completed, total);
      return result;
    });
  }

  // If all inputs skip GPU, use the local path (processPhoto handles it)
  const allSkipGpu = inputs.every((i) => resolveGpuMode(i) === "skip");
  if (allSkipGpu) {
    return runLocalConcurrency(inputs, LOCAL_CONCURRENCY, async (input) => {
      const result = await processPhoto(input, undefined, jobLogId);
      completed++;
      onProgress?.(completed, total);
      return result;
    });
  }

  // Phase 1 is intentionally global: every CPU checkpoint must commit before
  // a GPU reservation or provider resource is created.
  logger.info(`CPU phase starting for ${total} photos; GPU provisioning is blocked until it completes`);
  const cpuLogs = await safeQueuePhotoStageLogs({
    parentId: jobLogId,
    type: "cpu-import",
    provider: "local",
    gpuMode,
    s3Paths: inputs.map((input) => getS3Path(input.s3Bucket, input.s3Key)),
  });
  const cpuPrepared = await runLocalConcurrency(
    inputs,
    LOCAL_CONCURRENCY,
    (input) => {
      const s3Path = getS3Path(input.s3Bucket, input.s3Key);
      return prepareCpuPhoto(input, cpuLogs.get(s3Path));
    }
  );
  logger.info(`CPU phase complete for ${total} photos; evaluating GPU checkpoints`);

  const allResults: ProcessPhotoOutput[] = [];
  const gpuInputs: ProcessPhotoInput[] = [];
  for (const prepared of cpuPrepared) {
    const requested = resolveGpuMode(prepared.input);
    const required = requiredGpuMode(
      requested,
      prepared.photo,
      prepared.input.forceGpu
    );
    if (required === "skip") {
      allResults.push({
        ...prepared.output,
        gpuStatus: requested === "skip" ? "skipped" : "completed",
      });
      completed += 1;
      onProgress?.(completed, total);
    } else {
      gpuInputs.push({
        ...prepared.input,
        gpuMode: required,
        forceCpu: false,
        forceGpu: false,
      });
    }
  }

  if (gpuInputs.length === 0) {
    logger.info(`GPU phase skipped: all ${total} photos already satisfy their GPU checkpoints`);
    return allResults;
  }

  const captionLogs = await safeQueuePhotoStageLogs({
    parentId: jobLogId,
    type: "caption",
    provider: batchProvider,
    gpuMode,
    s3Paths: gpuInputs
      .filter((input) => input.gpuMode === "all" || input.gpuMode === "caption-only")
      .map((input) => getS3Path(input.s3Bucket, input.s3Key)),
  });
  const facesLogs = await safeQueuePhotoStageLogs({
    parentId: jobLogId,
    type: "faces",
    provider: batchProvider,
    gpuMode,
    s3Paths: gpuInputs
      .filter((input) => input.gpuMode === "all" || input.gpuMode === "faces-only")
      .map((input) => getS3Path(input.s3Bucket, input.s3Key)),
  });

  // --- GPU mode: reserve funds, create client, manage lifecycle, and meter usage ---
  const externalJobId = options?.externalJobId ?? jobLogId ?? crypto.randomUUID();
  const meteringContext = await beginMeteredGpuJob({
    externalJobId,
    provider: batchProvider,
    gpuMode,
    photoCount: gpuInputs.length,
    routingPolicyVersion: GPU_ROUTING_POLICY_VERSION,
    routingThreshold: getGpuProviderBatchThreshold(),
  });
  let gpuClient: GpuClient | null = null;
  let resourceHeartbeat: ReturnType<typeof setInterval> | null = null;
  const batchStartTime = Date.now();
  let provisionMs = 0;

  try {
    gpuClient = await createGpuClient(batchProvider);
    if (meteringContext) {
      gpuClient.setMeteringContext?.({
        workspaceId: meteringContext.workspaceId,
        externalJobId: meteringContext.externalJobId,
      });
    }
    if (batchProvider === "vastai") {
      gpuClient.setResourceLifecycleHandlers?.(
        createGpuResourceLifecycleHandlers(externalJobId)
      );
      resourceHeartbeat = setInterval(() => {
        void renewGpuResourceLeases(externalJobId).catch((error) =>
          logger.warn(`GPU resource lease heartbeat failed for ${externalJobId}:`, error)
        );
      }, 30_000);
      resourceHeartbeat.unref();
    }
    // A bad/stuck offer is retried here before the durable queue needs another
    // attempt. VastGpuClient switches to a different/on-demand offer after an
    // interruptible allocation fails.
    const provisionStart = Date.now();
    let startAttempt = 0;
    while (true) {
      try {
        if (startAttempt === 0) await gpuClient.start();
        else await gpuClient.reprovision();
        break;
      } catch (error) {
        if (startAttempt >= MAX_REPROVISIONS) throw error;
        startAttempt += 1;
        logger.warn(
          `GPU provisioning failed; retrying with a fresh offer ` +
            `(${startAttempt}/${MAX_REPROVISIONS}): ${error instanceof Error ? error.message : error}`
        );
        await recordGpuResourceUsage(
          meteringContext,
          gpuClient.drainResourceUsage?.() ?? []
        );
      }
    }
    provisionMs = Date.now() - provisionStart;
    logger.info(`GPU provisioning took ${(provisionMs / 1000).toFixed(1)}s`);

    const inferenceStart = Date.now();
    let reprovisionCount = startAttempt;

    // Build the initial list of inputs to process
    let remainingInputs = [...gpuInputs];

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

        const chunkResults = await processGpuChunk(
          chunkInputs,
          gpuClient,
          { caption: captionLogs, faces: facesLogs },
          meteringContext,
          reprovisionCount
        );

        const chunkMs = Date.now() - chunkStartTime;
        logger.info(
          `Chunk ${chunkIdx + 1}/${numChunks} done in ${(chunkMs / 1000).toFixed(1)}s ` +
            `(${(chunkMs / chunkInputs.length / 1000).toFixed(2)}s/photo)`
        );

        // Partition results: completed (has caption or faces depending on mode) vs failed
        for (let i = 0; i < chunkResults.length; i++) {
          const result = chunkResults[i];
          const hasGpuFailure = result.gpuStatus === "failed";

          if (hasGpuFailure) {
            if (result.gpuRetryable) {
              failedInputs.push(chunkInputs[i]);
              // Don't add to allResults yet — we'll retry these
            } else {
              allResults.push(result);
              completed++;
              onProgress?.(completed, total);
            }
          } else {
            allResults.push(result);
            completed++;
            onProgress?.(completed, total);
          }
        }

        // If instance died mid-chunk, don't process more chunks — break out to reprovision
        if (
          gpuClient.provider === "vastai" &&
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
      if (gpuClient.provider !== "vastai") {
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
            takenAtPrecision: "unknown",
            takenAtSource: "unknown",
            location: null,
            description: null,
            facesDetected: 0,
            errors: ["GPU analysis failed — non-interruptible, no retry"],
            gpuStatus: "failed",
            gpuRetryable: false,
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
            takenAtPrecision: "unknown",
            takenAtSource: "unknown",
            location: null,
            description: null,
            facesDetected: 0,
            errors: [
              `GPU analysis failed — max reprovisions (${MAX_REPROVISIONS}) exhausted`,
            ],
            gpuStatus: "failed",
            gpuRetryable: false,
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
      await recordGpuResourceUsage(
        meteringContext,
        gpuClient.drainResourceUsage?.() ?? []
      );
      const reprovisionMs = Date.now() - reprovisionStart;
      logger.info(
        `Reprovisioning took ${(reprovisionMs / 1000).toFixed(1)}s`
      );

      // Loop again with only missing GPU sub-stages. A caption that completed
      // before a face request was interrupted is not billed or executed twice.
      remainingInputs = [];
      for (const failedInput of failedInputs) {
        const s3Path = getS3Path(failedInput.s3Bucket, failedInput.s3Key);
        const photo = await getPhotoByS3Path(s3Path);
        if (!photo) {
          remainingInputs.push(failedInput);
          continue;
        }
        const mode = requiredGpuMode(resolveGpuMode(failedInput), photo);
        if (mode === "skip") {
          allResults.push(outputFromPhoto(photo, [], "completed"));
          completed += 1;
          onProgress?.(completed, total);
        } else {
          remainingInputs.push({ ...failedInput, gpuMode: mode });
        }
      }
    }

    const inferenceMs = Date.now() - inferenceStart;
    const totalMs = Date.now() - batchStartTime;

    logger.info(
      `Batch complete: ${total} photos (${gpuInputs.length} GPU) in ${(totalMs / 1000).toFixed(1)}s total ` +
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
    try {
      // Always tear down the GPU backend (destroys Vast.ai instance, no-op for Modal).
      // Keep the durable resource heartbeat alive while bounded teardown retries run.
      const teardownStart = Date.now();
      try {
        await gpuClient?.stop();
        logger.info(`GPU teardown took ${((Date.now() - teardownStart) / 1000).toFixed(1)}s`);
      } catch (err) {
        logger.error("Failed to stop GPU client; durable cleanup has been scheduled:", err);
      }
      if (gpuClient) {
        await recordGpuResourceUsage(
          meteringContext,
          gpuClient.drainResourceUsage?.() ?? []
        );
      }
      await completeMeteredGpuJob(meteringContext);
      const totalMs = Date.now() - batchStartTime;
      logger.info(`Batch wall time: ${(totalMs / 1000).toFixed(1)}s`);
    } finally {
      if (resourceHeartbeat) clearInterval(resourceHeartbeat);
    }
  }
}

async function saveGpuResults(
  input: ProcessPhotoInput,
  provider: string,
  captionResult: PromiseSettledResult<GpuCaptionResult> | null,
  facesResult: PromiseSettledResult<GpuFacesResult> | null
): Promise<ProcessPhotoOutput> {
  const s3Path = getS3Path(input.s3Bucket, input.s3Key);
  const errors: string[] = [];
  const caption = captionResult ? parseCaptionResult(captionResult, errors) : null;
  const faces = facesResult ? parseFacesResult(facesResult, errors) : [];
  const captionSucceeded = captionResult?.status === "fulfilled";
  const facesSucceeded = facesResult?.status === "fulfilled";

  // Commit successful sub-stages independently. Failed face inference must not
  // delete faces from an earlier successful attempt.
  if (captionSucceeded) {
    await updatePhotoGpuFields({
      s3Path,
      updateCaption: true,
      description: caption,
      captionVersion: CAPTION_VERSION,
      updateFacesVersion: false,
      facesVersion: null,
    });
  }
  if (facesSucceeded) {
    const current = await getPhotoByS3Path(s3Path);
    if (!current) throw new Error(`CPU checkpoint is missing for ${s3Path}`);
    await deleteFacesByPhotoId(current.id);
    for (const face of faces) {
      await insertFace({
        photoId: current.id,
        boundingBox: face.boundingBox,
        embedding: face.embedding,
        confidence: face.confidence,
      });
    }
    await updatePhotoGpuFields({
      s3Path,
      updateCaption: false,
      description: null,
      captionVersion: null,
      updateFacesVersion: true,
      facesVersion: FACES_VERSION,
    });
  }

  const photo = await getPhotoByS3Path(s3Path);
  if (!photo) throw new Error(`CPU checkpoint is missing for ${s3Path}`);
  const requestedSucceeded =
    (captionResult === null || captionSucceeded) &&
    (facesResult === null || facesSucceeded);
  const output = outputFromPhoto(
    photo,
    errors,
    requestedSucceeded ? "completed" : "failed"
  );
  output.gpuRetryable = !requestedSucceeded && [captionResult, facesResult]
    .some((result) => result?.status === "rejected" && isRetryableGpuFailure(result.reason));
  output.facesDetected = facesSucceeded ? faces.length : 0;
  logger.info(`GPU phase ${output.gpuStatus} for ${s3Path}`, {
    provider,
    caption: captionResult?.status ?? "skipped",
    faces: facesResult?.status ?? "skipped",
    errorCount: errors.length,
  });
  return output;
}

/** Process a GPU-only chunk after all CPU checkpoints have committed. */
async function processGpuChunk(
  inputs: ProcessPhotoInput[],
  gpuClient: GpuClient,
  stageLogs?: {
    caption: Map<string, PhotoStageLogRef>;
    faces: Map<string, PhotoStageLogRef>;
  },
  meteringContext?: MeteringJobContext | null,
  reprovision = 0
): Promise<ProcessPhotoOutput[]> {
  interface PendingPhoto {
    input: ProcessPhotoInput;
    s3Path: string;
    imageBuffer: Buffer;
    gpuMode: GpuMode;
    captionLog: PhotoStageLogRef | undefined;
    facesLog: PhotoStageLogRef | undefined;
    captionLogStarted: boolean;
    facesLogStarted: boolean;
    captionPromise: Promise<GpuCaptionResult> | null;
    facesPromise: Promise<GpuFacesResult> | null;
  }

  // Download + dispatch with stable input ordering. CPU work is forbidden here.
  const pending = await runLocalConcurrency(inputs, LOCAL_CONCURRENCY, async (input): Promise<PendingPhoto> => {
    const { s3Bucket, s3Key } = input;
    const s3Path = getS3Path(s3Bucket, s3Key);
    const mode = resolveGpuMode(input);

    logger.info(`Downloading: ${s3Path}`);
    const imageBuffer = await getObjectAsBuffer(s3Bucket, s3Key);
    logger.debug(`Downloaded ${imageBuffer.length} bytes`);

    // Dispatch GPU calls based on mode
    let captionPromise: Promise<GpuCaptionResult> | null = null;
    let facesPromise: Promise<GpuFacesResult> | null = null;
    const captionLog = stageLogs?.caption.get(s3Path);
    const facesLog = stageLogs?.faces.get(s3Path);
    let captionLogStarted = false;
    let facesLogStarted = false;

    if (mode === "all" || mode === "caption-only") {
      captionLogStarted = await safeStartPhotoStageLog(captionLog);
      logger.info(`[GPU caption] starting ${s3Path}`, { provider: gpuClient.provider });
      const startedAt = Date.now();
      captionPromise = gpuClient.caption(imageBuffer).then(
        async (result) => {
          await recordGpuOperationUsage(meteringContext ?? null, {
            operation: "caption",
            elapsedMs: Date.now() - startedAt,
            succeeded: true,
            reprovision,
          });
          return result;
        },
        async (error) => {
          await recordGpuOperationUsage(meteringContext ?? null, {
            operation: "caption",
            elapsedMs: Date.now() - startedAt,
            succeeded: false,
            reprovision,
          });
          throw error;
        }
      );
      captionPromise.catch(() => {}); // suppress unhandled rejection
    }
    if (mode === "all" || mode === "faces-only") {
      facesLogStarted = await safeStartPhotoStageLog(facesLog);
      logger.info(`[GPU faces] starting ${s3Path}`, { provider: gpuClient.provider });
      const startedAt = Date.now();
      facesPromise = gpuClient.faces(imageBuffer).then(
        async (result) => {
          await recordGpuOperationUsage(meteringContext ?? null, {
            operation: "faces",
            elapsedMs: Date.now() - startedAt,
            succeeded: true,
            reprovision,
          });
          return result;
        },
        async (error) => {
          await recordGpuOperationUsage(meteringContext ?? null, {
            operation: "faces",
            elapsedMs: Date.now() - startedAt,
            succeeded: false,
            reprovision,
          });
          throw error;
        }
      );
      facesPromise.catch(() => {}); // suppress unhandled rejection
    }

    return {
      input,
      s3Path,
      imageBuffer,
      gpuMode: mode,
      captionLog,
      facesLog,
      captionLogStarted,
      facesLogStarted,
      captionPromise,
      facesPromise,
    };
  });

  const dispatchedCaption = pending.filter((p) => p.captionPromise).length;
  const dispatchedFaces = pending.filter((p) => p.facesPromise).length;
  logger.info(`Chunk: ${dispatchedCaption} caption + ${dispatchedFaces} faces calls dispatched, awaiting results...`);

  // Phase 2: Collect results and save to DB
  const results: ProcessPhotoOutput[] = [];

  for (const item of pending) {
    const { s3Path } = item;

    try {
      const [captionSettled, facesSettled] = await Promise.all([
        item.captionPromise
          ? Promise.allSettled([item.captionPromise]).then(([result]) => result)
          : Promise.resolve(null),
        item.facesPromise
          ? Promise.allSettled([item.facesPromise]).then(([result]) => result)
          : Promise.resolve(null),
      ]);
      const output = await saveGpuResults(
        item.input,
        gpuClient.provider,
        captionSettled,
        facesSettled
      );
      results.push(output);
      if (captionSettled && item.captionLogStarted && item.captionLog) {
        if (captionSettled.status === "fulfilled") {
          logger.info(`[GPU caption] completed ${s3Path}`, { provider: gpuClient.provider });
          await safeCompleteGpuLog(item.captionLog.id);
          item.captionLog.status = "completed";
        } else {
          const message = captionSettled.reason instanceof Error
            ? captionSettled.reason.message
            : String(captionSettled.reason);
          logger.error(`[GPU caption] failed ${s3Path}: ${message}`);
          await safeFailGpuLog(item.captionLog.id, message);
          item.captionLog.status = "failed";
        }
      }
      if (facesSettled && item.facesLogStarted && item.facesLog) {
        if (facesSettled.status === "fulfilled") {
          logger.info(`[GPU faces] completed ${s3Path}`, { provider: gpuClient.provider });
          await safeCompleteGpuLog(item.facesLog.id);
          item.facesLog.status = "completed";
        } else {
          const message = facesSettled.reason instanceof Error
            ? facesSettled.reason.message
            : String(facesSettled.reason);
          logger.error(`[GPU faces] failed ${s3Path}: ${message}`);
          await safeFailGpuLog(item.facesLog.id, message);
          item.facesLog.status = "failed";
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Batch item failed for ${s3Path}:`, err);
      if (item.captionLogStarted && item.captionLog) {
        await safeFailGpuLog(item.captionLog.id, message);
        item.captionLog.status = "failed";
      }
      if (item.facesLogStarted && item.facesLog) {
        await safeFailGpuLog(item.facesLog.id, message);
        item.facesLog.status = "failed";
      }
      results.push({
        photoId: "",
        s3Path,
        takenAt: null,
        takenAtPrecision: "unknown",
        takenAtSource: "unknown",
        location: null,
        description: null,
        facesDetected: 0,
        errors: [message],
        gpuStatus: "failed",
        gpuRetryable: isRetryableGpuFailure(err),
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
  let completedCount = 0;
  const startTime = Date.now();
  const logEveryN = 50; // log memory/throughput every N items

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
      completedCount++;
      if (completedCount % logEveryN === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = (completedCount / elapsed).toFixed(1);
        logger.info(`[perf] progress: ${completedCount}/${items.length} (${rate} items/s) ${memoryMB()}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}
