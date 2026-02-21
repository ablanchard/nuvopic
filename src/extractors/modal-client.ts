import { logger } from "../logger.js";

export interface ModalAnalysisResult {
  caption: string;
  faces: Array<{
    bbox: { x: number; y: number; width: number; height: number };
    embedding: number[];
    confidence: number;
  }>;
}

const MODAL_TIMEOUT_MS = 30_000; // 30s — accounts for cold start + inference
const MAX_RETRIES = 1; // Retry once on 5xx / network errors

/**
 * Send an image to the Modal GPU endpoint for captioning + face detection.
 * Returns { caption, faces } on success.
 * Throws on unrecoverable errors (4xx, timeout after retries, missing config).
 */
export async function analyzeWithModal(
  imageBuffer: Buffer
): Promise<ModalAnalysisResult> {
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
        const result = (await response.json()) as ModalAnalysisResult;
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

/**
 * Check whether Modal processing is enabled via PROCESSING_MODE env var.
 * Defaults to "modal" if MODAL_ENDPOINT_URL is set, otherwise "local".
 */
export function isModalEnabled(): boolean {
  const mode = process.env.PROCESSING_MODE?.toLowerCase();
  if (mode === "local") return false;
  if (mode === "modal") return true;
  // Auto-detect: use Modal if endpoint is configured
  return !!process.env.MODAL_ENDPOINT_URL;
}
