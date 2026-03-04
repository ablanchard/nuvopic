/**
 * Modal GPU client — implements GpuClient for Modal's serverless GPU endpoint.
 *
 * Modal is always-on (scale-to-zero managed by Modal itself), so start/stop
 * are no-ops. The analyze() method sends a base64-encoded image via HTTP POST.
 */

import { logger } from "../logger.js";
import type { GpuClient, GpuAnalysisResult } from "./gpu-client.js";

export { type GpuAnalysisResult } from "./gpu-client.js";

const MODAL_TIMEOUT_MS = 30_000; // 30s — accounts for cold start + inference
const MAX_RETRIES = 1; // Retry once on 5xx / network errors

// ---------------------------------------------------------------------------
// Legacy exports (kept for backward compatibility)
// ---------------------------------------------------------------------------

/** @deprecated Use GpuAnalysisResult instead. */
export type ModalAnalysisResult = GpuAnalysisResult;

/** @deprecated Use getRealtimeGpuProvider() / getBatchGpuProvider() instead. */
export function isModalEnabled(): boolean {
  const mode = process.env.PROCESSING_MODE?.toLowerCase();
  if (mode === "local") return false;
  if (mode === "modal") return true;
  // Auto-detect: use Modal if endpoint is configured
  return !!process.env.MODAL_ENDPOINT_URL;
}

/** @deprecated Use createGpuClient("modal").analyze() instead. */
export async function analyzeWithModal(
  imageBuffer: Buffer
): Promise<GpuAnalysisResult> {
  const client = new ModalGpuClient();
  return client.analyze(imageBuffer);
}

// ---------------------------------------------------------------------------
// ModalGpuClient
// ---------------------------------------------------------------------------

export class ModalGpuClient implements GpuClient {
  readonly provider = "modal" as const;
  readonly isInterruptible = false;

  async start(): Promise<void> {
    // No-op: Modal manages container lifecycle (scale-to-zero).
  }

  async stop(): Promise<void> {
    // No-op: Modal manages container lifecycle.
  }

  async reprovision(): Promise<void> {
    // No-op: Modal manages container lifecycle.
  }

  async analyze(imageBuffer: Buffer): Promise<GpuAnalysisResult> {
    const endpointUrl = process.env.MODAL_ENDPOINT_URL;
    if (!endpointUrl) {
      throw new Error("MODAL_ENDPOINT_URL is not configured");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Modal proxy auth headers (required when requires_proxy_auth=True)
    const proxyKey = process.env.MODAL_PROXY_KEY;
    const proxySecret = process.env.MODAL_PROXY_SECRET;
    if (proxyKey && proxySecret) {
      headers["Modal-Key"] = proxyKey;
      headers["Modal-Secret"] = proxySecret;
    }

    const body = JSON.stringify({ image: imageBuffer.toString("base64") });

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), MODAL_TIMEOUT_MS);

        const response = await fetch(endpointUrl, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok) {
          const result = (await response.json()) as GpuAnalysisResult;
          return result;
        }

        // 4xx = client error, don't retry
        if (response.status >= 400 && response.status < 500) {
          const text = await response.text().catch(() => "");
          throw new Error(
            `Modal returned ${response.status}: ${text.substring(0, 200)}`
          );
        }

        // 5xx = server error, retry
        const text = await response.text().catch(() => "");
        lastError = new Error(
          `Modal returned ${response.status}: ${text.substring(0, 200)}`
        );
        logger.warn(
          `Modal request failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${lastError.message}`
        );
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          lastError = new Error(
            `Modal request timed out after ${MODAL_TIMEOUT_MS}ms`
          );
        } else if (
          err instanceof Error &&
          err.message.startsWith("Modal returned 4")
        ) {
          // 4xx errors — don't retry
          throw err;
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
        logger.warn(
          `Modal request error (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${lastError.message}`
        );
      }
    }

    throw lastError ?? new Error("Modal request failed");
  }
}
