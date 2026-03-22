import { Hono } from "hono";
import { browseFolder, getS3Path, isSupportedImage, listAllObjects } from "../../s3/client.js";
import { countImportedByKeys } from "../../db/queries.js";
import { getS3Bucket } from "../../db/settings.js";
import { logger } from "../../logger.js";

const storage = new Hono();

/**
 * GET /api/v1/storage/browse?prefix=...
 *
 * Browse S3 folders at the given prefix. Returns:
 * - Immediate subfolders with recursive image counts
 * - Count of images directly at this level
 * - For each folder + this level: how many are already imported in DB
 */
storage.get("/browse", async (c) => {
  const bucket = await getS3Bucket();
  if (!bucket) {
    return c.json(
      { error: "S3 bucket not configured. Set S3_BUCKET env var or configure it in Settings." },
      500
    );
  }

  const prefix = c.req.query("prefix") ?? "";

  logger.info(`Storage browse: bucket=${bucket}, prefix=${prefix || "(root)"}`);

  const result = await browseFolder(bucket, prefix);

  // Build a list of all image keys we need to check against the DB
  // (images at this level + images in each subfolder)
  // For this-level images, we already have the keys.
  // For subfolder images, we need the full keys to check DB.
  // Rather than re-listing, we do a batch DB check per folder.

  // Check how many of the current-level images are imported
  const currentLevelS3Paths = result.imageKeys.map((key) => getS3Path(bucket, key));
  const currentLevelImported = await countImportedByKeys(currentLevelS3Paths);

  // For each subfolder, count imported photos
  const folderImportCounts = await Promise.all(
    result.folders.map(async (folder) => {
      if (folder.imageCount === 0) return 0;
      // List all keys under this prefix and check DB
      const allKeys = await listAllObjects(bucket, folder.prefix);
      const imageKeys = allKeys.filter(isSupportedImage);
      const s3Paths = imageKeys.map((key) => getS3Path(bucket, key));
      return countImportedByKeys(s3Paths);
    })
  );

  return c.json({
    bucket,
    prefix: prefix || "",
    folders: result.folders.map((folder, i) => ({
      prefix: folder.prefix,
      name: folder.name,
      imageCount: folder.imageCount,
      importedCount: folderImportCounts[i],
      missingCount: folder.imageCount - folderImportCounts[i],
    })),
    imageCount: result.imageCount,
    importedCount: currentLevelImported,
    missingCount: result.imageCount - currentLevelImported,
  });
});

export default storage;
