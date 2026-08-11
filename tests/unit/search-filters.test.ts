import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("../../src/db/client.js", () => ({
  query: queryMock,
}));

import { getFilteredPhotosForReprocess } from "../../src/db/search.js";

describe("getFilteredPhotosForReprocess", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [] });
  });

  it("uses the Photos-page search, date, person, and tag filters", async () => {
    const from = new Date("2024-01-01");
    const to = new Date("2024-12-31");

    await getFilteredPhotosForReprocess({
      search: "holiday",
      dateFrom: from,
      dateTo: to,
      personId: "person-id",
      tagIds: ["tag-id"],
    });

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("p.description ILIKE $1");
    expect(sql).toContain("p.taken_at >= $2");
    expect(sql).toContain("p.taken_at <= $3");
    expect(sql).toContain("fc.person_id = $4");
    expect(sql).toContain("pt.tag_id = ANY($5)");
    expect(params).toEqual(["%holiday%", from, to, "person-id", ["tag-id"]]);
  });

  it("selects the full collection when the current filter set is empty", async () => {
    await getFilteredPhotosForReprocess({});

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).not.toContain("WHERE");
    expect(params).toEqual([]);
  });
});
