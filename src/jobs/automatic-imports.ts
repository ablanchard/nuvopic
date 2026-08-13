import type pg from "pg";
import { GpuPaymentRequiredError } from "../metering/gpu-metering.js";
import { getRealtimeGpuProvider } from "../extractors/gpu-client.js";
import { clusterUnassignedFaces } from "../db/clusters.js";
import {
  query,
  runWithWorkspaceContext,
  withTransaction,
} from "../db/client.js";
import { getAllSettings } from "../db/settings.js";
import { invalidatePhotoProcessingVersions } from "../db/queries.js";
import {
  safeCompleteGpuLog,
  safeCreateGpuLog,
  safeFailGpuLog,
  safeUpdateGpuLogOutcome,
  safePruneInventoryLogs,
  safeRecordInventoryItemLog,
  type InventoryItemLogStatus,
} from "../db/gpu-logs.js";
import { isManagedMode } from "../config/runtime.js";
import { listWorkspaceDirectoryIds } from "../managed/workspace-directory.js";
import { logger } from "../logger.js";
import {
  headObject,
  isSupportedImage,
  iterateObjects,
  type StorageObject,
} from "../s3/client.js";
import { processPhotoBatch, type GpuMode } from "../processor.js";

export const DEFAULT_STORAGE_CONNECTION_ID = "default";
const MAX_JOB_ATTEMPTS = 8;
const RUN_STALE_AFTER_MINUTES = 60;

export interface ObjectChangeEvent {
  connectionId: string;
  provider: string;
  providerEventId?: string;
  type: "created" | "updated" | "deleted";
  bucket: string;
  key: string;
  etag?: string;
  versionId?: string;
  size?: number;
  occurredAt?: Date;
}

export interface AutomaticImportConfig {
  connectionId: string;
  provider: string;
  bucket: string;
  allowedPrefixes: string[];
  enabled: boolean;
  initialImportMode: "new_only" | "all";
  gpuMode: GpuMode;
  scanIntervalMinutes: number;
  baselineCompleted: boolean;
  lastReconciledAt: Date | null;
  nextReconciliationAt: Date | null;
  lastError: string | null;
}

interface ConnectionRow extends pg.QueryResultRow {
  id: string;
  provider: string;
  bucket: string;
  allowed_prefixes: string[];
  automatic_import_enabled: boolean;
  initial_import_mode: "new_only" | "all";
  gpu_mode: GpuMode;
  scan_interval_minutes: number;
  baseline_completed: boolean;
  last_reconciled_at: Date | null;
  next_reconciliation_at: Date | null;
  last_error: string | null;
}

interface ImportJobRow extends pg.QueryResultRow {
  id: string;
  connection_id: string;
  object_key: string;
  object_fingerprint: string;
  etag: string | null;
  version_id: string | null;
  attempts: number;
}

interface AwsS3Record {
  eventName?: string;
  eventTime?: string;
  responseElements?: { "x-amz-request-id"?: string };
  s3?: {
    bucket?: { name?: string };
    object?: {
      key?: string;
      eTag?: string;
      etag?: string;
      versionId?: string;
      size?: number;
      sequencer?: string;
    };
  };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === "true";
}

function clampInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Parse newline/comma separated prefixes and remove duplicates and overlaps. */
export function parseImportPrefixes(value: string | undefined): string[] {
  const candidates = (value ?? "")
    .split(/[\n,]/)
    .map((prefix) => prefix.trim().replace(/^\/+/, ""))
    .filter(Boolean)
    .map((prefix) => (prefix.endsWith("/") ? prefix : `${prefix}/`));
  const sorted = [...new Set(candidates)].sort(
    (left, right) => left.length - right.length || left.localeCompare(right)
  );
  return sorted.filter(
    (prefix, index) => !sorted.slice(0, index).some((parent) => prefix.startsWith(parent))
  );
}

export function keyIsAllowed(key: string, prefixes: string[]): boolean {
  return prefixes.length === 0 || prefixes.some((prefix) => key.startsWith(prefix));
}

