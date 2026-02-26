import { Hono } from "hono";
import * as os from "os";
import { searchPhotos, getPhotoWithDetails } from "../../db/search.js";
import { getPhotoById, getPhotosToReprocess, getExistingS3Paths } from "../../db/queries.js";
import { getFacesByPhotoId } from "../../db/queries.js";
import { processPhoto } from "../../processor.js";
import { isModalEnabled } from "../../extractors/modal-client.js";
import { PROCESS_VERSION, PROCESS_CHANGELOG } from "../../version.js";
import { listAllObjects, getS3Path, getPresignedImageUrl } from "../../s3/client.js";
import { logger } from "../../logger.js";

const photos = new Hono();

// List photos with pagination and filters
photos.get("/", async (c) => {
  const q = c.req.query("q");
  const tag = c.req.query("tag");
  const personId = c.req.query("person");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const page = parseInt(c.req.query("page") ?? "1", 10);
  const limit = parseInt(c.req.query("limit") ?? "20", 10);

  const filters = {
    search: q || undefined,
    tagIds: tag ? [tag] : undefined,
    personId: personId || undefined,
    dateFrom: from ? new Date(from) : undefined,
    dateTo: to ? new Date(to) : undefined,
    limit: Math.min(limit, 100),
    offset: (page - 1) * limit,
  };

  const { photos: photoList, total } = await searchPhotos(filters);

  return c.json({
    photos: photoList.map((p) => ({
      id: p.id,
      thumbnailUrl: `/api/v1/photos/${p.id}/thumbnail`,
      fullImageUrl: `/api/v1/photos/${p.id}/image`,
      takenAt: p.taken_at,
      description: p.description,
      faceCount: p.face_count,
      tags: p.tags,
      location: p.location_lat && p.location_lng
        ? { lat: p.location_lat, lng: p.location_lng, name: p.location_name }
        : null,
    })),
    pagination: {
      page,
      limit,
      total,
      hasMore: page * limit < total,
    },
  });
});

// Preview reprocessing: show what would be reprocessed and why
photos.get("/reprocess", async (c) => {
  const outdated = await getPhotosToReprocess(PROCESS_VERSION);

  // Collect changelog entries for versions newer than each photo's version
  const changesApplied: Record<string, string> = {};
  for (const [version, description] of Object.entries(PROCESS_CHANGELOG)) {
    changesApplied[version] = description;
  }

  return c.json({
    currentVersion: PROCESS_VERSION,
    photosToReprocess: outdated.length,
    photos: outdated.map((p) => ({
      id: p.id,
      s3Path: p.s3_path,
      processVersion: p.process_version ?? null,
    })),
    changelog: changesApplied,
  });
});

// Trigger reprocessing of outdated photos
photos.post("/reprocess", async (c) => {
  const outdated = await getPhotosToReprocess(PROCESS_VERSION);

  if (outdated.length === 0) {
    return c.json({
      message: "All photos are up to date",
      currentVersion: PROCESS_VERSION,
      reprocessed: 0,
    });
  }

  const body = await c.req.json().catch(() => ({}));
  const requestedConcurrency: number | undefined = body.concurrency;
  const { concurrency: autoConcurrency } = getOptimalConcurrency();
  const concurrency = requestedConcurrency ?? autoConcurrency;

  logger.info(`Reprocessing ${outdated.length} photos with ${concurrency} workers`);
  const startTime = Date.now();

  const results = await runWithConcurrency(
    outdated,
    concurrency,
    async (photo): Promise<{ id: string; s3Path: string; success: boolean; error?: string }> => {
      const match = photo.s3_path.match(/^s3:\/\/([^/]+)\/(.+)$/);
      if (!match) {
        return { id: photo.id, s3Path: photo.s3_path, success: false, error: "Invalid s3_path format" };
      }

      const [, bucket, key] = match;
      try {
        await processPhoto({ s3Bucket: bucket, s3Key: key });
        return { id: photo.id, s3Path: photo.s3_path, success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`Reprocess failed for ${photo.s3_path}:`, err);
        return { id: photo.id, s3Path: photo.s3_path, success: false, error: message };
      }
    },
    (completed, total) => {
      if (completed % 10 === 0 || completed === total) {
        logger.info(`Reprocess progress: ${completed}/${total}`);
      }
    }
  );

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  return c.json({
    currentVersion: PROCESS_VERSION,
    reprocessed: succeeded,
    failed,
    concurrency,
    elapsedSeconds: parseFloat(elapsed),
    results,
  });
});

