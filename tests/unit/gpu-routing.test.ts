import { afterEach, describe, expect, it } from "vitest";
import {
  getGpuProviderBatchThreshold,
  selectBatchGpuProvider,
} from "../../src/extractors/gpu-client.js";
import { getGpuMeteringMode } from "../../src/config/runtime.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function configureBothProviders(): void {
  process.env.PROCESSING_MODE = "modal";
  process.env.BATCH_GPU_PROVIDER = "modal";
  process.env.MODAL_ENDPOINT_URL = "https://example--nuvopic-analyze.modal.run";
  process.env.VAST_API_KEY = "test";
  process.env.VAST_DOCKER_IMAGE = "example/nuvopic:latest";
  process.env.VAST_INFERENCE_API_KEY = "test";
  process.env.GPU_PROVIDER_ROUTING_ENABLED = "true";
}

describe("volume-based GPU provider routing", () => {
  it("routes exactly 500 photos to Modal and 501 to Vast.ai", () => {
    configureBothProviders();
    process.env.GPU_PROVIDER_BATCH_THRESHOLD = "500";

    expect(selectBatchGpuProvider(500, "all")).toBe("modal");
    expect(selectBatchGpuProvider(501, "all")).toBe("vastai");
  });

  it("uses no hosted provider when GPU work is skipped", () => {
    configureBothProviders();
    expect(selectBatchGpuProvider(10_000, "skip")).toBe("local");
  });

  it("keeps explicitly local installations local", () => {
    configureBothProviders();
    process.env.BATCH_GPU_PROVIDER = "local";
    expect(selectBatchGpuProvider(501, "all")).toBe("local");
  });

  it("supports a configurable positive threshold", () => {
    configureBothProviders();
    process.env.GPU_PROVIDER_BATCH_THRESHOLD = "25";
    expect(getGpuProviderBatchThreshold()).toBe(25);
    expect(selectBatchGpuProvider(25, "faces-only")).toBe("modal");
    expect(selectBatchGpuProvider(26, "faces-only")).toBe("vastai");
  });
});

describe("standalone GPU inference", () => {
  it("does not require SaaS metering configuration", () => {
    delete process.env.DEPLOY_MODE;
    delete process.env.GPU_METERING_URL;
    delete process.env.GPU_METERING_SERVICE_TOKEN;

    expect(getGpuMeteringMode()).toBe("disabled");

    configureBothProviders();
    expect(selectBatchGpuProvider(100, "all")).toBe("modal");
    expect(selectBatchGpuProvider(1_000, "all")).toBe("vastai");
  });

  it("cannot accidentally enforce SaaS metering in standalone mode", () => {
    process.env.DEPLOY_MODE = "standalone";
    process.env.GPU_METERING_MODE = "enforce";
    process.env.GPU_METERING_URL = "https://saas.example.test";
    process.env.GPU_METERING_SERVICE_TOKEN = "test";

    expect(getGpuMeteringMode()).toBe("disabled");
  });
});
