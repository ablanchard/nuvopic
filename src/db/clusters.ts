import { query } from "./client.js";
import { logger } from "../logger.js";
import { getFaceQualitySettings, faceQualityFilter } from "./settings.js";

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

// ---------------------------------------------------------------------------
// Internal: embedding helpers
// ---------------------------------------------------------------------------

/** Format a number[] embedding as pgvector literal '[1,2,3,...]' */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

// ---------------------------------------------------------------------------
// Core clustering algorithm
// ---------------------------------------------------------------------------

/**
 * Cluster faces that have no cluster_id assigned.
 * Matches against all existing clusters (named + unnamed).
 * Respects face_rejections and skips face_manual_assignments.
 */
export async function clusterUnassignedFaces(
  opts: { threshold?: number; strategy?: ClusterStrategy } = {}
): Promise<ClusteringResult> {
  const threshold = opts.threshold ?? 0.6;
  const strategy = opts.strategy ?? "first";
  const fqSettings = await getFaceQualitySettings();
  const fqFilter = faceQualityFilter("f", fqSettings);

  // Fetch all unclustered faces with their embeddings (quality-filtered)
  const unclustered = await query<{
    id: string;
    embedding: string;
  }>(
    `SELECT f.id, f.embedding::text
     FROM faces f
     WHERE f.cluster_id IS NULL
       AND f.embedding IS NOT NULL
       AND ${fqFilter}
       AND f.id NOT IN (SELECT face_id FROM face_manual_assignments)
     ORDER BY f.created_at ASC`
  );

  if (unclustered.rows.length === 0) {
    return { clustered: 0, newClusters: 0 };
  }

  logger.info(
    `Clustering ${unclustered.rows.length} unassigned faces (threshold=${threshold}, strategy=${strategy})`
  );

  let clustered = 0;
  let newClusters = 0;

  for (const face of unclustered.rows) {
    // Find the nearest cluster that this face hasn't been rejected from
    const nearest = await query<{ id: string; similarity: number }>(
      `SELECT
         c.id,
         1 - (c.representative_embedding <=> $1::vector) AS similarity
       FROM face_clusters c
       WHERE c.id NOT IN (
         SELECT cluster_id FROM face_rejections WHERE face_id = $2
       )
       AND c.representative_embedding IS NOT NULL
       ORDER BY c.representative_embedding <=> $1::vector
       LIMIT 1`,
      [face.embedding, face.id]
    );

    if (nearest.rows.length > 0 && nearest.rows[0].similarity >= threshold) {
      // Assign to existing cluster
      const clusterId = nearest.rows[0].id;
      await query(`UPDATE faces SET cluster_id = $1 WHERE id = $2`, [
        clusterId,
        face.id,
      ]);

      if (strategy === "average") {
        await updateClusterRepresentative(clusterId, "average");
      }

      clustered++;
    } else {
      // Create a new cluster with this face as the representative
      const newCluster = await query<{ id: string }>(
        `INSERT INTO face_clusters (representative_embedding)
         VALUES ($1::vector)
         RETURNING id`,
        [face.embedding]
      );

      const clusterId = newCluster.rows[0].id;
      await query(`UPDATE faces SET cluster_id = $1 WHERE id = $2`, [
        clusterId,
        face.id,
      ]);

      newClusters++;
      clustered++;
    }
  }

  logger.info(
    `Clustering complete: ${clustered} faces clustered, ${newClusters} new clusters created`
  );

  // Dissolve any unnamed clusters that ended up with only 1 face
  await dissolveSingleFaceClusters();

  return { clustered, newClusters };
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

  // Count named clusters (preserved)
  const namedResult = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM face_clusters WHERE person_id IS NOT NULL`
  );
  const namedPreserved = namedResult.rows[0].count;

  // Get unnamed cluster IDs
  const unnamedClusters = await query<{ id: string }>(
    `SELECT id FROM face_clusters WHERE person_id IS NULL`
  );

  // For each unnamed cluster: free non-locked faces, delete if empty
  for (const cluster of unnamedClusters.rows) {
    // Free faces that are NOT manually assigned
    await query(
      `UPDATE faces SET cluster_id = NULL
       WHERE cluster_id = $1
         AND id NOT IN (
           SELECT face_id FROM face_manual_assignments WHERE cluster_id = $1
         )`,
      [cluster.id]
    );

    // Check if cluster still has any faces
    const remaining = await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM faces WHERE cluster_id = $1`,
      [cluster.id]
    );

    if (remaining.rows[0].count === 0) {
      // Delete empty cluster (cascade deletes rejections for this cluster)
      await query(`DELETE FROM face_clusters WHERE id = $1`, [cluster.id]);
    } else {
      // Update representative for remaining locked faces
      await updateClusterRepresentative(cluster.id, strategy);
    }
  }

  // Now cluster all freed + never-clustered faces
  const result = await clusterUnassignedFaces({ threshold, strategy });

  // Dissolve any unnamed clusters that ended up with only 1 face
  await dissolveSingleFaceClusters();

  // Count total clusters
  const totalResult = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM face_clusters`
  );

  return {
    totalClusters: totalResult.rows[0].count,
    namedPreserved,
    newClusters: result.newClusters,
  };
}

// ---------------------------------------------------------------------------
// Cluster CRUD
// ---------------------------------------------------------------------------

/** Get all clusters with face count and representative face info.
 *  Excludes unnamed clusters with fewer than 2 quality faces (not meaningful).
 *  Face counts only include faces that pass quality thresholds. */
export async function getAllClusters(): Promise<ClusterRecord[]> {
  const fqSettings = await getFaceQualitySettings();
  const fqFilter = faceQualityFilter("f", fqSettings);
  const fqFilter2 = faceQualityFilter("f2", fqSettings);

  const result = await query<ClusterRecord>(
    `SELECT
       c.id,
       c.person_id,
       p.name AS person_name,
       (SELECT COUNT(*)::int FROM faces f WHERE f.cluster_id = c.id AND ${fqFilter}) AS face_count,
       rep.id AS representative_face_id,
       rep.photo_id AS representative_photo_id,
       rep.bounding_box AS representative_bounding_box
     FROM face_clusters c
     LEFT JOIN persons p ON p.id = c.person_id
     LEFT JOIN LATERAL (
       SELECT f.id, f.photo_id, f.bounding_box
       FROM faces f
       WHERE f.cluster_id = c.id AND ${fqFilter}
       ORDER BY f.created_at ASC
       LIMIT 1
     ) rep ON true
     WHERE c.person_id IS NOT NULL
        OR (SELECT COUNT(*) FROM faces f2 WHERE f2.cluster_id = c.id AND ${fqFilter2}) >= 2
     ORDER BY
       CASE WHEN c.person_id IS NULL THEN 0 ELSE 1 END,
       face_count DESC`
  );

  return result.rows;
}

/** Get all quality faces in a cluster with photo dimensions for bounding box scaling. */
export async function getClusterFaces(
  clusterId: string
): Promise<ClusterFaceRecord[]> {
  const fqSettings = await getFaceQualitySettings();
  const fqFilter = faceQualityFilter("f", fqSettings);

  const result = await query<ClusterFaceRecord>(
    `SELECT
       f.id,
       f.photo_id,
       f.bounding_box,
       ph.width AS photo_width,
       ph.height AS photo_height
     FROM faces f
     JOIN photos ph ON ph.id = f.photo_id
     WHERE f.cluster_id = $1 AND ${fqFilter}
     ORDER BY f.created_at ASC`,
    [clusterId]
  );

  return result.rows;
}

/** Get faces that are effectively unassigned: no cluster, or in a single-face unnamed cluster.
 *  Only returns faces that pass quality thresholds. */
export async function getUnclusteredFaces(): Promise<ClusterFaceRecord[]> {
  const fqSettings = await getFaceQualitySettings();
  const fqFilter = faceQualityFilter("f", fqSettings);

  const result = await query<ClusterFaceRecord>(
    `SELECT
       f.id,
       f.photo_id,
       f.bounding_box,
       ph.width AS photo_width,
       ph.height AS photo_height
     FROM faces f
     JOIN photos ph ON ph.id = f.photo_id
     WHERE f.embedding IS NOT NULL
       AND ${fqFilter}
       AND (
         f.cluster_id IS NULL
         OR (
           -- In an unnamed cluster with only 1 face (treated as unassigned)
           EXISTS (
             SELECT 1 FROM face_clusters c
             WHERE c.id = f.cluster_id
               AND c.person_id IS NULL
               AND (SELECT COUNT(*) FROM faces f2 WHERE f2.cluster_id = c.id) < 2
           )
         )
       )
     ORDER BY f.created_at DESC
     LIMIT 200`
  );

  return result.rows;
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
  // Get the face's embedding
  const face = await query<{ embedding: string }>(
    `SELECT embedding::text FROM faces WHERE id = $1`,
    [faceId]
  );

  if (face.rows.length === 0) {
    throw new Error("Face not found");
  }

  // Create cluster with this face's embedding as representative
  const cluster = await query<{ id: string }>(
    `INSERT INTO face_clusters (representative_embedding)
     VALUES ($1::vector)
     RETURNING id`,
    [face.rows[0].embedding]
  );

  const clusterId = cluster.rows[0].id;

  // Assign face to cluster
  await query(`UPDATE faces SET cluster_id = $1 WHERE id = $2`, [
    clusterId,
    faceId,
  ]);

  // Record as manual assignment (locked)
  await query(
    `INSERT INTO face_manual_assignments (face_id, cluster_id)
     VALUES ($1, $2)
     ON CONFLICT (face_id) DO UPDATE SET cluster_id = $2`,
    [faceId, clusterId]
  );

  return { clusterId };
}

/**
 * Manually assign a face to an existing cluster.
 * Records a manual assignment so this face is locked across reclusters.
 */
export async function assignFaceToCluster(
  faceId: string,
  clusterId: string
): Promise<void> {
  // Update the face's cluster
  await query(`UPDATE faces SET cluster_id = $1 WHERE id = $2`, [
    clusterId,
    faceId,
  ]);

  // If the cluster has a person_id, also set person_id on the face
  const cluster = await query<{ person_id: string | null }>(
    `SELECT person_id FROM face_clusters WHERE id = $1`,
    [clusterId]
  );

  if (cluster.rows[0]?.person_id) {
    await query(`UPDATE faces SET person_id = $1 WHERE id = $2`, [
      cluster.rows[0].person_id,
      faceId,
    ]);
  }

  // Record as manual assignment
  await query(
    `INSERT INTO face_manual_assignments (face_id, cluster_id)
     VALUES ($1, $2)
     ON CONFLICT (face_id) DO UPDATE SET cluster_id = $2`,
    [faceId, clusterId]
  );

  // Remove any rejection for this face+cluster combo (user changed their mind)
  await query(
    `DELETE FROM face_rejections WHERE face_id = $1 AND cluster_id = $2`,
    [faceId, clusterId]
  );
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
  // Unassign the face
  await query(
    `UPDATE faces SET cluster_id = NULL, person_id = NULL WHERE id = $1`,
    [faceId]
  );

  // Record rejection
  await query(
    `INSERT INTO face_rejections (face_id, cluster_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [faceId, clusterId]
  );

  // Remove manual assignment if present
  await query(`DELETE FROM face_manual_assignments WHERE face_id = $1`, [
    faceId,
  ]);

  // If the unnamed cluster now has only 1 face, dissolve it
  const remaining = await query<{ count: number; person_id: string | null }>(
    `SELECT
       (SELECT COUNT(*)::int FROM faces WHERE cluster_id = $1) AS count,
       c.person_id
     FROM face_clusters c
     WHERE c.id = $1`,
    [clusterId]
  );

  if (
    remaining.rows.length > 0 &&
    remaining.rows[0].person_id === null &&
    remaining.rows[0].count <= 1
  ) {
    // Dissolve: free the remaining face and delete the cluster
    await query(`UPDATE faces SET cluster_id = NULL WHERE cluster_id = $1`, [
      clusterId,
    ]);
    await query(
      `DELETE FROM face_manual_assignments WHERE cluster_id = $1`,
      [clusterId]
    );
    await query(`DELETE FROM face_clusters WHERE id = $1`, [clusterId]);
  }
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

  // Find existing person with this name, or create a new one
  const existing = await query<{ id: string }>(
    `SELECT id FROM persons WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [trimmed]
  );

  let personId: string;
  if (existing.rows.length > 0) {
    personId = existing.rows[0].id;
  } else {
    const person = await query<{ id: string }>(
      `INSERT INTO persons (name) VALUES ($1) RETURNING id`,
      [trimmed]
    );
    personId = person.rows[0].id;
  }

  // Link person to cluster
  await query(`UPDATE face_clusters SET person_id = $1 WHERE id = $2`, [
    personId,
    clusterId,
  ]);

  // Set person_id on all faces in this cluster
  await query(`UPDATE faces SET person_id = $1 WHERE cluster_id = $2`, [
    personId,
    clusterId,
  ]);

  // Lock all current faces as manual assignments
  await query(
    `INSERT INTO face_manual_assignments (face_id, cluster_id)
     SELECT f.id, $1
     FROM faces f
     WHERE f.cluster_id = $1
     ON CONFLICT (face_id) DO UPDATE SET cluster_id = $1`,
    [clusterId]
  );

  return { personId };
}

/**
 * Rename a cluster's person.
 */
export async function renameCluster(
  clusterId: string,
  name: string
): Promise<void> {
  const cluster = await query<{ person_id: string | null }>(
    `SELECT person_id FROM face_clusters WHERE id = $1`,
    [clusterId]
  );

  if (!cluster.rows[0]) {
    throw new Error("Cluster not found");
  }

  if (cluster.rows[0].person_id) {
    // Update existing person name
    await query(`UPDATE persons SET name = $1 WHERE id = $2`, [
      name.trim(),
      cluster.rows[0].person_id,
    ]);
  } else {
    // Cluster was unnamed — create person and link
    await nameCluster(clusterId, name);
  }
}

// ---------------------------------------------------------------------------
// Representative embedding management
// ---------------------------------------------------------------------------

/**
 * Recompute the representative embedding for a cluster.
 * - "first": uses the earliest face's embedding
 * - "average": averages all face embeddings using pgvector
 */
/**
 * Dissolve unnamed clusters that have only 1 face.
 * Single-face clusters aren't meaningful — the face is freed back to unassigned.
 * Named clusters are never dissolved (user explicitly created them).
 */
export async function dissolveSingleFaceClusters(): Promise<number> {
  // Find unnamed clusters with exactly 1 face
  const singles = await query<{ id: string; face_id: string }>(
    `SELECT c.id, f.id AS face_id
     FROM face_clusters c
     JOIN faces f ON f.cluster_id = c.id
     WHERE c.person_id IS NULL
     GROUP BY c.id, f.id
     HAVING (SELECT COUNT(*) FROM faces f2 WHERE f2.cluster_id = c.id) = 1`
  );

  if (singles.rows.length === 0) return 0;

  for (const { id: clusterId, face_id: faceId } of singles.rows) {
    // Free the face
    await query(`UPDATE faces SET cluster_id = NULL WHERE id = $1`, [faceId]);
    // Remove manual assignment if any
    await query(
      `DELETE FROM face_manual_assignments WHERE face_id = $1 AND cluster_id = $2`,
      [faceId, clusterId]
    );
    // Delete the empty cluster (cascades rejections)
    await query(`DELETE FROM face_clusters WHERE id = $1`, [clusterId]);
  }

  logger.info(`Dissolved ${singles.rows.length} single-face clusters`);
  return singles.rows.length;
}

export async function updateClusterRepresentative(
  clusterId: string,
  strategy: ClusterStrategy
): Promise<void> {
  if (strategy === "first") {
    await query(
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
  } else {
    // Average: use pgvector AVG aggregation
    await query(
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
}
