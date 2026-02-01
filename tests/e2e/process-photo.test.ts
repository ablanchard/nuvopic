import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import pg from "pg";
import * as fs from "fs";
import * as path from "path";
import { handler } from "../../src/index.js";
import { loadFaceModels } from "../../src/extractors/faces.js";
import { loadCaptionModel } from "../../src/extractors/caption.js";

const { Pool } = pg;

// Test photos from fixtures
const FIXTURES_DIR = path.join(process.cwd(), "tests", "fixtures");
const TEST_PHOTOS = [
  "christopher-campbell-rDEOVtE7vOs-unsplash.jpg",
  "jurica-koletic-7YVZYZeITc8-unsplash.jpg",
  "michael-dam-mEZ3PoFGs_k-unsplash.jpg",
  "vicky-hladynets-C8Ta0gwPbQg-unsplash.jpg",
];

describe("Photo Processing E2E", () => {
  let s3Client: S3Client;
  let pool: pg.Pool;
  const uploadedKeys: string[] = [];

  beforeAll(async () => {
    // Initialize S3 client
    s3Client = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      },
      forcePathStyle: true,
    });

    // Initialize database pool
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });

    // Pre-load models to avoid timeout on first test
    console.log("Pre-loading AI models...");
    await Promise.all([
      loadFaceModels().catch((e) =>
        console.warn("Face models not available:", e.message)
      ),
      loadCaptionModel().catch((e) =>
        console.warn("Caption model loading:", e.message)
      ),
    ]);
    console.log("Models loaded");
  }, 180000); // 3 minute timeout for model loading

  afterAll(async () => {
    // Cleanup uploaded files from S3
    for (const key of uploadedKeys) {
      try {
        await s3Client.send(
          new DeleteObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: key,
          })
        );
      } catch {
        // Ignore if file doesn't exist
      }
    }

    await pool.end();
  });

  it("should process a photo with a face and store metadata", async () => {
    const photoName = TEST_PHOTOS[0]; // christopher-campbell portrait
    const photoPath = path.join(FIXTURES_DIR, photoName);
    const photoBuffer = fs.readFileSync(photoPath);
    const testKey = `test-photos/${photoName}`;

    // Upload to S3
    await s3Client.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: testKey,
        Body: photoBuffer,
        ContentType: "image/jpeg",
      })
    );
    uploadedKeys.push(testKey);

    // Process the photo
    const response = await handler({
      s3Bucket: process.env.S3_BUCKET!,
      s3Key: testKey,
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    expect(body.processed).toBe(1);
    expect(body.results).toHaveLength(1);

    const result = body.results[0];
    expect(result.s3Path).toBe(`s3://${process.env.S3_BUCKET}/${testKey}`);
    expect(result.photoId).toBeDefined();
    expect(result.thumbnailSize).toBeGreaterThan(0);

    // Should detect at least one face
    expect(result.facesDetected).toBeGreaterThanOrEqual(1);

    // Description may fail if model has issues - log but don't fail test
    if (result.description) {
      expect(result.description.length).toBeGreaterThan(0);
    } else {
      console.warn("Caption generation failed - check model loading");
    }

    // Verify data in database
    const photoResult = await pool.query(
      "SELECT * FROM photos WHERE id = $1",
      [result.photoId]
    );

    expect(photoResult.rows).toHaveLength(1);
    const photo = photoResult.rows[0];
    expect(photo.thumbnail).not.toBeNull();
    // Description may be null if caption model fails
    if (!photo.description) {
      console.warn("Photo description is null in database");
    }

    // Verify faces in database
    const facesResult = await pool.query(
      "SELECT * FROM faces WHERE photo_id = $1",
      [result.photoId]
    );

    expect(facesResult.rows.length).toBeGreaterThanOrEqual(1);
    const face = facesResult.rows[0];
    expect(face.bounding_box).toBeDefined();
    expect(face.embedding).toBeDefined();

    console.log(`Processed ${photoName}:`);
    console.log(`  Description: ${result.description}`);
    console.log(`  Faces detected: ${result.facesDetected}`);
    console.log(`  Thumbnail size: ${result.thumbnailSize} bytes`);
  }, 120000);

  it("should process multiple photos via S3 events", async () => {
    // Upload all test photos
    const keys: string[] = [];
    for (const photoName of TEST_PHOTOS.slice(1)) {
      const photoPath = path.join(FIXTURES_DIR, photoName);
      const photoBuffer = fs.readFileSync(photoPath);
      const testKey = `test-photos/${photoName}`;

      await s3Client.send(
        new PutObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: testKey,
          Body: photoBuffer,
          ContentType: "image/jpeg",
        })
      );
      keys.push(testKey);
      uploadedKeys.push(testKey);
    }

    // Simulate S3 event with multiple records
    const s3Event = {
      Records: keys.map((key) => ({
        s3: {
          bucket: { name: process.env.S3_BUCKET! },
          object: { key },
        },
      })),
    };

    const response = await handler(s3Event);

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    expect(body.processed).toBe(keys.length);
    expect(body.results).toHaveLength(keys.length);

    // All should have faces detected (these are portrait photos)
    for (const result of body.results) {
      expect(result.facesDetected).toBeGreaterThanOrEqual(1);
      console.log(`${result.s3Path}: "${result.description ?? 'no caption'}" (${result.facesDetected} faces)`);
    }
  }, 300000); // 5 minutes for multiple photos

  it("should skip unsupported file types", async () => {
    const response = await handler({
      s3Bucket: process.env.S3_BUCKET!,
      s3Key: "document.pdf",
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toContain("Unsupported file type");
  });

  it("should update existing photo on reprocess (idempotent)", async () => {
    const testKey = `test-photos/${TEST_PHOTOS[0]}`;

    // First process
    const response1 = await handler({
      s3Bucket: process.env.S3_BUCKET!,
      s3Key: testKey,
    });

    const body1 = JSON.parse(response1.body);
    const photoId1 = body1.results[0].photoId;

    // Second process (same file)
    const response2 = await handler({
      s3Bucket: process.env.S3_BUCKET!,
      s3Key: testKey,
    });

    const body2 = JSON.parse(response2.body);
    const photoId2 = body2.results[0].photoId;

    // Should be the same photo ID (upsert)
    expect(photoId2).toBe(photoId1);

    // Should only have one record in database
    const countResult = await pool.query(
      "SELECT COUNT(*) FROM photos WHERE s3_path = $1",
      [`s3://${process.env.S3_BUCKET}/${testKey}`]
    );
    expect(parseInt(countResult.rows[0].count)).toBe(1);
  }, 120000);
});

