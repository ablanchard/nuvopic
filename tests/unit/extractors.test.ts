import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { generateThumbnail } from "../../src/extractors/thumbnail.js";
import { extractExif } from "../../src/extractors/exif.js";

describe("Thumbnail Extractor", () => {
  it("should generate a 200x200 JPEG thumbnail", async () => {
    // Create a test image
    const testImage = await sharp({
      create: {
        width: 1920,
        height: 1080,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .jpeg()
      .toBuffer();

    const result = await generateThumbnail(testImage);

    expect(result.width).toBe(200);
    expect(result.height).toBe(200);
    expect(result.format).toBe("jpeg");
    expect(result.buffer.length).toBeGreaterThan(0);

    // Verify the output is valid JPEG
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(200);
    expect(metadata.height).toBe(200);
  });

  it("should handle portrait images", async () => {
    const portraitImage = await sharp({
      create: {
        width: 1080,
        height: 1920,
        channels: 3,
        background: { r: 0, g: 255, b: 0 },
      },
    })
      .jpeg()
      .toBuffer();

    const result = await generateThumbnail(portraitImage);

    expect(result.width).toBe(200);
    expect(result.height).toBe(200);
  });

  it("should accept custom size", async () => {
    const testImage = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: { r: 0, g: 0, b: 255 },
      },
    })
      .jpeg()
      .toBuffer();

    const result = await generateThumbnail(testImage, 100);

    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
  });
});

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
