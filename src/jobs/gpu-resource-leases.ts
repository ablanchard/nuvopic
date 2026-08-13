import type pg from "pg";
import { isManagedMode } from "../config/runtime.js";
import { query, runWithWorkspaceContext, withTransaction } from "../db/client.js";
import type { GpuResourceLifecycleHandlers } from "../extractors/gpu-client.js";
import { destroyVastInstanceById } from "../extractors/vast-client.js";
import { logger } from "../logger.js";
import { listWorkspaceDirectoryIds } from "../managed/workspace-directory.js";

const RESOURCE_LEASE_SECONDS = 120;
const CLEANUP_BATCH_SIZE = 10;

interface ResourceLeaseRow extends pg.QueryResultRow {
  provider: "vastai";
  resource_id: string;
  external_job_id: string;
  release_attempts: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createGpuResourceLifecycleHandlers(
  externalJobId: string
): GpuResourceLifecycleHandlers {
  return {
    async acquired(resource) {
      await query(
        `INSERT INTO gpu_resource_leases (
           provider, resource_id, external_job_id, status, lease_expires_at,
           next_release_at, last_error, released_at, updated_at
         ) VALUES ($1, $2, $3, 'active',
                   NOW() + ($4 * INTERVAL '1 second'), NOW(), NULL, NULL, NOW())
         ON CONFLICT (provider, resource_id) DO UPDATE SET
           external_job_id = EXCLUDED.external_job_id,
           status = 'active',
           lease_expires_at = EXCLUDED.lease_expires_at,
           next_release_at = NOW(),
           last_error = NULL,
           released_at = NULL,
           updated_at = NOW()`,
        [resource.provider, resource.resourceId, externalJobId, RESOURCE_LEASE_SECONDS]
      );
    },

    async released(resource) {
      await query(
        `UPDATE gpu_resource_leases
         SET status = 'released', released_at = NOW(), last_error = NULL,
             updated_at = NOW()
         WHERE provider = $1 AND resource_id = $2`,
        [resource.provider, resource.resourceId]
      );
    },

    async releaseFailed(resource, error) {
      await query(
        `UPDATE gpu_resource_leases
         SET status = 'cleanup_pending',
             next_release_at = NOW(),
             last_error = $3,
             updated_at = NOW()
         WHERE provider = $1 AND resource_id = $2`,
        [resource.provider, resource.resourceId, errorMessage(error).slice(0, 4000)]
      );
    },
  };
}

export async function renewGpuResourceLeases(externalJobId: string): Promise<void> {
  await query(
    `UPDATE gpu_resource_leases
     SET lease_expires_at = NOW() + ($2 * INTERVAL '1 second'), updated_at = NOW()
     WHERE external_job_id = $1 AND status = 'active'`,
    [externalJobId, RESOURCE_LEASE_SECONDS]
  );
}

async function claimCleanupBatch(): Promise<ResourceLeaseRow[]> {
  return withTransaction(async (client) => {
    const result = await client.query<ResourceLeaseRow>(
      `UPDATE gpu_resource_leases leases
       SET status = 'releasing', release_attempts = release_attempts + 1,
           lease_expires_at = NOW() + ($2 * INTERVAL '1 second'),
           updated_at = NOW()
       WHERE (provider, resource_id) IN (
         SELECT provider, resource_id
         FROM gpu_resource_leases
         WHERE (
             status = 'cleanup_pending' AND next_release_at <= NOW()
           ) OR (
             status IN ('active', 'releasing') AND lease_expires_at <= NOW()
           )
         ORDER BY next_release_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       RETURNING provider, resource_id, external_job_id, release_attempts`,
      [CLEANUP_BATCH_SIZE, RESOURCE_LEASE_SECONDS]
    );
    return result.rows;
  });
}

async function finishCleanup(resource: ResourceLeaseRow): Promise<void> {
  await query(
    `UPDATE gpu_resource_leases
     SET status = 'released', released_at = NOW(), last_error = NULL,
         updated_at = NOW()
     WHERE provider = $1 AND resource_id = $2`,
    [resource.provider, resource.resource_id]
  );
}

async function deferCleanup(
  resource: ResourceLeaseRow,
  error: unknown
): Promise<void> {
  const delaySeconds = Math.min(3600, 2 ** Math.min(resource.release_attempts, 10));
  await query(
    `UPDATE gpu_resource_leases
     SET status = 'cleanup_pending',
         next_release_at = NOW() + ($3 * INTERVAL '1 second'),
         last_error = $4,
         updated_at = NOW()
     WHERE provider = $1 AND resource_id = $2`,
    [
      resource.provider,
      resource.resource_id,
      delaySeconds,
      errorMessage(error).slice(0, 4000),
    ]
  );
}

export async function cleanupExpiredGpuResources(): Promise<number> {
  const resources = await claimCleanupBatch();
  for (const resource of resources) {
    try {
      if (resource.provider === "vastai") {
        await destroyVastInstanceById(Number.parseInt(resource.resource_id, 10));
      }
      await finishCleanup(resource);
      logger.info(
        `Cleaned orphaned ${resource.provider} resource ${resource.resource_id} ` +
          `for job ${resource.external_job_id}`
      );
    } catch (error) {
      await deferCleanup(resource, error);
      logger.warn(
        `GPU resource cleanup deferred for ${resource.provider} ${resource.resource_id}: ` +
          errorMessage(error)
      );
    }
  }
  return resources.length;
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let cleanupPromise: Promise<void> | null = null;

async function pollAllWorkspaces(): Promise<void> {
  if (!isManagedMode()) {
    await cleanupExpiredGpuResources();
    return;
  }
  for (const workspaceId of await listWorkspaceDirectoryIds()) {
    try {
      await runWithWorkspaceContext(workspaceId, async () => {
        await cleanupExpiredGpuResources();
      });
    } catch (error) {
      logger.warn(
        `GPU resource cleanup failed for workspace ${workspaceId}: ${errorMessage(error)}`
      );
    }
  }
}

export function startGpuResourceCleanupWorker(): void {
  if (cleanupTimer) return;
  const parsed = Number.parseInt(
    process.env.GPU_RESOURCE_CLEANUP_POLL_INTERVAL_MS ?? "30000",
    10
  );
  const intervalMs = Number.isFinite(parsed) && parsed >= 5_000 ? parsed : 30_000;
  const poll = () => {
    if (cleanupPromise) return;
    cleanupPromise = pollAllWorkspaces()
      .catch((error) => logger.warn("GPU resource cleanup worker failed:", error))
      .finally(() => {
        cleanupPromise = null;
      });
  };
  poll();
  cleanupTimer = setInterval(poll, intervalMs);
  cleanupTimer.unref();
}

export async function stopGpuResourceCleanupWorker(): Promise<void> {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = null;
  await cleanupPromise;
}
