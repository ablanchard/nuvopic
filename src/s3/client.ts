import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getResolvedS3Config } from "../db/settings.js";

let s3Client: S3Client | null = null;

export interface S3Config {
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

/**
 * Build S3Config by resolving DB settings over env vars.
 * Throws if required fields (region, accessKeyId, secretAccessKey) are missing.
 */
async function buildS3Config(): Promise<S3Config> {
  const resolved = await getResolvedS3Config();

  if (!resolved.region || !resolved.accessKeyId || !resolved.secretAccessKey) {
    throw new Error(
      "S3 region, access key ID, and secret access key are required. " +
        "Configure them via S3_REGION / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY env vars " +
        "or set s3_region / s3_access_key_id / s3_secret_access_key in Settings."
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
  }

  return s3Client;
}

/**
 * Invalidate the cached S3 client so the next call to getS3Client()
 * rebuilds it from current DB settings + env vars.
 * Call this after S3-related settings are changed.
 */
export function invalidateS3Client(): void {
  if (s3Client) {
    s3Client.destroy();
  }
  s3Client = null;
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
  imageCount: number;   // Number of supported image files directly in this folder (not recursive)
}

export interface BrowseFolderResult {
  folders: FolderEntry[];
  imageCount: number;    // Supported images directly at this prefix level (not in subfolders)
  imageKeys: string[];   // The actual keys of images at this level
}

/**
 * Browse a "folder" in S3 using delimiter-based listing.
 * Returns immediate subfolders (CommonPrefixes) and a count of supported
 * image files at the current level.
 *
 * For each subfolder, we issue a separate recursive listing to count images.
 * This is intentionally lazy — only called when the user expands a folder.
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
            folders.push({ prefix: cp.Prefix, name, imageCount: 0 });
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

  // For each subfolder, count images recursively (full listing without delimiter)
  // We do this in parallel with a concurrency limit
  const CONCURRENCY = 5;
  for (let i = 0; i < folders.length; i += CONCURRENCY) {
    const batch = folders.slice(i, i + CONCURRENCY);
    const counts = await Promise.all(
      batch.map(async (folder) => {
        const allKeys = await listAllObjects(bucket, folder.prefix);
        return allKeys.filter(isSupportedImage).length;
      })
    );
    for (let j = 0; j < batch.length; j++) {
      batch[j].imageCount = counts[j];
    }
  }

  return {
    folders,
    imageCount: imageKeys.length,
    imageKeys,
  };
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
