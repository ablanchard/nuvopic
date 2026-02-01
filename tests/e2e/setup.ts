import { execSync } from "child_process";
import pg from "pg";
import * as fs from "fs";
import * as path from "path";

const { Pool } = pg;

// Set test environment variables
process.env.DATABASE_URL = "postgres://gphoto:gphoto@localhost:5432/gphoto";
process.env.S3_ENDPOINT = "http://localhost:9000";
process.env.S3_BUCKET = "photos";
process.env.S3_ACCESS_KEY_ID = "minioadmin";
process.env.S3_SECRET_ACCESS_KEY = "minioadmin";
process.env.S3_REGION = "us-east-1";
process.env.S3_FORCE_PATH_STYLE = "true";

async function waitForPostgres(maxAttempts = 30): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  for (let i = 0; i < maxAttempts; i++) {
    try {
      await pool.query("SELECT 1");
      await pool.end();
      console.log("PostgreSQL is ready");
      return;
    } catch {
      console.log(`Waiting for PostgreSQL... (${i + 1}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  await pool.end();
  throw new Error("PostgreSQL did not become ready in time");
}

async function waitForMinio(maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch("http://localhost:9000/minio/health/live");
      if (response.ok) {
        console.log("MinIO is ready");
        return;
      }
    } catch {
      console.log(`Waiting for MinIO... (${i + 1}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  throw new Error("MinIO did not become ready in time");
}

async function initializeDatabase(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const schemaPath = path.join(process.cwd(), "src", "db", "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");

  await pool.query(schema);
  await pool.end();
  console.log("Database schema initialized");
}

async function cleanDatabase(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  await pool.query("TRUNCATE photos, faces, persons, tags, photo_tags CASCADE");
  await pool.end();
  console.log("Database cleaned");
}

export async function setup(): Promise<void> {
  console.log("\n=== E2E Test Setup ===\n");

  // Check if docker-compose services are running
  try {
    await waitForPostgres(5);
    await waitForMinio(5);
  } catch {
    console.log("Services not running, starting docker-compose...");
    execSync("docker-compose up -d", { stdio: "inherit" });
    await waitForPostgres();
    await waitForMinio();
  }

  await initializeDatabase();
  await cleanDatabase();

  console.log("\n=== Setup Complete ===\n");
}

export async function teardown(): Promise<void> {
  // Optionally stop services
  // execSync("docker-compose down", { stdio: "inherit" });
}

// Run setup before all tests
await setup();
