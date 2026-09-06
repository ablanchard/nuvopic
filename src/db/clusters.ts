import { query, withTransaction } from "./client.js";
import { logger } from "../logger.js";
import { getFaceQualitySettings, faceQualityFilter } from "./settings.js";
import type { PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClusterStrategy = "first" | "average";

export interface ClusterRecord {
  id: string;
  person_id: string | null;
  person_name: string | null;
  face_count: number;
  representative_face_id: string | null;
  representative_photo_id: string | null;
  representative_bounding_box: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
}

export interface ClusterFaceRecord {
  id: string;
  photo_id: string;
  bounding_box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  photo_width: number | null;
  photo_height: number | null;
  confidence: number | null;
  area: number;
}

export interface ClusteringResult {
  clustered: number;
  newClusters: number;
}

export interface ReclusterResult {
  totalClusters: number;
  namedPreserved: number;
  newClusters: number;
}

export interface MergeSuggestionRecord {
  source_cluster_id: string;
  target_cluster_id: string;
  source_person_id: string | null;
  target_person_id: string | null;
  source_person_name: string | null;
  target_person_name: string | null;
  source_face_count: number;
  target_face_count: number;
  similarity: number;
  source_coverage: number;
  target_coverage: number;
  reason: "same-person" | "high-similarity";
}

export interface AutoMergeResult {
  merged: number;
  remainingSuggestions: number;
}

const CLUSTERING_LOCK_KEY = "nuvopic:face-clustering";

// Calibrated against the current InsightFace/ArcFace cosine distribution. The
// incremental clustering pass uses 0.60, so review candidates sit just below
// that boundary while unattended merges require near-boundary similarity and
// almost complete bidirectional face support.
export const DEFAULT_MERGE_SUGGESTION_SIMILARITY = 0.54;
export const DEFAULT_AUTO_MERGE_SIMILARITY = 0.59;
export const DEFAULT_AUTO_MERGE_COVERAGE = 0.95;

async function lockClusterMutation(client: PoolClient): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    CLUSTERING_LOCK_KEY,
  ]);
}

// ---------------------------------------------------------------------------
// Internal: embedding helpers
// ---------------------------------------------------------------------------

/** Faces presented as unassigned in the UI, including automatic singletons. */
function effectivelyUnassignedFilter(alias: string): string {
  return `(
    ${alias}.cluster_id IS NULL
    OR (
      NOT EXISTS (
        SELECT 1 FROM face_manual_assignments ma_unassigned
        WHERE ma_unassigned.face_id = ${alias}.id
      )
      AND EXISTS (
        SELECT 1 FROM face_clusters c_unassigned
        WHERE c_unassigned.id = ${alias}.cluster_id
          AND c_unassigned.person_id IS NULL
          AND (
            SELECT COUNT(*) FROM faces f_cluster
            WHERE f_cluster.cluster_id = c_unassigned.id
          ) < 2
      )
    )
  )`;
}

// ---------------------------------------------------------------------------
// Core clustering algorithm
// ---------------------------------------------------------------------------

async function dissolveSingleFaceClustersWithClient(
  client: PoolClient
): Promise<number> {
  const singles = await client.query<{ id: string; face_id: string }>(
    `SELECT c.id, f.id AS face_id
     FROM face_clusters c
     JOIN faces f ON f.cluster_id = c.id
     WHERE c.person_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM face_manual_assignments ma
         WHERE ma.face_id = f.id AND ma.cluster_id = c.id
       )
     GROUP BY c.id, f.id
     HAVING (SELECT COUNT(*) FROM faces f2 WHERE f2.cluster_id = c.id) = 1`
  );

  if (singles.rows.length === 0) return 0;
  const clusterIds = singles.rows.map((row) => row.id);
  const faceIds = singles.rows.map((row) => row.face_id);
  await client.query(
    `UPDATE faces SET cluster_id = NULL, person_id = NULL
     WHERE id = ANY($1::uuid[])`,
    [faceIds]
  );
  await client.query(
    `DELETE FROM face_manual_assignments
     WHERE face_id = ANY($1::uuid[]) AND cluster_id = ANY($2::uuid[])`,
    [faceIds, clusterIds]
  );
  await client.query(`DELETE FROM face_clusters WHERE id = ANY($1::uuid[])`, [
    clusterIds,
  ]);
  return singles.rows.length;
}

async function updateClusterRepresentativeWithClient(
  client: PoolClient,
  clusterId: string,
  strategy: ClusterStrategy
): Promise<void> {
  if (strategy === "first") {
    await client.query(
      `UPDATE face_clusters SET representative_embedding = (
         SELECT f.embedding
         FROM faces f
         WHERE f.cluster_id = $1 AND f.embedding IS NOT NULL
         ORDER BY f.created_at ASC
         LIMIT 1
       )
       WHERE id = $1`,
      [clusterId]
    );
    return;
  }

  await client.query(
    `UPDATE face_clusters SET representative_embedding = sub.avg_emb
     FROM (
       SELECT AVG(f.embedding) AS avg_emb
       FROM faces f
       WHERE f.cluster_id = $1 AND f.embedding IS NOT NULL
     ) sub
     WHERE face_clusters.id = $1`,
    [clusterId]
  );
}

