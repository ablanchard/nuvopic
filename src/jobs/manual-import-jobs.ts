import crypto from "node:crypto";
import type pg from "pg";
import { isManagedMode } from "../config/runtime.js";
import { clusterUnassignedFaces } from "../db/clusters.js";
import { query, runWithWorkspaceContext, withTransaction } from "../db/client.js";
import type { GpuProvider } from "../extractors/gpu-client.js";
import { logger } from "../logger.js";
import { listWorkspaceDirectoryIds } from "../managed/workspace-directory.js";
import {
  completeInterruptedMeteredGpuJob,
  GpuPaymentRequiredError,
} from "../metering/gpu-metering.js";
import { processPhotoBatch, type GpuMode } from "../processor.js";

const WORKER_ID = crypto.randomUUID();
const LEASE_SECONDS = 120;
const LEASE_HEARTBEAT_MS = 30_000;
const MAX_ITEM_ATTEMPTS = 5;

export type ManualImportJobStatus = "pending" | "running" | "completed" | "failed";

export interface EnqueueManualImportJobInput {
  bucket: string;
  prefix: string;
  sort: "recent" | "oldest";
  gpuMode: GpuMode;
  provider: GpuProvider;
  totalImages: number;
  alreadyImported: number;
  objectKeys: string[];
}

