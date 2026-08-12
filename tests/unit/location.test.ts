import { describe, expect, it } from "vitest";
import { resolveLocation } from "../../src/extractors/location.js";

describe("offline location resolver", () => {
  it("resolves central Barcelona to the city, region, and country", () => {
    expect(resolveLocation(41.3874, 2.1686)).toEqual({
      name: "Barcelona",
      region: "Catalonia",
      country: "Spain",
    });
  });

  it("rejects invalid coordinates", () => {
    expect(resolveLocation(91, 2)).toBeNull();
    expect(resolveLocation(41, Number.NaN)).toBeNull();
  });
});
