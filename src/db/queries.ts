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
  placeholder: string | null;
  width: number | null;
  height: number | null;
  process_version: string | null;
  caption_version: string | null;
  faces_version: string | null;
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
  placeholder?: string | null;
  width?: number | null;
  height?: number | null;
  processVersion?: string | null;
  captionVersion?: string | null;
  facesVersion?: string | null;
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
  confidence?: number | null;
}

export async function insertPhoto(params: InsertPhotoParams): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO photos (s3_path, taken_at, location_lat, location_lng, location_name, description, thumbnail, placeholder, width, height, process_version, caption_version, faces_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (s3_path) DO UPDATE SET
       taken_at = COALESCE(EXCLUDED.taken_at, photos.taken_at),
       location_lat = COALESCE(EXCLUDED.location_lat, photos.location_lat),
       location_lng = COALESCE(EXCLUDED.location_lng, photos.location_lng),
       location_name = COALESCE(EXCLUDED.location_name, photos.location_name),
       description = COALESCE(EXCLUDED.description, photos.description),
       thumbnail = COALESCE(EXCLUDED.thumbnail, photos.thumbnail),
       placeholder = COALESCE(EXCLUDED.placeholder, photos.placeholder),
       width = COALESCE(EXCLUDED.width, photos.width),
       height = COALESCE(EXCLUDED.height, photos.height),
       process_version = COALESCE(EXCLUDED.process_version, photos.process_version),
       caption_version = COALESCE(EXCLUDED.caption_version, photos.caption_version),
       faces_version = COALESCE(EXCLUDED.faces_version, photos.faces_version),
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
      params.placeholder ?? null,
      params.width ?? null,
      params.height ?? null,
      params.processVersion ?? null,
      params.captionVersion ?? null,
      params.facesVersion ?? null,
    ]
  );

  return result.rows[0].id;
}

export async function insertFace(params: InsertFaceParams): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO faces (photo_id, bounding_box, embedding, confidence)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      params.photoId,
      JSON.stringify(params.boundingBox),
      `[${params.embedding.join(",")}]`,
      params.confidence ?? null,
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

export async function getPhotosToReprocessCaption(
  belowCaptionVersion: string
): Promise<Pick<PhotoRecord, "id" | "s3_path" | "caption_version">[]> {
  const result = await query<Pick<PhotoRecord, "id" | "s3_path" | "caption_version">>(
    `SELECT id, s3_path, caption_version FROM photos
     WHERE caption_version IS NULL OR caption_version < $1
     ORDER BY created_at ASC`,
    [belowCaptionVersion]
  );

  return result.rows;
}

export async function getPhotosToReprocessFaces(
  belowFacesVersion: string
): Promise<Pick<PhotoRecord, "id" | "s3_path" | "faces_version">[]> {
  const result = await query<Pick<PhotoRecord, "id" | "s3_path" | "faces_version">>(
    `SELECT id, s3_path, faces_version FROM photos
     WHERE faces_version IS NULL OR faces_version < $1
     ORDER BY created_at ASC`,
    [belowFacesVersion]
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

// ---------------------------------------------------------------------------
// Photo Sources CRUD
// ---------------------------------------------------------------------------

export interface PhotoSourceRecord {
  id: string;
  label: string;
  path_prefixes: string[];
  sort_order: number;
  created_at: Date;
}

export async function listPhotoSources(): Promise<PhotoSourceRecord[]> {
  const result = await query<PhotoSourceRecord>(
    `SELECT * FROM photo_sources ORDER BY sort_order ASC, label ASC`
  );
  return result.rows;
}

export async function getPhotoSourceById(id: string): Promise<PhotoSourceRecord | null> {
  const result = await query<PhotoSourceRecord>(
    `SELECT * FROM photo_sources WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function createPhotoSource(params: {
  label: string;
  pathPrefixes: string[];
  sortOrder?: number;
}): Promise<PhotoSourceRecord> {
  const result = await query<PhotoSourceRecord>(
    `INSERT INTO photo_sources (label, path_prefixes, sort_order)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [params.label, params.pathPrefixes, params.sortOrder ?? 0]
  );
  return result.rows[0];
}

export async function updatePhotoSource(
  id: string,
  params: { label?: string; pathPrefixes?: string[]; sortOrder?: number }
): Promise<PhotoSourceRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.label !== undefined) {
    sets.push(`label = $${idx++}`);
    values.push(params.label);
  }
  if (params.pathPrefixes !== undefined) {
    sets.push(`path_prefixes = $${idx++}`);
    values.push(params.pathPrefixes);
  }
  if (params.sortOrder !== undefined) {
    sets.push(`sort_order = $${idx++}`);
    values.push(params.sortOrder);
  }

  if (sets.length === 0) return getPhotoSourceById(id);

  values.push(id);
  const result = await query<PhotoSourceRecord>(
    `UPDATE photo_sources SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );
  return result.rows[0] ?? null;
}

export async function deletePhotoSource(id: string): Promise<boolean> {
  const result = await query(`DELETE FROM photo_sources WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Count photos matching a source's path prefixes.
 * Each prefix is matched with `s3_path LIKE prefix || '%'`.
 */
export async function countPhotosForPrefixes(prefixes: string[]): Promise<number> {
  if (prefixes.length === 0) return 0;
  const likes = prefixes.map((_, i) => `p.s3_path LIKE $${i + 1}`).join(" OR ");
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM photos p WHERE ${likes}`,
    prefixes.map((pf) => pf + "%")
  );
  return parseInt(result.rows[0].count, 10);
}

/**
 * Path breakdown: level-1, level-2, and level-3 prefix counts.
 * Returns rows like { level1: "Photos", level2: "Camera", level3: "2018", count: 5484 }.
 * The s3_path format is `s3://<bucket>/<key>` so we strip the bucket prefix first.
 * Level-3 entries are only included when their count > 1 to exclude individual filenames.
 */
export async function getPathBreakdown(): Promise<
  { level1: string; level2: string | null; level3: string | null; count: number }[]
> {
  const result = await query<{ level1: string; level2: string | null; level3: string | null; count: string }>(
    `WITH keys AS (
       SELECT regexp_replace(s3_path, '^s3://[^/]+/', '') AS key FROM photos
     ),
     parts AS (
       SELECT
         split_part(key, '/', 1) AS level1,
         CASE WHEN position('/' in key) > 0
              THEN split_part(key, '/', 2)
              ELSE NULL
         END AS level2,
         CASE WHEN array_length(string_to_array(key, '/'), 1) >= 3
              THEN split_part(key, '/', 3)
              ELSE NULL
         END AS level3
       FROM keys
     ),
     grouped AS (
       SELECT level1, level2, level3, COUNT(*)::int AS count
       FROM parts
       WHERE level1 != ''
       GROUP BY level1, level2, level3
     )
     SELECT level1, level2, level3, count
     FROM grouped
     WHERE level3 IS NULL OR count > 1
     ORDER BY count DESC`
  );
  return result.rows.map((r) => ({
    level1: r.level1,
    level2: r.level2 || null,
    level3: r.level3 || null,
    count: parseInt(r.count, 10),
  }));
}