// Supported image extensions (same as index.ts)
const SUPPORTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".heic", ".webp"];
function isSupportedImage(key: string): boolean {
  const lower = key.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// Memory per concurrent photo processing (estimated ~200MB for buffers + inference)
const MEMORY_PER_WORKER_MB = 200;

// Modal mode: single container, queue requests sequentially
const MODAL_CONCURRENCY = 1;

/**
 * Auto-detect optimal concurrency based on available CPU cores and total memory.
 * In Modal mode, processing is I/O-bound so we can run many more concurrent tasks.
 * On macOS, os.freemem() is unreliable (doesn't account for reclaimable pages),
 * so we use a percentage of total memory instead.
 */
function getOptimalConcurrency(): { concurrency: number; reason: string } {
  if (isModalEnabled()) {
    return {
      concurrency: MODAL_CONCURRENCY,
      reason: `modal mode: processing is I/O-bound, using ${MODAL_CONCURRENCY} concurrent HTTP calls`,
    };
  }

  const cpuCores = os.cpus().length;
  const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
  const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
  const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);

  // Use 50% of total memory as available for workers (conservative; OS + other apps get the rest)
  const availableForWorkers = Math.max(0, Math.round(totalMemMB * 0.5) - rss);

  const maxByCpu = Math.max(1, cpuCores - 2); // leave 2 cores for OS + server
  const maxByMem = Math.max(1, Math.floor(availableForWorkers / MEMORY_PER_WORKER_MB));

  const concurrency = Math.min(maxByCpu, maxByMem);

  const reason = `cpus=${cpuCores} (max ${maxByCpu}), totalMem=${totalMemMB}MB, freeMem=${freeMemMB}MB, rss=${rss}MB, budgetForWorkers=${availableForWorkers}MB (max ${maxByMem}), chosen=${concurrency}`;

  return { concurrency, reason };
}

