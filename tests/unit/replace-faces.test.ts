import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, withTransactionMock, clientQuery } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withTransactionMock: vi.fn(),
  clientQuery: vi.fn(),
}));

vi.mock("../../src/db/client.js", () => ({
  query: queryMock,
  withTransaction: withTransactionMock,
}));

import { replaceFacesForPhoto } from "../../src/db/queries.js";

describe("replaceFacesForPhoto", () => {
  beforeEach(() => {
    queryMock.mockReset();
    clientQuery.mockReset();
    withTransactionMock.mockReset();
    withTransactionMock.mockImplementation(async (operation) =>
      operation({ query: clientQuery })
    );
  });

  it("updates a spatially matched face in place to preserve curation", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "face-1",
            bounding_box: { x: 10, y: 10, width: 100, height: 100 },
            cluster_id: "cluster-1",
          },
        ],
      });
    clientQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    const embedding = Array.from({ length: 512 }, (_, index) => index / 512);

    await replaceFacesForPhoto("photo-1", [
      {
        boundingBox: { x: 12, y: 11, width: 98, height: 101 },
        embedding,
        confidence: 0.99,
      },
    ]);

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE faces"),
      expect.arrayContaining(["face-1"])
    );
    expect(
      clientQuery.mock.calls.some(([sql]) =>
        String(sql).startsWith("DELETE FROM faces WHERE id")
      )
    ).toBe(false);
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE face_clusters"),
      [["cluster-1"]]
    );
  });

  it("rejects incompatible embedding dimensions before persistence", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(
      replaceFacesForPhoto("photo-1", [
        {
          boundingBox: { x: 0, y: 0, width: 10, height: 10 },
          embedding: [1, 2, 3],
          confidence: 0.9,
        },
      ])
    ).rejects.toThrow("exactly 512 finite values");
  });
});
