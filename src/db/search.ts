import { query } from "./client.js";
import { getFaceQualitySettings, faceQualityFilter } from "./settings.js";
import { getSmartTagById, buildSmartTagCondition } from "./queries.js";
import type { PhotoDatePrecision, PhotoDateSource } from "../extractors/exif.js";

export interface PhotoFilters {
  search?: string;
  tagIds?: string[];
  personId?: string;
  smartTagId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
  offset?: number;
}

export interface PhotoWithStats {
  id: string;
  s3_path: string;
  taken_at: Date | null;
  taken_at_precision: PhotoDatePrecision | null;
  taken_at_source: PhotoDateSource | null;
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

type UnpaginatedPhotoFilters = Omit<PhotoFilters, "limit" | "offset">;

interface PhotoFilterSql {
  whereClause: string;
  params: unknown[];
  nextParamIndex: number;
}

async function buildPhotoFilterSql(
  filters: UnpaginatedPhotoFilters,
  startParamIndex = 1
): Promise<PhotoFilterSql> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = startParamIndex;

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

  if (filters.smartTagId) {
    const tag = await getSmartTagById(filters.smartTagId);
    if (tag && tag.values.length > 0) {
      const result = buildSmartTagCondition(tag, paramIndex);
      conditions.push(result.condition);
      params.push(...result.params);
      paramIndex = result.nextIndex;
    }
  }

  return {
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
    nextParamIndex: paramIndex,
  };
}

export async function searchPhotos(filters: PhotoFilters): Promise<{
  photos: PhotoWithStats[];
  total: number;
}> {
  const fqSettings = await getFaceQualitySettings();
  const fqFilter = faceQualityFilter("f", fqSettings);
  const { whereClause, params, nextParamIndex: paramIndex } =
    await buildPhotoFilterSql(filters);

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
      p.taken_at_precision,
      p.taken_at_source,
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

export interface FilteredPhotoForReprocess {
  id: string;
  s3_path: string;
  process_version: string | null;
  caption_version: string | null;
  faces_version: string | null;
}

/** Return every photo matching the same filters used by the Photos page. */
export async function getFilteredPhotosForReprocess(
  filters: UnpaginatedPhotoFilters
): Promise<FilteredPhotoForReprocess[]> {
  const { whereClause, params } = await buildPhotoFilterSql(filters);
  const result = await query<FilteredPhotoForReprocess>(
    `SELECT p.id, p.s3_path, p.process_version, p.caption_version, p.faces_version
     FROM photos p
     ${whereClause}
     ORDER BY p.created_at ASC`,
    params
  );

  return result.rows;
}

export interface TimelineGroup {
  year: number | null;
  month: number | null;
  count: number;
}

export async function getTimelineIndex(
  filters: Omit<PhotoFilters, "limit" | "offset">
): Promise<TimelineGroup[]> {
  const { whereClause, params } = await buildPhotoFilterSql(filters);
  const hasConditions = whereClause.length > 0;

  // Get monthly counts for photos with a date
  const dated = await query<{ year: string; month: string; count: string }>(
    `SELECT
      EXTRACT(YEAR FROM p.taken_at)::int AS year,
      EXTRACT(MONTH FROM p.taken_at)::int AS month,
      COUNT(*)::int AS count
    FROM photos p
    ${whereClause}${hasConditions ? " AND" : " WHERE"} p.taken_at IS NOT NULL
    GROUP BY year, month
    ORDER BY year DESC, month DESC`,
    params
  );

  // Count photos with no date
  const undated = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
    FROM photos p
    ${whereClause}${hasConditions ? " AND" : " WHERE"} p.taken_at IS NULL`,
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
      p.taken_at_precision,
      p.taken_at_source,
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