export function objectFingerprint(object: {
  etag?: string | null;
  versionId?: string | null;
  size?: number | null;
  lastModified?: Date | null;
}): string {
  if (object.versionId) return `version:${object.versionId}`;
  if (object.etag) return `etag:${object.etag.replace(/^"|"$/g, "")}`;
  const modified = object.lastModified?.toISOString() ?? "unknown";
  return `metadata:${object.size ?? "unknown"}:${modified}`;
}

function mapConnection(row: ConnectionRow): AutomaticImportConfig {
  return {
    connectionId: row.id,
    provider: row.provider,
    bucket: row.bucket,
    allowedPrefixes: row.allowed_prefixes,
    enabled: row.automatic_import_enabled,
    initialImportMode: row.initial_import_mode,
    gpuMode: row.gpu_mode,
    scanIntervalMinutes: row.scan_interval_minutes,
    baselineCompleted: row.baseline_completed,
    lastReconciledAt: row.last_reconciled_at,
    nextReconciliationAt: row.next_reconciliation_at,
    lastError: row.last_error,
  };
}

/** Keep the connection model synchronized with the existing encrypted settings. */
export async function ensureDefaultStorageConnection(): Promise<AutomaticImportConfig | null> {
  const settings = await getAllSettings();
  const bucket = settings.s3_bucket?.trim();
  if (!bucket) return null;
  const previousResult = await query<{ bucket: string }>(
    `SELECT bucket FROM storage_connections WHERE id = $1`,
    [DEFAULT_STORAGE_CONNECTION_ID]
  );
  const previousBucket = previousResult.rows[0]?.bucket;

  const prefixes = parseImportPrefixes(settings.auto_import_prefixes);
  const mode = settings.auto_import_initial_mode === "all" ? "all" : "new_only";
  const requestedGpuMode = settings.auto_import_gpu_mode;
  const gpuMode: GpuMode =
    requestedGpuMode === "caption-only" ||
    requestedGpuMode === "faces-only" ||
    requestedGpuMode === "skip"
      ? requestedGpuMode
      : "all";
  const provider = settings.storage_provider?.trim() || "s3-compatible";
  const enabled = parseBoolean(settings.auto_import_enabled, false);
  const interval = clampInteger(
    settings.auto_import_scan_interval_minutes,
    10,
    1,
    10080
  );

  const result = await query<ConnectionRow>(
    `INSERT INTO storage_connections (
       id, provider, bucket, allowed_prefixes, automatic_import_enabled,
       initial_import_mode, gpu_mode, scan_interval_minutes,
       next_reconciliation_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $5 THEN NOW() ELSE NULL END)
     ON CONFLICT (id) DO UPDATE SET
       provider = EXCLUDED.provider,
       bucket = EXCLUDED.bucket,
       allowed_prefixes = EXCLUDED.allowed_prefixes,
       automatic_import_enabled = EXCLUDED.automatic_import_enabled,
       initial_import_mode = EXCLUDED.initial_import_mode,
       gpu_mode = EXCLUDED.gpu_mode,
       scan_interval_minutes = EXCLUDED.scan_interval_minutes,
       baseline_completed = CASE
         WHEN storage_connections.bucket IS DISTINCT FROM EXCLUDED.bucket
           OR storage_connections.allowed_prefixes IS DISTINCT FROM EXCLUDED.allowed_prefixes
           OR storage_connections.initial_import_mode IS DISTINCT FROM EXCLUDED.initial_import_mode
         THEN FALSE
         ELSE storage_connections.baseline_completed
       END,
       next_reconciliation_at = CASE
         WHEN EXCLUDED.automatic_import_enabled AND (
           NOT storage_connections.automatic_import_enabled
           OR storage_connections.bucket IS DISTINCT FROM EXCLUDED.bucket
           OR storage_connections.allowed_prefixes IS DISTINCT FROM EXCLUDED.allowed_prefixes
         ) THEN NOW()
         WHEN NOT EXCLUDED.automatic_import_enabled THEN NULL
         ELSE storage_connections.next_reconciliation_at
       END,
       updated_at = NOW()
     RETURNING *`,
    [
      DEFAULT_STORAGE_CONNECTION_ID,
      provider,
      bucket,
      prefixes,
      enabled,
      mode,
      gpuMode,
      interval,
    ]
  );
  if (previousBucket && previousBucket !== bucket) {
    await query(
      `UPDATE photo_import_jobs
       SET status = 'failed', completed_at = NOW(), updated_at = NOW(),
           last_error = 'Configured bucket changed before this job was processed'
       WHERE connection_id = $1 AND status IN ('pending', 'running')`,
      [DEFAULT_STORAGE_CONNECTION_ID]
    );
  }
  return mapConnection(result.rows[0]);
}