async function cleanupClusterWithClient(
  client: PoolClient,
  clusterId: string
): Promise<void> {
  const state = await client.query<{
    person_id: string | null;
    face_count: number;
    manual_count: number;
  }>(
    `SELECT
       c.person_id,
       (SELECT COUNT(*)::int FROM faces f WHERE f.cluster_id = c.id) AS face_count,
       (SELECT COUNT(*)::int FROM face_manual_assignments ma WHERE ma.cluster_id = c.id) AS manual_count
     FROM face_clusters c
     WHERE c.id = $1`,
    [clusterId]
  );
  const cluster = state.rows[0];
  if (!cluster) return;

  if (cluster.face_count === 0) {
    await client.query(`DELETE FROM face_clusters WHERE id = $1`, [clusterId]);
    return;
  }
  if (
    cluster.person_id === null &&
    cluster.face_count === 1 &&
    cluster.manual_count === 0
  ) {
    await client.query(
      `UPDATE faces SET cluster_id = NULL, person_id = NULL WHERE cluster_id = $1`,
      [clusterId]
    );
    await client.query(`DELETE FROM face_clusters WHERE id = $1`, [clusterId]);
    return;
  }
  await updateClusterRepresentativeWithClient(client, clusterId, "average");
}

async function clusterUnassignedFacesWithClient(
  client: PoolClient,
  fqFilter: string,
  candidateFqFilter: string,
  opts: { threshold: number; strategy: ClusterStrategy }
): Promise<ClusteringResult> {
  const { threshold, strategy } = opts;
  const unclustered = await client.query<{
    id: string;
    photo_id: string;
    embedding: string;
  }>(
    `SELECT f.id, f.photo_id, f.embedding::text
     FROM faces f
     WHERE f.cluster_id IS NULL
       AND f.embedding IS NOT NULL
       AND ${fqFilter}
       AND NOT EXISTS (
         SELECT 1 FROM face_manual_assignments ma WHERE ma.face_id = f.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM face_assignment_exclusions x WHERE x.face_id = f.id
       )
     ORDER BY f.created_at ASC, f.id ASC
     FOR UPDATE OF f`
  );

  let clustered = 0;
  let newClusters = 0;
  const assignedDuringRun = new Set<string>();
  for (const face of unclustered.rows) {
    if (assignedDuringRun.has(face.id)) continue;
    const nearest = await client.query<{
      id: string;
      person_id: string | null;
      similarity: number;
    }>(
      `SELECT
         c.id,
         c.person_id,
         1 - (c.representative_embedding <=> $1::vector) AS similarity
       FROM face_clusters c
       WHERE c.representative_embedding IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM face_rejections r
           WHERE r.face_id = $2 AND r.cluster_id = c.id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM faces member
           JOIN face_pair_rejections rejected_pair
             ON (rejected_pair.face_id_a = LEAST($2::uuid, member.id)
                 AND rejected_pair.face_id_b = GREATEST($2::uuid, member.id))
           WHERE member.cluster_id = c.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM faces same_photo
           WHERE same_photo.cluster_id = c.id AND same_photo.photo_id = $3
         )
       ORDER BY c.representative_embedding <=> $1::vector
       LIMIT 1`,
      [face.embedding, face.id, face.photo_id]
    );

    if (nearest.rows[0]?.similarity >= threshold) {
      const match = nearest.rows[0];
      await client.query(
        `UPDATE faces SET cluster_id = $1, person_id = $2 WHERE id = $3`,
        [match.id, match.person_id, face.id]
      );
      if (strategy === "average") {
        await updateClusterRepresentativeWithClient(client, match.id, strategy);
      }
      assignedDuringRun.add(face.id);
      clustered++;
    } else {
      // Do not create a disposable singleton. Seed a new cluster only when a
      // second compatible unassigned face exists.
      const partner = await client.query<{ id: string; embedding: string; similarity: number }>(
        `SELECT
           candidate.id,
           candidate.embedding::text,
           1 - (candidate.embedding <=> $1::vector) AS similarity
         FROM faces candidate
         WHERE candidate.id <> $2
           AND candidate.photo_id <> $3
           AND candidate.cluster_id IS NULL
           AND candidate.embedding IS NOT NULL
           AND ${candidateFqFilter}
           AND NOT EXISTS (
             SELECT 1 FROM face_manual_assignments ma WHERE ma.face_id = candidate.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM face_assignment_exclusions x WHERE x.face_id = candidate.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM face_pair_rejections rejected_pair
             WHERE rejected_pair.face_id_a = LEAST($2::uuid, candidate.id)
               AND rejected_pair.face_id_b = GREATEST($2::uuid, candidate.id)
           )
         ORDER BY candidate.embedding <=> $1::vector
         LIMIT 1`,
        [face.embedding, face.id, face.photo_id]
      );
      if (partner.rows[0]?.similarity >= threshold) {
        const created = await client.query<{ id: string }>(
          `INSERT INTO face_clusters (representative_embedding)
           VALUES ($1::vector)
           RETURNING id`,
          [face.embedding]
        );
        await client.query(
          `UPDATE faces SET cluster_id = $1, person_id = NULL
           WHERE id = ANY($2::uuid[])`,
          [created.rows[0].id, [face.id, partner.rows[0].id]]
        );
        if (strategy === "average") {
          await updateClusterRepresentativeWithClient(client, created.rows[0].id, strategy);
        }
        assignedDuringRun.add(face.id);
        assignedDuringRun.add(partner.rows[0].id);
        newClusters++;
        clustered += 2;
      }
    }
  }

  const dissolved = await dissolveSingleFaceClustersWithClient(client);
  if (dissolved > 0) {
    logger.info(`Dissolved ${dissolved} single-face clusters`);
  }
  return { clustered, newClusters };
}

/**
 * Cluster faces that have no cluster_id assigned.
 * Matches against all existing clusters (named + unnamed).
 * Respects face_rejections and skips face_manual_assignments.
 */
export async function clusterUnassignedFaces(
  opts: { threshold?: number; strategy?: ClusterStrategy } = {}
): Promise<ClusteringResult> {
  const threshold = opts.threshold ?? 0.6;
  const strategy = opts.strategy ?? "average";
  const fqSettings = await getFaceQualitySettings();
  const fqFilter = faceQualityFilter("f", fqSettings);
  const candidateFqFilter = faceQualityFilter("candidate", fqSettings);

  return withTransaction(async (client) => {
    await lockClusterMutation(client);
    const result = await clusterUnassignedFacesWithClient(client, fqFilter, candidateFqFilter, {
      threshold,
      strategy,
    });
    logger.info(
      `Clustering complete: ${result.clustered} faces assigned, ${result.newClusters} new clusters created`
    );
    return result;
  });
}

