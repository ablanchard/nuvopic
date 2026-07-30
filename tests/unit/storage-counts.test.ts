import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("../../src/db/client.js", () => ({
  query: queryMock,
}));

import { countImportedByPrefixes } from "../../src/db/queries.js";

describe("countImportedByPrefixes", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("counts all prefixes in one database query", async () => {
    queryMock.mockResolvedValue({
      rows: [
        { prefix: "s3://bucket/Photos/", count: "12" },
        { prefix: "s3://bucket/Videos/", count: "0" },
      ],
    });

    const result = await countImportedByPrefixes([
      "s3://bucket/Photos/",
      "s3://bucket/Videos/",
    ]);

    expect(result).toEqual(
      new Map([
        ["s3://bucket/Photos/", 12],
        ["s3://bucket/Videos/", 0],
      ])
    );
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("escapes LIKE metacharacters in S3 folder names", async () => {
    queryMock.mockResolvedValue({ rows: [] });

    await countImportedByPrefixes(["s3://bucket/100%_photos\\/"]);

    expect(queryMock.mock.calls[0][1]).toEqual([
      ["s3://bucket/100%_photos\\/"],
      ["s3://bucket/100\\%\\_photos\\\\/%"],
    ]);
  });
});
