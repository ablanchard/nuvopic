/**
 * Database helpers for GPU process logs.
 *
 * Provides functions to create, update, and query gpu_logs entries.
 * All writes are fire-and-forget safe — callers should wrap in try/catch
 * so logging failures never break photo processing.
 */

import { query } from "./client.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GpuLogType =
  | "import"
  | "inventory"
  | "inventory-item"
  | "reprocess"
  | "cpu-import"
  | "caption"
  | "faces"
  | "analyze"
  | "single";

export type GpuLogStatus =
  | "running"
  | "completed"
  | "failed"
  | "queued"
  | "duplicate"
  | "baseline"
  | "unsupported";

export type InventoryItemLogStatus =
  | "queued"
  | "duplicate"
  | "baseline"
  | "unsupported";

export interface CreateGpuLogInput {
  parentId?: string | null;
  type: GpuLogType;
  provider?: string | null;
  gpuMode?: string | null;
  photoId?: string | null;
  s3Path?: string | null;
  photoCount?: number | null;
}

export interface GpuLogRow {
  id: string;
  parent_id: string | null;
  type: GpuLogType;
  provider: string | null;
  gpu_mode: string | null;
  photo_id: string | null;
  s3_path: string | null;
  status: GpuLogStatus;
  photo_count: number | null;
  photos_succeeded: number | null;
  photos_failed: number | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
  /** Only present when fetching job-level logs with children count. */
  children_count?: number;
}

export type PhotoStageLogType = "cpu-import" | "caption" | "faces";

