import crypto from "node:crypto";
import type pg from "pg";
import { isManagedMode } from "../config/runtime.js";
import { clusterUnassignedFaces } from "../db/clusters.js";
import { query, runWithWorkspaceContext, withTransaction } from "../db/client.js";
import type { GpuMode } from "../processor.js";
import { processPhotoBatch } from "../processor.js";
import type { GpuProvider } from "../extractors/gpu-client.js";
import {
  completeInterruptedMeteredGpuJob,
  GpuPaymentRequiredError,
} from "../metering/gpu-metering.js";
import { logger } from "../logger.js";
import { listWorkspaceDirectoryIds } from "../managed/workspace-directory.js";

const WORKER_ID = crypto.randomUUID();
const LEASE_SECONDS = 90;
const LEASE_HEARTBEAT_MS = 30_000;
const BATCH_SIZE = 20;
const MAX_ITEM_ATTEMPTS = 5;

export type ReprocessMode = "all" | "caption" | "faces";
export type ReprocessJobStatus = "pending" | "running" | "completed" | "failed";

export interface ReprocessSelection {
  id: string;
  s3_path: string;
}

export interface EnqueueReprocessJobInput {
  photos: ReprocessSelection[];
  mode: ReprocessMode;
  gpuMode: GpuMode;
  provider: GpuProvider;
  force: boolean;
  pathPrefix?: string;
  filters?: unknown;
}

