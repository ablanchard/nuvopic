import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getResolvedS3Config } from "../db/settings.js";
import { getCurrentDatabaseCacheKey } from "../db/client.js";

const s3Clients = new Map<string, S3Client>();

const FOLDER_IMAGE_COUNT_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_FOLDER_IMAGE_COUNT_CACHE_ENTRIES = 500;

interface FolderImageCountCacheEntry {
  cacheKey: string;
  expiresAt: number;
  settled: boolean;
  promise: Promise<FolderImageCountsResult>;
}

const folderImageCountCache = new Map<string, FolderImageCountCacheEntry>();

export interface S3Config {
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

/**
 * Build S3Config from DB settings only.
 * Throws if required fields (region, accessKeyId, secretAccessKey) are missing.
 */
async function buildS3Config(): Promise<S3Config> {
  const resolved = await getResolvedS3Config();

  if (!resolved.region || !resolved.accessKeyId || !resolved.secretAccessKey) {
    throw new Error(
      "S3 region, access key ID, and secret access key are required. " +
        "Configure them in NuvoPic Settings."
    );
  }

  return {
    endpoint: resolved.endpoint || undefined,
    region: resolved.region,
    accessKeyId: resolved.accessKeyId,
    secretAccessKey: resolved.secretAccessKey,
    forcePathStyle: resolved.forcePathStyle || undefined,
  };
}

export async function getS3Client(): Promise<S3Client> {
  const cacheKey = getCurrentDatabaseCacheKey();
  let s3Client = s3Clients.get(cacheKey);

  if (!s3Client) {
    const config = await buildS3Config();

    s3Client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle,
    });
    s3Clients.set(cacheKey, s3Client);
  }

  return s3Client;
}

/**
 * Invalidate the cached S3 client so the next call to getS3Client()
 * rebuilds it from current DB settings.
 * Call this after S3-related settings are changed.
 */
export function invalidateS3Client(): void {
  const cacheKey = getCurrentDatabaseCacheKey();
  const s3Client = s3Clients.get(cacheKey);
  if (s3Client) {
    s3Client.destroy();
    s3Clients.delete(cacheKey);
  }
  invalidateFolderImageCountCache(cacheKey);
}

export function invalidateAllS3Clients(): void {
  for (const client of s3Clients.values()) {
    client.destroy();
  }
  s3Clients.clear();
  folderImageCountCache.clear();
}

function invalidateFolderImageCountCache(cacheKey: string): void {
  for (const [key, entry] of folderImageCountCache) {
    if (entry.cacheKey === cacheKey) {
      folderImageCountCache.delete(key);
    }
  }
}

export async function getObject(
  bucket: string,
  key: string
): Promise<GetObjectCommandOutput> {
  const client = await getS3Client();
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return client.send(command);
}

export async function getObjectAsBuffer(
  bucket: string,
  key: string
): Promise<Buffer> {
  const response = await getObject(bucket, key);

  if (!response.Body) {
    throw new Error(`Empty response body for s3://${bucket}/${key}`);
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

export function getS3Path(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}

export interface ListObjectsOptions {
  bucket: string;
  prefix?: string;
  maxKeys?: number;
  continuationToken?: string;
}

export interface ListObjectsResult {
  keys: string[];
  nextContinuationToken?: string;
  isTruncated: boolean;
}

/**
 * List objects in an S3 bucket. Handles pagination internally up to `maxKeys` total results.
 * If maxKeys is not set, returns all objects under the prefix.
 */
export async function listAllObjects(
  bucket: string,
  prefix?: string,
  maxKeys?: number
): Promise<string[]> {
  const client = await getS3Client();
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const command = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: Math.min(maxKeys ? maxKeys - keys.length : 1000, 1000),
      ContinuationToken: continuationToken,
    });

    const response = await client.send(command);

    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key) {
          keys.push(obj.Key);
          if (maxKeys && keys.length >= maxKeys) {
            return keys;
          }
        }
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return keys;
}

/** Supported image extensions for import/browsing. */
export const SUPPORTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".heic", ".webp"];

