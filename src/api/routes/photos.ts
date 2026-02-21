import { Hono } from "hono";
import { searchPhotos, getPhotoWithDetails } from "../../db/search.js";
import { getPhotoById, getPhotosToReprocess } from "../../db/queries.js";
import { getFacesByPhotoId } from "../../db/queries.js";
import { processPhoto } from "../../processor.js";
import { PROCESS_VERSION, PROCESS_CHANGELOG } from "../../version.js";
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

  const results: { id: string; s3Path: string; success: boolean; error?: string }[] = [];

  for (const photo of outdated) {
    // Extract bucket and key from s3_path (format: s3://bucket/key)
    const match = photo.s3_path.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (!match) {
      results.push({ id: photo.id, s3Path: photo.s3_path, success: false, error: "Invalid s3_path format" });
      continue;
    }

    const [, bucket, key] = match;
    try {
      await processPhoto({ s3Bucket: bucket, s3Key: key });
      results.push({ id: photo.id, s3Path: photo.s3_path, success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Reprocess failed for ${photo.s3_path}:`, err);
      results.push({ id: photo.id, s3Path: photo.s3_path, success: false, error: message });
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  return c.json({
    currentVersion: PROCESS_VERSION,
    reprocessed: succeeded,
    failed,
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

  return new Response(photo.thumbnail, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
      "ETag": `"${id}"`,
    },
  });
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
