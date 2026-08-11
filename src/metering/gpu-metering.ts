import crypto from "node:crypto";
import type pg from "pg";
import {
  getGpuMeteringMode,
  getGpuMeteringRequestTimeoutMs,
  getGpuMeteringToken,
  getGpuMeteringUrl,
} from "../config/runtime.js";
import {
  getCurrentWorkspaceId,
  query,
  withTransaction,
} from "../db/client.js";
import type {
  GpuProvider,
  GpuResourceUsage,
} from "../extractors/gpu-client.js";
import { logger } from "../logger.js";

export type MeteredGpuMode = "all" | "caption-only" | "faces-only";
export type MeteredOperation = "caption" | "faces" | "combined";

export interface MeteringJobContext {
  externalJobId: string;
  workspaceId: string;
  provider: Exclude<GpuProvider, "local">;
  gpuMode: MeteredGpuMode;
  photoCount: number;
  routingPolicyVersion: string;
  routingThreshold: number;
}

export interface OperationUsageInput {
  eventId?: string;
  operation: "caption" | "faces";
  elapsedMs: number;
  succeeded: boolean;
  attempt?: number;
  reprovision?: number;
  metadata?: Record<string, unknown>;
}

export interface GpuJobEstimate {
  currency: string;
  provider: "modal" | "vastai";
  priceCatalogVersion: string;
  estimatedMicros: string;
  availableMicros: string;
  sufficient: boolean;
}

interface OutboxRow extends pg.QueryResultRow {
  id: string;
  external_job_id: string;
  command_type: "reservation" | "usage" | "settlement" | "cancellation";
  idempotency_key: string;
  payload: Record<string, unknown>;
  attempts: number;
}

interface MeteringJobRow extends pg.QueryResultRow {
  external_job_id: string;
  reservation_id: string | null;
  status: string;
}

export class GpuPaymentRequiredError extends Error {
  constructor(
    readonly currency: string,
    readonly requiredMicros: string,
    readonly availableMicros: string
  ) {
    super("Your GPU processing allowance is insufficient for this job.");
    this.name = "GpuPaymentRequiredError";
  }
}

export async function getGpuJobEstimate(input: {
  photoCount: number;
  provider: GpuProvider;
  gpuMode: string;
}): Promise<GpuJobEstimate | null> {
  if (
    input.photoCount <= 0 ||
    input.provider === "local" ||
    input.gpuMode === "skip" ||
    getGpuMeteringMode() === "disabled"
  ) {
    return null;
  }
  const workspaceId = getCurrentWorkspaceId();
  if (!workspaceId) return null;
  const response = await meteringFetch("/internal/gpu/estimate", `estimate:${crypto.randomUUID()}`, {
    workspaceId,
    provider: input.provider,
    operations: operationsForMode(input.gpuMode as MeteredGpuMode),
    photoCount: input.photoCount,
  });
  return response.estimate as unknown as GpuJobEstimate;
}

class MeteringHttpError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(typeof body.message === "string" ? body.message : `Metering service returned ${status}`);
    this.name = "MeteringHttpError";
  }
}

function operationsForMode(mode: MeteredGpuMode): Array<"caption" | "faces"> {
  if (mode === "caption-only") return ["caption"];
  if (mode === "faces-only") return ["faces"];
  return ["caption", "faces"];
}