export interface ReprocessJobSummary {
  id: string;
  gpuLogId: string | null;
  mode: ReprocessMode;
  gpuMode: GpuMode;
  provider: GpuProvider;
  status: ReprocessJobStatus;
  photoCount: number;
  photosSucceeded: number;
  photosFailed: number;
  lastError: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

interface ReprocessJobRow extends pg.QueryResultRow {
  id: string;
  gpu_log_id: string | null;
  mode: ReprocessMode;
  gpu_mode: GpuMode;
  provider: GpuProvider;
  status: ReprocessJobStatus;
  photo_count: number;
  photos_succeeded: number;
  photos_failed: number;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

interface ReprocessItemRow extends pg.QueryResultRow {
  id: string;
  photo_id: string;
  s3_path: string;
  s3_bucket: string;
  s3_key: string;
  attempts: number;
}

interface ClaimedBatch {
  job: ReprocessJobRow;
  items: ReprocessItemRow[];
}

function mapJob(row: ReprocessJobRow): ReprocessJobSummary {
  return {
    id: row.id,
    gpuLogId: row.gpu_log_id,
    mode: row.mode,
    gpuMode: row.gpu_mode,
    provider: row.provider,
    status: row.status,
    photoCount: row.photo_count,
    photosSucceeded: row.photos_succeeded,
    photosFailed: row.photos_failed,
    lastError: row.last_error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function parseS3Path(s3Path: string): { bucket: string; key: string } | null {
  const match = s3Path.match(/^s3:\/\/([^/]+)\/(.+)$/);
  return match ? { bucket: match[1], key: match[2] } : null;
}

export async function enqueueReprocessJob(
  input: EnqueueReprocessJobInput
): Promise<ReprocessJobSummary> {
  if (input.photos.length === 0) {
    throw new Error("Cannot enqueue an empty reprocess job");
  }

  return withTransaction(async (client) => {
    const logResult = await client.query<{ id: string }>(
      `INSERT INTO gpu_logs (
         type, provider, gpu_mode, status, photo_count, started_at
       ) VALUES ('reprocess', $1, $2, 'queued', $3, NOW())
       RETURNING id`,
      [input.provider, input.gpuMode, input.photos.length]
    );
    const gpuLogId = logResult.rows[0].id;

    const jobResult = await client.query<ReprocessJobRow>(
      `INSERT INTO reprocess_jobs (
         gpu_log_id, mode, gpu_mode, provider, force, path_prefix, filters,
         photo_count
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       RETURNING *`,
      [
        gpuLogId,
        input.mode,
        input.gpuMode,
        input.provider,
        input.force,
        input.pathPrefix ?? null,
        input.filters === undefined ? null : JSON.stringify(input.filters),
        input.photos.length,
      ]
    );
    const job = jobResult.rows[0];

    const items = input.photos.map((photo) => {
      const parsed = parseS3Path(photo.s3_path);
      return {
        photo_id: photo.id,
        s3_path: photo.s3_path,
        s3_bucket: parsed?.bucket ?? null,
        s3_key: parsed?.key ?? null,
        status: parsed ? "pending" : "failed",
        last_error: parsed ? null : "Invalid s3_path format",
      };
    });

    await client.query(
      `INSERT INTO reprocess_job_items (
         job_id, photo_id, s3_path, s3_bucket, s3_key, status, last_error,
         completed_at
       )
       SELECT $1, item.photo_id, item.s3_path, item.s3_bucket, item.s3_key,
              item.status, item.last_error,
              CASE WHEN item.status = 'failed' THEN NOW() ELSE NULL END
       FROM jsonb_to_recordset($2::jsonb) AS item(
         photo_id UUID, s3_path TEXT, s3_bucket TEXT, s3_key TEXT,
         status TEXT, last_error TEXT
       )`,
      [job.id, JSON.stringify(items)]
    );

    return mapJob(job);
  });
}

export async function getReprocessJob(id: string): Promise<ReprocessJobSummary | null> {
  const result = await query<ReprocessJobRow>(
    `SELECT * FROM reprocess_jobs WHERE id = $1`,
    [id]
  );
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}

async function claimBatch(): Promise<ClaimedBatch | null> {
  await recoverExpiredJobs();
  return withTransaction(async (client) => {
    const jobResult = await client.query<ReprocessJobRow>(
      `UPDATE reprocess_jobs
       SET status = 'running', attempts = attempts + 1,
           started_at = COALESCE(started_at, NOW()),
           lease_owner = $1,
           lease_expires_at = NOW() + ($2 * INTERVAL '1 second'),
           updated_at = NOW()
       WHERE id = (
         SELECT id FROM reprocess_jobs
         WHERE status = 'pending' AND next_attempt_at <= NOW()
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [WORKER_ID, LEASE_SECONDS]
    );
    const job = jobResult.rows[0];
    if (!job) return null;

    if (job.gpu_log_id) {
      await client.query(
        `UPDATE gpu_logs
         SET status = 'running', started_at = CASE WHEN status = 'queued' THEN NOW() ELSE started_at END,
             completed_at = NULL, duration_ms = NULL, error = NULL
         WHERE id = $1`,
        [job.gpu_log_id]
      );
    }

    const itemResult = await client.query<ReprocessItemRow>(
      `UPDATE reprocess_job_items
       SET status = 'running', attempts = attempts + 1,
           started_at = NOW(), updated_at = NOW(), last_error = NULL
       WHERE id IN (
         SELECT id FROM reprocess_job_items
         WHERE job_id = $1 AND status = 'pending'
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       RETURNING id, photo_id, s3_path, s3_bucket, s3_key, attempts`,
      [job.id, BATCH_SIZE]
    );
    return { job, items: itemResult.rows };
  });
}

async function recoverExpiredJobs(): Promise<void> {
  const expired = await withTransaction(async (client) => {
    const result = await client.query<{ id: string; attempts: number }>(
      `UPDATE reprocess_jobs
       SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
           next_attempt_at = NOW(),
           last_error = COALESCE(last_error, 'Recovered after worker interruption'),
           updated_at = NOW()
       WHERE status = 'running' AND lease_expires_at < NOW()
       RETURNING id, attempts`
    );
    if (result.rows.length > 0) {
      const ids = result.rows.map((row) => row.id);
      await client.query(
        `UPDATE reprocess_job_items
         SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END,
             last_error = COALESCE(last_error, 'Recovered after worker interruption'),
             completed_at = CASE WHEN attempts >= $2 THEN NOW() ELSE NULL END,
             updated_at = NOW()
         WHERE job_id = ANY($1::uuid[]) AND status = 'running'`,
        [ids, MAX_ITEM_ATTEMPTS]
      );
    }
    return result.rows;
  });
  for (const job of expired) {
    try {
      await completeInterruptedMeteredGpuJob(`${job.id}:batch:${job.attempts}`);
    } catch (error) {
      logger.warn(
        `Could not finalize interrupted GPU reservation for reprocess job ${job.id}: ${error instanceof Error ? error.message : error}`
      );
    }
  }
}

async function recoverLegacyReprocessLogs(): Promise<void> {
  const stale = await withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `UPDATE gpu_logs logs
       SET status = 'failed', completed_at = NOW(),
           duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000,
           error = 'Interrupted by data-plane restart before durable reprocess queues were enabled'
       WHERE logs.parent_id IS NULL AND logs.type = 'reprocess'
         AND logs.status = 'running'
         AND logs.started_at < NOW() - INTERVAL '5 minutes'
         AND NOT EXISTS (
           SELECT 1 FROM reprocess_jobs jobs WHERE jobs.gpu_log_id = logs.id
         )
       RETURNING logs.id`
    );
    if (result.rows.length > 0) {
      await client.query(
        `UPDATE gpu_logs
         SET status = 'failed', completed_at = NOW(),
             duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000,
             error = COALESCE(error, 'Interrupted by data-plane restart')
         WHERE parent_id = ANY($1::uuid[]) AND status = 'running'`,
        [result.rows.map((row) => row.id)]
      );
    }
    return result.rows;
  });
  for (const log of stale) {
    try {
      await completeInterruptedMeteredGpuJob(log.id);
    } catch (error) {
      logger.warn(
        `Could not finalize legacy GPU reservation ${log.id}: ${error instanceof Error ? error.message : error}`
      );
    }
  }
}

async function renewLease(jobId: string): Promise<void> {
  await query(
    `UPDATE reprocess_jobs
     SET lease_expires_at = NOW() + ($3 * INTERVAL '1 second'), updated_at = NOW()
     WHERE id = $1 AND status = 'running' AND lease_owner = $2`,
    [jobId, WORKER_ID, LEASE_SECONDS]
  );
}

async function updateProgressAndRelease(job: ReprocessJobRow): Promise<boolean> {
  return withTransaction(async (client) => {
    const countsResult = await client.query<{
      pending: string;
      running: string;
      completed: string;
      failed: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::text AS pending,
         COUNT(*) FILTER (WHERE status = 'running')::text AS running,
         COUNT(*) FILTER (WHERE status = 'completed')::text AS completed,
         COUNT(*) FILTER (WHERE status = 'failed')::text AS failed
       FROM reprocess_job_items WHERE job_id = $1`,
      [job.id]
    );
    const counts = countsResult.rows[0];
    const pending = Number.parseInt(counts.pending, 10);
    const running = Number.parseInt(counts.running, 10);
    const succeeded = Number.parseInt(counts.completed, 10);
    const failed = Number.parseInt(counts.failed, 10);
    const finished = pending === 0 && running === 0;

    await client.query(
      `UPDATE reprocess_jobs
       SET status = $2, photos_succeeded = $3, photos_failed = $4,
           completed_at = CASE WHEN $2 = 'completed' THEN NOW() ELSE NULL END,
           lease_owner = NULL, lease_expires_at = NULL,
           next_attempt_at = CASE WHEN $2 = 'pending' THEN NOW() ELSE next_attempt_at END,
           last_error = NULL, updated_at = NOW()
       WHERE id = $1 AND lease_owner = $5`,
      [job.id, finished ? "completed" : "pending", succeeded, failed, WORKER_ID]
    );

    if (job.gpu_log_id) {
      await client.query(
        `UPDATE gpu_logs
         SET status = $2, photos_succeeded = $3, photos_failed = $4,
             completed_at = CASE WHEN $2 = 'completed' THEN NOW() ELSE NULL END,
             duration_ms = CASE WHEN $2 = 'completed'
               THEN EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000
               ELSE NULL END,
             error = NULL
         WHERE id = $1`,
        [job.gpu_log_id, finished ? "completed" : "running", succeeded, failed]
      );
    }
    return finished;
  });
}

async function recordBatchResults(
  job: ReprocessJobRow,
  items: ReprocessItemRow[],
  results: Awaited<ReturnType<typeof processPhotoBatch>>
): Promise<void> {
  const resultsByPath = new Map<string, typeof results>();
  for (const result of results) {
    const matches = resultsByPath.get(result.s3Path) ?? [];
    matches.push(result);
    resultsByPath.set(result.s3Path, matches);
  }

  await withTransaction(async (client) => {
    for (const item of items) {
      const matches = resultsByPath.get(item.s3_path);
      const result = matches?.shift();
      const succeeded = Boolean(result && (result.errors.length === 0 || result.photoId !== ""));
      const error = result
        ? result.errors.length > 0
          ? result.errors.join("; ")
          : null
        : "Processor returned no result for this photo";
      await client.query(
        `UPDATE reprocess_job_items
         SET status = $2, last_error = $3, completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'running'`,
        [item.id, succeeded ? "completed" : "failed", error]
      );
    }
  });
}

async function releaseAfterError(
  job: ReprocessJobRow,
  items: ReprocessItemRow[],
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const retryUntilResolved = error instanceof GpuPaymentRequiredError;
  const retryDelay = retryUntilResolved
    ? 3600
    : Math.min(300, 2 ** Math.min(job.attempts, 8));
  await withTransaction(async (client) => {
    if (items.length > 0) {
      await client.query(
        `UPDATE reprocess_job_items
         SET status = CASE WHEN $4 OR attempts < $2 THEN 'pending' ELSE 'failed' END,
             last_error = $3,
             completed_at = CASE WHEN $4 OR attempts < $2 THEN NULL ELSE NOW() END,
             updated_at = NOW()
         WHERE id = ANY($1::uuid[]) AND status = 'running'`,
        [
          items.map((item) => item.id),
          MAX_ITEM_ATTEMPTS,
          message.slice(0, 4000),
          retryUntilResolved,
        ]
      );
    }
    await client.query(
      `UPDATE reprocess_jobs
       SET status = 'pending', next_attempt_at = NOW() + ($3 * INTERVAL '1 second'),
           lease_owner = NULL, lease_expires_at = NULL,
           last_error = $2, updated_at = NOW()
       WHERE id = $1 AND lease_owner = $4`,
      [job.id, message.slice(0, 4000), retryDelay, WORKER_ID]
    );
    if (job.gpu_log_id) {
      await client.query(
        `UPDATE gpu_logs SET status = 'queued', error = $2 WHERE id = $1`,
        [job.gpu_log_id, `Retry scheduled: ${message}`.slice(0, 4000)]
      );
    }
  });
}

export async function processNextReprocessBatch(): Promise<boolean> {
  const claimed = await claimBatch();
  if (!claimed) return false;
  const { job, items } = claimed;
  const heartbeat = setInterval(() => {
    void renewLease(job.id).catch((error) =>
      logger.warn(`Reprocess job ${job.id} lease heartbeat failed:`, error)
    );
  }, LEASE_HEARTBEAT_MS);
  heartbeat.unref();

  try {
    if (items.length > 0) {
      logger.info(
        `Reprocess job ${job.id}: processing ${items.length} item(s) ` +
          `(mode=${job.gpu_mode}, provider=${job.provider})`
      );
      const results = await processPhotoBatch(
        items.map((item) => ({
          s3Bucket: item.s3_bucket,
          s3Key: item.s3_key,
          gpuMode: job.gpu_mode,
        })),
        undefined,
        job.gpu_log_id,
        {
          provider: job.provider,
          externalJobId: `${job.id}:batch:${job.attempts}`,
        }
      );
      await recordBatchResults(job, items, results);
    }

    const finished = await updateProgressAndRelease(job);
    if (finished && (job.gpu_mode === "all" || job.gpu_mode === "faces-only")) {
      try {
        const result = await clusterUnassignedFaces({ threshold: 0.6, strategy: "first" });
        logger.info(
          `Reprocess job ${job.id}: auto-clustered ${result.clustered} faces into ${result.newClusters} clusters`
        );
      } catch (error) {
        logger.error(`Reprocess job ${job.id}: auto-clustering failed:`, error);
      }
    }
    return true;
  } catch (error) {
    await releaseAfterError(job, items, error);
    logger.error(`Reprocess job ${job.id} batch failed:`, error);
    return true;
  } finally {
    clearInterval(heartbeat);
  }
}

let workerTimer: ReturnType<typeof setInterval> | null = null;
let workerPromise: Promise<void> | null = null;

async function pollAllWorkspaces(): Promise<void> {
  if (!isManagedMode()) {
    await recoverLegacyReprocessLogs();
    await processNextReprocessBatch();
    return;
  }
  for (const workspaceId of await listWorkspaceDirectoryIds()) {
    try {
      await runWithWorkspaceContext(workspaceId, async () => {
        await recoverLegacyReprocessLogs();
        await processNextReprocessBatch();
      });
    } catch (error) {
      logger.warn(
        `Reprocess poll failed for workspace ${workspaceId}: ${error instanceof Error ? error.message : error}`
      );
    }
  }
}

export function startReprocessJobWorker(): void {
  if (workerTimer) return;
  const parsed = Number.parseInt(process.env.REPROCESS_JOB_POLL_INTERVAL_MS ?? "2000", 10);
  const intervalMs = Number.isFinite(parsed) && parsed >= 1000 ? parsed : 2_000;
  const poll = () => {
    if (workerPromise) return;
    workerPromise = pollAllWorkspaces()
      .catch((error) => logger.warn("Reprocess worker failed:", error))
      .finally(() => {
        workerPromise = null;
      });
  };
  poll();
  workerTimer = setInterval(poll, intervalMs);
  workerTimer.unref();
}

export async function stopReprocessJobWorker(): Promise<void> {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  await workerPromise;
}
