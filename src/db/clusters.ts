import { query, withTransaction } from "./client.js";
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

// ---------------------------------------------------------------------------
// Internal: embedding helpers
// ---------------------------------------------------------------------------

/** Format a number[] embedding as pgvector literal '[1,2,3,...]' */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

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
       AND f.id NOT IN (SELECT face_id FROM face_assignment_exclusions)
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
       ORDER BY f.created_at ASC
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
export async function getUnclusteredFaces(): Promise<ClusterFaceRecord[]> {
  const fqSettings = await getFaceQualitySettings();
  const fqFilter = faceQualityFilter("f", fqSettings);
  const unassignedFilter = effectivelyUnassignedFilter("f");

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
     WHERE f.embedding IS NOT NULL
       AND ${fqFilter}
       AND ${unassignedFilter}
       AND NOT EXISTS (
         SELECT 1 FROM face_assignment_exclusions x WHERE x.face_id = f.id
       )
     ORDER BY f.created_at DESC
     LIMIT 200`
  );

  return result.rows;
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
  // Reuse an existing automatic singleton rather than leaving it orphaned.
  const face = await query<{
    embedding: string;
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
     WHERE f.id = $1`,
    [faceId]
  );

  if (face.rows.length === 0) {
    throw new Error("Face not found");
  }

  const current = face.rows[0];
  if (
    current.cluster_id &&
    current.cluster_person_id === null &&
    current.cluster_face_count === 1
  ) {
    await query(
      `INSERT INTO face_manual_assignments (face_id, cluster_id)
       VALUES ($1, $2)
       ON CONFLICT (face_id) DO UPDATE SET cluster_id = $2`,
      [faceId, current.cluster_id]
    );
    await query(`DELETE FROM face_assignment_exclusions WHERE face_id = $1`, [
      faceId,
    ]);
    return { clusterId: current.cluster_id };
  }

  // Create cluster with this face's embedding as representative
  const cluster = await query<{ id: string }>(
    `INSERT INTO face_clusters (representative_embedding)
     VALUES ($1::vector)
     RETURNING id`,
    [current.embedding]
  );

  const clusterId = cluster.rows[0].id;

  // Assign face to cluster
  await query(`UPDATE faces SET cluster_id = $1, person_id = NULL WHERE id = $2`, [
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
  await query(`DELETE FROM face_assignment_exclusions WHERE face_id = $1`, [
    faceId,
  ]);

  // Moving a face out of an automatic singleton can leave an empty shell.
  if (current.cluster_id) {
    await query(
      `DELETE FROM face_clusters
       WHERE id = $1
         AND person_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM faces WHERE cluster_id = $1)`,
      [current.cluster_id]
    );
  }

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
  await query(`DELETE FROM face_assignment_exclusions WHERE face_id = $1`, [
    faceId,
  ]);
}

/** Merge a source cluster into a target cluster as one atomic manual action. */
export async function mergeClusters(
  sourceClusterId: string,
  targetClusterId: string
): Promise<{ faceCount: number; personId: string | null }> {
  if (sourceClusterId === targetClusterId) {
    throw new Error("Source and target clusters must be different");
  }

  return withTransaction(async (client) => {
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

    // Keep the user-confirmed merge intact across future reclustering.
    await client.query(
      `INSERT INTO face_manual_assignments (face_id, cluster_id)
       SELECT id, $1 FROM faces WHERE cluster_id = $1
       ON CONFLICT (face_id) DO UPDATE SET cluster_id = $1`,
      [targetClusterId]
    );

    await client.query(`DELETE FROM face_clusters WHERE id = $1`, [sourceClusterId]);

    // If the target identity replaced the source identity, discard it only
    // when it is no longer referenced by another cluster or face.
    if (source.person_id && source.person_id !== personId) {
      await client.query(
        `DELETE FROM persons p
         WHERE p.id = $1
           AND NOT EXISTS (SELECT 1 FROM face_clusters c WHERE c.person_id = p.id)
           AND NOT EXISTS (SELECT 1 FROM faces f WHERE f.person_id = p.id)`,
        [source.person_id]
      );
    }

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

  // Atomically reuse an existing identity if another request used this name.
  const person = await query<{ id: string }>(
    `INSERT INTO persons (name)
     VALUES ($1)
     ON CONFLICT (LOWER(BTRIM(name))) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [trimmed]
  );
  const personId = person.rows[0].id;

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
    const currentPersonId = cluster.rows[0].person_id;
    const existing = await query<{ id: string }>(
      `SELECT id FROM persons
       WHERE LOWER(BTRIM(name)) = LOWER(BTRIM($1))
         AND id <> $2
       LIMIT 1`,
      [name, currentPersonId]
    );

    if (existing.rows[0]) {
      const targetPersonId = existing.rows[0].id;
      await query(`UPDATE face_clusters SET person_id = $1 WHERE person_id = $2`, [
        targetPersonId,
        currentPersonId,
      ]);
      await query(`UPDATE faces SET person_id = $1 WHERE person_id = $2`, [
        targetPersonId,
        currentPersonId,
      ]);
      await query(`DELETE FROM persons WHERE id = $1`, [currentPersonId]);
    } else {
      await query(`UPDATE persons SET name = $1 WHERE id = $2`, [
        name.trim(),
        currentPersonId,
      ]);
    }
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
 * Dissolve automatic unnamed clusters that have only 1 face.
 * Manually created and named clusters are preserved.
 */
export async function dissolveSingleFaceClusters(): Promise<number> {
  // Find unnamed clusters with exactly 1 face
  const singles = await query<{ id: string; face_id: string }>(
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
