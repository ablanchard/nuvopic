import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { extractExif, parseDateFromFilename } from "../../src/extractors/exif.js";
import { compareSemver } from "../../src/version.js";

describe("EXIF Extractor", () => {
  it("should return null values for image without EXIF", async () => {
    const testImage = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 128, g: 128, b: 128 },
      },
    })
      .jpeg()
      .toBuffer();

    const result = await extractExif(testImage);

    expect(result.takenAt).toBeNull();
    expect(result.location).toBeNull();
  });

  it("should handle PNG images", async () => {
    const pngImage = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 128, g: 128, b: 128, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const result = await extractExif(pngImage);

    // PNG doesn't have EXIF
    expect(result.takenAt).toBeNull();
    expect(result.location).toBeNull();
  });
});

describe("parseDateFromFilename", () => {
  it("should parse Android-style IMG_YYYYMMDD_HHMMSS", () => {
    const date = parseDateFromFilename("IMG_20231015_143022.jpg");
    expect(date).toEqual(new Date(Date.UTC(2023, 9, 15, 14, 30, 22)));
  });

  it("should parse Pixel-style PXL_YYYYMMDD_HHMMSSmmm", () => {
    const date = parseDateFromFilename("PXL_20231015_143022123.jpg");
    expect(date).toEqual(new Date(Date.UTC(2023, 9, 15, 14, 30, 22)));
  });

  it("should parse YYYYMMDD_HHMMSS without prefix", () => {
    const date = parseDateFromFilename("20231015_143022.jpg");
    expect(date).toEqual(new Date(Date.UTC(2023, 9, 15, 14, 30, 22)));
  });

  it("should parse YYYY-MM-DD_HH-MM-SS", () => {
    const date = parseDateFromFilename("2023-10-15_14-30-22.jpg");
    expect(date).toEqual(new Date(Date.UTC(2023, 9, 15, 14, 30, 22)));
  });

  it("should parse YYYY-MM-DD HH.MM.SS (Apple style)", () => {
    const date = parseDateFromFilename("Photo 2023-10-15 at 14.30.22.jpg");
    expect(date).toEqual(new Date(Date.UTC(2023, 9, 15, 14, 30, 22)));
  });

  it("should parse Screenshot_YYYY-MM-DD-HH-MM-SS", () => {
    const date = parseDateFromFilename("Screenshot_2023-10-15-14-30-22.png");
    expect(date).toEqual(new Date(Date.UTC(2023, 9, 15, 14, 30, 22)));
  });

  it("should parse YYYY-MM-DD only (no time)", () => {
    const date = parseDateFromFilename("vacation-2023-10-15.jpg");
    expect(date).toEqual(new Date(Date.UTC(2023, 9, 15)));
  });

  it("should parse date from full S3 path", () => {
    const date = parseDateFromFilename("photos/2023/IMG_20231015_143022.jpg");
    expect(date).toEqual(new Date(Date.UTC(2023, 9, 15, 14, 30, 22)));
  });

  it("should return null for filenames without dates", () => {
    expect(parseDateFromFilename("photo.jpg")).toBeNull();
    expect(parseDateFromFilename("my-vacation.png")).toBeNull();
    expect(parseDateFromFilename("DSC0001.jpg")).toBeNull();
  });

  it("should reject invalid month/day values", () => {
    expect(parseDateFromFilename("20231300_120000.jpg")).toBeNull();
    expect(parseDateFromFilename("20231032_120000.jpg")).toBeNull();
  });
});

describe("compareSemver", () => {
  it("should return 0 for equal versions", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
  });

  it("should compare major versions", () => {
    expect(compareSemver("2.0.0", "1.0.0")).toBe(1);
    expect(compareSemver("1.0.0", "2.0.0")).toBe(-1);
  });

  it("should compare minor versions", () => {
    expect(compareSemver("1.1.0", "1.0.0")).toBe(1);
    expect(compareSemver("1.0.0", "1.1.0")).toBe(-1);
  });

  it("should compare patch versions", () => {
    expect(compareSemver("1.0.1", "1.0.0")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
  });

  it("should handle multi-digit versions", () => {
    expect(compareSemver("1.10.0", "1.9.0")).toBe(1);
    expect(compareSemver("1.0.10", "1.0.9")).toBe(1);
  });
});
