import { Hono } from "hono";
import { browseFolder, getS3Path } from "../../s3/client.js";
import {
  countImportedByKeys,
  countImportedByPrefixes,
} from "../../db/queries.js";
import { getS3Bucket } from "../../db/settings.js";
import { logger } from "../../logger.js";

const storage = new Hono();

/**
 * GET /api/v1/storage/browse?prefix=...
 *
 * Browse S3 folders at the given prefix. Returns:
 * - Immediate subfolders, without recursively scanning their contents
 * - Count of images directly at this level
 * - For each folder + this level: imported counts sourced from PostgreSQL
 */
storage.get("/browse", async (c) => {
  const bucket = await getS3Bucket();
  if (!bucket) {
    return c.json(
      { error: "S3 bucket not configured. Complete storage setup in Settings." },
      500
    );
  }

  const prefix = c.req.query("prefix") ?? "";

  logger.info(`Storage browse: bucket=${bucket}, prefix=${prefix || "(root)"}`);

  const result = await browseFolder(bucket, prefix);

  // Current-level totals are exact because the delimiter listing returned
  // these keys. Subfolder totals remain unknown until that folder is opened.
  const currentLevelS3Paths = result.imageKeys.map((key) => getS3Path(bucket, key));
  const folderS3Prefixes = result.folders.map((folder) =>
    getS3Path(bucket, folder.prefix)
  );
  const [currentLevelImported, folderImportCounts] = await Promise.all([
    countImportedByKeys(currentLevelS3Paths),
    countImportedByPrefixes(folderS3Prefixes),
  ]);

  return c.json({
    bucket,
    prefix: prefix || "",
    folders: result.folders.map((folder) => {
      const s3Prefix = getS3Path(bucket, folder.prefix);
      return {
        prefix: folder.prefix,
        name: folder.name,
        imageCount: null,
        importedCount: folderImportCounts.get(s3Prefix) ?? 0,
        missingCount: null,
      };
    }),
    imageCount: result.imageCount,
    importedCount: currentLevelImported,
    missingCount: result.imageCount - currentLevelImported,
  });
});

export default storage;
