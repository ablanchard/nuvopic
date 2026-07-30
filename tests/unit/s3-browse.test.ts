import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();

  return {
    ...actual,
    S3Client: class {
      send = sendMock;
      destroy() {}
    },
  };
});

vi.mock("../../src/db/settings.js", () => ({
  getResolvedS3Config: vi.fn(async () => ({
    bucket: "test-bucket",
    region: "test-region",
    endpoint: null,
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret",
    forcePathStyle: false,
  })),
}));

vi.mock("../../src/db/client.js", () => ({
  getCurrentDatabaseCacheKey: () => "s3-browse-test",
}));

import {
  browseFolder,
  invalidateAllS3Clients,
} from "../../src/s3/client.js";

describe("browseFolder", () => {
  beforeEach(() => {
    sendMock.mockReset();
    invalidateAllS3Clients();
  });

  it("returns one folder level without recursively listing subfolders", async () => {
    sendMock.mockResolvedValue({
      CommonPrefixes: [
        { Prefix: "Photos/2025/" },
        { Prefix: "Photos/2026/" },
      ],
      Contents: [
        { Key: "Photos/cover.jpg" },
        { Key: "Photos/readme.txt" },
      ],
      IsTruncated: false,
    });

    const result = await browseFolder("test-bucket", "Photos/");

    expect(result).toEqual({
      folders: [
        { prefix: "Photos/2025/", name: "2025" },
        { prefix: "Photos/2026/", name: "2026" },
      ],
      imageCount: 1,
      imageKeys: ["Photos/cover.jpg"],
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].input).toMatchObject({
      Bucket: "test-bucket",
      Prefix: "Photos/",
      Delimiter: "/",
      MaxKeys: 1000,
    });
  });

  it("only follows delimiter-list pagination", async () => {
    sendMock
      .mockResolvedValueOnce({
        CommonPrefixes: [{ Prefix: "Photos/2025/" }],
        NextContinuationToken: "next-page",
      })
      .mockResolvedValueOnce({
        CommonPrefixes: [{ Prefix: "Photos/2026/" }],
        Contents: [{ Key: "Photos/latest.webp" }],
      });

    const result = await browseFolder("test-bucket", "Photos/");

    expect(result.folders).toHaveLength(2);
    expect(result.imageKeys).toEqual(["Photos/latest.webp"]);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[1][0].input).toMatchObject({
      Delimiter: "/",
      ContinuationToken: "next-page",
    });
  });
});