/**
 * Recluster all faces while preserving named clusters and manual assignments.
 *
 * 1. Named clusters (person_id IS NOT NULL) are preserved as anchors.
 * 2. Manually assigned faces are never moved.
 * 3. Unnamed clusters are dissolved (non-locked faces freed).
 * 4. All freed + unclustered faces are re-clustered with new params.
 */
export async function reclusterFaces(
  opts: { threshold: number; strategy: ClusterStrategy }
): Promise<ReclusterResult> {
  const { threshold, strategy } = opts;
  const fqSettings = await getFaceQualitySettings();
  const fqFilter = faceQualityFilter("f", fqSettings);
  const candidateFqFilter = faceQualityFilter("candidate", fqSettings);

  return withTransaction(async (client) => {
    await lockClusterMutation(client);
    const namedResult = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM face_clusters WHERE person_id IS NOT NULL`
    );
    const unnamedClusters = await client.query<{ id: string }>(
      `SELECT id FROM face_clusters WHERE person_id IS NULL ORDER BY id FOR UPDATE`
    );

    for (const cluster of unnamedClusters.rows) {
      await client.query(
        `UPDATE faces SET cluster_id = NULL, person_id = NULL
         WHERE cluster_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM face_manual_assignments ma
             WHERE ma.face_id = faces.id AND ma.cluster_id = $1
           )`,
        [cluster.id]
      );
      const remaining = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM faces WHERE cluster_id = $1`,
        [cluster.id]
      );
      if (remaining.rows[0].count === 0) {
        await client.query(`DELETE FROM face_clusters WHERE id = $1`, [cluster.id]);
      } else {
        await updateClusterRepresentativeWithClient(client, cluster.id, strategy);
      }
    }

    const result = await clusterUnassignedFacesWithClient(client, fqFilter, candidateFqFilter, {
      threshold,
      strategy,
    });
    const totalResult = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM face_clusters`
    );
    return {
      totalClusters: totalResult.rows[0].count,
      namedPreserved: namedResult.rows[0].count,
      newClusters: result.newClusters,
    };
  });
}

// ---------------------------------------------------------------------------
// Cluster CRUD
// ---------------------------------------------------------------------------

/** Get all clusters with face count and representative face info.
 *  Excludes automatic unnamed clusters with fewer than 2 faces, but
 *  keeps a singleton cluster when the user explicitly created it.
 *  Assigned faces remain visible even when quality settings change. */
export async function getAllClusters(): Promise<ClusterRecord[]> {
  const result = await query<ClusterRecord>(
    `SELECT
       c.id,
       c.person_id,
       p.name AS person_name,
       (SELECT COUNT(*)::int FROM faces f WHERE f.cluster_id = c.id) AS face_count,
       rep.id AS representative_face_id,
       rep.photo_id AS representative_photo_id,
       rep.bounding_box AS representative_bounding_box
     FROM face_clusters c
     LEFT JOIN persons p ON p.id = c.person_id
     LEFT JOIN LATERAL (
       SELECT f.id, f.photo_id, f.bounding_box
       FROM faces f
       WHERE f.cluster_id = c.id
       ORDER BY
         f.confidence DESC NULLS LAST,
         (f.bounding_box->>'width')::int * (f.bounding_box->>'height')::int DESC,
         f.created_at ASC
       LIMIT 1
     ) rep ON true
     WHERE c.person_id IS NOT NULL
        OR (SELECT COUNT(*) FROM faces f2 WHERE f2.cluster_id = c.id) >= 2
        OR EXISTS (
          SELECT 1 FROM face_manual_assignments ma WHERE ma.cluster_id = c.id
        )
     ORDER BY
       CASE WHEN c.person_id IS NULL THEN 0 ELSE 1 END,
       face_count DESC`
  );

  return result.rows;
}

/** Get all assigned faces in a cluster, regardless of the current quality gate. */
export async function getClusterFaces(
  clusterId: string
): Promise<ClusterFaceRecord[]> {
  const result = await query<ClusterFaceRecord>(
    `SELECT
       f.id,
       f.photo_id,
       f.bounding_box,
       ph.width AS photo_width,
       ph.height AS photo_height,
       f.confidence,
       (f.bounding_box->>'width')::int * (f.bounding_box->>'height')::int AS area
     FROM faces f
     JOIN photos ph ON ph.id = f.photo_id
     WHERE f.cluster_id = $1
     ORDER BY f.created_at ASC`,
    [clusterId]
  );

  return result.rows;
}

/** Get faces that are effectively unassigned: no cluster, or in an automatic
 *  single-face unnamed cluster. Manually created singletons are assigned.
 *  Only returns faces that pass quality thresholds. */
export async function getUnclusteredFaces(
  limit = 40,
  offset = 0
): Promise<{ faces: ClusterFaceRecord[]; total: number; hasMore: boolean }> {
  const fqSettings = await getFaceQualitySettings();
  const fqFilter = faceQualityFilter("f", fqSettings);
  const unassignedFilter = effectivelyUnassignedFilter("f");
  const normalizedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 40;
  const normalizedOffset = Number.isFinite(offset) ? Math.trunc(offset) : 0;
  const safeLimit = Math.min(Math.max(normalizedLimit, 1), 100);
  const safeOffset = Math.max(normalizedOffset, 0);

  const [facesResult, countResult] = await Promise.all([
    query<ClusterFaceRecord>(
      `SELECT
         f.id,
         f.photo_id,
         f.bounding_box,
         ph.width AS photo_width,
         ph.height AS photo_height,
         f.confidence,
         (f.bounding_box->>'width')::int * (f.bounding_box->>'height')::int AS area
       FROM faces f
       JOIN photos ph ON ph.id = f.photo_id
       WHERE f.embedding IS NOT NULL
         AND ${fqFilter}
         AND ${unassignedFilter}
         AND NOT EXISTS (
           SELECT 1 FROM face_assignment_exclusions x WHERE x.face_id = f.id
         )
       ORDER BY f.created_at DESC, f.id DESC
       LIMIT $1 OFFSET $2`,
      [safeLimit, safeOffset]
    ),
    query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM faces f
       WHERE f.embedding IS NOT NULL
         AND ${fqFilter}
         AND ${unassignedFilter}
         AND NOT EXISTS (
           SELECT 1 FROM face_assignment_exclusions x WHERE x.face_id = f.id
         )`
    ),
  ]);

  const total = countResult.rows[0]?.count ?? 0;
  return {
    faces: facesResult.rows,
    total,
    hasMore: safeOffset + facesResult.rows.length < total,
  };
}