export function isSupportedImage(key: string): boolean {
  const lower = key.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export interface FolderEntry {
  prefix: string;       // Full prefix (e.g. "Photos/2024/")
  name: string;         // Just the folder name (e.g. "2024")
}

export interface BrowseFolderResult {
  folders: FolderEntry[];
  imageCount: number;    // Supported images directly at this prefix level (not in subfolders)
  imageKeys: string[];   // The actual keys of images at this level
}

export interface FolderImageCount {
  prefix: string;
  imageCount: number;
}

export interface FolderImageCountsResult {
  prefix: string;
  imageCount: number;
  folders: FolderImageCount[];
}

/**
 * Browse a "folder" in S3 using delimiter-based listing.
 * Returns immediate subfolders (CommonPrefixes) and a count of supported
 * image files at the current level.
 *
 * Deliberately does not recursively list each subfolder. Recursive listings
 * make the latency and S3 request count proportional to the size of the
 * entire bucket, even though the UI only needs one tree level at a time.
 */
export async function browseFolder(
  bucket: string,
  prefix: string = "",
): Promise<BrowseFolderResult> {
  const client = await getS3Client();
  const folders: FolderEntry[] = [];
  const imageKeys: string[] = [];
  let continuationToken: string | undefined;

  // Single-level listing with delimiter
  do {
    const command = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix || undefined,
      Delimiter: "/",
      MaxKeys: 1000,
      ContinuationToken: continuationToken,
    });

    const response = await client.send(command);

    // Collect subfolders
    if (response.CommonPrefixes) {
      for (const cp of response.CommonPrefixes) {
        if (cp.Prefix) {
          const name = cp.Prefix.slice(prefix.length).replace(/\/$/, "");
          if (name) {
            folders.push({ prefix: cp.Prefix, name });
          }
        }
      }
    }

    // Collect image files at this level
    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key && isSupportedImage(obj.Key)) {
          imageKeys.push(obj.Key);
        }
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return {
    folders,
    imageCount: imageKeys.length,
    imageKeys,
  };
}

/**
 * Count supported images recursively for each immediate child folder.
 *
 * This intentionally runs separately from browseFolder so the tree can render
 * after its cheap delimiter listing. A single recursive scan supplies every
 * child count, and the result is cached for subsequent visits and expansions.
 */
export async function getFolderImageCounts(
  bucket: string,
  prefix: string = "",
  forceRefresh: boolean = false,
): Promise<FolderImageCountsResult> {
  const cacheKey = getCurrentDatabaseCacheKey();
  const key = `${cacheKey}\n${bucket}\n${prefix}`;
  const now = Date.now();
  const cached = folderImageCountCache.get(key);

  // A forced refresh must not fan out duplicate scans when users click the
  // refresh button repeatedly while the first scan is still running.
  if (cached && !cached.settled) {
    return cached.promise;
  }
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return cached.promise;
  }
  if (cached) {
    folderImageCountCache.delete(key);
  }

  for (const [existingKey, entry] of folderImageCountCache) {
    if (entry.expiresAt <= now) {
      folderImageCountCache.delete(existingKey);
    }
  }
  if (folderImageCountCache.size >= MAX_FOLDER_IMAGE_COUNT_CACHE_ENTRIES) {
    const oldestKey = folderImageCountCache.keys().next().value;
    if (oldestKey !== undefined) {
      folderImageCountCache.delete(oldestKey);
    }
  }

  const entry: FolderImageCountCacheEntry = {
    cacheKey,
    expiresAt: now + FOLDER_IMAGE_COUNT_CACHE_TTL_MS,
    settled: false,
    promise: scanFolderImageCounts(bucket, prefix),
  };
  folderImageCountCache.set(key, entry);

  entry.promise = entry.promise
    .then((result) => {
      entry.settled = true;
      entry.expiresAt = Date.now() + FOLDER_IMAGE_COUNT_CACHE_TTL_MS;
      return result;
    })
    .catch((error) => {
      if (folderImageCountCache.get(key) === entry) {
        folderImageCountCache.delete(key);
      }
      throw error;
    });

  return entry.promise;
}

async function scanFolderImageCounts(
  bucket: string,
  prefix: string,
): Promise<FolderImageCountsResult> {
  const client = await getS3Client();
  const folderCounts = new Map<string, number>();
  let imageCount = 0;
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      })
    );

    for (const object of response.Contents ?? []) {
      const key = object.Key;
      if (!key || !isSupportedImage(key)) continue;

      const relativeKey = key.slice(prefix.length);
      const separatorIndex = relativeKey.indexOf("/");
      if (separatorIndex === -1) {
        imageCount += 1;
        continue;
      }

      const folderPrefix = `${prefix}${relativeKey.slice(0, separatorIndex + 1)}`;
      folderCounts.set(folderPrefix, (folderCounts.get(folderPrefix) ?? 0) + 1);
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return {
    prefix,
    imageCount,
    folders: [...folderCounts.entries()].map(([folderPrefix, count]) => ({
      prefix: folderPrefix,
      imageCount: count,
    })),
  };
}

export async function validateS3Connection(
  config: S3Config,
  bucket: string,
  prefix?: string
): Promise<void> {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
  });

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
        MaxKeys: 1,
      })
    );
  } finally {
    client.destroy();
  }
}

/**
 * Generate a presigned URL for an S3 object.
 * The URL is valid for the specified duration (default: 15 minutes).
 */
export async function getPresignedImageUrl(
  bucket: string,
  key: string,
  expiresInSeconds: number = 900
): Promise<string> {
  const client = await getS3Client();
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}
