import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTION_VERSION, FACES_VERSION, PROCESS_VERSION } from "../../src/version.js";

const state = vi.hoisted(() => ({
  events: [] as string[],
  photos: new Map<string, Record<string, unknown>>(),
  caption: vi.fn(),
  faces: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  reprovision: vi.fn(),
  extractExif: vi.fn(),
  placeholder: vi.fn(),
  queueStageLogs: vi.fn(),
  startStageLog: vi.fn(),
  completeStageLog: vi.fn(),
  failStageLog: vi.fn(),
}));

vi.mock("../../src/s3/client.js", () => ({
  getS3Path: (bucket: string, key: string) => `s3://${bucket}/${key}`,
  getObjectAsBuffer: vi.fn(async (_bucket: string, key: string) => {
    state.events.push(`download:${key}`);
    return Buffer.from(key);
  }),
}));

vi.mock("sharp", () => ({
  default: vi.fn(() => ({ metadata: vi.fn().mockResolvedValue({ width: 10, height: 20 }) })),
}));

vi.mock("../../src/extractors/index.js", () => ({
  extractExif: state.extractExif,
  generatePlaceholder: state.placeholder,
  generateCaption: vi.fn(),
  detectFaces: vi.fn(),
  resolvePhotoDate: (takenAt: Date | null) => ({
    takenAt,
    precision: takenAt ? "exact" : "unknown",
    source: takenAt ? "exif" : "unknown",
  }),
  resolveLocation: vi.fn(() => null),
}));

const gpuClient = {
  provider: "vastai" as const,
  isInterruptible: true,
  start: state.start,
  stop: state.stop,
  reprovision: state.reprovision,
  caption: state.caption,
  faces: state.faces,
  analyze: vi.fn(),
  setMeteringContext: vi.fn(),
  setResourceLifecycleHandlers: vi.fn(),
  drainResourceUsage: vi.fn(() => []),
};

vi.mock("../../src/extractors/gpu-client.js", () => ({
  isGpuEnabled: vi.fn(() => true),
  getRealtimeGpuProvider: vi.fn(() => "vastai"),
  getGpuProviderBatchThreshold: vi.fn(() => 500),
  GPU_ROUTING_POLICY_VERSION: "test",
  selectBatchGpuProvider: vi.fn(() => "vastai"),
  createGpuClient: vi.fn(async () => gpuClient),
}));

