import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for full-stack Playwright`);
  return value;
}

export default async function globalSetup(): Promise<void> {
  if (process.env.E2E_FULL_STACK !== "true") return;

  const databaseUrl = requiredEnv("DATABASE_URL");
  const pool = new Pool({ connectionString: databaseUrl });
  const schema = await fs.readFile(
    path.join(process.cwd(), "src", "db", "schema.sql"),
    "utf8"
  );

  try {
    await pool.query(schema);
    await pool.query(`
      TRUNCATE TABLE
        face_manual_assignments,
        face_rejections,
        faces,
        face_clusters,
        photo_tags,
        tags,
        persons,
        gpu_logs,
        smart_tags,
        photos,
        settings
      CASCADE
    `);
    await pool.query(schema);
  } finally {
    await pool.end();
  }

  const endpoint = requiredEnv("E2E_S3_ENDPOINT");
  const region = requiredEnv("E2E_S3_REGION");
  const accessKeyId = requiredEnv("E2E_S3_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnv("E2E_S3_SECRET_ACCESS_KEY");
  const bucket = requiredEnv("E2E_S3_BUCKET");
  const objectKey = requiredEnv("E2E_S3_OBJECT_KEY");
  const s3 = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });

  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") {
      throw error;
    }
  }

  const image = await fs.readFile(
    path.join(
      process.cwd(),
      "tests",
      "fixtures",
      "christopher-campbell-rDEOVtE7vOs-unsplash.jpg"
    )
  );
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: image,
      ContentType: "image/jpeg",
    })
  );
  s3.destroy();

  const inferenceUrl = requiredEnv("E2E_INFERENCE_URL");
  const resetResponse = await fetch(`${inferenceUrl}/reset`, { method: "POST" });
  if (!resetResponse.ok) {
    throw new Error(`Unable to reset inference fixture: ${resetResponse.status}`);
  }
}
