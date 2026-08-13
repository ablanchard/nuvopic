import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clientQuery: vi.fn(),
}));

vi.mock("../../src/db/client.js", () => ({
  query: vi.fn(),
  runWithWorkspaceContext: vi.fn(),
  withTransaction: vi.fn(async (operation: (client: unknown) => Promise<unknown>) =>
    operation({ query: mocks.clientQuery })
  ),
}));

vi.mock("../../src/processor.js", () => ({
  processPhotoBatch: vi.fn(),
}));

import { enqueueManualImportJob } from "../../src/jobs/manual-import-jobs.js";

describe("durable manual import enqueue", () => {
  beforeEach(() => {
    mocks.clientQuery.mockReset();
  });

  it("snapshots the parent log, job, and every object in one transaction", async () => {
    const createdAt = new Date("2026-08-12T20:00:00Z");
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [{ id: "log-1" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "job-1",
            gpu_log_id: "log-1",
            bucket: "photos",
            prefix: "Camera/",
            sort: "recent",
            gpu_mode: "all",
            provider: "vastai",
            status: "pending",
            total_images: 5,
            already_imported: 2,
            photo_count: 2,
            photos_succeeded: 0,
            photos_failed: 0,
            attempts: 0,
            last_error: null,
            created_at: createdAt,
            started_at: null,
            completed_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const job = await enqueueManualImportJob({
      bucket: "photos",
      prefix: "Camera/",
      sort: "recent",
      gpuMode: "all",
      provider: "vastai",
      totalImages: 5,
      alreadyImported: 2,
      objectKeys: ["Camera/a.jpg", "Camera/b.jpg"],
    });

    expect(job).toMatchObject({
      id: "job-1",
      gpuLogId: "log-1",
      status: "pending",
      photoCount: 2,
      remaining: 1,
    });
    expect(mocks.clientQuery).toHaveBeenCalledTimes(3);
    const itemParameters = mocks.clientQuery.mock.calls[2][1] as [string, string];
    expect(JSON.parse(itemParameters[1])).toEqual([
      { object_key: "Camera/a.jpg", s3_path: "s3://photos/Camera/a.jpg" },
      { object_key: "Camera/b.jpg", s3_path: "s3://photos/Camera/b.jpg" },
    ]);
  });

  it("rejects an empty snapshot", async () => {
    await expect(
      enqueueManualImportJob({
        bucket: "photos",
        prefix: "",
        sort: "recent",
        gpuMode: "skip",
        provider: "local",
        totalImages: 0,
        alreadyImported: 0,
        objectKeys: [],
      })
    ).rejects.toThrow("Cannot enqueue an empty manual import job");
    expect(mocks.clientQuery).not.toHaveBeenCalled();
  });
});
