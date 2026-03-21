import { query } from "./client.js";
import { getFaceQualitySettings, faceQualityFilter } from "./settings.js";

export interface PhotoFilters {
  search?: string;
  tagIds?: string[];
  personId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
  offset?: number;
}

export interface PhotoWithStats {
  id: string;
  s3_path: string;
  taken_at: Date | null;
  description: string | null;
  location_lat: number | null;
  location_lng: number | null;
  location_name: string | null;
  width: number | null;
  height: number | null;
  placeholder: string | null;
  face_count: number;
  tags: string[];
}

export async function searchPhotos(filters: PhotoFilters): Promise<{
  photos: PhotoWithStats[];
  total: number;
}> {
  const fqSettings = await getFaceQualitySettings();
  const fqFilter = faceQualityFilter("f", fqSettings);

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (filters.search) {
    conditions.push(`(
      p.description ILIKE $${paramIndex}
      OR EXISTS (
        SELECT 1 FROM faces f2
        JOIN face_clusters fc2 ON f2.cluster_id = fc2.id
        JOIN persons per ON fc2.person_id = per.id
        WHERE f2.photo_id = p.id AND per.name ILIKE $${paramIndex}
      )
    )`);
    params.push(`%${filters.search}%`);
    paramIndex++;
  }

  if (filters.dateFrom) {
    conditions.push(`p.taken_at >= $${paramIndex}`);
    params.push(filters.dateFrom);
    paramIndex++;
  }

  if (filters.dateTo) {
    conditions.push(`p.taken_at <= $${paramIndex}`);
    params.push(filters.dateTo);
    paramIndex++;
  }

  if (filters.personId) {
    conditions.push(`EXISTS (
      SELECT 1 FROM faces f
      JOIN face_clusters fc ON f.cluster_id = fc.id
      WHERE f.photo_id = p.id AND fc.person_id = $${paramIndex}
    )`);
    params.push(filters.personId);
    paramIndex++;
  }

  if (filters.tagIds && filters.tagIds.length > 0) {
    conditions.push(`EXISTS (
      SELECT 1 FROM photo_tags pt
      WHERE pt.photo_id = p.id AND pt.tag_id = ANY($${paramIndex})
    )`);
    params.push(filters.tagIds);
    paramIndex++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Count total
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM photos p ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].count, 10);

  // Get photos with stats
  const limit = filters.limit ?? 20;
  const offset = filters.offset ?? 0;

  const photosResult = await query<PhotoWithStats>(
    `SELECT
      p.id,
      p.s3_path,
      p.taken_at,
      p.description,
      p.location_lat,
      p.location_lng,
      p.location_name,
      p.width,
      p.height,
      p.placeholder,
      (SELECT COUNT(*)::int FROM faces f WHERE f.photo_id = p.id AND ${fqFilter}) as face_count,
      COALESCE(
        (SELECT array_agg(t.name ORDER BY t.name)
         FROM tags t
         JOIN photo_tags pt ON t.id = pt.tag_id
         WHERE pt.photo_id = p.id),
        ARRAY[]::text[]
      ) as tags
    FROM photos p
    ${whereClause}
    ORDER BY p.taken_at DESC NULLS LAST, p.created_at DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );

  return {
    photos: photosResult.rows,
    total,
  };
}

export interface TimelineGroup {
  year: number | null;
  month: number | null;
  count: number;
}

export async function getTimelineIndex(
  filters: Omit<PhotoFilters, "limit" | "offset">
): Promise<TimelineGroup[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (filters.search) {
    conditions.push(`(
      p.description ILIKE $${paramIndex}
      OR EXISTS (
        SELECT 1 FROM faces f2
        JOIN face_clusters fc2 ON f2.cluster_id = fc2.id
        JOIN persons per ON fc2.person_id = per.id
        WHERE f2.photo_id = p.id AND per.name ILIKE $${paramIndex}
      )
    )`);
    params.push(`%${filters.search}%`);
    paramIndex++;
  }

  if (filters.dateFrom) {
    conditions.push(`p.taken_at >= $${paramIndex}`);
    params.push(filters.dateFrom);
    paramIndex++;
  }

  if (filters.dateTo) {
    conditions.push(`p.taken_at <= $${paramIndex}`);
    params.push(filters.dateTo);
    paramIndex++;
  }

  if (filters.personId) {
    conditions.push(`EXISTS (
      SELECT 1 FROM faces f
      JOIN face_clusters fc ON f.cluster_id = fc.id
      WHERE f.photo_id = p.id AND fc.person_id = $${paramIndex}
    )`);
    params.push(filters.personId);
    paramIndex++;
  }

  if (filters.tagIds && filters.tagIds.length > 0) {
    conditions.push(`EXISTS (
      SELECT 1 FROM photo_tags pt
      WHERE pt.photo_id = p.id AND pt.tag_id = ANY($${paramIndex})
    )`);
    params.push(filters.tagIds);
    paramIndex++;
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Get monthly counts for photos with a date
  const dated = await query<{ year: string; month: string; count: string }>(
    `SELECT
      EXTRACT(YEAR FROM p.taken_at)::int AS year,
      EXTRACT(MONTH FROM p.taken_at)::int AS month,
      COUNT(*)::int AS count
    FROM photos p
    ${whereClause}${conditions.length > 0 ? " AND" : " WHERE"} p.taken_at IS NOT NULL
    GROUP BY year, month
    ORDER BY year DESC, month DESC`,
    params
  );

  // Count photos with no date
  const undated = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
    FROM photos p
    ${whereClause}${conditions.length > 0 ? " AND" : " WHERE"} p.taken_at IS NULL`,
    params
  );

  const groups: TimelineGroup[] = dated.rows.map((r) => ({
    year: parseInt(r.year, 10),
    month: parseInt(r.month, 10),
    count: parseInt(r.count, 10),
  }));

  const undatedCount = parseInt(undated.rows[0]?.count ?? "0", 10);
  if (undatedCount > 0) {
    groups.push({ year: null, month: null, count: undatedCount });
  }

  return groups;
}

export async function getPhotoWithDetails(id: string): Promise<PhotoWithStats | null> {
  const fqSettings = await getFaceQualitySettings();
  const fqFilter = faceQualityFilter("f", fqSettings);

  const result = await query<PhotoWithStats>(
    `SELECT
      p.id,
      p.s3_path,
      p.taken_at,
      p.description,
      p.location_lat,
      p.location_lng,
      p.location_name,
      p.width,
      p.height,
      p.placeholder,
      (SELECT COUNT(*)::int FROM faces f WHERE f.photo_id = p.id AND ${fqFilter}) as face_count,
      COALESCE(
        (SELECT array_agg(t.name ORDER BY t.name)
         FROM tags t
         JOIN photo_tags pt ON t.id = pt.tag_id
         WHERE pt.photo_id = p.id),
        ARRAY[]::text[]
      ) as tags
    FROM photos p
    WHERE p.id = $1`,
    [id]
  );

  return result.rows[0] ?? null;
}