export function normalizeAwsS3Event(payload: unknown): ObjectChangeEvent[] {
  let records: AwsS3Record[];
  if (Array.isArray(payload)) {
    records = payload as AwsS3Record[];
  } else if (
    typeof payload === "object" &&
    payload !== null &&
    "Records" in payload &&
    Array.isArray((payload as { Records?: unknown[] }).Records)
  ) {
    records = (payload as { Records: AwsS3Record[] }).Records;
  } else if (typeof payload === "object" && payload !== null && "s3" in payload) {
    records = [payload as AwsS3Record];
  } else {
    throw new Error("Unsupported S3 webhook payload");
  }

  return records.map((record) => {
    const bucket = record.s3?.bucket?.name;
    const encodedKey = record.s3?.object?.key;
    if (!bucket || !encodedKey) {
      throw new Error("S3 event record is missing bucket or object key");
    }
    const eventName = record.eventName ?? "ObjectCreated:Unknown";
    const type: ObjectChangeEvent["type"] = eventName.includes("ObjectRemoved")
      ? "deleted"
      : eventName.includes("ObjectCreated")
        ? "created"
        : "updated";
    const key = decodeURIComponent(encodedKey.replace(/\+/g, " "));
    const sequencer = record.s3?.object?.sequencer;
    const requestId = record.responseElements?.["x-amz-request-id"];
    const providerEventId = sequencer
      ? `${bucket}:${key}:${sequencer}`
      : requestId
        ? `${bucket}:${key}:${requestId}`
        : undefined;
    const occurredAt = record.eventTime ? new Date(record.eventTime) : undefined;

    return {
      connectionId: DEFAULT_STORAGE_CONNECTION_ID,
      provider: "amazon-s3",
      providerEventId,
      type,
      bucket,
      key,
      etag: record.s3?.object?.eTag ?? record.s3?.object?.etag,
      versionId: record.s3?.object?.versionId,
      size: record.s3?.object?.size,
      occurredAt:
        occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : undefined,
    };
  });
}

async function enqueueImportJob(
  client: pg.PoolClient | null,
  event: ObjectChangeEvent,
  fingerprint: string
): Promise<boolean> {
  const execute = client ? client.query.bind(client) : query;
  const result = await execute<{ id: string }>(
    `INSERT INTO photo_import_jobs (
       connection_id, provider, provider_event_id, object_key, etag,
       version_id, object_fingerprint, size, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      event.connectionId,
      event.provider,
      event.providerEventId ?? null,
      event.key,
      event.etag ?? null,
      event.versionId ?? null,
      fingerprint,
      event.size ?? null,
      event.occurredAt ?? null,
    ]
  );
  return result.rowCount === 1;
}

export async function recordObjectChangeEvent(
  event: ObjectChangeEvent
): Promise<boolean> {
  const connection = await ensureDefaultStorageConnection();
  if (!connection || connection.connectionId !== event.connectionId) {
    throw new Error(`Unknown storage connection: ${event.connectionId}`);
  }
  if (connection.bucket !== event.bucket) {
    throw new Error(`Event bucket does not match configured bucket`);
  }
  if (!connection.enabled) return false;
  if (!keyIsAllowed(event.key, connection.allowedPrefixes)) return false;

  if (event.type === "deleted") {
    await query(
      `UPDATE storage_objects
       SET missing_since = COALESCE(missing_since, NOW()), last_seen_at = NOW()
       WHERE connection_id = $1 AND object_key = $2`,
      [event.connectionId, event.key]
    );
    return false;
  }
  if (!isSupportedImage(event.key)) return false;

  let metadata: StorageObject = {
    key: event.key,
    etag: event.etag,
    versionId: event.versionId,
    size: event.size,
  };
  // Some S3-compatible event formats omit identity metadata. HEAD supplies a
  // durable version identity before the delivery is acknowledged.
  if (!metadata.etag && !metadata.versionId) {
    metadata = await headObject(event.bucket, event.key);
  }
  const fingerprint = objectFingerprint(metadata);

  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO storage_objects (
         connection_id, object_key, etag, version_id, object_fingerprint,
         size, last_modified, last_seen_at, missing_since
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NULL)
       ON CONFLICT (connection_id, object_key) DO UPDATE SET
         etag = EXCLUDED.etag,
         version_id = EXCLUDED.version_id,
         object_fingerprint = EXCLUDED.object_fingerprint,
         size = EXCLUDED.size,
         last_modified = COALESCE(EXCLUDED.last_modified, storage_objects.last_modified),
         last_seen_at = NOW(),
         missing_since = NULL`,
      [
        event.connectionId,
        event.key,
        metadata.etag ?? null,
        metadata.versionId ?? null,
        fingerprint,
        metadata.size ?? null,
        metadata.lastModified ?? null,
      ]
    );
    return enqueueImportJob(client, { ...event, ...metadata }, fingerprint);
  });
}

