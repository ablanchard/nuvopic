/**
 * Generic GPU client abstraction for NuvoPic inference.
 *
 * Provides a provider-agnostic interface so processor.ts doesn't need to
 * know whether inference runs on Modal, Vast.ai, or any other GPU backend.
 */

import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Shared result type (same shape regardless of provider)
// ---------------------------------------------------------------------------

export interface GpuAnalysisResult {
  caption: string;
  faces: Array<{
    bbox: { x: number; y: number; width: number; height: number };
    embedding: number[];
    confidence: number;
  }>;
}

// ---------------------------------------------------------------------------
// GPU client interface
// ---------------------------------------------------------------------------

export interface GpuClient {
  /** Human-readable provider name (for logging). */
  readonly provider: string;

  /**
   * Analyze an image: generate a caption + detect faces.
   * The image is sent as a raw Buffer (the client handles encoding).
   */
  analyze(imageBuffer: Buffer): Promise<GpuAnalysisResult>;

  /**
   * Provision / start the GPU backend (if needed).
   * No-op for always-on providers like Modal.
   */
  start(): Promise<void>;

  /**
   * Tear down / destroy the GPU backend (if needed).
   * No-op for always-on providers like Modal.
   * MUST be safe to call multiple times or after a failed start().
   */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

export type GpuProvider = "modal" | "vastai" | "local";

/** Which GPU provider is configured for real-time (single-photo) processing. */
export function getRealtimeGpuProvider(): GpuProvider {
  const mode = process.env.PROCESSING_MODE?.toLowerCase();
  if (mode === "local") return "local";
  if (mode === "modal") return "modal";
  if (mode === "vastai") {
    logger.warn(
      "PROCESSING_MODE=vastai is not supported for realtime processing " +
        "(each photo would provision a new instance). Falling back to local. " +
        "Use BATCH_GPU_PROVIDER=vastai instead for batch operations."
    );
    return "local";
  }
  // Auto-detect: use Modal if endpoint is configured, otherwise local
  if (process.env.MODAL_ENDPOINT_URL) return "modal";
  return "local";
}

/** Which GPU provider to use for batch processing (import / reprocess). */
export function getBatchGpuProvider(): GpuProvider {
  const batch = process.env.BATCH_GPU_PROVIDER?.toLowerCase();
  if (batch === "vastai") return "vastai";
  if (batch === "modal") return "modal";
  if (batch === "local") return "local";
  // Default: same as realtime provider
  return getRealtimeGpuProvider();
}

/** Whether *any* GPU provider is enabled (vs. local-only CPU mode). */
export function isGpuEnabled(): boolean {
  return getRealtimeGpuProvider() !== "local";
}

// ---------------------------------------------------------------------------
// Factory — lazy imports to avoid pulling in unused dependencies
// ---------------------------------------------------------------------------

/** Create a GPU client for the given provider. */
export async function createGpuClient(
  provider: GpuProvider
): Promise<GpuClient> {
  switch (provider) {
    case "modal": {
      const { ModalGpuClient } = await import("./modal-client.js");
      return new ModalGpuClient();
    }
    case "vastai": {
      const { VastGpuClient } = await import("./vast-client.js");
      return new VastGpuClient();
    }
    case "local":
      throw new Error(
        "Cannot create GPU client for 'local' provider — use local extractors directly"
      );
    default:
      throw new Error(`Unknown GPU provider: ${provider}`);
  }
}

// ---------------------------------------------------------------------------
// Convenience: get a ready-to-use client for realtime or batch
// ---------------------------------------------------------------------------

export async function createRealtimeGpuClient(): Promise<GpuClient> {
  const provider = getRealtimeGpuProvider();
  logger.info(`Creating realtime GPU client: ${provider}`);
  return createGpuClient(provider);
}

export async function createBatchGpuClient(): Promise<GpuClient> {
  const provider = getBatchGpuProvider();
  logger.info(`Creating batch GPU client: ${provider}`);
  return createGpuClient(provider);
}