export interface ManualImportJobSummary {
  id: string;
  gpuLogId: string | null;
  bucket: string;
  prefix: string;
  sort: "recent" | "oldest";
  gpuMode: GpuMode;
  provider: GpuProvider;
  status: ManualImportJobStatus;
  totalImages: number;
  alreadyImported: number;
  photoCount: number;
  photosSucceeded: number;
  photosFailed: number;
  remaining: number;
  lastError: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

interface ManualImportJobRow extends pg.QueryResultRow {
  id: string;
  gpu_log_id: string | null;
  bucket: string;
  prefix: string;
  sort: "recent" | "oldest";
  gpu_mode: GpuMode;
  provider: GpuProvider;
  status: ManualImportJobStatus;
  total_images: number;
  already_imported: number;
  photo_count: number;
  photos_succeeded: number;
  photos_failed: number;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

interface ManualImportItemRow extends pg.QueryResultRow {
  id: string;
  object_key: string;
  s3_path: string;
  attempts: number;
}

interface ClaimedBatch {
  job: ManualImportJobRow;
  items: ManualImportItemRow[];
}

function batchSize(): number {
  const parsed = Number.parseInt(process.env.MANUAL_IMPORT_BATCH_SIZE ?? "1000", 10);
  return Number.isFinite(parsed) ? Math.min(5000, Math.max(1, parsed)) : 1000;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mapJob(row: ManualImportJobRow): ManualImportJobSummary {
  return {
    id: row.id,
    gpuLogId: row.gpu_log_id,
    bucket: row.bucket,
    prefix: row.prefix,
    sort: row.sort,
    gpuMode: row.gpu_mode,
    provider: row.provider,
    status: row.status,
    totalImages: row.total_images,
    alreadyImported: row.already_imported,
    photoCount: row.photo_count,
    photosSucceeded: row.photos_succeeded,
    photosFailed: row.photos_failed,
    remaining: Math.max(
      0,
      row.total_images - row.already_imported - row.photo_count
    ),
    lastError: row.last_error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function enqueueManualImportJob(
  input: EnqueueManualImportJobInput
): Promise<ManualImportJobSummary> {
  if (input.objectKeys.length === 0) {
    throw new Error("Cannot enqueue an empty manual import job");
  }

  return withTransaction(async (client) => {
    const logResult = await client.query<{ id: string }>(
      `INSERT INTO gpu_logs (
         type, provider, gpu_mode, status, photo_count, started_at
       ) VALUES ('import', $1, $2, 'queued', $3, NOW())
       RETURNING id`,
      [input.provider, input.gpuMode, input.objectKeys.length]
    );
    const gpuLogId = logResult.rows[0].id;

    const jobResult = await client.query<ManualImportJobRow>(
      `INSERT INTO manual_import_jobs (
         gpu_log_id, bucket, prefix, sort, gpu_mode, provider,
         total_images, already_imported, photo_count
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        gpuLogId,
        input.bucket,
        input.prefix,
        input.sort,
        input.gpuMode,
        input.provider,
        input.totalImages,
        input.alreadyImported,
        input.objectKeys.length,
      ]
    );
    const job = jobResult.rows[0];
    const items = input.objectKeys.map((objectKey) => ({
      object_key: objectKey,
      s3_path: `s3://${input.bucket}/${objectKey}`,
    }));

    await client.query(
      `INSERT INTO manual_import_job_items (job_id, object_key, s3_path)
       SELECT $1, item.object_key, item.s3_path
       FROM jsonb_to_recordset($2::jsonb) AS item(
         object_key TEXT, s3_path TEXT
       )`,
      [job.id, JSON.stringify(items)]
    );

    return mapJob(job);
  });
}

export async function getManualImportJob(
  id: string
): Promise<ManualImportJobSummary | null> {
  const result = await query<ManualImportJobRow>(
    `SELECT * FROM manual_import_jobs WHERE id = $1`,
    [id]
  );
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}

async function recoverExpiredJobs(): Promise<void> {
  const expired = await withTransaction(async (client) => {
    const result = await client.query<{ id: string; attempts: number; gpu_log_id: string | null }>(
      `SELECT id, attempts, gpu_log_id
       FROM manual_import_jobs
       WHERE status = 'running' AND lease_expires_at < NOW()
       FOR UPDATE`
    );
    for (const job of result.rows) {
      await client.query(
        `UPDATE manual_import_job_items
         SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END,
             last_error = COALESCE(last_error, 'Recovered after worker interruption'),
             completed_at = CASE WHEN attempts >= $2 THEN NOW() ELSE NULL END,
             updated_at = NOW()
         WHERE job_id = $1 AND status = 'running'`,
        [job.id, MAX_ITEM_ATTEMPTS]
      );
      const pendingResult = await client.query<{ pending: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM manual_import_job_items
           WHERE job_id = $1 AND status = 'pending'
         ) AS pending`,
        [job.id]
      );
      const retry = pendingResult.rows[0]?.pending === true;
      await client.query(
        `UPDATE manual_import_jobs
         SET status = $2, lease_owner = NULL, lease_expires_at = NULL,
             next_attempt_at = NOW(),
             completed_at = CASE WHEN $2 = 'failed' THEN NOW() ELSE NULL END,
             last_error = 'Recovered after worker interruption', updated_at = NOW()
         WHERE id = $1`,
        [job.id, retry ? "pending" : "failed"]
      );
      if (job.gpu_log_id) {
        await client.query(
          `UPDATE gpu_logs
           SET status = $2,
               completed_at = CASE WHEN $2 = 'failed' THEN NOW() ELSE NULL END,
               duration_ms = CASE WHEN $2 = 'failed'
                 THEN EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000 ELSE NULL END,
               error = 'Recovered after worker interruption'
           WHERE id = $1`,
          [job.gpu_log_id, retry ? "queued" : "failed"]
        );
      }
    }
    return result.rows;
  });

  for (const job of expired) {
    try {
      await completeInterruptedMeteredGpuJob(`${job.id}:batch:${job.attempts}`);
    } catch (error) {
      logger.warn(
        `Could not finalize interrupted GPU reservation for manual import ${job.id}: ${messageFor(error)}`
      );
    }
  }
}

async function recoverLegacyManualImportLogs(): Promise<void> {
  await query(
    `UPDATE gpu_logs logs
     SET status = 'failed', completed_at = NOW(),
         duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000,
         error = 'Interrupted before durable manual import queues were enabled'
     WHERE logs.parent_id IS NULL
       AND logs.type = 'import'
       AND logs.status = 'running'
       AND logs.s3_path IS NULL
       AND logs.started_at < NOW() - INTERVAL '5 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM manual_import_jobs jobs WHERE jobs.gpu_log_id = logs.id
       )`
  );
}

async function claimBatch(): Promise<ClaimedBatch | null> {
  await recoverExpiredJobs();
  await recoverLegacyManualImportLogs();
  return withTransaction(async (client) => {
    const jobResult = await client.query<ManualImportJobRow>(
      `UPDATE manual_import_jobs
       SET status = 'running', attempts = attempts + 1,
           started_at = COALESCE(started_at, NOW()),
           lease_owner = $1,
           lease_expires_at = NOW() + ($2 * INTERVAL '1 second'),
           updated_at = NOW()
       WHERE id = (
         SELECT id FROM manual_import_jobs
         WHERE status = 'pending' AND next_attempt_at <= NOW()
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [WORKER_ID, LEASE_SECONDS]
    );
    const job = jobResult.rows[0];
    if (!job) return null;

    const itemResult = await client.query<ManualImportItemRow>(
      `UPDATE manual_import_job_items
       SET status = 'running', attempts = attempts + 1,
           started_at = NOW(), updated_at = NOW(), last_error = NULL
       WHERE id IN (
         SELECT id FROM manual_import_job_items
         WHERE job_id = $1 AND status = 'pending'
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       RETURNING id, object_key, s3_path, attempts`,
      [job.id, batchSize()]
    );
    return { job, items: itemResult.rows };
  });
}

async function renewLease(jobId: string): Promise<void> {
  await query(
    `UPDATE manual_import_jobs
     SET lease_expires_at = NOW() + ($3 * INTERVAL '1 second'), updated_at = NOW()
     WHERE id = $1 AND status = 'running' AND lease_owner = $2`,
    [jobId, WORKER_ID, LEASE_SECONDS]
  );
}

async function recordBatchResults(
  items: ManualImportItemRow[],
  results: Awaited<ReturnType<typeof processPhotoBatch>>
): Promise<void> {
  const resultsByPath = new Map(results.map((result) => [result.s3Path, result]));
  await withTransaction(async (client) => {
    for (const item of items) {
      const result = resultsByPath.get(item.s3_path);
      const succeeded = Boolean(
        result && result.photoId && result.gpuStatus !== "failed"
      );
      const nextStatus = succeeded
        ? "completed"
        : result?.gpuRetryable && item.attempts < MAX_ITEM_ATTEMPTS
          ? "pending"
          : "failed";
      const error = result
        ? result.errors.length > 0
          ? result.errors.join("; ")
          : null
        : "Processor returned no result for this photo";
      await client.query(
        `UPDATE manual_import_job_items
         SET status = $2, last_error = $3,
             completed_at = CASE WHEN $2 = 'pending' THEN NULL ELSE NOW() END,
             updated_at = NOW()
         WHERE id = $1 AND status = 'running'`,
        [item.id, nextStatus, error]
      );
    }
  });
}

async function updateProgressAndRelease(job: ManualImportJobRow): Promise<boolean> {
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
       FROM manual_import_job_items WHERE job_id = $1`,
      [job.id]
    );
    const counts = countsResult.rows[0];
    const pending = Number.parseInt(counts.pending, 10);
    const running = Number.parseInt(counts.running, 10);
    const succeeded = Number.parseInt(counts.completed, 10);
    const failed = Number.parseInt(counts.failed, 10);
    const finished = pending === 0 && running === 0;
    const terminalStatus: ManualImportJobStatus =
      finished && succeeded === 0 && failed > 0 ? "failed" : "completed";
    const status: ManualImportJobStatus = finished ? terminalStatus : "pending";

    await client.query(
      `UPDATE manual_import_jobs
       SET status = $2, photos_succeeded = $3, photos_failed = $4,
           completed_at = CASE WHEN $2 IN ('completed', 'failed') THEN NOW() ELSE NULL END,
           lease_owner = NULL, lease_expires_at = NULL,
           next_attempt_at = CASE WHEN $2 = 'pending' THEN NOW() ELSE next_attempt_at END,
           last_error = CASE WHEN $2 = 'failed' THEN last_error ELSE NULL END,
           updated_at = NOW()
       WHERE id = $1 AND lease_owner = $5`,
      [job.id, status, succeeded, failed, WORKER_ID]
    );
    if (job.gpu_log_id) {
      await client.query(
        `UPDATE gpu_logs
         SET photos_succeeded = $2, photos_failed = $3,
             error = CASE WHEN $4 = 'failed'
               THEN COALESCE(error, 'All manual import items failed') ELSE NULL END,
             status = CASE WHEN NOT EXISTS (
               SELECT 1 FROM gpu_logs child WHERE child.parent_id = gpu_logs.id
                 AND child.type IN ('cpu-import', 'caption', 'faces')
             ) THEN CASE WHEN $4 = 'pending' THEN 'running' ELSE $4 END ELSE status END,
             completed_at = CASE WHEN NOT EXISTS (
               SELECT 1 FROM gpu_logs child WHERE child.parent_id = gpu_logs.id
                 AND child.type IN ('cpu-import', 'caption', 'faces')
             ) AND $4 IN ('completed', 'failed') THEN NOW() ELSE completed_at END,
             duration_ms = CASE WHEN NOT EXISTS (
               SELECT 1 FROM gpu_logs child WHERE child.parent_id = gpu_logs.id
                 AND child.type IN ('cpu-import', 'caption', 'faces')
             ) AND $4 IN ('completed', 'failed')
               THEN EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000 ELSE duration_ms END
         WHERE id = $1`,
        [job.gpu_log_id, succeeded, failed, status]
      );
    }
    return finished;
  });
}

async function releaseAfterError(
  job: ManualImportJobRow,
  items: ManualImportItemRow[],
  error: unknown
): Promise<void> {
  const message = messageFor(error).slice(0, 4000);
  const retryUntilResolved = error instanceof GpuPaymentRequiredError;
  const retryDelay = retryUntilResolved
    ? 3600
    : Math.min(300, 2 ** Math.min(job.attempts, 8));

  await withTransaction(async (client) => {
    if (items.length > 0) {
      await client.query(
        `UPDATE manual_import_job_items
         SET status = CASE WHEN $4 OR attempts < $2 THEN 'pending' ELSE 'failed' END,
             last_error = $3,
             completed_at = CASE WHEN $4 OR attempts < $2 THEN NULL ELSE NOW() END,
             updated_at = NOW()
         WHERE id = ANY($1::uuid[]) AND status = 'running'`,
        [
          items.map((item) => item.id),
          MAX_ITEM_ATTEMPTS,
          message,
          retryUntilResolved,
        ]
      );
    }
    const pendingResult = await client.query<{ pending: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM manual_import_job_items
         WHERE job_id = $1 AND status = 'pending'
       ) AS pending`,
      [job.id]
    );
    const retry = pendingResult.rows[0]?.pending === true;
    await client.query(
      `UPDATE manual_import_jobs
       SET status = $2,
           next_attempt_at = NOW() + ($3 * INTERVAL '1 second'),
           lease_owner = NULL, lease_expires_at = NULL,
           completed_at = CASE WHEN $2 = 'failed' THEN NOW() ELSE NULL END,
           last_error = $4, updated_at = NOW()
       WHERE id = $1 AND lease_owner = $5`,
      [job.id, retry ? "pending" : "failed", retryDelay, message, WORKER_ID]
    );
    if (job.gpu_log_id) {
      await client.query(
        `UPDATE gpu_logs
         SET error = $2,
             status = CASE WHEN NOT EXISTS (
               SELECT 1 FROM gpu_logs child WHERE child.parent_id = gpu_logs.id
                 AND child.type IN ('cpu-import', 'caption', 'faces')
             ) THEN $3 ELSE status END,
             completed_at = CASE WHEN $3 = 'failed' AND NOT EXISTS (
               SELECT 1 FROM gpu_logs child WHERE child.parent_id = gpu_logs.id
                 AND child.type IN ('cpu-import', 'caption', 'faces')
             ) THEN NOW() ELSE completed_at END,
             duration_ms = CASE WHEN $3 = 'failed' AND NOT EXISTS (
               SELECT 1 FROM gpu_logs child WHERE child.parent_id = gpu_logs.id
                 AND child.type IN ('cpu-import', 'caption', 'faces')
             ) THEN EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000 ELSE duration_ms END
         WHERE id = $1`,
        [
          job.gpu_log_id,
          retry ? `Retry scheduled: ${message}` : message,
          retry ? "queued" : "failed",
        ]
      );
    }
  });
}

