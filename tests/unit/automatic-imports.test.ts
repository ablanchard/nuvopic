import { describe, expect, it } from "vitest";
import {
  keyIsAllowed,
  normalizeAwsS3Event,
  objectFingerprint,
  parseImportPrefixes,
} from "../../src/jobs/automatic-imports.js";

describe("automatic import event normalization", () => {
  it("normalizes AWS records and decodes object keys", () => {
    const [event] = normalizeAwsS3Event({
      Records: [
        {
          eventName: "ObjectCreated:CompleteMultipartUpload",
          eventTime: "2026-08-12T08:30:00.000Z",
          s3: {
            bucket: { name: "family-photos" },
            object: {
              key: "Uploads%2FSummer+Trip%2Fphoto.jpg",
              eTag: "abc123",
              size: 42,
              sequencer: "001",
            },
          },
        },
      ],
    });

    expect(event).toMatchObject({
      connectionId: "default",
      provider: "amazon-s3",
      type: "created",
      bucket: "family-photos",
      key: "Uploads/Summer Trip/photo.jpg",
      etag: "abc123",
      size: 42,
      providerEventId: "family-photos:Uploads/Summer Trip/photo.jpg:001",
    });
    expect(event.occurredAt?.toISOString()).toBe("2026-08-12T08:30:00.000Z");
  });

  it("normalizes removal notifications without treating them as imports", () => {
    const [event] = normalizeAwsS3Event({
      s3: { bucket: { name: "photos" }, object: { key: "old.jpg" } },
      eventName: "ObjectRemoved:Delete",
    });
    expect(event.type).toBe("deleted");
  });

  it("rejects records that do not identify an object", () => {
    expect(() => normalizeAwsS3Event({ Records: [{}] })).toThrow(
      "missing bucket or object key"
    );
  });
});

describe("automatic import scope and identity", () => {
  it("normalizes prefixes and removes nested duplicates", () => {
    expect(parseImportPrefixes("/Photos, Photos/2026/, Uploads\nPhotos"))
      .toEqual(["Photos/", "Uploads/"]);
    expect(keyIsAllowed("Photos/image.jpg", ["Photos/"])).toBe(true);
    expect(keyIsAllowed("Private/image.jpg", ["Photos/"])).toBe(false);
    expect(keyIsAllowed("anything.jpg", [])).toBe(true);
  });

  it("prefers version IDs and ETags for stable idempotency keys", () => {
    expect(objectFingerprint({ versionId: "v2", etag: "old" })).toBe("version:v2");
    expect(objectFingerprint({ etag: '"abc"' })).toBe("etag:abc");
    expect(
      objectFingerprint({ size: 12, lastModified: new Date("2026-08-12T00:00:00Z") })
    ).toBe("metadata:12:2026-08-12T00:00:00.000Z");
  });
});