export async function enqueueAwsS3Webhook(payload: unknown): Promise<{
  accepted: number;
  ignored: number;
}> {
  const events = normalizeAwsS3Event(payload);
  let accepted = 0;
  for (const event of events) {
    if (await recordObjectChangeEvent(event)) accepted += 1;
  }
  return { accepted, ignored: events.length - accepted };
}

async function beginInventoryRun(connectionId: string): Promise<string | null> {
  await query(
    `UPDATE inventory_sync_runs
     SET status = 'failed', completed_at = NOW(),
         error = COALESCE(error, 'Recovered stale reconciliation run')
     WHERE connection_id = $1 AND status = 'running'
       AND started_at < NOW() - ($2 * INTERVAL '1 minute')`,
    [connectionId, RUN_STALE_AFTER_MINUTES]
  );
  try {
    const result = await query<{ id: string }>(
      `INSERT INTO inventory_sync_runs (connection_id) VALUES ($1) RETURNING id`,
      [connectionId]
    );
    return result.rows[0].id;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") return null;
    throw error;
  }
}

async function observeInventoryObject(
  connection: AutomaticImportConfig,
  runId: string,
  object: StorageObject,
  enqueue: boolean
): Promise<InventoryItemLogStatus> {
  const fingerprint = objectFingerprint(object);
  return withTransaction(async (client) => {
    const previousResult = await client.query<{
      object_fingerprint: string;
    }>(
      `SELECT object_fingerprint FROM storage_objects
       WHERE connection_id = $1 AND object_key = $2`,
      [connection.connectionId, object.key]
    );
    const previousFingerprint = previousResult.rows[0]?.object_fingerprint;

    await client.query(
      `INSERT INTO storage_objects (
         connection_id, object_key, etag, version_id, object_fingerprint,
         size, last_modified, last_seen_at, last_seen_run_id, missing_since
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, NULL)
       ON CONFLICT (connection_id, object_key) DO UPDATE SET
         etag = EXCLUDED.etag,
         version_id = EXCLUDED.version_id,
         object_fingerprint = EXCLUDED.object_fingerprint,
         size = EXCLUDED.size,
         last_modified = EXCLUDED.last_modified,
         last_seen_at = NOW(),
         last_seen_run_id = EXCLUDED.last_seen_run_id,
         missing_since = NULL`,
      [
        connection.connectionId,
        object.key,
        object.etag ?? null,
        object.versionId ?? null,
        fingerprint,
        object.size ?? null,
        object.lastModified ?? null,
        runId,
      ]
    );
    if (!isSupportedImage(object.key)) return "unsupported";
    if (!enqueue) return "baseline";
    if (connection.baselineCompleted && previousFingerprint === fingerprint) {
      return "duplicate";
    }
    if (!previousFingerprint) {
      const existingPhoto = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM photos WHERE s3_path = $1
         ) AS exists`,
        [`s3://${connection.bucket}/${object.key}`]
      );
      if (existingPhoto.rows[0]?.exists) {
        await client.query(
          `UPDATE storage_objects
           SET imported_at = COALESCE(imported_at, NOW()), imported_fingerprint = $3
           WHERE connection_id = $1 AND object_key = $2`,
          [connection.connectionId, object.key, fingerprint]
        );
        return "duplicate";
      }
    }
    const queued = await enqueueImportJob(
      client,
      {
        connectionId: connection.connectionId,
        provider: connection.provider,
        type: "created",
        bucket: connection.bucket,
        key: object.key,
        etag: object.etag,
        versionId: object.versionId,
        size: object.size,
        occurredAt: object.lastModified,
      },
      fingerprint
    );
    return queued ? "queued" : "duplicate";
  });
}