/** Get faces excluded specifically by the current confidence or area gate. */
export async function getFilteredOutFaces(
  limit = 200
): Promise<{ faces: ClusterFaceRecord[]; total: number }> {
  const fqSettings = await getFaceQualitySettings();
  const fqFilter = faceQualityFilter("f", fqSettings);
  const unassignedFilter = effectivelyUnassignedFilter("f");
  const normalizedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 200;
  const safeLimit = Math.min(Math.max(normalizedLimit, 1), 500);

  const [facesResult, countResult] = await Promise.all([
    query<ClusterFaceRecord>(
      `SELECT
         f.id,
         f.photo_id,
         f.bounding_box,
         ph.width AS photo_width,
         ph.height AS photo_height,
         f.confidence,
         (f.bounding_box->>'width')::int * (f.bounding_box->>'height')::int AS area
       FROM faces f
       JOIN photos ph ON ph.id = f.photo_id
       WHERE (${fqFilter}) IS NOT TRUE
         AND ${unassignedFilter}
         AND NOT EXISTS (
           SELECT 1 FROM face_assignment_exclusions x WHERE x.face_id = f.id
         )
       ORDER BY f.created_at DESC
       LIMIT $1`,
      [safeLimit]
    ),
    query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM faces f
       WHERE (${fqFilter}) IS NOT TRUE
         AND ${unassignedFilter}
         AND NOT EXISTS (
           SELECT 1 FROM face_assignment_exclusions x WHERE x.face_id = f.id
         )`
    ),
  ]);

  return {
    faces: facesResult.rows,
    total: countResult.rows[0]?.count ?? 0,
  };
}

/** Get faces manually excluded from assignment and automatic clustering. */
export async function getWontAssignFaces(
  limit = 200
): Promise<{ faces: ClusterFaceRecord[]; total: number }> {
  const normalizedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 200;
  const safeLimit = Math.min(Math.max(normalizedLimit, 1), 500);
  const [facesResult, countResult] = await Promise.all([
    query<ClusterFaceRecord>(
      `SELECT
         f.id,
         f.photo_id,
         f.bounding_box,
         ph.width AS photo_width,
         ph.height AS photo_height,
         f.confidence,
         (f.bounding_box->>'width')::int * (f.bounding_box->>'height')::int AS area
       FROM face_assignment_exclusions x
       JOIN faces f ON f.id = x.face_id
       JOIN photos ph ON ph.id = f.photo_id
       ORDER BY x.created_at DESC
       LIMIT $1`,
      [safeLimit]
    ),
    query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM face_assignment_exclusions`
    ),
  ]);

  return {
    faces: facesResult.rows,
    total: countResult.rows[0]?.count ?? 0,
  };
}

/** Manually exclude an effectively unassigned face from future clustering. */
export async function markFaceWontAssign(faceId: string): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query<{
      cluster_id: string | null;
      cluster_person_id: string | null;
      cluster_face_count: number;
      manually_assigned: boolean;
    }>(
      `SELECT
         f.cluster_id,
         c.person_id AS cluster_person_id,
         CASE
           WHEN f.cluster_id IS NULL THEN 0
           ELSE (SELECT COUNT(*)::int FROM faces f2 WHERE f2.cluster_id = f.cluster_id)
         END AS cluster_face_count,
         EXISTS (
           SELECT 1 FROM face_manual_assignments ma WHERE ma.face_id = f.id
         ) AS manually_assigned
       FROM faces f
       LEFT JOIN face_clusters c ON c.id = f.cluster_id
       WHERE f.id = $1
       FOR UPDATE OF f`,
      [faceId]
    );

    const face = result.rows[0];
    if (!face) throw new Error("Face not found");

    const isAssigned =
      face.cluster_id !== null &&
      (face.cluster_person_id !== null ||
        face.cluster_face_count >= 2 ||
        face.manually_assigned);
    if (isAssigned) {
      throw new Error("Assigned faces cannot be marked as won't assign");
    }

    await client.query(
      `INSERT INTO face_assignment_exclusions (face_id)
       VALUES ($1)
       ON CONFLICT (face_id) DO NOTHING`,
      [faceId]
    );

    if (face.cluster_id) {
      await client.query(
        `UPDATE faces SET cluster_id = NULL, person_id = NULL WHERE id = $1`,
        [faceId]
      );
      await client.query(
        `DELETE FROM face_clusters
         WHERE id = $1
           AND person_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM faces WHERE cluster_id = $1)`,
        [face.cluster_id]
      );
    }
  });
}