/**
 * Run async tasks with bounded concurrency (worker pool pattern).
 * Calls onProgress after each task completes.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
  onProgress?: (completed: number, total: number) => void
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
      completed++;
      onProgress?.(completed, items.length);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );

  await Promise.all(workers);
  return results;
}

// Preview import: list S3 objects that would be imported
photos.get("/import", async (c) => {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    return c.json({ error: "S3_BUCKET not configured" }, 500);
  }

  const prefix = c.req.query("prefix") ?? "";
  const limit = parseInt(c.req.query("limit") ?? "100", 10);
  const sort = c.req.query("sort") ?? "recent"; // "recent" (newest first) or "oldest"

  logger.info(`Import preview: bucket=${bucket}, prefix=${prefix}, limit=${limit}, sort=${sort}`);

  // List all objects under prefix (we need more than limit to account for filtering)
  const allKeys = await listAllObjects(bucket, prefix || undefined);
  const imageKeys = allKeys.filter(isSupportedImage);

  // Sort: S3 returns lexicographic (oldest first for date-based keys), reverse for recent
  if (sort === "recent") {
    imageKeys.reverse();
  }

  // Check which ones are already imported
  const s3Paths = imageKeys.map((key) => getS3Path(bucket, key));
  const existing = await getExistingS3Paths(s3Paths);
  const newKeys = imageKeys.filter((key) => !existing.has(getS3Path(bucket, key)));
  const limited = newKeys.slice(0, limit);

  const { concurrency, reason } = getOptimalConcurrency();
  const secsPerPhoto = isModalEnabled() ? 3 : 11;
  const estimatedSeconds = Math.ceil((limited.length / concurrency) * secsPerPhoto);

  return c.json({
    bucket,
    prefix: prefix || "(root)",
    sort,
    totalObjects: allKeys.length,
    totalImages: imageKeys.length,
    alreadyImported: existing.size,
    toImport: limited.length,
    remainingAfterLimit: newKeys.length - limited.length,
    concurrency,
    concurrencyReason: reason,
    estimatedTime: `${Math.ceil(estimatedSeconds / 60)} minutes`,
    keys: limited,
  });
});

// Import photos from S3 bucket
photos.post("/import", async (c) => {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    return c.json({ error: "S3_BUCKET not configured" }, 500);
  }

  const body = await c.req.json().catch(() => ({}));
  const prefix: string = body.prefix ?? "";
  const limit: number = body.limit ?? 100;
  const sort: string = body.sort ?? "recent";
  const requestedConcurrency: number | undefined = body.concurrency;

  // Auto-detect or use requested concurrency
  const { concurrency: autoConcurrency, reason } = getOptimalConcurrency();
  const concurrency = requestedConcurrency ?? autoConcurrency;

  logger.info(`Import started: bucket=${bucket}, prefix=${prefix}, limit=${limit}, sort=${sort}, concurrency=${concurrency} (${requestedConcurrency ? "manual" : "auto: " + reason})`);

  // List all objects under prefix
  const allKeys = await listAllObjects(bucket, prefix || undefined);
  const imageKeys = allKeys.filter(isSupportedImage);

  // Sort: S3 returns lexicographic (oldest first for date-based keys), reverse for recent
  if (sort === "recent") {
    imageKeys.reverse();
  }

  // Check which ones are already imported
  const s3Paths = imageKeys.map((key) => getS3Path(bucket, key));
  const existing = await getExistingS3Paths(s3Paths);
  const newKeys = imageKeys.filter((key) => !existing.has(getS3Path(bucket, key)));
  const toProcess = newKeys.slice(0, limit);

  logger.info(`Found ${imageKeys.length} images, ${existing.size} already imported, processing ${toProcess.length} with ${concurrency} workers`);

  const startTime = Date.now();

  const results = await runWithConcurrency(
    toProcess,
    concurrency,
    async (key): Promise<{ key: string; success: boolean; error?: string }> => {
      try {
        await processPhoto({ s3Bucket: bucket, s3Key: key });
        return { key, success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`Import failed for ${key}:`, err);
        return { key, success: false, error: message };
      }
    },
    (completed, total) => {
      if (completed % 10 === 0 || completed === total) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = (completed / parseFloat(elapsed)).toFixed(2);
        logger.info(`Import progress: ${completed}/${total} (${elapsed}s, ${rate} photos/s)`);
      }
    }
  );

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  logger.info(`Import complete: ${succeeded} succeeded, ${failed} failed in ${elapsed}s`);

  return c.json({
    bucket,
    prefix: prefix || "(root)",
    totalImages: imageKeys.length,
    alreadyImported: existing.size,
    processed: succeeded,
    failed,
    remaining: newKeys.length - toProcess.length,
    concurrency,
    elapsedSeconds: parseFloat(elapsed),
    photosPerSecond: parseFloat((succeeded / parseFloat(elapsed)).toFixed(2)),
    results,
  });
});

// Get single photo details
photos.get("/:id", async (c) => {
  const id = c.req.param("id");
  const photo = await getPhotoWithDetails(id);

  if (!photo) {
    return c.json({ error: "Photo not found" }, 404);
  }

  return c.json({
    id: photo.id,
    s3Path: photo.s3_path,
    thumbnailUrl: `/api/v1/photos/${photo.id}/thumbnail`,
    fullImageUrl: `/api/v1/photos/${photo.id}/image`,
    takenAt: photo.taken_at,
    description: photo.description,
    faceCount: photo.face_count,
    tags: photo.tags,
    location: photo.location_lat && photo.location_lng
      ? { lat: photo.location_lat, lng: photo.location_lng, name: photo.location_name }
      : null,
  });
});

// Get thumbnail image
photos.get("/:id/thumbnail", async (c) => {
  const id = c.req.param("id");
  const photo = await getPhotoById(id);

  if (!photo?.thumbnail) {
    return c.json({ error: "Thumbnail not found" }, 404);
  }

  // Detect format from magic bytes: WebP starts with "RIFF....WEBP", JPEG with 0xFF 0xD8
  const bytes = photo.thumbnail;
  const isWebP =
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  const contentType = isWebP ? "image/webp" : "image/jpeg";

  return new Response(photo.thumbnail, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "ETag": `"${id}"`,
    },
  });
});

// Get full-resolution image (presigned S3 URL)
photos.get("/:id/image", async (c) => {
  const id = c.req.param("id");
  const photo = await getPhotoById(id);

  if (!photo) {
    return c.json({ error: "Photo not found" }, 404);
  }

  const match = photo.s3_path.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    return c.json({ error: "Invalid s3_path format" }, 500);
  }

  const [, bucket, key] = match;
  const url = await getPresignedImageUrl(bucket, key);

  return c.json({ url });
});

// Get faces for a photo
photos.get("/:id/faces", async (c) => {
  const id = c.req.param("id");
  const faces = await getFacesByPhotoId(id);

  return c.json({
    faces: faces.map((f) => ({
      id: f.id,
      boundingBox: f.bounding_box,
      personId: f.person_id,
    })),
  });
});

export default photos;