function nextScanDate(intervalMinutes: number): Date {
  const jitter = 0.9 + Math.random() * 0.2;
  return new Date(Date.now() + intervalMinutes * 60_000 * jitter);
}

export async function reconcileConnection(
  connectionId = DEFAULT_STORAGE_CONNECTION_ID
): Promise<{ runId: string | null; objects: number; queued: number }> {
  const current = await ensureDefaultStorageConnection();
  if (!current || current.connectionId !== connectionId) {
    throw new Error(`Storage connection is not configured`);
  }
  if (!current.enabled) return { runId: null, objects: 0, queued: 0 };

  const runId = await beginInventoryRun(connectionId);
  if (!runId) return { runId: null, objects: 0, queued: 0 };
  const scanLogId = await safeCreateGpuLog({
    type: "inventory",
    provider: current.provider,
    s3Path: `s3://${current.bucket}/${current.allowedPrefixes.join(",")}`,
  });
  await safePruneInventoryLogs();

  let objectCount = 0;
  let queuedCount = 0;
  let pageCount = 0;
  const shouldEnqueue = current.baselineCompleted || current.initialImportMode === "all";

  try {
    const prefixes = current.allowedPrefixes.length > 0 ? current.allowedPrefixes : [""];
    for (const prefix of prefixes) {
      for await (const object of iterateObjects(
        current.bucket,
        prefix || undefined,
        () => { pageCount += 1; }
      )) {
        objectCount += 1;
        const outcome = await observeInventoryObject(
          current,
          runId,
          object,
          shouldEnqueue
        );
        await safeRecordInventoryItemLog({
          parentId: scanLogId,
          provider: current.provider,
          s3Path: `s3://${current.bucket}/${object.key}`,
          status: outcome,
        });
        if (outcome === "queued") {
          queuedCount += 1;
        }
      }
    }

    await withTransaction(async (client) => {
      // This executes only after every listing succeeds. Partial scans never
      // mark unseen objects missing.
      await client.query(
        `UPDATE storage_objects
         SET missing_since = COALESCE(missing_since, NOW())
         WHERE connection_id = $1 AND last_seen_run_id IS DISTINCT FROM $2`,
        [connectionId, runId]
      );
      await client.query(
        `UPDATE inventory_sync_runs
         SET status = 'completed', completed_at = NOW(), object_count = $2,
             page_count = $3, queued_count = $4
         WHERE id = $1`,
        [
          runId,
          objectCount,
          pageCount,
          queuedCount,
        ]
      );
      await client.query(
        `UPDATE storage_connections
         SET baseline_completed = TRUE, last_reconciled_at = NOW(),
             next_reconciliation_at = $2, last_error = NULL, updated_at = NOW()
         WHERE id = $1`,
        [connectionId, nextScanDate(current.scanIntervalMinutes)]
      );
    });
    logger.info(
      `Automatic import reconciliation complete: ${objectCount} objects, ${queuedCount} queued`
    );
    await safeCompleteGpuLog(scanLogId, {
      photoCount: objectCount,
      photosSucceeded: queuedCount,
      photosFailed: 0,
    });
    return { runId, objects: objectCount, queued: queuedCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE inventory_sync_runs
         SET status = 'failed', completed_at = NOW(), object_count = $2,
             queued_count = $3, error = $4
         WHERE id = $1`,
        [runId, objectCount, queuedCount, message.slice(0, 4000)]
      );
      await client.query(
        `UPDATE storage_connections
         SET last_error = $2, next_reconciliation_at = $3, updated_at = NOW()
         WHERE id = $1`,
        [
          connectionId,
          message.slice(0, 4000),
          nextScanDate(Math.min(current.scanIntervalMinutes, 5)),
        ]
      );
    });
    await safeFailGpuLog(scanLogId, message, {
      photoCount: objectCount,
      photosSucceeded: queuedCount,
    });
    throw error;
  }
}

async function claimImportJobs(limit: number): Promise<ImportJobRow[]> {
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE photo_import_jobs
       SET status = 'pending', next_attempt_at = NOW(), updated_at = NOW(),
           last_error = COALESCE(last_error, 'Recovered after worker interruption')
       WHERE status = 'running' AND updated_at < NOW() - INTERVAL '10 minutes'`
    );
    const result = await client.query<ImportJobRow>(
      `UPDATE photo_import_jobs
       SET status = 'running', attempts = attempts + 1,
           started_at = NOW(), updated_at = NOW()
       WHERE id IN (
         SELECT jobs.id FROM photo_import_jobs jobs
         JOIN storage_connections connections ON connections.id = jobs.connection_id
         WHERE jobs.status = 'pending' AND jobs.next_attempt_at <= NOW()
           AND connections.automatic_import_enabled = TRUE
         ORDER BY jobs.created_at ASC
         FOR UPDATE OF jobs SKIP LOCKED
         LIMIT $1
       )
       RETURNING id, connection_id, object_key, object_fingerprint,
                 etag, version_id, attempts`,
      [limit]
    );
    return result.rows;
  });
}

