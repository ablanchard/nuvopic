import { Hono } from "hono";
import { searchPhotos, getPhotoWithDetails, getTimelineIndex } from "../../db/search.js";
import { getPhotosToReprocess, getPhotosToReprocessCaption, getPhotosToReprocessFaces, getAllPhotosForReprocess, getExistingS3Paths, getVersionStats } from "../../db/queries.js";
import { getPhotoById } from "../../db/queries.js";
import { getFacesByPhotoId } from "../../db/queries.js";
import { processPhoto, processPhotoBatch, type GpuMode } from "../../processor.js";
import { isGpuEnabled, getBatchGpuProvider } from "../../extractors/gpu-client.js";
import { PROCESS_VERSION, CAPTION_VERSION, FACES_VERSION, PROCESS_CHANGELOG, CAPTION_CHANGELOG, FACES_CHANGELOG, compareSemver } from "../../version.js";
import { listAllObjects, getS3Path, getPresignedImageUrl, isSupportedImage } from "../../s3/client.js";
import { logger } from "../../logger.js";
import { clusterUnassignedFaces } from "../../db/clusters.js";
import { getS3Bucket } from "../../db/settings.js";
import { safeCreateGpuLog, safeCompleteGpuLog, safeFailGpuLog } from "../../db/gpu-logs.js";

const photos = new Hono();

