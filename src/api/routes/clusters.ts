import { Hono } from "hono";
import {
  getAllClusters,
  getClusterFaces,
  getUnclusteredFaces,
  getFilteredOutFaces,
  getWontAssignFaces,
  clusterUnassignedFaces,
  reclusterFaces,
  getMergeSuggestions,
  autoMergeClusters,
  createClusterFromFace,
  assignFaceToCluster,
  mergeClusters,
  markFaceWontAssign,
  restoreFaceAssignment,
  removeFaceFromCluster,
  nameCluster,
  renameCluster,
  DEFAULT_MERGE_SUGGESTION_SIMILARITY,
  DEFAULT_AUTO_MERGE_SIMILARITY,
  DEFAULT_AUTO_MERGE_COVERAGE,
} from "../../db/clusters.js";
import type { ClusterStrategy } from "../../db/clusters.js";

const clusters = new Hono();

function validUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validStrategy(value: unknown): value is ClusterStrategy {
  return value === "first" || value === "average";
}

// List all clusters
clusters.get("/", async (c) => {
  const clusterList = await getAllClusters();
  return c.json({
    clusters: clusterList.map((cl) => ({
      id: cl.id,
      faceCount: cl.face_count,
      personId: cl.person_id,
      personName: cl.person_name,
      representativeFace: cl.representative_face_id
        ? {
            faceId: cl.representative_face_id,
            photoId: cl.representative_photo_id,
            boundingBox: cl.representative_bounding_box,
          }
        : null,
    })),
  });
});

// List unassigned faces
clusters.get("/unassigned", async (c) => {
  const limit = Number.parseInt(c.req.query("limit") ?? "40", 10);
  const offset = Number.parseInt(c.req.query("offset") ?? "0", 10);
  const { faces, total, hasMore } = await getUnclusteredFaces(limit, offset);
  return c.json({
    faces: faces.map((f) => ({
      id: f.id,
      photoId: f.photo_id,
      boundingBox: f.bounding_box,
      photoWidth: f.photo_width,
      photoHeight: f.photo_height,
      confidence: f.confidence,
      area: f.area,
    })),
    total,
    hasMore,
  });
});

// List faces excluded by the current confidence or area quality gate
clusters.get("/filtered-out", async (c) => {
  const requestedLimit = Number.parseInt(c.req.query("limit") ?? "200", 10);
  const { faces, total } = await getFilteredOutFaces(requestedLimit);
  return c.json({
    faces: faces.map((f) => ({
      id: f.id,
      photoId: f.photo_id,
      boundingBox: f.bounding_box,
      photoWidth: f.photo_width,
      photoHeight: f.photo_height,
      confidence: f.confidence,
      area: f.area,
    })),
    total,
  });
});

// List faces manually excluded from assignment
clusters.get("/wont-assign", async (c) => {
  const requestedLimit = Number.parseInt(c.req.query("limit") ?? "200", 10);
  const { faces, total } = await getWontAssignFaces(requestedLimit);
  return c.json({
    faces: faces.map((f) => ({
      id: f.id,
      photoId: f.photo_id,
      boundingBox: f.bounding_box,
      photoWidth: f.photo_width,
      photoHeight: f.photo_height,
      confidence: f.confidence,
      area: f.area,
    })),
    total,
  });
});

// Manually exclude a face from assignment and automatic clustering
clusters.post("/wont-assign/:faceId", async (c) => {
  const faceId = c.req.param("faceId");
  try {
    await markFaceWontAssign(faceId);
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Face not found") {
      return c.json({ error: error.message }, 404);
    }
    if (
      error instanceof Error &&
      error.message === "Assigned faces cannot be marked as won't assign"
    ) {
      return c.json({ error: error.message }, 409);
    }
    throw error;
  }
});

// Return a manually excluded face to normal gate and clustering behavior
clusters.delete("/wont-assign/:faceId", async (c) => {
  const restored = await restoreFaceAssignment(c.req.param("faceId"));
  if (!restored) {
    return c.json({ error: "Face is not marked as won't assign" }, 404);
  }
  return c.json({ success: true });
});

// Get faces in a cluster
clusters.get("/:id/faces", async (c) => {
  const id = c.req.param("id");
  const faces = await getClusterFaces(id);
  return c.json({
    faces: faces.map((f) => ({
      id: f.id,
      photoId: f.photo_id,
      boundingBox: f.bounding_box,
      photoWidth: f.photo_width,
      photoHeight: f.photo_height,
      confidence: f.confidence,
      area: f.area,
    })),
  });
});

// Create a new cluster from a single face
clusters.post("/", async (c) => {
  const body = await c.req.json<{ faceId: string }>();

  if (!body.faceId) {
    return c.json({ error: "faceId is required" }, 400);
  }

  try {
    const result = await createClusterFromFace(body.faceId);
    return c.json({ id: result.clusterId, faceCount: 1 }, 201);
  } catch (error) {
    if (error instanceof Error && error.message === "Face not found") {
      return c.json({ error: error.message }, 404);
    }
    if (error instanceof Error && error.message === "Face has no embedding") {
      return c.json({ error: error.message }, 409);
    }
    throw error;
  }
});

// Run clustering on unassigned faces (non-destructive)
clusters.post("/run", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const threshold: unknown = body.threshold ?? 0.6;
  const strategy: unknown = body.strategy ?? "average";

  if (!validUnitInterval(threshold) || !validStrategy(strategy)) {
    return c.json({ error: "threshold must be between 0 and 1 and strategy must be 'first' or 'average'" }, 400);
  }

  const result = await clusterUnassignedFaces({ threshold, strategy });
  return c.json(result);
});

