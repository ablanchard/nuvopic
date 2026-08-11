import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  extractExif,
  parseDateFromFilename,
  resolvePhotoDate,
} from "../../src/extractors/exif.js";
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

  it("should read nested EXIF original timestamps", async () => {
    const image = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .withMetadata({
        exif: {
          IFD0: { DateTime: "2025:12:28 13:11:36" },
          IFD2: { DateTimeOriginal: "2025:12:28 13:11:36" },
        },
      })
      .jpeg()
      .toBuffer();

    const result = await extractExif(image);
    expect(result.takenAt).toEqual(new Date("2025-12-28T13:11:36.000Z"));
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
    expect(parseDateFromFilename("20230231_120000.jpg")).toBeNull();
    expect(parseDateFromFilename("20231015_246000.jpg")).toBeNull();
  });

  it("should not interpret opaque social-media IDs as dates", () => {
    expect(parseDateFromFilename("Snapchat-7003030358710177817.jpg")).toBeNull();
    expect(parseDateFromFilename("Snapchat--7485324816502303059.jpg")).toBeNull();
    expect(parseDateFromFilename("received_10209667077050984.jpeg")).toBeNull();
  });
});

describe("resolvePhotoDate", () => {
  it("should prefer a plausible EXIF date", () => {
    const exifDate = new Date("2025-12-28T13:11:36.000Z");
    expect(resolvePhotoDate(exifDate, "Photos/Camera/2016/08/photo.jpg")).toEqual({
      takenAt: exifDate,
      precision: "exact",
      source: "exif",
    });
  });

  it("should infer month precision from a structured storage path", () => {
    expect(
      resolvePhotoDate(null, "Photos/Camera/2016/08/Snapchat-7003030358710177817.jpg")
    ).toEqual({
      takenAt: new Date("2016-08-01T00:00:00.000Z"),
      precision: "month",
      source: "path",
    });
  });

  it("should explicitly return unknown when no reliable date exists", () => {
    expect(resolvePhotoDate(null, "uploads/photo.jpg")).toEqual({
      takenAt: null,
      precision: "unknown",
      source: "unknown",
    });
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
