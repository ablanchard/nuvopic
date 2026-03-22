import { query } from "./client.js";

export interface PhotoRecord {
  id: string;
  s3_path: string;
  taken_at: Date | null;
  location_lat: number | null;
  location_lng: number | null;
  location_name: string | null;
  description: string | null;
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
    `INSERT INTO photos (s3_path, taken_at, location_lat, location_lng, location_name, description, placeholder, width, height, process_version, caption_version, faces_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (s3_path) DO UPDATE SET
       taken_at = COALESCE(EXCLUDED.taken_at, photos.taken_at),
       location_lat = COALESCE(EXCLUDED.location_lat, photos.location_lat),
       location_lng = COALESCE(EXCLUDED.location_lng, photos.location_lng),
       location_name = COALESCE(EXCLUDED.location_name, photos.location_name),
       description = COALESCE(EXCLUDED.description, photos.description),
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
// Storage browser helpers — count imported photos by S3 key prefix
// ---------------------------------------------------------------------------

/**
 * Count how many photos exist in the DB whose s3_path matches a given set
 * of full S3 keys. Used to compute "already imported" counts per folder.
 */
export async function countImportedByKeys(
  s3Paths: string[]
): Promise<number> {
  if (s3Paths.length === 0) return 0;
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM photos WHERE s3_path = ANY($1)`,
    [s3Paths]
  );
  return parseInt(result.rows[0].count, 10);
}

// ---------------------------------------------------------------------------
// Smart Tags CRUD
// ---------------------------------------------------------------------------

export interface SmartTagRecord {
  id: string;
  label: string;
  field: string;
  values: string[];
  rule: string; // 'any' | 'all' | 'none'
  sort_order: number;
  created_at: Date;
}

export async function listSmartTags(): Promise<SmartTagRecord[]> {
  const result = await query<SmartTagRecord>(
    `SELECT * FROM smart_tags ORDER BY sort_order ASC, label ASC`
  );
  return result.rows;
}

export async function getSmartTagById(id: string): Promise<SmartTagRecord | null> {
  const result = await query<SmartTagRecord>(
    `SELECT * FROM smart_tags WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function createSmartTag(params: {
  label: string;
  field: string;
  values: string[];
  rule: string;
  sortOrder?: number;
}): Promise<SmartTagRecord> {
  const result = await query<SmartTagRecord>(
    `INSERT INTO smart_tags (label, field, values, rule, sort_order)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [params.label, params.field, params.values, params.rule, params.sortOrder ?? 0]
  );
  return result.rows[0];
}