/** Restore a manually excluded face to normal gate and clustering behavior. */
export async function restoreFaceAssignment(faceId: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM face_assignment_exclusions WHERE face_id = $1 RETURNING face_id`,
    [faceId]
  );
  return result.rowCount === 1;
}

// ---------------------------------------------------------------------------
// Face ↔ Cluster operations
// ---------------------------------------------------------------------------

/**
 * Create a new cluster from a single face (manual action).
 * Records a manual assignment so this face is locked across reclusters.
 */
export async function createClusterFromFace(
  faceId: string
): Promise<{ clusterId: string }> {
  return withTransaction(async (client) => {
    await lockClusterMutation(client);
    const face = await client.query<{
      embedding: string | null;
      cluster_id: string | null;
      cluster_person_id: string | null;
      cluster_face_count: number;
    }>(
      `SELECT
         f.embedding::text,
         f.cluster_id,
         c.person_id AS cluster_person_id,
         CASE
           WHEN f.cluster_id IS NULL THEN 0
           ELSE (SELECT COUNT(*)::int FROM faces f2 WHERE f2.cluster_id = f.cluster_id)
         END AS cluster_face_count
       FROM faces f
       LEFT JOIN face_clusters c ON c.id = f.cluster_id
       WHERE f.id = $1
       FOR UPDATE OF f`,
      [faceId]
    );
    const current = face.rows[0];
    if (!current) throw new Error("Face not found");
    if (!current.embedding) throw new Error("Face has no embedding");
    if (current.cluster_id) {
      await client.query(`SELECT id FROM face_clusters WHERE id = $1 FOR UPDATE`, [
        current.cluster_id,
      ]);
    }

    if (
      current.cluster_id &&
      current.cluster_person_id === null &&
      current.cluster_face_count === 1
    ) {
      await client.query(
        `INSERT INTO face_manual_assignments (face_id, cluster_id)
         VALUES ($1, $2)
         ON CONFLICT (face_id) DO UPDATE SET cluster_id = EXCLUDED.cluster_id`,
        [faceId, current.cluster_id]
      );
      await client.query(`DELETE FROM face_assignment_exclusions WHERE face_id = $1`, [
        faceId,
      ]);
      return { clusterId: current.cluster_id };
    }

    const created = await client.query<{ id: string }>(
      `INSERT INTO face_clusters (representative_embedding)
       VALUES ($1::vector)
       RETURNING id`,
      [current.embedding]
    );
    const clusterId = created.rows[0].id;
    await client.query(
      `UPDATE faces SET cluster_id = $1, person_id = NULL WHERE id = $2`,
      [clusterId, faceId]
    );
    await client.query(
      `INSERT INTO face_manual_assignments (face_id, cluster_id)
       VALUES ($1, $2)
       ON CONFLICT (face_id) DO UPDATE SET cluster_id = EXCLUDED.cluster_id`,
      [faceId, clusterId]
    );
    await client.query(`DELETE FROM face_assignment_exclusions WHERE face_id = $1`, [
      faceId,
    ]);
    if (current.cluster_id && current.cluster_id !== clusterId) {
      await cleanupClusterWithClient(client, current.cluster_id);
    }
    return { clusterId };
  });
}

/**
 * Manually assign a face to an existing cluster.
 * Records a manual assignment so this face is locked across reclusters.
 */
export async function assignFaceToCluster(
  faceId: string,
  clusterId: string
): Promise<void> {
  await withTransaction(async (client) => {
    await lockClusterMutation(client);
    const faceResult = await client.query<{ cluster_id: string | null }>(
      `SELECT cluster_id FROM faces WHERE id = $1 FOR UPDATE`,
      [faceId]
    );
    if (!faceResult.rows[0]) throw new Error("Face not found");
    const sourceClusterId = faceResult.rows[0].cluster_id;

    const clusterIds = [clusterId, sourceClusterId]
      .filter((id): id is string => id !== null)
      .sort();
    const clusters = await client.query<{ id: string; person_id: string | null }>(
      `SELECT id, person_id
       FROM face_clusters
       WHERE id = ANY($1::uuid[])
       ORDER BY id
       FOR UPDATE`,
      [clusterIds]
    );
    const target = clusters.rows.find((cluster) => cluster.id === clusterId);
    if (!target) throw new Error("Cluster not found");

    await client.query(
      `UPDATE faces SET cluster_id = $1, person_id = $2 WHERE id = $3`,
      [clusterId, target.person_id, faceId]
    );
    await client.query(
      `INSERT INTO face_manual_assignments (face_id, cluster_id)
       VALUES ($1, $2)
       ON CONFLICT (face_id) DO UPDATE SET cluster_id = EXCLUDED.cluster_id`,
      [faceId, clusterId]
    );
    await client.query(
      `DELETE FROM face_rejections WHERE face_id = $1 AND cluster_id = $2`,
      [faceId, clusterId]
    );
    await client.query(
      `DELETE FROM face_pair_rejections rejected_pair
       USING faces member
       WHERE member.cluster_id = $2
         AND rejected_pair.face_id_a = LEAST($1::uuid, member.id)
         AND rejected_pair.face_id_b = GREATEST($1::uuid, member.id)`,
      [faceId, clusterId]
    );
    await client.query(`DELETE FROM face_assignment_exclusions WHERE face_id = $1`, [
      faceId,
    ]);

    await updateClusterRepresentativeWithClient(client, clusterId, "average");
    if (sourceClusterId && sourceClusterId !== clusterId) {
      await cleanupClusterWithClient(client, sourceClusterId);
    }
  });
}

/** Merge a source cluster into a target cluster as one atomic manual action. */
export async function mergeClusters(
  sourceClusterId: string,
  targetClusterId: string,
  opts: { lockAllFaces?: boolean } = {}
): Promise<{ faceCount: number; personId: string | null }> {
  if (sourceClusterId === targetClusterId) {
    throw new Error("Source and target clusters must be different");
  }

  return withTransaction(async (client) => {
    await lockClusterMutation(client);
    const clusters = await client.query<{
      id: string;
      person_id: string | null;
    }>(
      `SELECT id, person_id
       FROM face_clusters
       WHERE id = ANY($1::uuid[])
       ORDER BY id
       FOR UPDATE`,
      [[sourceClusterId, targetClusterId]]
    );

    const source = clusters.rows.find((cluster) => cluster.id === sourceClusterId);
    const target = clusters.rows.find((cluster) => cluster.id === targetClusterId);
    if (!source || !target) {
      throw new Error("Source or target cluster not found");
    }

    if (
      source.person_id &&
      target.person_id &&
      source.person_id !== target.person_id
    ) {
      throw new Error("Named clusters belong to different people");
    }

    // The target identity wins. If it is unnamed, preserve the source identity.
    const personId = target.person_id ?? source.person_id;
    await client.query(
      `UPDATE face_clusters SET person_id = $1 WHERE id = $2`,
      [personId, targetClusterId]
    );

    // A manual merge overrides any earlier rejection of the target cluster.
    await client.query(
      `DELETE FROM face_rejections r
       USING faces f
       WHERE f.cluster_id = $1
         AND r.face_id = f.id
         AND r.cluster_id = $2`,
      [sourceClusterId, targetClusterId]
    );
    await client.query(
      `DELETE FROM face_pair_rejections rejected_pair
       USING faces source_face, faces target_face
       WHERE source_face.cluster_id = $1
         AND target_face.cluster_id = $2
         AND rejected_pair.face_id_a = LEAST(source_face.id, target_face.id)
         AND rejected_pair.face_id_b = GREATEST(source_face.id, target_face.id)`,
      [sourceClusterId, targetClusterId]
    );

    await client.query(
      `UPDATE faces
       SET cluster_id = $1
       WHERE cluster_id = $2`,
      [targetClusterId, sourceClusterId]
    );
    await client.query(
      `UPDATE faces
       SET person_id = $1
       WHERE cluster_id = $2`,
      [personId, targetClusterId]
    );

    if (opts.lockAllFaces ?? true) {
      // Keep a user-confirmed merge intact across future reclustering.
      await client.query(
        `INSERT INTO face_manual_assignments (face_id, cluster_id)
         SELECT id, $1 FROM faces WHERE cluster_id = $1
         ON CONFLICT (face_id) DO UPDATE SET cluster_id = EXCLUDED.cluster_id`,
        [targetClusterId]
      );
    } else {
      // Automatic merges retain existing manual locks without turning every
      // automatically grouped face into a manual assignment.
      await client.query(
        `UPDATE face_manual_assignments
         SET cluster_id = $1
         WHERE cluster_id = $2`,
        [targetClusterId, sourceClusterId]
      );
    }

    await client.query(`DELETE FROM face_clusters WHERE id = $1`, [sourceClusterId]);

    await client.query(
      `UPDATE face_clusters
       SET representative_embedding = (
         SELECT AVG(f.embedding) FROM faces f
         WHERE f.cluster_id = $1 AND f.embedding IS NOT NULL
       )
       WHERE id = $1`,
      [targetClusterId]
    );

    const count = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM faces WHERE cluster_id = $1`,
      [targetClusterId]
    );

    return {
      faceCount: count.rows[0]?.count ?? 0,
      personId,
    };
  });
}

