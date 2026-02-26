import { query } from "./client.js";

export interface PhotoRecord {
  id: string;
  s3_path: string;
  taken_at: Date | null;
  location_lat: number | null;
  location_lng: number | null;
  location_name: string | null;
  description: string | null;
  thumbnail: Buffer | null;
  width: number | null;
  height: number | null;
  process_version: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface FaceRecord {
  id: string;
  photo_id: string;
  bounding_box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  embedding: number[];
  person_id: string | null;
  created_at: Date;
}

export interface InsertPhotoParams {
  s3Path: string;
  takenAt?: Date | null;
  locationLat?: number | null;
  locationLng?: number | null;
  locationName?: string | null;
  description?: string | null;
  thumbnail?: Buffer | null;
  width?: number | null;
  height?: number | null;
  processVersion?: string | null;
}

export interface InsertFaceParams {
  photoId: string;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  embedding: number[];
}

export async function insertPhoto(params: InsertPhotoParams): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO photos (s3_path, taken_at, location_lat, location_lng, location_name, description, thumbnail, width, height, process_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (s3_path) DO UPDATE SET
       taken_at = COALESCE(EXCLUDED.taken_at, photos.taken_at),
       location_lat = COALESCE(EXCLUDED.location_lat, photos.location_lat),
       location_lng = COALESCE(EXCLUDED.location_lng, photos.location_lng),
       location_name = COALESCE(EXCLUDED.location_name, photos.location_name),
       description = COALESCE(EXCLUDED.description, photos.description),
       thumbnail = COALESCE(EXCLUDED.thumbnail, photos.thumbnail),
       width = COALESCE(EXCLUDED.width, photos.width),
       height = COALESCE(EXCLUDED.height, photos.height),
       process_version = COALESCE(EXCLUDED.process_version, photos.process_version),
       updated_at = NOW()
     RETURNING id`,
    [
      params.s3Path,
      params.takenAt ?? null,
      params.locationLat ?? null,
      params.locationLng ?? null,
      params.locationName ?? null,
      params.description ?? null,
      params.thumbnail ?? null,
      params.width ?? null,
      params.height ?? null,
      params.processVersion ?? null,
    ]
  );

  return result.rows[0].id;
}

export async function insertFace(params: InsertFaceParams): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO faces (photo_id, bounding_box, embedding)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [
      params.photoId,
      JSON.stringify(params.boundingBox),
      `[${params.embedding.join(",")}]`,
    ]
  );

  return result.rows[0].id;
}

export async function deleteFacesByPhotoId(photoId: string): Promise<void> {
  await query("DELETE FROM faces WHERE photo_id = $1", [photoId]);
}

export async function getPhotoByS3Path(
  s3Path: string
): Promise<PhotoRecord | null> {
  const result = await query<PhotoRecord>(
    "SELECT * FROM photos WHERE s3_path = $1",
    [s3Path]
  );

  return result.rows[0] ?? null;
}

export async function getPhotoById(id: string): Promise<PhotoRecord | null> {
  const result = await query<PhotoRecord>("SELECT * FROM photos WHERE id = $1", [
    id,
  ]);

  return result.rows[0] ?? null;
}

export async function getFacesByPhotoId(photoId: string): Promise<FaceRecord[]> {
  const result = await query<FaceRecord>(
    "SELECT * FROM faces WHERE photo_id = $1",
    [photoId]
  );

  return result.rows;
}

export async function getPhotosToReprocess(
  belowVersion: string
): Promise<Pick<PhotoRecord, "id" | "s3_path" | "process_version">[]> {
  const result = await query<Pick<PhotoRecord, "id" | "s3_path" | "process_version">>(
    `SELECT id, s3_path, process_version FROM photos
     WHERE process_version IS NULL OR process_version < $1
     ORDER BY created_at ASC`,
    [belowVersion]
  );

  return result.rows;
}

export async function getAllPhotosForReprocess(): Promise<
  Pick<PhotoRecord, "id" | "s3_path" | "process_version">[]
> {
  const result = await query<
    Pick<PhotoRecord, "id" | "s3_path" | "process_version">
  >(
    `SELECT id, s3_path, process_version FROM photos ORDER BY created_at ASC`
  );

  return result.rows;
}

export async function getExistingS3Paths(
  s3Paths: string[]
): Promise<Set<string>> {
  if (s3Paths.length === 0) return new Set();

  const result = await query<{ s3_path: string }>(
    `SELECT s3_path FROM photos WHERE s3_path = ANY($1)`,
    [s3Paths]
  );

  return new Set(result.rows.map((r) => r.s3_path));
}