async function completeImportJob(
  job: ImportJobRow,
  note: string | null = null
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE photo_import_jobs
       SET status = 'completed', completed_at = NOW(), updated_at = NOW(),
           last_error = $2
       WHERE id = $1`,
      [job.id, note]
    );
    if (!note) {
      await client.query(
        `UPDATE storage_objects
         SET imported_at = NOW(), imported_fingerprint = $3
         WHERE connection_id = $1 AND object_key = $2
           AND object_fingerprint = $3`,
        [job.connection_id, job.object_key, job.object_fingerprint]
      );
    }
  });
}

async function failImportJob(
  job: ImportJobRow,
  error: unknown,
  retryUntilResolved = false
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const retry = retryUntilResolved || job.attempts < MAX_JOB_ATTEMPTS;
  const delaySeconds = retryUntilResolved
    ? 3600
    : Math.min(3600, 2 ** Math.min(job.attempts, 10));
  await query(
    `UPDATE photo_import_jobs
     SET status = $2, next_attempt_at = NOW() + ($3 * INTERVAL '1 second'),
         last_error = $4, updated_at = NOW()
     WHERE id = $1`,
    [job.id, retry ? "pending" : "failed", delaySeconds, message.slice(0, 4000)]
  );
}

async function getConnectionById(id: string): Promise<AutomaticImportConfig | null> {
  const result = await query<ConnectionRow>(
    `SELECT * FROM storage_connections WHERE id = $1`,
    [id]
  );
  return result.rows[0] ? mapConnection(result.rows[0]) : null;
}

async function processClaimedJob(job: ImportJobRow): Promise<boolean> {
  let importLogId: string | null = null;
  try {
    const connection = await getConnectionById(job.connection_id);
    if (!connection?.enabled) {
      await failImportJob(job, "Automatic import is disabled", true);
      return false;
    }
    if (!keyIsAllowed(job.object_key, connection.allowedPrefixes)) {
      await completeImportJob(job, "Object is outside the configured import prefixes");
      return false;
    }
    if (!isSupportedImage(job.object_key)) {
      await completeImportJob(job, "Unsupported image type");
      return false;
    }

    const current = await headObject(connection.bucket, job.object_key);
    const currentFingerprint = objectFingerprint(current);
    if (currentFingerprint !== job.object_fingerprint) {
      await recordObjectChangeEvent({
        connectionId: connection.connectionId,
        provider: connection.provider,
        type: "updated",
        bucket: connection.bucket,
        key: job.object_key,
        etag: current.etag,
        versionId: current.versionId,
        size: current.size,
        occurredAt: current.lastModified,
      });
      await completeImportJob(job, "Superseded by a newer object version");
      return false;
    }

    const importProvider = connection.gpuMode === "skip"
      ? "local"
      : getRealtimeGpuProvider();
    importLogId = await safeCreateGpuLog({
      type: "import",
      provider: importProvider,
      gpuMode: connection.gpuMode,
      s3Path: `s3://${connection.bucket}/${job.object_key}`,
      photoCount: 1,
    });

    // An object may have changed at the same S3 path. Clear the old stage
    // checkpoints once, then later queue attempts can safely resume only the
    // stages that did not finish.
    if (job.attempts === 1) {
      await invalidatePhotoProcessingVersions(
        `s3://${connection.bucket}/${job.object_key}`,
        {
          cpu: true,
          caption:
            connection.gpuMode === "all" ||
            connection.gpuMode === "caption-only",
          faces:
            connection.gpuMode === "all" ||
            connection.gpuMode === "faces-only",
        }
      );
    }

    const [result] = await processPhotoBatch(
      [
        {
          s3Bucket: connection.bucket,
          s3Key: job.object_key,
          gpuMode: connection.gpuMode,
        },
      ],
      undefined,
      importLogId,
      {
        provider: importProvider,
        externalJobId: job.id,
      }
    );
    if (result?.gpuStatus === "failed" && !result.gpuRetryable) {
      const message = result.errors.join("; ") || "Permanent GPU input failure";
      await completeImportJob(job, message);
      await safeUpdateGpuLogOutcome(importLogId, {
        photoCount: 1,
        photosSucceeded: 0,
        photosFailed: 1,
        error: message,
        fallbackStatus: "failed",
      });
      return false;
    }
    if (!result || !result.photoId || result.gpuStatus === "failed") {
      throw new Error(result?.errors.join("; ") || "Photo processing failed");
    }
    await completeImportJob(job);
    await safeUpdateGpuLogOutcome(importLogId, {
      photosSucceeded: 1,
      photosFailed: 0,
      fallbackStatus: "completed",
    });
    return connection.gpuMode === "all" || connection.gpuMode === "faces-only";
  } catch (error) {
    await failImportJob(job, error, error instanceof GpuPaymentRequiredError);
    await safeUpdateGpuLogOutcome(importLogId, {
      photoCount: 1,
      photosSucceeded: 0,
      photosFailed: 1,
      error: error instanceof Error ? error.message : String(error),
      fallbackStatus: "failed",
    });
    logger.warn(
      `Automatic photo import ${job.id} failed: ${error instanceof Error ? error.message : error}`
    );
    return false;
  }
}

