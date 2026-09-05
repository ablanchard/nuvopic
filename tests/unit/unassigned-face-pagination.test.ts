import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, getFaceQualitySettingsMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  getFaceQualitySettingsMock: vi.fn(),
}));

vi.mock("../../src/db/client.js", () => ({
  query: queryMock,
  withTransaction: vi.fn(),
}));

vi.mock("../../src/db/settings.js", () => ({
  getFaceQualitySettings: getFaceQualitySettingsMock,
  faceQualityFilter: () => "TRUE",
}));

import { getUnclusteredFaces } from "../../src/db/clusters.js";

describe("unassigned face pagination", () => {
  beforeEach(() => {
    queryMock.mockReset();
    getFaceQualitySettingsMock.mockReset();
    getFaceQualitySettingsMock.mockResolvedValue({
      minConfidence: 0.7,
      minArea: 2500,
    });
  });

  it("returns a stable page and the complete unassigned count", async () => {
    const faces = [{ id: "face-41" }, { id: "face-42" }];
    queryMock
      .mockResolvedValueOnce({ rows: faces })
      .mockResolvedValueOnce({ rows: [{ count: 82 }] });

    const result = await getUnclusteredFaces(40, 40);

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[0][0]).toContain("ORDER BY f.created_at DESC, f.id DESC");
    expect(queryMock.mock.calls[0][1]).toEqual([40, 40]);
    expect(result).toEqual({ faces, total: 82, hasMore: true });
  });
});