export async function processNextManualImportBatch(): Promise<boolean> {
  const claimed = await claimBatch();
  if (!claimed) return false;
  const { job, items } = claimed;
  const heartbeat = setInterval(() => {
    void renewLease(job.id).catch((error) =>
      logger.warn(`Manual import ${job.id} lease heartbeat failed:`, error)
    );
  }, LEASE_HEARTBEAT_MS);
  heartbeat.unref();

  try {
    if (items.length > 0) {
      logger.info(
        `Manual import ${job.id}: processing ${items.length} item(s) ` +
          `(mode=${job.gpu_mode}, provider=${job.provider})`
      );
      const results = await processPhotoBatch(
        items.map((item) => ({
          s3Bucket: job.bucket,
          s3Key: item.object_key,
          gpuMode: job.gpu_mode,
        })),
        undefined,
        job.gpu_log_id,
        {
          provider: job.provider,
          externalJobId: `${job.id}:batch:${job.attempts}`,
        }
      );
      await recordBatchResults(items, results);
    }

    const finished = await updateProgressAndRelease(job);
    if (finished && (job.gpu_mode === "all" || job.gpu_mode === "faces-only")) {
      try {
        const result = await clusterUnassignedFaces({ threshold: 0.6, strategy: "first" });
        logger.info(
          `Manual import ${job.id}: auto-clustered ${result.clustered} faces into ${result.newClusters} clusters`
        );
      } catch (error) {
        logger.error(`Manual import ${job.id}: auto-clustering failed:`, error);
      }
    }
    return true;
  } catch (error) {
    await releaseAfterError(job, items, error);
    logger.error(`Manual import ${job.id} batch failed:`, error);
    return true;
  } finally {
    clearInterval(heartbeat);
  }
}

