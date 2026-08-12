import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("../../src/db/client.js", () => ({
  query: queryMock,
}));

import {
  getFilteredPhotosForReprocess,
  getLocationFacets,
} from "../../src/db/search.js";

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

  it("filters unknown dates directly in SQL and ignores incompatible ranges", async () => {
    await getFilteredPhotosForReprocess({
      dateUnknown: true,
      dateFrom: new Date("2024-01-01"),
      dateTo: new Date("2024-12-31"),
    });

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("p.taken_at IS NULL");
    expect(sql).not.toContain("p.taken_at >=");
    expect(sql).not.toContain("p.taken_at <=");
    expect(params).toEqual([]);
  });

  it("uses exact hierarchical location filters", async () => {
    await getFilteredPhotosForReprocess({
      locationCountry: "Spain",
      locationRegion: "Catalonia",
      locationCity: "Barcelona",
    });

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("p.location_country = $1");
    expect(sql).toContain("p.location_region = $2");
    expect(sql).toContain("p.location_name = $3");
    expect(params).toEqual(["Spain", "Catalonia", "Barcelona"]);
  });

  it("counts location facets under non-location filters", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { city: "Barcelona", region: "Catalonia", country: "Spain", count: 7 },
      ],
    });

    const result = await getLocationFacets({
      search: "beach",
      locationCountry: "Spain",
    });

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("p.description ILIKE $1");
    expect(sql).not.toContain("p.location_country =");
    expect(params).toEqual(["%beach%"]);
    expect(result).toEqual([
      { city: "Barcelona", region: "Catalonia", country: "Spain", count: 7 },
    ]);
  });
});
