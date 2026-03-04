/**
 * Vast.ai GPU client — implements GpuClient with automatic instance lifecycle.
 *
 * start():       Search offers → create instance → poll until running → wait for /health
 * analyze():     HTTP POST to the running instance (same payload as Modal)
 * stop():        Destroy the instance (always called, even on error)
 * reprovision(): Destroy current instance → provision a new one (after eviction)
 *
 * Supports interruptible (bid/spot) instances for ~70% cost savings:
 *   - Background health monitor detects evictions within 10s
 *   - Circuit breaker aborts all in-flight requests immediately
 *   - Automatic fallback to on-demand if no interruptible offers available
 *
 * Environment variables:
 *   VAST_API_KEY              — Vast.ai API key (required)
 *   VAST_DOCKER_IMAGE         — Docker image to use (required)
 *   VAST_INFERENCE_API_KEY    — Bearer token for the inference server (required)
 *   VAST_GPU_TYPE             — GPU filter (default: "RTX 3090")
 *   VAST_MAX_PRICE_PER_HOUR   — Max $/hr (default: 0.30)
 *   VAST_DISK_GB              — Disk space in GB (default: 20)
 *   VAST_USE_INTERRUPTIBLE    — Use bid/spot instances (default: "true")
 *   VAST_BID_PRICE            — Override bid price $/hr (default: offer's dph_total)
 */

import { logger } from "../logger.js";
import type { GpuClient, GpuAnalysisResult } from "./gpu-client.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const VAST_API_BASE = "https://console.vast.ai";

function getConfig() {
  const apiKey = process.env.VAST_API_KEY;
  if (!apiKey) throw new Error("VAST_API_KEY is not configured");

  const dockerImage = process.env.VAST_DOCKER_IMAGE;
  if (!dockerImage) throw new Error("VAST_DOCKER_IMAGE is not configured");

  const inferenceApiKey = process.env.VAST_INFERENCE_API_KEY;
  if (!inferenceApiKey)
    throw new Error("VAST_INFERENCE_API_KEY is not configured");

  return {
    apiKey,
    dockerImage,
    inferenceApiKey,
    gpuType: (process.env.VAST_GPU_TYPE ?? "RTX 3090").replace(/_/g, " "),
    maxPricePerHour: parseFloat(
      process.env.VAST_MAX_PRICE_PER_HOUR ?? "0.30"
    ),
    diskGb: parseInt(process.env.VAST_DISK_GB ?? "20", 10),
    useInterruptible:
      (process.env.VAST_USE_INTERRUPTIBLE ?? "true").toLowerCase() === "true",
    bidPrice: process.env.VAST_BID_PRICE
      ? parseFloat(process.env.VAST_BID_PRICE)
      : null,
  };
}

// ---------------------------------------------------------------------------
// Vast.ai API types (partial — only what we need)
// ---------------------------------------------------------------------------

interface VastOffer {
  id: number;
  gpu_name: string;
  num_gpus: number;
  dph_total: number;
  gpu_ram: number;
  reliability: number;
  inet_down: number;
  inet_up: number;
  min_bid: number;
}

interface VastInstance {
  id: number;
  actual_status: string | null;
  intended_status: string;
  public_ipaddr: string;
  ports: Record<string, Array<{ HostIp: string; HostPort: string }>>;
  status_msg: string;
  cur_state: string;
}

// ---------------------------------------------------------------------------
// Vast.ai API helpers
// ---------------------------------------------------------------------------

/** Timeout for Vast.ai control-plane API calls (not inference). */
const API_TIMEOUT_MS = 30_000;

async function vastFetch(
  path: string,
  apiKey: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${VAST_API_BASE}${path}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(options.headers as Record<string, string>),
      },
    });
    return response;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `Vast.ai API call timed out after ${API_TIMEOUT_MS}ms: ${path}`
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

interface SearchOffersOptions {
  apiKey: string;
  gpuType: string;
  maxPrice: number;
  type: "ondemand" | "bid";
}