let workerTimer: ReturnType<typeof setInterval> | null = null;
let workerPromise: Promise<void> | null = null;

async function pollAllWorkspaces(): Promise<void> {
  if (!isManagedMode()) {
    await processNextManualImportBatch();
    return;
  }
  for (const workspaceId of await listWorkspaceDirectoryIds()) {
    try {
      await runWithWorkspaceContext(workspaceId, async () => {
        await processNextManualImportBatch();
      });
    } catch (error) {
      logger.warn(
        `Manual-import poll failed for workspace ${workspaceId}: ${messageFor(error)}`
      );
    }
  }
}

export function startManualImportJobWorker(): void {
  if (workerTimer) return;
  const parsed = Number.parseInt(
    process.env.MANUAL_IMPORT_JOB_POLL_INTERVAL_MS ?? "2000",
    10
  );
  const intervalMs = Number.isFinite(parsed) && parsed >= 1000 ? parsed : 2_000;
  const poll = () => {
    if (workerPromise) return;
    workerPromise = pollAllWorkspaces()
      .catch((error) => logger.warn("Manual-import worker failed:", error))
      .finally(() => {
        workerPromise = null;
      });
  };
  poll();
  workerTimer = setInterval(poll, intervalMs);
  workerTimer.unref();
}

export async function stopManualImportJobWorker(): Promise<void> {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  await workerPromise;
}
