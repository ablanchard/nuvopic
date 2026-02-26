import { Hono } from "hono";
import { searchPhotos, getPhotoWithDetails } from "../../db/search.js";
import { getPhotoById, getPhotosToReprocess, getAllPhotosForReprocess, getExistingS3Paths } from "../../db/queries.js";
import { getFacesByPhotoId } from "../../db/queries.js";
import { processPhoto, processPhotoBatch } from "../../processor.js";
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
      thumbnailUrl: `/api/v1/photos/${p.id}/thumbnail?v=${PROCESS_VERSION}`,
      fullImageUrl: `/api/v1/photos/${p.id}/image`,
      takenAt: p.taken_at,
      description: p.description,
      width: p.width,
      height: p.height,
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

// Trigger reprocessing of outdated photos (pass { "force": true } to reprocess all, { "skipModal": true } to skip GPU work)
photos.post("/reprocess", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const force: boolean = body.force === true;
  const skipModal: boolean = body.skipModal === true;

  const photosToProcess = force
    ? await getAllPhotosForReprocess()
    : await getPhotosToReprocess(PROCESS_VERSION);

  if (photosToProcess.length === 0) {
    return c.json({
      message: "All photos are up to date",
      currentVersion: PROCESS_VERSION,
      reprocessed: 0,
    });
  }

  logger.info(`Reprocessing ${photosToProcess.length} photos (force=${force}, skipModal=${skipModal})`);
  const startTime = Date.now();

  // Build batch inputs, skipping any with invalid s3_path
  const batchInputs: Array<{ id: string; s3Path: string; s3Bucket: string; s3Key: string }> = [];
  const skipped: Array<{ id: string; s3Path: string; error: string }> = [];

  for (const photo of photosToProcess) {
    const match = photo.s3_path.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (!match) {
      skipped.push({ id: photo.id, s3Path: photo.s3_path, error: "Invalid s3_path format" });
      continue;
    }
    batchInputs.push({ id: photo.id, s3Path: photo.s3_path, s3Bucket: match[1], s3Key: match[2] });
  }

  const batchResults = await processPhotoBatch(
    batchInputs.map((p) => ({ s3Bucket: p.s3Bucket, s3Key: p.s3Key, skipModal })),
    (completed, total) => {
      if (completed % 10 === 0 || completed === total) {
        logger.info(`Reprocess progress: ${completed}/${total}`);
      }
    }
  );

  // Merge results
  const results = [
    ...batchInputs.map((p, i) => ({
      id: p.id,
      s3Path: p.s3Path,
      success: batchResults[i].errors.length === 0 || batchResults[i].photoId !== "",
      error: batchResults[i].errors.length > 0 ? batchResults[i].errors.join("; ") : undefined,
    })),
    ...skipped.map((s) => ({ id: s.id, s3Path: s.s3Path, success: false, error: s.error })),
  ];

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  return c.json({
    currentVersion: PROCESS_VERSION,
    reprocessed: succeeded,
    failed,
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

  // Rough time estimate: Modal ~3s/photo (GPU bound, sequential), local ~11s/photo
  const secsPerPhoto = isModalEnabled() ? 3 : 11;
  const estimatedSeconds = Math.ceil(limited.length * secsPerPhoto);

  return c.json({
    bucket,
    prefix: prefix || "(root)",
    sort,
    totalObjects: allKeys.length,
    totalImages: imageKeys.length,
    alreadyImported: existing.size,
    toImport: limited.length,
    remainingAfterLimit: newKeys.length - limited.length,
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

  logger.info(`Import started: bucket=${bucket}, prefix=${prefix}, limit=${limit}, sort=${sort}`);

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

  logger.info(`Found ${imageKeys.length} images, ${existing.size} already imported, processing ${toProcess.length}`);

  const startTime = Date.now();

  const batchInputs = toProcess.map((key) => ({ s3Bucket: bucket, s3Key: key }));
  const batchResults = await processPhotoBatch(
    batchInputs,
    (completed, total) => {
      if (completed % 10 === 0 || completed === total) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = (completed / parseFloat(elapsed)).toFixed(2);
        logger.info(`Import progress: ${completed}/${total} (${elapsed}s, ${rate} photos/s)`);
      }
    }
  );

  const results = toProcess.map((key, i) => ({
    key,
    success: batchResults[i].errors.length === 0 || batchResults[i].photoId !== "",
    error: batchResults[i].errors.length > 0 ? batchResults[i].errors.join("; ") : undefined,
  }));

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
    thumbnailUrl: `/api/v1/photos/${photo.id}/thumbnail?v=${PROCESS_VERSION}`,
    fullImageUrl: `/api/v1/photos/${photo.id}/image`,
    takenAt: photo.taken_at,
    description: photo.description,
    width: photo.width,
    height: photo.height,
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