// List photos with pagination and filters
photos.get("/", async (c) => {
  const q = c.req.query("q");
  const tag = c.req.query("tag");
  const personId = c.req.query("person");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const smartTag = c.req.query("smartTag");
  const page = parseInt(c.req.query("page") ?? "1", 10);
  const limit = parseInt(c.req.query("limit") ?? "20", 10);

  const filters = {
    search: q || undefined,
    tagIds: tag ? [tag] : undefined,
    personId: personId || undefined,
    smartTagId: smartTag || undefined,
    dateFrom: from ? new Date(from) : undefined,
    dateTo: to ? new Date(to) : undefined,
    limit: Math.min(limit, 100),
    offset: (page - 1) * limit,
  };

  const { photos: photoList, total } = await searchPhotos(filters);

  return c.json({
    photos: photoList.map((p) => ({
      id: p.id,
      fullImageUrl: `/api/v1/photos/${p.id}/image`,
      placeholder: p.placeholder,
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

// Timeline index: lightweight year/month counts for virtual scrolling
photos.get("/timeline", async (c) => {
  const q = c.req.query("q");
  const tag = c.req.query("tag");
  const personId = c.req.query("person");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const smartTag = c.req.query("smartTag");

  const filters = {
    search: q || undefined,
    tagIds: tag ? [tag] : undefined,
    personId: personId || undefined,
    smartTagId: smartTag || undefined,
    dateFrom: from ? new Date(from) : undefined,
    dateTo: to ? new Date(to) : undefined,
  };

  const groups = await getTimelineIndex(filters);
  const total = groups.reduce((sum, g) => sum + g.count, 0);

  return c.json({ groups, total });
});

// Reprocess stats: aggregated version distribution for the reprocess dashboard
photos.get("/reprocess/stats", async (c) => {
  const pathPrefix = c.req.query("pathPrefix") || undefined;

  const stats = await getVersionStats(pathPrefix);
  const gpuEnabled = isGpuEnabled();
  const provider = getBatchGpuProvider();
  const secsPerPhoto = gpuEnabled ? 3 : 11;
  const costPerHour = parseFloat(process.env.GPU_COST_PER_HOUR ?? "0");

  // Compute outdated counts per pipeline
  function computeOutdated(
    versions: Record<string, number>,
    latestVersion: string
  ): number {
    let outdated = 0;
    for (const [version, count] of Object.entries(versions)) {
      if (version === "null" || compareSemver(version, latestVersion) < 0) {
        outdated += count;
      }
    }
    return outdated;
  }

  return c.json({
    totalPhotos: stats.totalPhotos,
    pathPrefix: pathPrefix ?? null,
    process: {
      versions: stats.process,
      latestVersion: PROCESS_VERSION,
      outdated: computeOutdated(stats.process, PROCESS_VERSION),
      changelog: PROCESS_CHANGELOG,
    },
    caption: {
      versions: stats.caption,
      latestVersion: CAPTION_VERSION,
      outdated: computeOutdated(stats.caption, CAPTION_VERSION),
      changelog: CAPTION_CHANGELOG,
    },
    faces: {
      versions: stats.faces,
      latestVersion: FACES_VERSION,
      outdated: computeOutdated(stats.faces, FACES_VERSION),
      changelog: FACES_CHANGELOG,
    },
    estimates: {
      gpuEnabled,
      provider,
      secsPerPhoto,
      costPerHour,
    },
  });
});

// Preview reprocessing: show what would be reprocessed and why
photos.get("/reprocess", async (c) => {
  const mode = c.req.query("mode") ?? "all"; // "all" | "caption" | "faces"

  let photosToReprocess;
  if (mode === "caption") {
    photosToReprocess = await getPhotosToReprocessCaption(CAPTION_VERSION);
  } else if (mode === "faces") {
    photosToReprocess = await getPhotosToReprocessFaces(FACES_VERSION);
  } else {
    photosToReprocess = await getPhotosToReprocess(PROCESS_VERSION);
  }

  return c.json({
    mode,
    currentVersions: {
      process: PROCESS_VERSION,
      caption: CAPTION_VERSION,
      faces: FACES_VERSION,
    },
    photosToReprocess: photosToReprocess.length,
    photos: photosToReprocess.map((p) => ({
      id: p.id,
      s3Path: p.s3_path,
    })),
    changelog: {
      process: PROCESS_CHANGELOG,
      caption: CAPTION_CHANGELOG,
      faces: FACES_CHANGELOG,
    },
  });
});

// Trigger reprocessing of outdated photos
// Body options:
//   { "force": true }             — reprocess all photos (not just outdated)
//   { "skipModal": true }         — skip GPU work entirely (local extraction only)
//   { "mode": "caption" }         — reprocess only captions (skip face detection)
//   { "mode": "faces" }           — reprocess only faces (skip captioning)
//   { "mode": "all" }             — reprocess both (default)
photos.post("/reprocess", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const force: boolean = body.force === true;
  const skipModal: boolean = body.skipModal === true;
  const mode: string = body.mode ?? "all";
  const pathPrefix: string | undefined = body.pathPrefix || undefined;

  // Determine which photos need reprocessing
  let photosToProcess;
  if (force) {
    photosToProcess = await getAllPhotosForReprocess(pathPrefix);
  } else if (mode === "caption") {
    photosToProcess = await getPhotosToReprocessCaption(CAPTION_VERSION, pathPrefix);
  } else if (mode === "faces") {
    photosToProcess = await getPhotosToReprocessFaces(FACES_VERSION, pathPrefix);
  } else {
    photosToProcess = await getPhotosToReprocess(PROCESS_VERSION, pathPrefix);
  }

  if (photosToProcess.length === 0) {
    return c.json({
      message: "All photos are up to date",
      currentVersions: {
        process: PROCESS_VERSION,
        caption: CAPTION_VERSION,
        faces: FACES_VERSION,
      },
      reprocessed: 0,
    });
  }

  // Resolve GPU mode
  let gpuMode: GpuMode;
  if (skipModal) {
    gpuMode = "skip";
  } else if (mode === "caption") {
    gpuMode = "caption-only";
  } else if (mode === "faces") {
    gpuMode = "faces-only";
  } else {
    gpuMode = "all";
  }

  logger.info(`Reprocessing ${photosToProcess.length} photos (force=${force}, gpuMode=${gpuMode})`);
  const startTime = Date.now();

  // Create a job-level GPU log entry
  const provider = getBatchGpuProvider();
  const jobLogId = await safeCreateGpuLog({
    type: "reprocess",
    provider,
    gpuMode,
    photoCount: photosToProcess.length,
  });

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
    batchInputs.map((p) => ({ s3Bucket: p.s3Bucket, s3Key: p.s3Key, gpuMode })),
    (completed, total) => {
      if (completed % 10 === 0 || completed === total) {
        logger.info(`Reprocess progress: ${completed}/${total}`);
      }
    },
    jobLogId
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

  // Complete the job-level GPU log
  await safeCompleteGpuLog(jobLogId, { photosSucceeded: succeeded, photosFailed: failed });

  // Auto-cluster newly detected faces after reprocess (only if we processed faces)
  if (gpuMode === "all" || gpuMode === "faces-only") {
    try {
      const clusterResult = await clusterUnassignedFaces({ threshold: 0.6, strategy: "first" });
      logger.info(`Auto-clustered ${clusterResult.clustered} faces into ${clusterResult.newClusters} new clusters`);
    } catch (err) {
      logger.error("Auto-clustering failed:", err);
    }
  }

  return c.json({
    mode: gpuMode,
    currentVersions: {
      process: PROCESS_VERSION,
      caption: CAPTION_VERSION,
      faces: FACES_VERSION,
    },
    reprocessed: succeeded,
    failed,
    elapsedSeconds: parseFloat(elapsed),
    results,
  });
});

// Preview import: list S3 objects that would be imported
photos.get("/import", async (c) => {
  const bucket = await getS3Bucket();
  if (!bucket) {
    return c.json({ error: "S3 bucket not configured. Set S3_BUCKET env var or configure it in Settings." }, 500);
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
  const secsPerPhoto = isGpuEnabled() ? 3 : 11;
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
  const bucket = await getS3Bucket();
  if (!bucket) {
    return c.json({ error: "S3 bucket not configured. Set S3_BUCKET env var or configure it in Settings." }, 500);
  }

  const body = await c.req.json().catch(() => ({}));
  const prefix: string = body.prefix ?? "";
  const limit: number = body.limit ?? 100;
  const sort: string = body.sort ?? "recent";
  const skipModal: boolean = body.skipModal === true;

  // Granular GPU mode: accept explicit gpuMode, or derive from legacy skipModal flag
  // Supported: "all" | "caption-only" | "faces-only" | "skip"
  let gpuMode: GpuMode;
  if (body.gpuMode) {
    gpuMode = body.gpuMode as GpuMode;
  } else {
    gpuMode = skipModal ? "skip" : "all";
  }

  logger.info(`Import started: bucket=${bucket}, prefix=${prefix}, limit=${limit}, sort=${sort}, gpuMode=${gpuMode}`);

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

  // Create a job-level GPU log entry for this import
  const importProvider = skipModal ? "local" : getBatchGpuProvider();
  const jobLogId = await safeCreateGpuLog({
    type: "import",
    provider: importProvider,
    gpuMode,
    photoCount: toProcess.length,
  });

  const batchInputs = toProcess.map((key) => ({ s3Bucket: bucket, s3Key: key, gpuMode }));
  const batchResults = await processPhotoBatch(
    batchInputs,
    (completed, total) => {
      if (completed % 10 === 0 || completed === total) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = (completed / parseFloat(elapsed)).toFixed(2);
        logger.info(`Import progress: ${completed}/${total} (${elapsed}s, ${rate} photos/s)`);
      }
    },
    jobLogId
  );

  const results = toProcess.map((key, i) => ({
    key,
    success: batchResults[i].errors.length === 0 || batchResults[i].photoId !== "",
    error: batchResults[i].errors.length > 0 ? batchResults[i].errors.join("; ") : undefined,
  }));

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Complete the job-level GPU log
  await safeCompleteGpuLog(jobLogId, { photosSucceeded: succeeded, photosFailed: failed });

  logger.info(`Import complete: ${succeeded} succeeded, ${failed} failed in ${elapsed}s`);

  // Auto-cluster newly detected faces
  try {
    const clusterResult = await clusterUnassignedFaces({ threshold: 0.6, strategy: "first" });
    logger.info(`Auto-clustered ${clusterResult.clustered} faces into ${clusterResult.newClusters} new clusters`);
  } catch (err) {
    logger.error("Auto-clustering failed:", err);
  }

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
    fullImageUrl: `/api/v1/photos/${photo.id}/image`,
    placeholder: photo.placeholder,
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
