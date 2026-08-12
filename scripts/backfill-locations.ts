import "dotenv/config";
import pg from "pg";
import { resolveLocation } from "../src/extractors/location.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL environment variable is required");
const pool = new Pool({
  connectionString,
  ssl: process.env.DATABASE_SSL === "true"
    ? { rejectUnauthorized: false }
    : undefined,
});

interface PhotoCoordinates {
  id: string;
  location_lat: number;
  location_lng: number;
}

async function main(): Promise<void> {
  const result = await pool.query<PhotoCoordinates>(
    `SELECT id, location_lat, location_lng
     FROM photos
     WHERE location_lat IS NOT NULL
       AND location_lng IS NOT NULL
       AND (location_name IS NULL OR location_region IS NULL OR location_country IS NULL)
     ORDER BY id`
  );

  let updated = 0;
  for (const photo of result.rows) {
    const location = resolveLocation(photo.location_lat, photo.location_lng);
    if (!location) continue;
    await pool.query(
      `UPDATE photos
       SET location_name = $2,
           location_region = $3,
           location_country = $4,
           updated_at = NOW()
       WHERE id = $1`,
      [photo.id, location.name, location.region, location.country]
    );
    updated++;
  }

  console.log(`Resolved locations for ${updated} of ${result.rows.length} photos.`);
}

main()
  .catch((error) => {
    console.error("Location backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