// Recluster all faces (destructive for unnamed clusters, preserves named + manual)
clusters.post("/recluster", async (c) => {
  const body = await c.req.json<{ threshold: number; strategy: ClusterStrategy }>();

  if (!validUnitInterval(body.threshold) || !validStrategy(body.strategy)) {
    return c.json({ error: "threshold must be between 0 and 1 and strategy must be 'first' or 'average'" }, 400);
  }

  const result = await reclusterFaces({
    threshold: body.threshold,
    strategy: body.strategy,
  });
  return c.json(result);
});

// Rank safe cluster-to-cluster merge candidates.
clusters.get("/merge-suggestions", async (c) => {
  const parsed = Number(
    c.req.query("minSimilarity") ?? DEFAULT_MERGE_SUGGESTION_SIMILARITY
  );
  if (!validUnitInterval(parsed)) {
    return c.json({ error: "minSimilarity must be between 0 and 1" }, 400);
  }
  const suggestions = await getMergeSuggestions({ minSimilarity: parsed });
  return c.json({
    suggestions: suggestions.map((suggestion) => ({
      sourceClusterId: suggestion.source_cluster_id,
      targetClusterId: suggestion.target_cluster_id,
      sourcePersonId: suggestion.source_person_id,
      targetPersonId: suggestion.target_person_id,
      sourcePersonName: suggestion.source_person_name,
      targetPersonName: suggestion.target_person_name,
      sourceFaceCount: suggestion.source_face_count,
      targetFaceCount: suggestion.target_face_count,
      similarity: suggestion.similarity,
      sourceCoverage: suggestion.source_coverage,
      targetCoverage: suggestion.target_coverage,
      reason: suggestion.reason,
    })),
  });
});

// Conservatively merge exact identities and strongly supported candidates.
clusters.post("/auto-merge", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const threshold: unknown = body.threshold ?? DEFAULT_AUTO_MERGE_SIMILARITY;
  const minCoverage: unknown = body.minCoverage ?? DEFAULT_AUTO_MERGE_COVERAGE;
  const maxMerges: unknown = body.maxMerges ?? 50;
  if (
    !validUnitInterval(threshold) ||
    !validUnitInterval(minCoverage) ||
    typeof maxMerges !== "number" ||
    !Number.isInteger(maxMerges) ||
    maxMerges < 1 ||
    maxMerges > 200
  ) {
    return c.json({ error: "threshold/minCoverage must be between 0 and 1; maxMerges must be an integer from 1 to 200" }, 400);
  }
  return c.json(await autoMergeClusters({ threshold, minCoverage, maxMerges }));
});

// Name a cluster (creates person, locks all faces)
clusters.post("/:id/name", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ name: string }>();

  if (!body.name?.trim()) {
    return c.json({ error: "Name is required" }, 400);
  }

  try {
    return c.json(await nameCluster(id, body.name));
  } catch (error) {
    if (error instanceof Error && error.message === "Cluster not found") {
      return c.json({ error: error.message }, 404);
    }
    throw error;
  }
});

// Rename a cluster's person
clusters.put("/:id/name", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ name: string }>();

  if (!body.name?.trim()) {
    return c.json({ error: "Name is required" }, 400);
  }

  try {
    await renameCluster(id, body.name);
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Cluster not found") {
      return c.json({ error: error.message }, 404);
    }
    throw error;
  }
});

// Manually assign a face to a cluster
clusters.post("/:id/faces/:faceId", async (c) => {
  const clusterId = c.req.param("id");
  const faceId = c.req.param("faceId");

  try {
    await assignFaceToCluster(faceId, clusterId);
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof Error && ["Face not found", "Cluster not found"].includes(error.message)) {
      return c.json({ error: error.message }, 404);
    }
    throw error;
  }
});

// Merge this cluster into another cluster
clusters.post("/:id/merge", async (c) => {
  const sourceClusterId = c.req.param("id");
  const body: { targetClusterId?: string } = await c.req
    .json<{ targetClusterId?: string }>()
    .catch(() => ({}));
  const targetClusterId = body.targetClusterId;

  if (!targetClusterId) {
    return c.json({ error: "targetClusterId is required" }, 400);
  }
  if (sourceClusterId === targetClusterId) {
    return c.json({ error: "Source and target clusters must be different" }, 400);
  }

  try {
    const result = await mergeClusters(sourceClusterId, targetClusterId);
    return c.json({
      success: true,
      targetClusterId,
      faceCount: result.faceCount,
      personId: result.personId,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Source or target cluster not found") {
      return c.json({ error: error.message }, 404);
    }
    if (error instanceof Error && error.message === "Named clusters belong to different people") {
      return c.json({ error: error.message }, 409);
    }
    throw error;
  }
});

// Remove a face from a cluster (with rejection tracking)
clusters.delete("/:id/faces/:faceId", async (c) => {
  const clusterId = c.req.param("id");
  const faceId = c.req.param("faceId");

  try {
    await removeFaceFromCluster(faceId, clusterId);
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof Error && ["Face not found", "Cluster not found"].includes(error.message)) {
      return c.json({ error: error.message }, 404);
    }
    if (error instanceof Error && error.message === "Face does not belong to cluster") {
      return c.json({ error: error.message }, 409);
    }
    throw error;
  }
});

export default clusters;