export async function processPendingAutomaticImports(limit = 5): Promise<number> {
  const jobs = await claimImportJobs(limit);
  let shouldCluster = false;
  for (const job of jobs) {
    shouldCluster = (await processClaimedJob(job)) || shouldCluster;
  }
  if (shouldCluster) {
    try {
      await clusterUnassignedFaces({ threshold: 0.6, strategy: "first" });
    } catch (error) {
      logger.warn("Automatic import face clustering failed:", error);
    }
  }
  return jobs.length;
}

export async function getInventoryFolderCounts(
  bucket: string,
  prefix: string
): Promise<{
  prefix: string;
  imageCount: number;
  folders: Array<{ prefix: string; imageCount: number }>;
} | null> {
  const connection = await ensureDefaultStorageConnection();
  if (
    !connection?.baselineCompleted ||
    connection.bucket !== bucket ||
    (connection.allowedPrefixes.length > 0 &&
      !connection.allowedPrefixes.some((allowed) => prefix.startsWith(allowed)))
  ) {
    return null;
  }
  const escapedPrefix = prefix.replace(/[\\%_]/g, "\\$&");
  const result = await query<{ object_key: string }>(
    `SELECT object_key FROM storage_objects
     WHERE connection_id = $1 AND missing_since IS NULL
       AND object_key LIKE $2 ESCAPE '\\'`,
    [connection.connectionId, `${escapedPrefix}%`]
  );
  let imageCount = 0;
  const folders = new Map<string, number>();
  for (const row of result.rows) {
    if (!isSupportedImage(row.object_key)) continue;
    const relative = row.object_key.slice(prefix.length);
    const separator = relative.indexOf("/");
    if (separator === -1) {
      imageCount += 1;
      continue;
    }
    const folderPrefix = `${prefix}${relative.slice(0, separator + 1)}`;
    folders.set(folderPrefix, (folders.get(folderPrefix) ?? 0) + 1);
  }
  return {
    prefix,
    imageCount,
    folders: [...folders].map(([folderPrefix, count]) => ({
      prefix: folderPrefix,
      imageCount: count,
    })),
  };
}

