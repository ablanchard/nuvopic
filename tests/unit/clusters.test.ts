import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, withTransactionMock, settingsMock, clientQuery } = vi.hoisted(
  () => ({
    queryMock: vi.fn(),
    withTransactionMock: vi.fn(),
    settingsMock: vi.fn(),
    clientQuery: vi.fn(),
  })
);

vi.mock("../../src/db/client.js", () => ({
  query: queryMock,
  withTransaction: withTransactionMock,
}));

vi.mock("../../src/db/settings.js", () => ({
  getFaceQualitySettings: settingsMock,
  faceQualityFilter: () => "TRUE",
}));

import {
  assignFaceToCluster,
  clusterUnassignedFaces,
  getMergeSuggestions,
  mergeClusters,
  removeFaceFromCluster,
} from "../../src/db/clusters.js";

describe("face cluster integrity", () => {
  beforeEach(() => {
    queryMock.mockReset();
    clientQuery.mockReset();
    withTransactionMock.mockReset();
    settingsMock.mockReset();
    settingsMock.mockResolvedValue({ minConfidence: 0.7, minSize: 2500 });
    withTransactionMock.mockImplementation(async (operation) =>
      operation({ query: clientQuery })
    );
  });

  it("copies a named cluster's person and excludes same-photo matches", async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT f.id, f.photo_id")) {
        return {
          rows: [{ id: "face-1", photo_id: "photo-1", embedding: "[1,0]" }],
        };
      }
      if (sql.includes("SELECT\n         c.id")) {
        expect(sql).toContain("same_photo.photo_id = $3");
        expect(sql).toContain("face_pair_rejections");
        return {
          rows: [{ id: "cluster-1", person_id: "person-1", similarity: 0.9 }],
        };
      }
      if (sql.includes("SELECT c.id, f.id AS face_id")) return { rows: [] };
      return { rows: [], rowCount: 0 };
    });

    await expect(
      clusterUnassignedFaces({ threshold: 0.8, strategy: "first" })
    ).resolves.toEqual({ clustered: 1, newClusters: 0 });
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET cluster_id = $1, person_id = $2"),
      ["cluster-1", "person-1", "face-1"]
    );
  });

  it("moves a face transactionally and clears a stale person for an unnamed target", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ cluster_id: null }] })
      .mockResolvedValueOnce({ rows: [{ id: "cluster-1", person_id: null }] })
      .mockResolvedValue({ rows: [], rowCount: 1 });

    await assignFaceToCluster("face-1", "cluster-1");

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET cluster_id = $1, person_id = $2"),
      ["cluster-1", null, "face-1"]
    );
  });

  it("does not remove a face through the wrong cluster URL", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ cluster_id: "actual-cluster" }] });
    await expect(
      removeFaceFromCluster("face-1", "different-cluster")
    ).rejects.toThrow("Face does not belong to cluster");
    expect(clientQuery).toHaveBeenCalledTimes(2);
  });

  it("refuses to merge differently named identities", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { id: "cluster-1", person_id: "person-1" },
          { id: "cluster-2", person_id: "person-2" },
        ],
      });
    await expect(mergeClusters("cluster-1", "cluster-2")).rejects.toThrow(
      "Named clusters belong to different people"
    );
    expect(clientQuery).toHaveBeenCalledTimes(2);
  });

  it("builds suggestions with identity, photo, and rejection constraints", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await getMergeSuggestions();
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("target.person_id = source.person_id");
    expect(sql).toContain("tf.photo_id = sf.photo_id");
    expect(sql).toContain("face_pair_rejections");
  });
});
