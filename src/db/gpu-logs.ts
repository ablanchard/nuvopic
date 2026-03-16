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
  | "reprocess"
  | "caption"
  | "faces"
  | "analyze"
  | "single";

export type GpuLogStatus = "running" | "completed" | "failed";

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
    photosSucceeded?: number;
    photosFailed?: number;
  }
): Promise<void> {
  await query(
    `UPDATE gpu_logs
     SET status = 'completed',
         completed_at = NOW(),
         duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000,
         photos_succeeded = COALESCE($2, photos_succeeded),
         photos_failed = COALESCE($3, photos_failed)
     WHERE id = $1`,
    [id, opts?.photosSucceeded ?? null, opts?.photosFailed ?? null]
  );
}

/**
 * Mark a gpu_logs entry as failed.
 */
export async function failGpuLog(id: string, error: string): Promise<void> {
  await query(
    `UPDATE gpu_logs
     SET status = 'failed',
         completed_at = NOW(),
         duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000,
         error = $2
     WHERE id = $1`,
    [id, error]
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
  opts?: { photosSucceeded?: number; photosFailed?: number }
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
  error: string
): Promise<void> {
  if (!id) return;
  try {
    await failGpuLog(id, error);
  } catch (err) {
    logger.error("Failed to fail GPU log:", err);
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