/**
 * Rank conservative cluster-to-cluster merge candidates. Differently named
 * identities, same-photo conflicts, and prior rejection feedback are excluded.
 */
export async function getMergeSuggestions(
  opts: {
    minSimilarity?: number;
    supportSimilarity?: number;
    neighborsPerCluster?: number;
    limit?: number;
  } = {}
): Promise<MergeSuggestionRecord[]> {
  const minSimilarity = opts.minSimilarity ?? DEFAULT_MERGE_SUGGESTION_SIMILARITY;
  const supportSimilarity = opts.supportSimilarity ?? 0.55;
  const neighbors = Math.min(Math.max(opts.neighborsPerCluster ?? 4, 1), 20);
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);

  const result = await query<MergeSuggestionRecord>(
    `WITH raw_candidates AS (
       SELECT c.id AS left_id, neighbor.id AS right_id
       FROM face_clusters c
       CROSS JOIN LATERAL (
         SELECT other.id
         FROM face_clusters other
         WHERE other.id <> c.id
           AND other.representative_embedding IS NOT NULL
         ORDER BY other.representative_embedding <=> c.representative_embedding
         LIMIT $1
       ) neighbor
       WHERE c.representative_embedding IS NOT NULL
     ), candidate_pairs AS (
       SELECT DISTINCT source_id, target_id
       FROM (
         SELECT
           LEAST(left_id, right_id) AS source_id,
           GREATEST(left_id, right_id) AS target_id
         FROM raw_candidates
         UNION ALL
         SELECT source.id, target.id
         FROM face_clusters source
         JOIN face_clusters target
           ON target.person_id = source.person_id AND target.id > source.id
         WHERE source.person_id IS NOT NULL
       ) candidates
     )
     SELECT
       source.id AS source_cluster_id,
       target.id AS target_cluster_id,
       source.person_id AS source_person_id,
       target.person_id AS target_person_id,
       source_person.name AS source_person_name,
       target_person.name AS target_person_name,
       (SELECT COUNT(*)::int FROM faces f WHERE f.cluster_id = source.id) AS source_face_count,
       (SELECT COUNT(*)::int FROM faces f WHERE f.cluster_id = target.id) AS target_face_count,
       (1 - (source.representative_embedding <=> target.representative_embedding))::real AS similarity,
       COALESCE((
         SELECT AVG((matches.nearest_similarity >= $3)::int)::real
         FROM (
           SELECT 1 - MIN(sf.embedding <=> tf.embedding) AS nearest_similarity
           FROM LATERAL (
             SELECT id, embedding FROM faces
             WHERE cluster_id = source.id AND embedding IS NOT NULL
             ORDER BY confidence DESC NULLS LAST, created_at
             LIMIT 20
           ) sf
           CROSS JOIN LATERAL (
             SELECT id, embedding FROM faces
             WHERE cluster_id = target.id AND embedding IS NOT NULL
             ORDER BY confidence DESC NULLS LAST, created_at
             LIMIT 20
           ) tf
           GROUP BY sf.id
         ) matches
       ), 0)::real AS source_coverage,
       COALESCE((
         SELECT AVG((matches.nearest_similarity >= $3)::int)::real
         FROM (
           SELECT 1 - MIN(tf.embedding <=> sf.embedding) AS nearest_similarity
           FROM LATERAL (
             SELECT id, embedding FROM faces
             WHERE cluster_id = target.id AND embedding IS NOT NULL
             ORDER BY confidence DESC NULLS LAST, created_at
             LIMIT 20
           ) tf
           CROSS JOIN LATERAL (
             SELECT id, embedding FROM faces
             WHERE cluster_id = source.id AND embedding IS NOT NULL
             ORDER BY confidence DESC NULLS LAST, created_at
             LIMIT 20
           ) sf
           GROUP BY tf.id
         ) matches
       ), 0)::real AS target_coverage,
       CASE
         WHEN source.person_id IS NOT NULL AND source.person_id = target.person_id
           THEN 'same-person'
         ELSE 'high-similarity'
       END AS reason
     FROM candidate_pairs pair
     JOIN face_clusters source ON source.id = pair.source_id
     JOIN face_clusters target ON target.id = pair.target_id
     LEFT JOIN persons source_person ON source_person.id = source.person_id
     LEFT JOIN persons target_person ON target_person.id = target.person_id
     WHERE
       (source.person_id IS NULL OR target.person_id IS NULL OR source.person_id = target.person_id)
       AND (
         (source.person_id IS NOT NULL AND source.person_id = target.person_id)
         OR 1 - (source.representative_embedding <=> target.representative_embedding) >= $2
       )
       AND NOT EXISTS (
         SELECT 1
         FROM faces sf
         JOIN faces tf ON tf.photo_id = sf.photo_id
         WHERE sf.cluster_id = source.id AND tf.cluster_id = target.id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM faces f
         JOIN face_rejections r ON r.face_id = f.id
         WHERE (f.cluster_id = source.id AND r.cluster_id = target.id)
            OR (f.cluster_id = target.id AND r.cluster_id = source.id)
       )
       AND NOT EXISTS (
         SELECT 1
         FROM faces sf
         JOIN faces tf ON tf.cluster_id = target.id
         JOIN face_pair_rejections rejected_pair
           ON rejected_pair.face_id_a = LEAST(sf.id, tf.id)
          AND rejected_pair.face_id_b = GREATEST(sf.id, tf.id)
         WHERE sf.cluster_id = source.id
       )
     ORDER BY
       (source.person_id IS NOT NULL AND source.person_id = target.person_id) DESC,
       similarity DESC
     LIMIT $4`,
    [neighbors, minSimilarity, supportSimilarity, limit]
  );
  return result.rows;
}