export async function requestReconciliation(): Promise<boolean> {
  const connection = await ensureDefaultStorageConnection();
  if (!connection?.enabled) return false;
  await query(
    `UPDATE storage_connections SET next_reconciliation_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [connection.connectionId]
  );
  return true;
}

export async function getAutomaticImportStatus(): Promise<{
  connection: AutomaticImportConfig | null;
  jobs: Record<string, number>;
  lastRun: {
    id: string;
    status: string;
    startedAt: Date;
    completedAt: Date | null;
    objectCount: number;
    queuedCount: number;
    error: string | null;
  } | null;
}> {
  const connection = await ensureDefaultStorageConnection();
  if (!connection) return { connection: null, jobs: {} , lastRun: null };
  const [jobResult, runResult] = await Promise.all([
    query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count FROM photo_import_jobs
       WHERE connection_id = $1 GROUP BY status`,
      [connection.connectionId]
    ),
    query<{
      id: string;
      status: string;
      started_at: Date;
      completed_at: Date | null;
      object_count: number;
      queued_count: number;
      error: string | null;
    }>(
      `SELECT id, status, started_at, completed_at, object_count, queued_count, error
       FROM inventory_sync_runs WHERE connection_id = $1
       ORDER BY started_at DESC LIMIT 1`,
      [connection.connectionId]
    ),
  ]);
  const jobs = Object.fromEntries(
    jobResult.rows.map((row) => [row.status, Number.parseInt(row.count, 10)])
  );
  const run = runResult.rows[0];
  return {
    connection,
    jobs,
    lastRun: run
      ? {
          id: run.id,
          status: run.status,
          startedAt: run.started_at,
          completedAt: run.completed_at,
          objectCount: run.object_count,
          queuedCount: run.queued_count,
          error: run.error,
        }
      : null,
  };
}

async function pollCurrentWorkspace(): Promise<void> {
  const connection = await ensureDefaultStorageConnection();
  if (!connection?.enabled) return;
  // Drain event-accelerated work before a potentially long inventory scan.
  await processPendingAutomaticImports();
  if (
    !connection.nextReconciliationAt ||
    connection.nextReconciliationAt.getTime() <= Date.now()
  ) {
    await reconcileConnection(connection.connectionId);
    await processPendingAutomaticImports();
  }
}

let automaticImportTimer: ReturnType<typeof setInterval> | null = null;
let automaticImportPoll: Promise<void> | null = null;

async function pollAllWorkspaces(): Promise<void> {
  if (!isManagedMode()) {
    await pollCurrentWorkspace();
    return;
  }
  for (const workspaceId of await listWorkspaceDirectoryIds()) {
    try {
      await runWithWorkspaceContext(workspaceId, pollCurrentWorkspace);
    } catch (error) {
      logger.warn(
        `Automatic import poll failed for workspace ${workspaceId}: ${error instanceof Error ? error.message : error}`
      );
    }
  }
}

export function startAutomaticImportWorker(): void {
  if (automaticImportTimer) return;
  const interval = clampInteger(
    process.env.AUTO_IMPORT_POLL_INTERVAL_MS,
    10_000,
    1_000,
    300_000
  );
  const poll = () => {
    if (automaticImportPoll) return;
    automaticImportPoll = pollAllWorkspaces()
      .catch((error) => logger.warn("Automatic import worker failed:", error))
      .finally(() => {
        automaticImportPoll = null;
      });
  };
  poll();
  automaticImportTimer = setInterval(poll, interval);
  automaticImportTimer.unref();
}

export async function stopAutomaticImportWorker(): Promise<void> {
  if (automaticImportTimer) clearInterval(automaticImportTimer);
  automaticImportTimer = null;
  await automaticImportPoll;
}
