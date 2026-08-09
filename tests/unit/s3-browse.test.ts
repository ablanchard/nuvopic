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
  getFolderImageCounts,
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

  it("counts each immediate folder recursively in one paginated scan", async () => {
    sendMock
      .mockResolvedValueOnce({
        Contents: [
          { Key: "Photos/cover.jpg" },
          { Key: "Photos/2025/january/one.jpg" },
          { Key: "Photos/2025/february/two.webp" },
          { Key: "Photos/notes.txt" },
        ],
        NextContinuationToken: "count-page-2",
      })
      .mockResolvedValueOnce({
        Contents: [
          { Key: "Photos/2025/march/three.heic" },
          { Key: "Photos/2026/four.png" },
        ],
      });

    const result = await getFolderImageCounts("test-bucket", "Photos/");

    expect(result).toEqual({
      prefix: "Photos/",
      imageCount: 1,
      folders: [
        { prefix: "Photos/2025/", imageCount: 3 },
        { prefix: "Photos/2026/", imageCount: 1 },
      ],
    });
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0][0].input.Delimiter).toBeUndefined();
    expect(sendMock.mock.calls[1][0].input).toMatchObject({
      Prefix: "Photos/",
      ContinuationToken: "count-page-2",
    });
  });

  it("reuses an in-flight count scan unless refresh is requested", async () => {
    sendMock.mockResolvedValue({ Contents: [{ Key: "Photos/2026/one.jpg" }] });

    const first = getFolderImageCounts("test-bucket", "Photos/");
    const second = getFolderImageCounts("test-bucket", "Photos/");
    await Promise.all([first, second]);

    expect(sendMock).toHaveBeenCalledTimes(1);

    await getFolderImageCounts("test-bucket", "Photos/", true);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});
