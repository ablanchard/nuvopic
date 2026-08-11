import type pg from "pg";
import { isManagedMode } from "../config/runtime.js";
import {
  query,
  runWithWorkspaceContext,
  withTransaction,
} from "../db/client.js";
import { handler } from "../index.js";
import { logger } from "../logger.js";
import { listWorkspaceDirectoryIds } from "../managed/workspace-directory.js";

interface ProcessingJobRow extends pg.QueryResultRow {
  id: string;
  payload: unknown;
  attempts: number;
}

let workerTimer: ReturnType<typeof setInterval> | null = null;
let workerRunning = false;
let workerPromise: Promise<void> | null = null;

export async function enqueueS3WebhookJob(payload: unknown): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO processing_jobs (type, payload)
     VALUES ('s3_webhook', $1::jsonb)
     RETURNING id`,
    [JSON.stringify(payload)]
  );
  return result.rows[0].id;
}

async function claimProcessingJob(): Promise<ProcessingJobRow | null> {
  return withTransaction(async (client) => {
    // A process that disappeared while holding a job cannot leave it running forever.
    await client.query(
      `UPDATE processing_jobs
       SET status = 'pending', next_attempt_at = NOW(), updated_at = NOW(),
           last_error = COALESCE(last_error, 'Recovered after worker interruption')
       WHERE status = 'running' AND updated_at < NOW() - INTERVAL '10 minutes'`
    );
    const result = await client.query<ProcessingJobRow>(
      `UPDATE processing_jobs
       SET status = 'running', attempts = attempts + 1,
           started_at = NOW(), updated_at = NOW()
       WHERE id = (
         SELECT id FROM processing_jobs
         WHERE status = 'pending' AND next_attempt_at <= NOW()
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING id, payload, attempts`
    );
    return result.rows[0] ?? null;
  });
}

async function completeProcessingJob(id: string): Promise<void> {
  await query(
    `UPDATE processing_jobs
     SET status = 'completed', completed_at = NOW(), updated_at = NOW(), last_error = NULL
     WHERE id = $1`,
    [id]
  );
}

async function failProcessingJob(
  job: ProcessingJobRow,
  error: string,
  retryUntilResolved: boolean
): Promise<void> {
  const shouldRetry = retryUntilResolved || job.attempts < 5;
  const delaySeconds = retryUntilResolved
    ? 3600
    : Math.min(3600, 2 ** Math.min(job.attempts, 10));
  await query(
    `UPDATE processing_jobs
     SET status = $2,
         next_attempt_at = NOW() + ($3 * INTERVAL '1 second'),
         last_error = $4,
         updated_at = NOW()
     WHERE id = $1`,
    [job.id, shouldRetry ? "pending" : "failed", delaySeconds, error.slice(0, 4000)]
  );
}

export async function processPendingJobsInCurrentWorkspace(limit = 2): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    const job = await claimProcessingJob();
    if (!job) return;
    const heartbeat = setInterval(() => {
      void query(
        `UPDATE processing_jobs SET updated_at = NOW()
         WHERE id = $1 AND status = 'running'`,
        [job.id]
      ).catch((error) => logger.warn(`Processing job ${job.id} heartbeat failed:`, error));
    }, 60_000);
    heartbeat.unref();
    try {
      const result = await handler(job.payload as Parameters<typeof handler>[0]);
      if (result.statusCode !== 200) {
        const body = JSON.parse(result.body) as { error?: string; message?: string };
        const message = body.message ?? body.error ?? `Processing returned ${result.statusCode}`;
        await failProcessingJob(job, message, result.statusCode === 402);
        continue;
      }
      await completeProcessingJob(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await failProcessingJob(job, message, false);
      logger.error(`Processing job ${job.id} failed:`, error);
    } finally {
      clearInterval(heartbeat);
    }
  }
}

async function pollManagedWorkspaces(): Promise<void> {
  if (workerRunning || !isManagedMode()) return;
  workerRunning = true;
  try {
    const workspaceIds = await listWorkspaceDirectoryIds();
    for (const workspaceId of workspaceIds) {
      try {
        await runWithWorkspaceContext(workspaceId, () =>
          processPendingJobsInCurrentWorkspace()
        );
      } catch (error) {
        logger.warn(
          `Processing-job poll failed for workspace ${workspaceId}: ${error instanceof Error ? error.message : error}`
        );
      }
    }
  } catch (error) {
    logger.warn(
      `Processing-job workspace discovery failed: ${error instanceof Error ? error.message : error}`
    );
  } finally {
    workerRunning = false;
  }
}

export function startProcessingJobWorker(): void {
  if (workerTimer || !isManagedMode()) return;
  const parsed = Number.parseInt(process.env.PROCESSING_JOB_POLL_INTERVAL_MS ?? "10000", 10);
  const intervalMs = Number.isFinite(parsed) && parsed >= 1000 ? parsed : 10_000;
  const runPoll = () => {
    if (workerPromise) return;
    workerPromise = pollManagedWorkspaces().finally(() => {
      workerPromise = null;
    });
  };
  runPoll();
  workerTimer = setInterval(runPoll, intervalMs);
  workerTimer.unref();
}

export async function stopProcessingJobWorker(): Promise<void> {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  await workerPromise;
}