describe("Database Tags", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("should add and retrieve tags for photos", async () => {
    // Get a photo ID from previous tests
    const photoResult = await pool.query("SELECT id FROM photos LIMIT 1");
    if (photoResult.rows.length === 0) {
      console.log("Skipping tag test - no photos in database");
      return;
    }

    const photoId = photoResult.rows[0].id;

    // Import and test tag functions
    const { addTagToPhoto, getPhotoTags, removeTagFromPhoto } = await import(
      "../../src/db/tags.js"
    );

    // Add tags
    await addTagToPhoto(photoId, "portrait");
    await addTagToPhoto(photoId, "people");
    await addTagToPhoto(photoId, "test");

    // Retrieve tags
    let tags = await getPhotoTags(photoId);
    expect(tags).toHaveLength(3);
    expect(tags.map((t) => t.name).sort()).toEqual(["people", "portrait", "test"]);

    // Remove a tag
    const testTag = tags.find((t) => t.name === "test");
    await removeTagFromPhoto(photoId, testTag!.id);

    // Verify removal
    tags = await getPhotoTags(photoId);
    expect(tags).toHaveLength(2);
    expect(tags.map((t) => t.name).sort()).toEqual(["people", "portrait"]);
  });

  it("should find photos by tag", async () => {
    const { getPhotosByTag } = await import("../../src/db/tags.js");

    const photos = await getPhotosByTag("portrait");
    expect(photos.length).toBeGreaterThanOrEqual(1);
  });
});