/** Merge only exact-identity or strongly supported high-similarity pairs. */
export async function autoMergeClusters(
  opts: {
    threshold?: number;
    minCoverage?: number;
    maxMerges?: number;
  } = {}
): Promise<AutoMergeResult> {
  const threshold = opts.threshold ?? DEFAULT_AUTO_MERGE_SIMILARITY;
  const minCoverage = opts.minCoverage ?? DEFAULT_AUTO_MERGE_COVERAGE;
  const maxMerges = Math.min(Math.max(opts.maxMerges ?? 50, 1), 200);
  const suggestions = await getMergeSuggestions({
    minSimilarity: Math.min(threshold, DEFAULT_MERGE_SUGGESTION_SIMILARITY),
    limit: Math.min(maxMerges * 4, 200),
  });
  const usedClusters = new Set<string>();
  let merged = 0;

  for (const suggestion of suggestions) {
    if (merged >= maxMerges) break;
    if (
      usedClusters.has(suggestion.source_cluster_id) ||
      usedClusters.has(suggestion.target_cluster_id)
    ) {
      continue;
    }
    const eligible =
      suggestion.reason === "same-person" ||
      (suggestion.similarity >= threshold &&
        suggestion.source_coverage >= minCoverage &&
        suggestion.target_coverage >= minCoverage);
    if (!eligible) continue;

    const sourceIsPreferredTarget =
      (suggestion.source_person_id !== null && suggestion.target_person_id === null) ||
      (suggestion.source_person_id === suggestion.target_person_id &&
        suggestion.source_face_count > suggestion.target_face_count);
    const sourceId = sourceIsPreferredTarget
      ? suggestion.target_cluster_id
      : suggestion.source_cluster_id;
    const targetId = sourceIsPreferredTarget
      ? suggestion.source_cluster_id
      : suggestion.target_cluster_id;
    await mergeClusters(sourceId, targetId, { lockAllFaces: false });
    usedClusters.add(suggestion.source_cluster_id);
    usedClusters.add(suggestion.target_cluster_id);
    merged++;
  }

  const remaining = await getMergeSuggestions({
    minSimilarity: DEFAULT_MERGE_SUGGESTION_SIMILARITY,
    limit: 200,
  });
  return { merged, remainingSuggestions: remaining.length };
}

/**
 * Remove a face from its cluster and record a rejection.
 * The face becomes unassigned and won't be re-assigned to this cluster
 * by automatic clustering.
 */
