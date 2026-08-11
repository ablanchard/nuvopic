import { beforeEach, describe, expect, it, vi } from "vitest";

const { listMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
}));

vi.mock("../../webapp/src/api/client", () => ({
  api: {
    photos: {
      list: listMock,
    },
  },
}));

import { PhotoCache } from "../../webapp/src/lib/photoCache";

function undatedPhotos(start: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `photo-${start + index}`,
    takenAt: null,
  }));
}

describe("PhotoCache unknown-date sections", () => {
  beforeEach(() => {
    listMock.mockReset();
  });

  it("uses the server-side unknown-date filter and loads every page", async () => {
    listMock
      .mockResolvedValueOnce({
        photos: undatedPhotos(0, 100),
        pagination: { page: 1, limit: 100, total: 125, hasMore: true },
      })
      .mockResolvedValueOnce({
        photos: undatedPhotos(100, 25),
        pagination: { page: 2, limit: 100, total: 125, hasMore: false },
      });

    const cache = new PhotoCache();
    cache.setFilters({ search: "holiday" });

    const photos = await cache.ensure("undated", 125);

    expect(photos).toHaveLength(125);
    expect(listMock).toHaveBeenNthCalledWith(1, {
      search: "holiday",
      dateUnknown: true,
      page: 1,
      limit: 100,
    });
    expect(listMock).toHaveBeenNthCalledWith(2, {
      search: "holiday",
      dateUnknown: true,
      page: 2,
      limit: 100,
    });
  });
});
