import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculateProtectedBidPrice,
  destroyVastInstanceById,
  shouldUseInterruptibleAllocation,
} from "../../src/extractors/vast-client.js";

describe("Vast.ai resource cleanup", () => {
  const originalApiKey = process.env.VAST_API_KEY;

  beforeEach(() => {
    process.env.VAST_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env.VAST_API_KEY;
    else process.env.VAST_API_KEY = originalApiKey;
  });

  it("treats an already-removed instance as cleaned", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(destroyVastInstanceById(123, 1)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://console.vast.ai/api/v0/instances/123/",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("retries a transient provider failure", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const cleanup = destroyVastInstanceById(456, 2);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(cleanup).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a terminal cleanup failure for durable retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("provider unavailable", { status: 503 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(destroyVastInstanceById(789, 1)).rejects.toThrow(
      "Vast.ai destroy instance failed (503)"
    );
  });
});

describe("Vast.ai reclamation protection", () => {
  it("raises a stale configured bid above the current minimum", () => {
    expect(
      calculateProtectedBidPrice({
        configuredBid: 0.1,
        listedPrice: 0.135,
        minimumBid: 0.133,
        marginPercent: 10,
        maximumPrice: 0.3,
      })
    ).toBeCloseTo(0.1463);
  });

  it("falls back to on-demand after the configured spot allocation count", () => {
    expect(shouldUseInterruptibleAllocation(true, 0, 1)).toBe(true);
    expect(shouldUseInterruptibleAllocation(true, 1, 1)).toBe(false);
  });
});
