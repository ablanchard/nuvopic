import { describe, expect, it, vi } from "vitest";

const { getFaceThumbnailMock } = vi.hoisted(() => ({
  getFaceThumbnailMock: vi.fn(),
}));

vi.mock("../../webapp/src/api/client", () => ({
  api: {
    photos: {
      getFaceThumbnail: getFaceThumbnailMock,
    },
  },
}));

import { loadFaceThumbnail } from "../../webapp/src/lib/faceThumbnailLoader";

describe("face thumbnail loader", () => {
  it("limits concurrent requests and reuses completed blobs", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];

    getFaceThumbnailMock.mockImplementation(
      (_photoId: string, faceId: string) => new Promise<Blob>((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        releases.push(() => {
          active -= 1;
          resolve(new Blob([faceId]));
        });
      }),
    );

    const requests = Array.from({ length: 10 }, (_, index) =>
      loadFaceThumbnail(`photo-${index}`, `face-${index}`, 96),
    );

    expect(getFaceThumbnailMock).toHaveBeenCalledTimes(4);

    releases.slice(0, 4).forEach((release) => release());
    await vi.waitFor(() => expect(getFaceThumbnailMock).toHaveBeenCalledTimes(8));

    releases.slice(4, 8).forEach((release) => release());
    await vi.waitFor(() => expect(getFaceThumbnailMock).toHaveBeenCalledTimes(10));

    releases.slice(8, 10).forEach((release) => release());
    const blobs = await Promise.all(requests);

    expect(maxActive).toBe(4);

    const cached = await loadFaceThumbnail("photo-0", "face-0", 96);
    expect(cached).toBe(blobs[0]);
    expect(getFaceThumbnailMock).toHaveBeenCalledTimes(10);
  });
});