async function searchOffers(
  options: SearchOffersOptions
): Promise<VastOffer[]> {
  const { apiKey, gpuType, maxPrice, type } = options;

  const searchBody = {
    gpu_name: { in: [gpuType] },
    num_gpus: { gte: 1 },
    reliability: { gte: 0.95 },
    dph_total: { lte: maxPrice },
    verified: { eq: true },
    rentable: { eq: true },
    rented: { eq: false },
    datacenter: { eq: true },
    type,
    limit: 10,
  };

  logger.debug(
    `Vast.ai search: POST /api/v0/bundles/ with body: ${JSON.stringify(searchBody)}`
  );

  const response = await vastFetch("/api/v0/bundles/", apiKey, {
    method: "POST",
    body: JSON.stringify(searchBody),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    logger.error(
      `Vast.ai search offers failed (${response.status}): ${text.substring(0, 500)}`
    );
    throw new Error(
      `Vast.ai search offers failed (${response.status}): ${text.substring(0, 200)}`
    );
  }

  const data = (await response.json()) as { offers?: VastOffer[] };
  const offers = data.offers ?? [];

  logger.info(
    `Vast.ai search (${type}): got ${offers.length} offers` +
      (offers.length > 0
        ? `. Cheapest: $${offers[0]?.dph_total?.toFixed(3)}/hr ${offers[0]?.gpu_name} (id=${offers[0]?.id})`
        : `. Raw response keys: ${JSON.stringify(Object.keys(data))}`)
  );

  return offers;
}

interface CreateInstanceOptions {
  apiKey: string;
  offerId: number;
  dockerImage: string;
  diskGb: number;
  inferenceApiKey: string;
  /** If set, create as interruptible at this bid price. If null, create on-demand. */
  bidPrice: number | null;
}

async function createInstance(
  options: CreateInstanceOptions
): Promise<number> {
  const { apiKey, offerId, dockerImage, diskGb, inferenceApiKey, bidPrice } =
    options;

  const body: Record<string, unknown> = {
    image: dockerImage,
    disk: diskGb,
    runtype: "ssh_direct",
    env: {
      INFERENCE_API_KEY: inferenceApiKey,
      "-p 8000:8000": "1",
    },
    onstart: "cd /app && uvicorn server:app --host 0.0.0.0 --port 8000 &",
    label: "nuvopic-inference",
  };

  if (bidPrice !== null) {
    body.price = bidPrice;
    logger.info(
      `Vast.ai: creating interruptible instance (bid=$${bidPrice.toFixed(3)}/hr) from offer ${offerId}`
    );
  } else {
    logger.info(
      `Vast.ai: creating on-demand instance from offer ${offerId}`
    );
  }

  const response = await vastFetch(`/api/v0/asks/${offerId}/`, apiKey, {
    method: "PUT",
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Vast.ai create instance failed (${response.status}): ${text.substring(0, 200)}`
    );
  }

  const data = (await response.json()) as {
    success?: boolean;
    new_contract?: number;
  };
  if (!data.new_contract) {
    throw new Error(
      `Vast.ai create instance: unexpected response: ${JSON.stringify(data).substring(0, 200)}`
    );
  }

  return data.new_contract;
}

async function getInstance(
  apiKey: string,
  instanceId: number
): Promise<VastInstance | null> {
  const response = await vastFetch(
    `/api/v0/instances/${instanceId}/`,
    apiKey
  );

  if (!response.ok) {
    if (response.status === 404) return null;
    const text = await response.text().catch(() => "");
    throw new Error(
      `Vast.ai get instance failed (${response.status}): ${text.substring(0, 200)}`
    );
  }

  const data = (await response.json()) as {
    instances?: VastInstance;
  };
  return data.instances ?? null;
}

async function destroyInstance(
  apiKey: string,
  instanceId: number
): Promise<void> {
  const response = await vastFetch(
    `/api/v0/instances/${instanceId}/`,
    apiKey,
    { method: "DELETE" }
  );

  if (!response.ok && response.status !== 404) {
    const text = await response.text().catch(() => "");
    logger.warn(
      `Vast.ai destroy instance warning (${response.status}): ${text.substring(0, 200)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Polling helpers
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 10_000; // 10s between status checks
const MAX_PROVISION_TIME_MS = 10 * 60 * 1000; // 10 minutes max for provisioning (image is ~15GB)
const HEALTH_CHECK_INTERVAL_MS = 5_000; // 5s between health checks
const MAX_HEALTH_WAIT_MS = 3 * 60 * 1000; // 3 minutes max for models to load

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until the instance reaches `actual_status === "running"`.
 * Returns the instance info with port mappings.
 */
async function waitForRunning(
  apiKey: string,
  instanceId: number
): Promise<VastInstance> {
  const start = Date.now();

  while (Date.now() - start < MAX_PROVISION_TIME_MS) {
    const instance = await getInstance(apiKey, instanceId);

    if (!instance) {
      throw new Error(
        `Vast.ai instance ${instanceId} not found — may have been destroyed`
      );
    }

    if (instance.actual_status === "running") {
      return instance;
    }

    if (
      instance.cur_state === "error" ||
      instance.actual_status === "exited"
    ) {
      throw new Error(
        `Vast.ai instance ${instanceId} entered error state: ${instance.status_msg}`
      );
    }

    logger.info(
      `Vast.ai instance ${instanceId}: status=${instance.actual_status ?? "loading"}, ` +
        `state=${instance.cur_state}, waiting...`
    );
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Vast.ai instance ${instanceId} did not start within ${MAX_PROVISION_TIME_MS / 1000}s`
  );
}

/**
 * Parse the instance port mapping to get the external host:port for container port 8000.
 */
function getEndpointUrl(instance: VastInstance): string {
  const portMapping = instance.ports["8000/tcp"];
  if (portMapping && portMapping.length > 0) {
    const hostPort = portMapping[0].HostPort;
    return `http://${instance.public_ipaddr}:${hostPort}`;
  }

  // Fallback: try direct port
  throw new Error(
    `Vast.ai instance ${instance.id}: no port mapping found for 8000/tcp. ` +
      `Available ports: ${JSON.stringify(instance.ports)}`
  );
}

/**
 * Wait for the inference server to respond to /health.
 */
async function waitForHealthy(endpointUrl: string): Promise<void> {
  const start = Date.now();
  const healthUrl = `${endpointUrl}/health`;

  while (Date.now() - start < MAX_HEALTH_WAIT_MS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);

      const response = await fetch(healthUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (response.ok) {
        logger.info(`Vast.ai inference server is healthy at ${endpointUrl}`);
        return;
      }

      logger.info(
        `Vast.ai health check: ${response.status}, waiting for models to load...`
      );
    } catch {
      logger.info(`Vast.ai health check: not reachable yet, waiting...`);
    }

    await sleep(HEALTH_CHECK_INTERVAL_MS);
  }

  throw new Error(
    `Vast.ai inference server at ${endpointUrl} did not become healthy within ${MAX_HEALTH_WAIT_MS / 1000}s`
  );
}

// ---------------------------------------------------------------------------
// VastGpuClient
// ---------------------------------------------------------------------------

const INFERENCE_TIMEOUT_MS = 120_000; // 120s — requests queue server-side on single GPU, allow time for large batches
const MAX_RETRIES = 2;
const HEALTH_MONITOR_INTERVAL_MS = 10_000; // 10s between health monitor polls

export class VastGpuClient implements GpuClient {
  readonly provider = "vastai" as const;

  private instanceId: number | null = null;
  private endpointUrl: string | null = null;
  private inferenceApiKey: string = "";
  private apiKey: string = "";

  // --- Interruptible support ---
  private _isInterruptible: boolean = false;
  private instanceDead: boolean = false;
  private instanceAbort: AbortController = new AbortController();
  private healthMonitorTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether the current instance is interruptible (bid/spot). */
  get isInterruptible(): boolean {
    return this._isInterruptible;
  }

  /**
   * Provision a Vast.ai GPU instance:
   * 1. Search for cheapest matching offer (interruptible first, fallback to on-demand)
   * 2. Create instance (with bid price if interruptible)
   * 3. Poll until running
   * 4. Wait for /health to respond
   * 5. Start health monitor (if interruptible)
   */
  async start(): Promise<void> {
    const config = getConfig();
    this.inferenceApiKey = config.inferenceApiKey;
    this.apiKey = config.apiKey;

    // Reset circuit breaker state
    this.instanceDead = false;
    this.instanceAbort = new AbortController();

    let offer: VastOffer;
    let bidPrice: number | null = null;

    if (config.useInterruptible) {
      logger.info(
        `Vast.ai: searching for interruptible ${config.gpuType} offers (max $${config.maxPricePerHour}/hr)...`
      );

      const interruptibleOffers = await searchOffers({
        apiKey: config.apiKey,
        gpuType: config.gpuType,
        maxPrice: config.maxPricePerHour,
        type: "bid",
      });

      if (interruptibleOffers.length > 0) {
        // Sort by price, pick cheapest
        interruptibleOffers.sort((a, b) => a.dph_total - b.dph_total);
        offer = interruptibleOffers[0];
        // Bid price: explicit override, or the offer's listed price (dph_total)
        bidPrice = config.bidPrice ?? offer.dph_total;
        this._isInterruptible = true;

        logger.info(
          `Vast.ai: selected interruptible offer ${offer.id} — ${offer.gpu_name} ` +
            `(${offer.gpu_ram}MB RAM, $${offer.dph_total.toFixed(3)}/hr, ` +
            `bid=$${bidPrice.toFixed(3)}/hr, min_bid=$${offer.min_bid?.toFixed(3) ?? "?"}/hr, ` +
            `reliability=${(offer.reliability * 100).toFixed(1)}%)`
        );
      } else {
        logger.warn(
          `Vast.ai: no interruptible offers found for ${config.gpuType}. Falling back to on-demand.`
        );
        // Fall through to on-demand search
        const onDemandOffers = await searchOffers({
          apiKey: config.apiKey,
          gpuType: config.gpuType,
          maxPrice: config.maxPricePerHour,
          type: "ondemand",
        });

        if (onDemandOffers.length === 0) {
          throw new Error(
            `Vast.ai: no ${config.gpuType} offers found under $${config.maxPricePerHour}/hr ` +
              `(tried both interruptible and on-demand). ` +
              `Try increasing VAST_MAX_PRICE_PER_HOUR or changing VAST_GPU_TYPE.`
          );
        }

        onDemandOffers.sort((a, b) => a.dph_total - b.dph_total);
        offer = onDemandOffers[0];
        bidPrice = null;
        this._isInterruptible = false;

        logger.info(
          `Vast.ai: selected on-demand offer ${offer.id} — ${offer.gpu_name} ` +
            `(${offer.gpu_ram}MB RAM, $${offer.dph_total.toFixed(3)}/hr, ` +
            `reliability=${(offer.reliability * 100).toFixed(1)}%)`
        );
      }
    } else {
      // Interruptible disabled — use on-demand directly
      logger.info(
        `Vast.ai: searching for on-demand ${config.gpuType} offers (max $${config.maxPricePerHour}/hr)...`
      );

      const offers = await searchOffers({
        apiKey: config.apiKey,
        gpuType: config.gpuType,
        maxPrice: config.maxPricePerHour,
        type: "ondemand",
      });

      if (offers.length === 0) {
        throw new Error(
          `Vast.ai: no ${config.gpuType} offers found under $${config.maxPricePerHour}/hr. ` +
            `Try increasing VAST_MAX_PRICE_PER_HOUR or changing VAST_GPU_TYPE.`
        );
      }

      offers.sort((a, b) => a.dph_total - b.dph_total);
      offer = offers[0];
      bidPrice = null;
      this._isInterruptible = false;

      logger.info(
        `Vast.ai: selected on-demand offer ${offer.id} — ${offer.gpu_name} ` +
          `(${offer.gpu_ram}MB RAM, $${offer.dph_total.toFixed(3)}/hr, ` +
          `reliability=${(offer.reliability * 100).toFixed(1)}%)`
      );
    }

    logger.info(
      `Vast.ai: creating instance with image ${config.dockerImage}...`
    );

    this.instanceId = await createInstance({
      apiKey: config.apiKey,
      offerId: offer.id,
      dockerImage: config.dockerImage,
      diskGb: config.diskGb,
      inferenceApiKey: config.inferenceApiKey,
      bidPrice,
    });

    logger.info(
      `Vast.ai: instance ${this.instanceId} created` +
        (this._isInterruptible ? " (interruptible)" : " (on-demand)") +
        `, waiting for it to start...`
    );

    const instance = await waitForRunning(config.apiKey, this.instanceId);
    this.endpointUrl = getEndpointUrl(instance);

    logger.info(
      `Vast.ai: instance ${this.instanceId} is running at ${this.endpointUrl}, ` +
        `waiting for inference server to load models...`
    );

    await waitForHealthy(this.endpointUrl);

    logger.info(
      `Vast.ai: ready! Instance ${this.instanceId} at ${this.endpointUrl}` +
        (this._isInterruptible ? " (interruptible)" : " (on-demand)")
    );

    // Start background health monitor for interruptible instances
    if (this._isInterruptible) {
      this.startHealthMonitor();
    }
  }

  /**
   * Destroy the Vast.ai instance and stop health monitoring. Safe to call multiple times.
   */
  async stop(): Promise<void> {
    this.stopHealthMonitor();

    if (this.instanceId === null) return;

    const id = this.instanceId;
    const apiKey = this.apiKey;
    this.instanceId = null;
    this.endpointUrl = null;

    if (!apiKey) {
      logger.warn(
        `Vast.ai: cannot destroy instance ${id} — API key not cached (start() may not have been called)`
      );
      return;
    }

    logger.info(`Vast.ai: destroying instance ${id}...`);
    await destroyInstance(apiKey, id);
    logger.info(`Vast.ai: instance ${id} destroyed.`);
  }

  /**
   * Re-provision after eviction: destroy current instance → provision a new one.
   * Resets the circuit breaker so analyze() calls resume.
   */
  async reprovision(): Promise<void> {
    logger.info("Vast.ai: reprovisioning — stopping current instance...");
    await this.stop();

    logger.info("Vast.ai: reprovisioning — starting new instance...");
    await this.start();

    logger.info("Vast.ai: reprovisioning complete.");
  }

  /**
   * Send an image to the running Vast.ai inference server for analysis.
   * Includes circuit breaker: aborts immediately if instance is dead.
   */
  async analyze(imageBuffer: Buffer): Promise<GpuAnalysisResult> {
    // Circuit breaker: fail fast if instance is dead
    if (this.instanceDead) {
      throw new InstanceDeadError(
        "Vast.ai instance is dead (evicted or failed) — call reprovision() to get a new instance"
      );
    }

    if (!this.endpointUrl) {
      throw new Error(
        "Vast.ai client is not started — call start() before analyze()"
      );
    }

    const url = `${this.endpointUrl}/analyze`;
    const body = JSON.stringify({ image: imageBuffer.toString("base64") });

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Check circuit breaker before each attempt
      if (this.instanceDead) {
        throw new InstanceDeadError(
          "Vast.ai instance died during retry — aborting"
        );
      }

      try {
        // Per-request timeout
        const timeoutController = new AbortController();
        const timeout = setTimeout(
          () => timeoutController.abort(),
          INFERENCE_TIMEOUT_MS
        );

        // Combine per-request timeout with instance-level abort signal
        const combinedSignal = AbortSignal.any([
          timeoutController.signal,
          this.instanceAbort.signal,
        ]);

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.inferenceApiKey}`,
          },
          body,
          signal: combinedSignal,
        });

        clearTimeout(timeout);

        if (response.ok) {
          return (await response.json()) as GpuAnalysisResult;
        }

        // 4xx = client error, don't retry
        if (response.status >= 400 && response.status < 500) {
          const text = await response.text().catch(() => "");
          throw new Error(
            `Vast.ai inference returned ${response.status}: ${text.substring(0, 200)}`
          );
        }

        // 5xx = server error, retry
        const text = await response.text().catch(() => "");
        lastError = new Error(
          `Vast.ai inference returned ${response.status}: ${text.substring(0, 200)}`
        );
        logger.warn(
          `Vast.ai inference failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${lastError.message}`
        );
      } catch (err) {
        if (err instanceof InstanceDeadError) {
          throw err;
        }
        if (err instanceof Error && err.name === "AbortError") {
          // Distinguish timeout vs instance abort
          if (this.instanceDead) {
            throw new InstanceDeadError(
              "Vast.ai instance died — all in-flight requests aborted"
            );
          }
          lastError = new Error(
            `Vast.ai inference timed out after ${INFERENCE_TIMEOUT_MS}ms`
          );
        } else if (
          err instanceof Error &&
          err.message.startsWith("Vast.ai inference returned 4")
        ) {
          throw err;
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
        logger.warn(
          `Vast.ai inference error (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${lastError.message}`
        );
      }
    }

    throw lastError ?? new Error("Vast.ai inference request failed");
  }

  // -------------------------------------------------------------------------
  // Health monitor — background poller to detect evictions
  // -------------------------------------------------------------------------

  /**
   * Start polling the instance status every 10s.
   * If the instance is no longer running (evicted), sets instanceDead and
   * aborts all in-flight analyze() requests immediately.
   */
  private startHealthMonitor(): void {
    if (this.healthMonitorTimer) return; // already running

    logger.info(
      `Vast.ai: starting health monitor for instance ${this.instanceId} (every ${HEALTH_MONITOR_INTERVAL_MS / 1000}s)`
    );

    this.healthMonitorTimer = setInterval(async () => {
      if (this.instanceId === null || this.instanceDead) {
        this.stopHealthMonitor();
        return;
      }

      try {
        const instance = await getInstance(this.apiKey, this.instanceId);

        if (!instance) {
          logger.error(
            `Vast.ai health monitor: instance ${this.instanceId} not found — marking as dead`
          );
          this.markInstanceDead("instance not found (404)");
          return;
        }

        if (
          instance.actual_status !== "running" &&
          instance.intended_status === "running"
        ) {
          // Involuntary stop = evicted by on-demand or higher bidder
          logger.error(
            `Vast.ai health monitor: instance ${this.instanceId} evicted! ` +
              `actual_status=${instance.actual_status}, ` +
              `intended_status=${instance.intended_status}, ` +
              `status_msg=${instance.status_msg}`
          );
          this.markInstanceDead(
            `evicted (actual_status=${instance.actual_status})`
          );
          return;
        }

        if (
          instance.actual_status === "exited" ||
          instance.cur_state === "error"
        ) {
          logger.error(
            `Vast.ai health monitor: instance ${this.instanceId} in error state: ${instance.status_msg}`
          );
          this.markInstanceDead(
            `error state (${instance.cur_state}: ${instance.status_msg})`
          );
          return;
        }

        // Instance is healthy — no log (too noisy at 10s interval)
      } catch (err) {
        // API call failed — don't mark as dead for transient API errors
        logger.warn(
          `Vast.ai health monitor: API error checking instance ${this.instanceId}: ${err instanceof Error ? err.message : err}`
        );
      }
    }, HEALTH_MONITOR_INTERVAL_MS);
  }

  /**
   * Stop the background health monitor.
   */
  private stopHealthMonitor(): void {
    if (this.healthMonitorTimer) {
      clearInterval(this.healthMonitorTimer);
      this.healthMonitorTimer = null;
    }
  }

  /**
   * Mark the instance as dead: set the flag and abort all in-flight requests.
   */
  private markInstanceDead(reason: string): void {
    if (this.instanceDead) return; // already marked

    logger.error(`Vast.ai: instance marked as dead — ${reason}`);
    this.instanceDead = true;
    this.instanceAbort.abort();
    this.stopHealthMonitor();
  }
}

// ---------------------------------------------------------------------------
// Custom error for circuit breaker — lets processor.ts distinguish eviction
// from other errors
// ---------------------------------------------------------------------------

export class InstanceDeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceDeadError";
  }
}