export async function removeFaceFromCluster(
  faceId: string,
  clusterId: string
): Promise<void> {
  await withTransaction(async (client) => {
    await lockClusterMutation(client);
    const faceResult = await client.query<{ cluster_id: string | null }>(
      `SELECT cluster_id FROM faces WHERE id = $1 FOR UPDATE`,
      [faceId]
    );
    if (!faceResult.rows[0]) throw new Error("Face not found");
    if (faceResult.rows[0].cluster_id !== clusterId) {
      throw new Error("Face does not belong to cluster");
    }
    const clusterResult = await client.query(
      `SELECT id FROM face_clusters WHERE id = $1 FOR UPDATE`,
      [clusterId]
    );
    if (!clusterResult.rows[0]) throw new Error("Cluster not found");

    await client.query(
      `UPDATE faces SET cluster_id = NULL, person_id = NULL WHERE id = $1`,
      [faceId]
    );
    await client.query(
      `INSERT INTO face_rejections (face_id, cluster_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [faceId, clusterId]
    );
    await client.query(
      `INSERT INTO face_pair_rejections (face_id_a, face_id_b)
       SELECT LEAST($1::uuid, member.id), GREATEST($1::uuid, member.id)
       FROM faces member
       WHERE member.cluster_id = $2 AND member.id <> $1
       ON CONFLICT DO NOTHING`,
      [faceId, clusterId]
    );
    await client.query(`DELETE FROM face_manual_assignments WHERE face_id = $1`, [
      faceId,
    ]);
    await cleanupClusterWithClient(client, clusterId);
  });
}

/**
 * Name a cluster: finds or creates a person, links it to the cluster,
 * sets person_id on all faces, and locks all current faces as manual assignments.
 */
export async function nameCluster(
  clusterId: string,
  name: string
): Promise<{ personId: string }> {
  const trimmed = name.trim();

  return withTransaction(async (client) => {
    await lockClusterMutation(client);
    const cluster = await client.query(
      `SELECT id FROM face_clusters WHERE id = $1 FOR UPDATE`,
      [clusterId]
    );
    if (!cluster.rows[0]) throw new Error("Cluster not found");
    const person = await client.query<{ id: string }>(
      `INSERT INTO persons (name)
       VALUES ($1)
       ON CONFLICT (LOWER(BTRIM(name))) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [trimmed]
    );
    const personId = person.rows[0].id;
    await client.query(`UPDATE face_clusters SET person_id = $1 WHERE id = $2`, [
      personId,
      clusterId,
    ]);
    await client.query(`UPDATE faces SET person_id = $1 WHERE cluster_id = $2`, [
      personId,
      clusterId,
    ]);
    await client.query(
      `INSERT INTO face_manual_assignments (face_id, cluster_id)
       SELECT f.id, $1 FROM faces f WHERE f.cluster_id = $1
       ON CONFLICT (face_id) DO UPDATE SET cluster_id = EXCLUDED.cluster_id`,
      [clusterId]
    );
    return { personId };
  });
}

/**
 * Rename a cluster's person.
 */
export async function renameCluster(
  clusterId: string,
  name: string
): Promise<void> {
  const trimmed = name.trim();
  await withTransaction(async (client) => {
    await lockClusterMutation(client);
    const cluster = await client.query<{ person_id: string | null }>(
      `SELECT person_id FROM face_clusters WHERE id = $1 FOR UPDATE`,
      [clusterId]
    );
    if (!cluster.rows[0]) throw new Error("Cluster not found");

    const currentPersonId = cluster.rows[0].person_id;
    if (!currentPersonId) {
      const person = await client.query<{ id: string }>(
        `INSERT INTO persons (name)
         VALUES ($1)
         ON CONFLICT (LOWER(BTRIM(name))) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [trimmed]
      );
      await client.query(`UPDATE face_clusters SET person_id = $1 WHERE id = $2`, [
        person.rows[0].id,
        clusterId,
      ]);
      await client.query(`UPDATE faces SET person_id = $1 WHERE cluster_id = $2`, [
        person.rows[0].id,
        clusterId,
      ]);
      await client.query(
        `INSERT INTO face_manual_assignments (face_id, cluster_id)
         SELECT id, $1 FROM faces WHERE cluster_id = $1
         ON CONFLICT (face_id) DO UPDATE SET cluster_id = EXCLUDED.cluster_id`,
        [clusterId]
      );
      return;
    }

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM persons
       WHERE LOWER(BTRIM(name)) = LOWER(BTRIM($1))
         AND id <> $2
       LIMIT 1
       FOR UPDATE`,
      [trimmed, currentPersonId]
    );
    if (existing.rows[0]) {
      const targetPersonId = existing.rows[0].id;
      await client.query(`UPDATE face_clusters SET person_id = $1 WHERE person_id = $2`, [
        targetPersonId,
        currentPersonId,
      ]);
      await client.query(`UPDATE faces SET person_id = $1 WHERE person_id = $2`, [
        targetPersonId,
        currentPersonId,
      ]);
      await client.query(`DELETE FROM persons WHERE id = $1`, [currentPersonId]);
    } else {
      await client.query(`UPDATE persons SET name = $1 WHERE id = $2`, [
        trimmed,
        currentPersonId,
      ]);
    }
  });
}

// ---------------------------------------------------------------------------
// Representative embedding management
// ---------------------------------------------------------------------------

/**
 * Dissolve automatic unnamed clusters that have only 1 face.
 * Manually created and named clusters are preserved.
 */
export async function dissolveSingleFaceClusters(): Promise<number> {
  return withTransaction((client) => dissolveSingleFaceClustersWithClient(client));
}

/** Recompute a cluster representative using its first face or average. */
export async function updateClusterRepresentative(
  clusterId: string,
  strategy: ClusterStrategy
): Promise<void> {
  await withTransaction((client) =>
    updateClusterRepresentativeWithClient(client, clusterId, strategy)
  );
}