async function enqueueCommand(
  externalJobId: string,
  commandType: OutboxRow["command_type"],
  idempotencyKey: string,
  payload: Record<string, unknown>
): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO gpu_metering_outbox (
       external_job_id, command_type, idempotency_key, payload
     ) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (idempotency_key) DO UPDATE
       SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING id`,
    [externalJobId, commandType, idempotencyKey, JSON.stringify(payload)]
  );
  return result.rows[0].id;
}

async function meteringFetch(
  path: string,
  idempotencyKey: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const baseUrl = getGpuMeteringUrl();
  const token = getGpuMeteringToken();
  if (!baseUrl || !token) throw new Error("GPU metering service is not configured");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getGpuMeteringRequestTimeoutMs());
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const responseBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new MeteringHttpError(response.status, responseBody);
    return responseBody;
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverOutboxRow(row: OutboxRow): Promise<void> {
  const jobResult = await query<MeteringJobRow>(
    `SELECT external_job_id, reservation_id, status
     FROM gpu_metering_jobs WHERE external_job_id = $1`,
    [row.external_job_id]
  );
  const job = jobResult.rows[0];
  if (!job) throw new Error(`Metering job ${row.external_job_id} not found`);

  let path: string;
  let body = row.payload;
  if (row.command_type === "reservation") {
    path = "/internal/gpu/reservations";
  } else {
    if (!job.reservation_id) throw new Error("Reservation has not been delivered yet");
    if (row.command_type === "usage") {
      path = "/internal/gpu/usage-events";
      const event = { ...row.payload, reservationId: job.reservation_id };
      body = { events: [event] };
    } else if (row.command_type === "settlement") {
      path = `/internal/gpu/reservations/${encodeURIComponent(job.reservation_id)}/settle`;
    } else {
      path = `/internal/gpu/reservations/${encodeURIComponent(job.reservation_id)}/cancel`;
    }
  }

  const response = await meteringFetch(path, row.idempotency_key, body);
  await withTransaction(async (client) => {
    if (row.command_type === "reservation") {
      const reservation = response.reservation as Record<string, unknown> | undefined;
      if (!reservation || typeof reservation.id !== "string") {
        throw new Error("Metering reservation response did not include an ID");
      }
      const reservationIsActive = reservation.status === "active";
      await client.query(
        `UPDATE gpu_metering_jobs
         SET reservation_id = $2,
             price_catalog_version = $3,
             currency = $4,
             reserved_micros = $5,
             status = $6,
             updated_at = NOW()
         WHERE external_job_id = $1`,
        [
          row.external_job_id,
          reservation.id,
          reservation.priceCatalogVersion ?? null,
          reservation.currency ?? null,
          reservation.reservedMicros ?? null,
          reservationIsActive ? "reserved" : "shadow",
        ]
      );
    } else if (row.command_type === "settlement") {
      const reservation = response.reservation as Record<string, unknown> | undefined;
      await client.query(
        `UPDATE gpu_metering_jobs
         SET status = 'settled', settled_micros = $2, updated_at = NOW()
         WHERE external_job_id = $1`,
        [row.external_job_id, reservation?.settledMicros ?? 0]
      );
    } else if (row.command_type === "cancellation") {
      await client.query(
        `UPDATE gpu_metering_jobs SET status = 'cancelled', updated_at = NOW()
         WHERE external_job_id = $1`,
        [row.external_job_id]
      );
    }

    await client.query(
      `UPDATE gpu_metering_outbox
       SET status = 'delivered', response = $2::jsonb, delivered_at = NOW(),
           attempts = attempts + 1, last_error = NULL
       WHERE id = $1`,
      [row.id, JSON.stringify(response)]
    );
  });
}

async function markDeliveryFailure(row: OutboxRow, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const nextDelaySeconds = Math.min(3600, 2 ** Math.min(row.attempts, 10));
  await query(
    `UPDATE gpu_metering_outbox
     SET attempts = attempts + 1,
         last_error = $2,
         next_attempt_at = NOW() + ($3 * INTERVAL '1 second')
     WHERE id = $1`,
    [row.id, message.slice(0, 2000), nextDelaySeconds]
  );
}

export async function flushMeteringOutbox(
  externalJobId: string
): Promise<void> {
  const rows = await query<OutboxRow>(
    `SELECT id, external_job_id, command_type, idempotency_key, payload, attempts
     FROM gpu_metering_outbox
     WHERE external_job_id = $1 AND status = 'pending'
     ORDER BY created_at ASC`,
    [externalJobId]
  );
  for (const row of rows.rows) {
    try {
      await deliverOutboxRow(row);
    } catch (error) {
      await markDeliveryFailure(row, error);
      throw error;
    }
  }
}

export async function retryPendingMeteringOutbox(limit = 10): Promise<void> {
  const jobs = await query<{ external_job_id: string }>(
    `SELECT external_job_id
     FROM gpu_metering_outbox
     WHERE status = 'pending' AND next_attempt_at <= NOW()
     GROUP BY external_job_id
     ORDER BY MIN(created_at)
     LIMIT $1`,
    [limit]
  );
  for (const job of jobs.rows) {
    try {
      await flushMeteringOutbox(job.external_job_id);
    } catch (error) {
      logger.warn(
        `GPU metering retry remains pending for job ${job.external_job_id}: ${error instanceof Error ? error.message : error}`
      );
    }
  }
}

export async function beginMeteredGpuJob(input: {
  externalJobId: string;
  provider: GpuProvider;
  gpuMode: string;
  photoCount: number;
  routingPolicyVersion: string;
  routingThreshold: number;
}): Promise<MeteringJobContext | null> {
  const mode = getGpuMeteringMode();
  if (mode === "disabled" || input.provider === "local" || input.gpuMode === "skip") {
    return null;
  }
  const workspaceId = getCurrentWorkspaceId();
  if (!workspaceId) {
    if (mode === "enforce") throw new Error("GPU metering requires a managed workspace context");
    logger.warn("GPU metering skipped because no managed workspace context is active");
    return null;
  }
  const gpuMode = input.gpuMode as MeteredGpuMode;
  const context: MeteringJobContext = {
    externalJobId: input.externalJobId,
    workspaceId,
    provider: input.provider,
    gpuMode,
    photoCount: input.photoCount,
    routingPolicyVersion: input.routingPolicyVersion,
    routingThreshold: input.routingThreshold,
  };

  await retryPendingMeteringOutbox();

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO gpu_metering_jobs (
         external_job_id, provider, gpu_mode, photo_count, routing_policy_version,
         routing_threshold, status
       ) VALUES ($1, $2, $3, $4, $5, $6, 'pending_reservation')
       ON CONFLICT (external_job_id) DO NOTHING`,
      [
        context.externalJobId,
        context.provider,
        context.gpuMode,
        context.photoCount,
        context.routingPolicyVersion,
        context.routingThreshold,
      ]
    );
    await client.query(
      `INSERT INTO gpu_metering_outbox (
         external_job_id, command_type, idempotency_key, payload
       ) VALUES ($1, 'reservation', $2, $3::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        context.externalJobId,
        `reservation:${context.externalJobId}`,
        JSON.stringify({
          workspaceId,
          externalJobId: context.externalJobId,
          provider: context.provider,
          operations: operationsForMode(context.gpuMode),
          photoCount: context.photoCount,
          routingPolicyVersion: context.routingPolicyVersion,
          routingThreshold: context.routingThreshold,
          metadata: { meter: "fixed_operation_v1" },
        }),
      ]
    );
  });

  try {
    await flushMeteringOutbox(context.externalJobId);
    const delivered = await query<MeteringJobRow>(
      `SELECT external_job_id, reservation_id, status
       FROM gpu_metering_jobs WHERE external_job_id = $1`,
      [context.externalJobId]
    );
    if (!delivered.rows[0]?.reservation_id || delivered.rows[0].status !== "reserved") {
      throw new Error("GPU reservation is not active");
    }
    await query(
      `UPDATE gpu_metering_jobs SET status = 'running', updated_at = NOW()
       WHERE external_job_id = $1`,
      [context.externalJobId]
    );
  } catch (error) {
    if (error instanceof MeteringHttpError && error.status === 402) {
      const currency = typeof error.body.currency === "string" ? error.body.currency : "USD";
      const required = typeof error.body.requiredMicros === "string" ? error.body.requiredMicros : "0";
      const available = typeof error.body.availableMicros === "string" ? error.body.availableMicros : "0";
      if (mode === "enforce") throw new GpuPaymentRequiredError(currency, required, available);
    } else if (mode === "enforce") {
      throw error;
    }
    await query(
      `UPDATE gpu_metering_jobs SET status = 'shadow', error = $2, updated_at = NOW()
       WHERE external_job_id = $1`,
      [context.externalJobId, error instanceof Error ? error.message : String(error)]
    );
    logger.warn(`GPU metering reservation is in shadow mode: ${error instanceof Error ? error.message : error}`);
  }
  return context;
}

export async function recordGpuOperationUsage(
  context: MeteringJobContext | null,
  input: OperationUsageInput
): Promise<void> {
  if (!context) return;
  const eventId = input.eventId ?? crypto.randomUUID();
  await enqueueCommand(context.externalJobId, "usage", `usage:${eventId}`, {
    eventId,
    workspaceId: context.workspaceId,
    externalJobId: context.externalJobId,
    provider: context.provider,
    operation: input.operation,
    units: 1,
    billableGpuMs: null,
    providerCostUsdMicros: null,
    attempt: input.attempt ?? 1,
    reprovision: input.reprovision ?? 0,
    succeeded: input.succeeded,
    occurredAt: new Date().toISOString(),
    routingPolicyVersion: context.routingPolicyVersion,
    routingThreshold: context.routingThreshold,
    metadata: {
      localElapsedMs: input.elapsedMs,
      authoritativeProviderDuration: false,
      ...input.metadata,
    },
  });
}

export async function recordGpuResourceUsage(
  context: MeteringJobContext | null,
  usages: GpuResourceUsage[]
): Promise<void> {
  if (!context) return;
  for (const usage of usages) {
    const eventId = crypto.randomUUID();
    await enqueueCommand(context.externalJobId, "usage", `usage:${eventId}`, {
      eventId,
      workspaceId: context.workspaceId,
      externalJobId: context.externalJobId,
      provider: context.provider,
      providerResourceId: usage.providerResourceId,
      gpuModel: usage.gpuModel,
      gpuCount: usage.gpuCount,
      operation: "combined",
      units: 0,
      billableGpuMs: usage.billableGpuMs,
      providerCostUsdMicros: usage.providerCostUsdMicros,
      attempt: 1,
      reprovision: usage.reprovision,
      succeeded: usage.succeeded,
      occurredAt: usage.occurredAt,
      routingPolicyVersion: context.routingPolicyVersion,
      routingThreshold: context.routingThreshold,
      metadata: usage.metadata ?? {},
    });
  }
}

export async function completeMeteredGpuJob(
  context: MeteringJobContext | null
): Promise<void> {
  if (!context) return;
  const usageCount = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM gpu_metering_outbox
     WHERE external_job_id = $1 AND command_type = 'usage'`,
    [context.externalJobId]
  );
  const hasUsage = usageCount.rows[0]?.count !== "0";
  const command = hasUsage ? "settlement" : "cancellation";
  await query(
    `UPDATE gpu_metering_jobs SET status = $2, updated_at = NOW()
     WHERE external_job_id = $1`,
    [context.externalJobId, hasUsage ? "settlement_pending" : "failed"]
  );
  await enqueueCommand(
    context.externalJobId,
    command,
    `${command}:${context.externalJobId}`,
    hasUsage ? {} : { reason: "No hosted GPU usage was recorded" }
  );
  try {
    await flushMeteringOutbox(context.externalJobId);
  } catch (error) {
    logger.error("GPU metering delivery remains pending in the durable outbox:", error);
    if (getGpuMeteringMode() === "enforce") throw error;
  }
}