export async function updateSmartTag(
  id: string,
  params: { label?: string; field?: string; values?: string[]; rule?: string; sortOrder?: number }
): Promise<SmartTagRecord | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  if (params.label !== undefined) { sets.push(`label = $${idx++}`); vals.push(params.label); }
  if (params.field !== undefined) { sets.push(`field = $${idx++}`); vals.push(params.field); }
  if (params.values !== undefined) { sets.push(`values = $${idx++}`); vals.push(params.values); }
  if (params.rule !== undefined) { sets.push(`rule = $${idx++}`); vals.push(params.rule); }
  if (params.sortOrder !== undefined) { sets.push(`sort_order = $${idx++}`); vals.push(params.sortOrder); }

  if (sets.length === 0) return getSmartTagById(id);

  vals.push(id);
  const result = await query<SmartTagRecord>(
    `UPDATE smart_tags SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    vals
  );
  return result.rows[0] ?? null;
}

export async function deleteSmartTag(id: string): Promise<boolean> {
  const result = await query(`DELETE FROM smart_tags WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Smart Tag matching — build WHERE clause for a tag's rules
// ---------------------------------------------------------------------------

/**
 * Build a WHERE condition + params for a smart tag.
 * Returns { condition, params } where condition is a SQL fragment.
 * The paramIndex is the starting $N index for this tag's params.
 */
export function buildSmartTagCondition(
  tag: SmartTagRecord,
  paramIndex: number
): { condition: string; params: unknown[]; nextIndex: number } {
  const { field, values, rule } = tag;
  if (values.length === 0) return { condition: "TRUE", params: [], nextIndex: paramIndex };

  const parts: string[] = [];
  const params: unknown[] = [];
  let idx = paramIndex;

  for (const value of values) {
    if (field === "s3_path") {
      // Prefix match
      parts.push(`p.s3_path LIKE $${idx}`);
      params.push(value + "%");
      idx++;
    } else if (field === "taken_at") {
      // Smart date range: "2023" = full year, "2023-06" = full month
      if (/^\d{4}$/.test(value)) {
        parts.push(`(p.taken_at >= $${idx} AND p.taken_at < $${idx + 1})`);
        params.push(`${value}-01-01`, `${parseInt(value, 10) + 1}-01-01`);
        idx += 2;
      } else if (/^\d{4}-\d{2}$/.test(value)) {
        const [y, m] = value.split("-").map(Number);
        const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
        parts.push(`(p.taken_at >= $${idx} AND p.taken_at < $${idx + 1})`);
        params.push(`${value}-01`, nextMonth);
        idx += 2;
      }
    } else {
      // Text fields: substring/contains (case-insensitive)
      parts.push(`p.${field} ILIKE $${idx}`);
      params.push(`%${value}%`);
      idx++;
    }
  }

  if (parts.length === 0) return { condition: "TRUE", params: [], nextIndex: paramIndex };

  let condition: string;
  if (rule === "none") {
    condition = `NOT (${parts.join(" OR ")})`;
  } else if (rule === "all") {
    condition = `(${parts.join(" AND ")})`;
  } else {
    // rule === "any" (default)
    condition = `(${parts.join(" OR ")})`;
  }

  return { condition, params, nextIndex: idx };
}

/**
 * Count photos matching a smart tag's rules.
 */
export async function countPhotosForSmartTag(tag: SmartTagRecord): Promise<number> {
  const { condition, params } = buildSmartTagCondition(tag, 1);
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM photos p WHERE ${condition}`,
    params
  );
  return parseInt(result.rows[0].count, 10);
}

// ---------------------------------------------------------------------------
// Field Facets — distinct values + counts for any photo column
// ---------------------------------------------------------------------------

/** Allowed fields users can create smart tags on. */
const ALLOWED_FIELDS = new Set([
  "s3_path",
  "taken_at",
  "description",
  "location_name",
]);

export function isAllowedField(field: string): boolean {
  return ALLOWED_FIELDS.has(field);
}

export function getAllowedFields(): string[] {
  return Array.from(ALLOWED_FIELDS);
}

/**
 * s3_path facets: 3-level hierarchical path breakdown.
 */
export async function getPathFacets(): Promise<
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

/**
 * taken_at facets: year > month hierarchy with counts.
 */
export async function getDateFacets(): Promise<
  { year: number; month: number | null; count: number }[]
> {
  const result = await query<{ year: string; month: string | null; count: string }>(
    `SELECT
       EXTRACT(YEAR FROM taken_at)::int AS year,
       EXTRACT(MONTH FROM taken_at)::int AS month,
       COUNT(*)::int AS count
     FROM photos
     WHERE taken_at IS NOT NULL
     GROUP BY year, month
     ORDER BY year DESC, month DESC`
  );
  return result.rows.map((r) => ({
    year: parseInt(r.year, 10),
    month: r.month ? parseInt(r.month, 10) : null,
    count: parseInt(r.count, 10),
  }));
}

/**
 * Generic text field facets: top distinct values with counts.
 */
export async function getTextFacets(
  field: string,
  limit = 100
): Promise<{ value: string; count: number }[]> {
  if (!isAllowedField(field)) throw new Error(`Field "${field}" is not allowed`);
  // Sanitize: only allow known column names (already validated above)
  const result = await query<{ value: string; count: string }>(
    `SELECT ${field} AS value, COUNT(*)::int AS count
     FROM photos
     WHERE ${field} IS NOT NULL AND ${field} != ''
     GROUP BY ${field}
     ORDER BY count DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map((r) => ({
    value: r.value,
    count: parseInt(r.count, 10),
  }));
}