vi.mock("../../src/db/queries.js", () => ({
  getPhotoByS3Path: vi.fn(async (s3Path: string) => state.photos.get(s3Path) ?? null),
  insertPhoto: vi.fn(async (params: Record<string, unknown>) => {
    const s3Path = params.s3Path as string;
    state.events.push(`cpu-commit:${s3Path}`);
    const previous = state.photos.get(s3Path) ?? {};
    const photo = {
      id: previous.id ?? `id-${s3Path}`,
      s3_path: s3Path,
      taken_at: params.takenAt ?? null,
      taken_at_precision: params.takenAtPrecision ?? "unknown",
      taken_at_source: params.takenAtSource ?? "unknown",
      location_lat: params.locationLat ?? null,
      location_lng: params.locationLng ?? null,
      location_name: params.locationName ?? null,
      location_region: params.locationRegion ?? null,
      location_country: params.locationCountry ?? null,
      description: previous.description ?? null,
      placeholder: params.placeholder ?? previous.placeholder ?? null,
      width: params.width ?? previous.width ?? null,
      height: params.height ?? previous.height ?? null,
      process_version: params.processVersion ?? previous.process_version ?? null,
      caption_version: previous.caption_version ?? null,
      faces_version: previous.faces_version ?? null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    state.photos.set(s3Path, photo);
    return photo.id;
  }),
  updatePhotoGpuFields: vi.fn(async (params: Record<string, unknown>) => {
    const s3Path = params.s3Path as string;
    const photo = state.photos.get(s3Path)!;
    if (params.updateCaption) {
      photo.description = params.description;
      photo.caption_version = params.captionVersion;
    }
    if (params.updateFacesVersion) photo.faces_version = params.facesVersion;
    return photo.id as string;
  }),
  deleteFacesByPhotoId: vi.fn(),
  insertFace: vi.fn(async () => "face-id"),
}));

vi.mock("../../src/metering/gpu-metering.js", () => ({
  beginMeteredGpuJob: vi.fn(async () => null),
  completeMeteredGpuJob: vi.fn(),
  recordGpuOperationUsage: vi.fn(),
  recordGpuResourceUsage: vi.fn(),
}));

vi.mock("../../src/db/gpu-logs.js", () => ({
  safeQueuePhotoStageLogs: state.queueStageLogs,
  safeStartPhotoStageLog: state.startStageLog,
  safeCompleteGpuLog: state.completeStageLog,
  safeFailGpuLog: state.failStageLog,
}));

vi.mock("../../src/jobs/gpu-resource-leases.js", () => ({
  createGpuResourceLifecycleHandlers: vi.fn(() => ({})),
  renewGpuResourceLeases: vi.fn(),
}));

vi.mock("../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { processPhotoBatch } from "../../src/processor.js";

describe("processor CPU/GPU phase checkpoints", () => {
  beforeEach(() => {
    state.events.length = 0;
    state.photos.clear();
    vi.clearAllMocks();
    state.extractExif.mockResolvedValue({ takenAt: null, location: null });
    state.placeholder.mockResolvedValue("placeholder");
    state.start.mockImplementation(async () => state.events.push("gpu-start"));
    state.stop.mockResolvedValue(undefined);
    state.reprovision.mockResolvedValue(undefined);
    state.caption.mockResolvedValue({ caption: "caption" });
    state.faces.mockResolvedValue({ faces: [] });
    state.queueStageLogs.mockImplementation(async (input: { type: string; s3Paths: string[] }) =>
      new Map(input.s3Paths.map((path) => [path, {
        id: `${input.type}:${path}`,
        status: "queued",
      }]))
    );
    state.startStageLog.mockImplementation(async (ref?: { status: string }) => {
      if (!ref || ref.status === "completed") return false;
      ref.status = "running";
      return true;
    });
  });

  it("commits every CPU checkpoint before starting the GPU", async () => {
    await processPhotoBatch([
      { s3Bucket: "bucket", s3Key: "a.jpg", gpuMode: "all" },
      { s3Bucket: "bucket", s3Key: "b.jpg", gpuMode: "all" },
    ]);

    const gpuStart = state.events.indexOf("gpu-start");
    expect(gpuStart).toBeGreaterThan(state.events.indexOf("cpu-commit:s3://bucket/a.jpg"));
    expect(gpuStart).toBeGreaterThan(state.events.indexOf("cpu-commit:s3://bucket/b.jpg"));
  });

  it("resumes only a missing GPU sub-stage without repeating CPU or caption", async () => {
    state.photos.set("s3://bucket/a.jpg", {
      id: "photo-id",
      s3_path: "s3://bucket/a.jpg",
      taken_at: null,
      taken_at_precision: "unknown",
      taken_at_source: "unknown",
      location_lat: null,
      location_lng: null,
      location_name: null,
      location_region: null,
      location_country: null,
      description: "existing caption",
      placeholder: "existing",
      width: 10,
      height: 20,
      process_version: PROCESS_VERSION,
      caption_version: CAPTION_VERSION,
      faces_version: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const [result] = await processPhotoBatch([
      { s3Bucket: "bucket", s3Key: "a.jpg", gpuMode: "all" },
    ]);

    expect(state.extractExif).not.toHaveBeenCalled();
    expect(state.caption).not.toHaveBeenCalled();
    expect(state.faces).toHaveBeenCalledOnce();
    expect(result.gpuStatus).toBe("completed");
    expect(state.photos.get("s3://bucket/a.jpg")?.faces_version).toBe(FACES_VERSION);
  });

  it("preserves a successful caption and retries only faces after reclamation", async () => {
    state.faces
      .mockRejectedValueOnce(new Error("Vast.ai instance is dead (evicted or failed)"))
      .mockResolvedValueOnce({ faces: [] });

    const [result] = await processPhotoBatch([
      { s3Bucket: "bucket", s3Key: "a.jpg", gpuMode: "all" },
    ]);

    expect(state.reprovision).toHaveBeenCalledOnce();
    expect(state.caption).toHaveBeenCalledOnce();
    expect(state.faces).toHaveBeenCalledTimes(2);
    expect(result.gpuStatus).toBe("completed");
  });

  it("does not reprovision for a permanent invalid-image response", async () => {
    state.caption.mockRejectedValueOnce(
      new Error('Vast.ai inference returned 400: {"error":"Could not decode image from provided bytes"}')
    );
    state.faces.mockRejectedValueOnce(
      new Error('Vast.ai inference returned 400: {"error":"Could not decode image from provided bytes"}')
    );

    const [result] = await processPhotoBatch([
      { s3Bucket: "bucket", s3Key: "invalid.jpg", gpuMode: "all" },
    ]);

    expect(state.reprovision).not.toHaveBeenCalled();
    expect(result.gpuStatus).toBe("failed");
    expect(result.gpuRetryable).toBe(false);
  });

  it("records separate CPU, caption, and faces child operations", async () => {
    await processPhotoBatch(
      [{ s3Bucket: "bucket", s3Key: "a.jpg", gpuMode: "all" }],
      undefined,
      "group-log-id"
    );

    expect(state.queueStageLogs).toHaveBeenCalledWith(
      expect.objectContaining({ type: "cpu-import", s3Paths: ["s3://bucket/a.jpg"] })
    );
    expect(state.queueStageLogs).toHaveBeenCalledWith(
      expect.objectContaining({ type: "caption", s3Paths: ["s3://bucket/a.jpg"] })
    );
    expect(state.queueStageLogs).toHaveBeenCalledWith(
      expect.objectContaining({ type: "faces", s3Paths: ["s3://bucket/a.jpg"] })
    );
    expect(state.completeStageLog).toHaveBeenCalledWith("cpu-import:s3://bucket/a.jpg");
    expect(state.completeStageLog).toHaveBeenCalledWith("caption:s3://bucket/a.jpg");
    expect(state.completeStageLog).toHaveBeenCalledWith("faces:s3://bucket/a.jpg");
  });
});