export interface PhotoStageLogRef {
  id: string;
  status: GpuLogStatus;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Create a new gpu_logs entry with status='running'.
 * Returns the log ID.
 */
export async function createGpuLog(input: CreateGpuLogInput): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO gpu_logs (parent_id, type, provider, gpu_mode, photo_id, s3_path, status, photo_count)
     VALUES ($1, $2, $3, $4, $5, $6, 'running', $7)
     RETURNING id`,
    [
      input.parentId ?? null,
      input.type,
      input.provider ?? null,
      input.gpuMode ?? null,
      input.photoId ?? null,
      input.s3Path ?? null,
      input.photoCount ?? null,
    ]
  );
  return result.rows[0].id;
}

/**
 * Mark a gpu_logs entry as completed.
 */
export async function completeGpuLog(
  id: string,
  opts?: {
    photoCount?: number;
    photosSucceeded?: number;
    photosFailed?: number;
  }
): Promise<void> {
  await query(
    `UPDATE gpu_logs
     SET status = 'completed',
         completed_at = NOW(),
         duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000,
         photo_count = COALESCE($2, photo_count),
         photos_succeeded = COALESCE($3, photos_succeeded),
         photos_failed = COALESCE($4, photos_failed)
     WHERE id = $1`,
    [
      id,
      opts?.photoCount ?? null,
      opts?.photosSucceeded ?? null,
      opts?.photosFailed ?? null,
    ]
  );
}

/**
 * Mark a gpu_logs entry as failed.
 */
export async function failGpuLog(
  id: string,
  error: string,
  opts?: { photoCount?: number; photosSucceeded?: number; photosFailed?: number }
): Promise<void> {
  await query(
    `UPDATE gpu_logs
     SET status = 'failed',
         completed_at = NOW(),
         duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000,
         error = $2,
         photo_count = COALESCE($3, photo_count),
         photos_succeeded = COALESCE($4, photos_succeeded),
         photos_failed = COALESCE($5, photos_failed)
     WHERE id = $1`,
    [
      id,
      error,
      opts?.photoCount ?? null,
      opts?.photosSucceeded ?? null,
      opts?.photosFailed ?? null,
    ]
  );
}

// ---------------------------------------------------------------------------
// Safe wrappers (fire-and-forget, never throw)
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget: create a log entry. Returns the ID or null on failure.
 */
export async function safeCreateGpuLog(
  input: CreateGpuLogInput
): Promise<string | null> {
  try {
    return await createGpuLog(input);
  } catch (err) {
    logger.error("Failed to create GPU log:", err);
    return null;
  }
}

/**
 * Fire-and-forget: mark a log entry as completed.
 */
export async function safeCompleteGpuLog(
  id: string | null,
  opts?: { photoCount?: number; photosSucceeded?: number; photosFailed?: number }
): Promise<void> {
  if (!id) return;
  try {
    await completeGpuLog(id, opts);
  } catch (err) {
    logger.error("Failed to complete GPU log:", err);
  }
}

/**
 * Fire-and-forget: mark a log entry as failed.
 */
export async function safeFailGpuLog(
  id: string | null,
  error: string,
  opts?: { photoCount?: number; photosSucceeded?: number; photosFailed?: number }
): Promise<void> {
  if (!id) return;
  try {
    await failGpuLog(id, error, opts);
  } catch (err) {
    logger.error("Failed to fail GPU log:", err);
  }
}

/** Update group counters/error without overriding its child-derived lifecycle. */
export async function safeUpdateGpuLogOutcome(
  id: string | null,
  opts: {
    photoCount?: number;
    photosSucceeded?: number;
    photosFailed?: number;
    error?: string | null;
    /** Used only if logging failed before any stage child could be created. */
    fallbackStatus?: "completed" | "failed";
  }
): Promise<void> {
  if (!id) return;
  try {
    await query(
      `UPDATE gpu_logs
       SET photo_count = COALESCE($2, photo_count),
           photos_succeeded = COALESCE($3, photos_succeeded),
           photos_failed = COALESCE($4, photos_failed),
           error = $5,
           status = CASE WHEN $6 IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM gpu_logs child
               WHERE child.parent_id = gpu_logs.id
                 AND child.type IN ('cpu-import', 'caption', 'faces')
             ) THEN $6 ELSE status END,
           completed_at = CASE WHEN $6 IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM gpu_logs child
               WHERE child.parent_id = gpu_logs.id
                 AND child.type IN ('cpu-import', 'caption', 'faces')
             ) THEN NOW() ELSE completed_at END,
           duration_ms = CASE WHEN $6 IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM gpu_logs child
               WHERE child.parent_id = gpu_logs.id
                 AND child.type IN ('cpu-import', 'caption', 'faces')
             ) THEN EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000
             ELSE duration_ms END
       WHERE id = $1`,
      [
        id,
        opts.photoCount ?? null,
        opts.photosSucceeded ?? null,
        opts.photosFailed ?? null,
        opts.error ?? null,
        opts.fallbackStatus ?? null,
      ]
    );
  } catch (err) {
    logger.error("Failed to update GPU log outcome:", err);
  }
}

/**
 * Ensure one durable child log exists for every photo/stage in a job group.
 * Existing completed children are never reopened; failed/queued children are
 * reused by queue retries so the UI shows one coherent operation per stage.
 */
export async function safeQueuePhotoStageLogs(input: {
  parentId?: string | null;
  type: PhotoStageLogType;
  provider: string;
  gpuMode?: string | null;
  s3Paths: string[];
}): Promise<Map<string, PhotoStageLogRef>> {
  if (!input.parentId || input.s3Paths.length === 0) return new Map();
  try {
    const paths = [...new Set(input.s3Paths)];
    await query(
      `INSERT INTO gpu_logs (
         parent_id, type, provider, gpu_mode, s3_path, status, started_at
       )
       SELECT $1, $2, $3, $4, paths.s3_path, 'queued', NOW()
       FROM UNNEST($5::text[]) AS paths(s3_path)
       WHERE NOT EXISTS (
         SELECT 1 FROM gpu_logs existing
         WHERE existing.parent_id = $1
           AND existing.type = $2
           AND existing.s3_path = paths.s3_path
       )`,
      [
        input.parentId,
        input.type,
        input.provider,
        input.gpuMode ?? null,
        paths,
      ]
    );
    await query(
      `UPDATE gpu_logs
       SET status = 'queued', completed_at = NULL
       WHERE parent_id = $1 AND type = $2 AND s3_path = ANY($3::text[])
         AND status = 'failed'`,
      [input.parentId, input.type, paths]
    );
    const result = await query<Pick<GpuLogRow, "id" | "s3_path" | "status">>(
      `SELECT DISTINCT ON (s3_path) id, s3_path, status
       FROM gpu_logs
       WHERE parent_id = $1 AND type = $2 AND s3_path = ANY($3::text[])
       ORDER BY s3_path, created_at DESC`,
      [input.parentId, input.type, paths]
    );
    return new Map(
      result.rows.flatMap((row) =>
        row.s3_path ? [[row.s3_path, { id: row.id, status: row.status }]] : []
      )
    );
  } catch (err) {
    logger.error(`Failed to queue ${input.type} photo-stage logs:`, err);
    return new Map();
  }
}

/** Start or resume an individual stage without losing its first real start. */
export async function safeStartPhotoStageLog(
  ref: PhotoStageLogRef | undefined
): Promise<boolean> {
  if (!ref || ref.status === "completed") return false;
  try {
    await query(
      `UPDATE gpu_logs
       SET status = 'running',
           started_at = CASE WHEN duration_ms IS NULL THEN NOW() ELSE started_at END,
           completed_at = NULL, duration_ms = NULL, error = NULL
       WHERE id = $1 AND status <> 'completed'`,
      [ref.id]
    );
    ref.status = "running";
    return true;
  } catch (err) {
    logger.error("Failed to start photo-stage log:", err);
    return false;
  }
}

/** Record the final outcome for one object observed during an inventory scan. */
export async function safeRecordInventoryItemLog(input: {
  parentId: string | null;
  provider: string;
  s3Path: string;
  status: InventoryItemLogStatus;
}): Promise<void> {
  if (!input.parentId) return;
  try {
    await query(
      `INSERT INTO gpu_logs (
         parent_id, type, provider, s3_path, status, started_at,
         completed_at, duration_ms
       ) VALUES ($1, 'inventory-item', $2, $3, $4, NOW(), NOW(), 0)`,
      [input.parentId, input.provider, input.s3Path, input.status]
    );
  } catch (err) {
    logger.error("Failed to record inventory item log:", err);
  }
}

/** Keep detailed object rows for only the most recent inventory scans. */
export async function safePruneInventoryLogs(retainScans = 20): Promise<void> {
  try {
    await query(
      `DELETE FROM gpu_logs
       WHERE parent_id IS NULL AND type = 'inventory'
         AND id NOT IN (
           SELECT id FROM gpu_logs
           WHERE parent_id IS NULL AND type = 'inventory'
           ORDER BY started_at DESC
           LIMIT $1
         )`,
      [retainScans]
    );
  } catch (err) {
    logger.error("Failed to prune inventory logs:", err);
  }
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

export interface GpuLogFilters {
  type?: string;
  status?: string;
  parentId?: string | null;
  /** When true, only return top-level (job) logs (parent_id IS NULL). */
  jobsOnly?: boolean;
  page?: number;
  limit?: number;
}

/**
 * List GPU logs with pagination and optional filters.
 * By default returns job-level logs (parent_id IS NULL) newest first,
 * with a children_count column showing how many per-photo entries exist.
 */
export async function getGpuLogs(
  filters: GpuLogFilters = {}
): Promise<{ logs: GpuLogRow[]; total: number }> {
  const page = filters.page ?? 1;
  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (filters.jobsOnly !== false) {
    // Default: only top-level jobs
    if (filters.parentId !== undefined) {
      if (filters.parentId === null) {
        conditions.push("g.parent_id IS NULL");
      } else {
        conditions.push(`g.parent_id = $${paramIdx++}`);
        params.push(filters.parentId);
      }
    } else {
      conditions.push("g.parent_id IS NULL");
    }
  }

  if (filters.type) {
    conditions.push(`g.type = $${paramIdx++}`);
    params.push(filters.type);
  }

  if (filters.status) {
    conditions.push(`g.status = $${paramIdx++}`);
    params.push(filters.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Count total
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM gpu_logs g ${where}`,
    params
  );
  const total = parseInt(countResult.rows[0].count, 10);

  // Fetch with children count
  const dataResult = await query<GpuLogRow>(
    `SELECT g.*,
            COALESCE((SELECT COUNT(*) FROM gpu_logs c WHERE c.parent_id = g.id), 0)::int AS children_count
     FROM gpu_logs g
     ${where}
     ORDER BY g.started_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...params, limit, offset]
  );

  return { logs: dataResult.rows, total };
}

/**
 * Get child (per-photo) log entries for a specific job.
 */
export async function getGpuLogChildren(
  parentId: string
): Promise<GpuLogRow[]> {
  const result = await query<GpuLogRow>(
    `SELECT * FROM gpu_logs
     WHERE parent_id = $1
     ORDER BY started_at ASC`,
    [parentId]
  );
  return result.rows;
}

/**
 * Get a single GPU log entry by ID.
 */
export async function getGpuLogById(id: string): Promise<GpuLogRow | null> {
  const result = await query<GpuLogRow>(
    `SELECT g.*,
            COALESCE((SELECT COUNT(*) FROM gpu_logs c WHERE c.parent_id = g.id), 0)::int AS children_count
     FROM gpu_logs g
     WHERE g.id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}
