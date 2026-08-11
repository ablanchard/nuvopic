import { Hono } from "hono";
import {
  getAllClusters,
  getClusterFaces,
  getUnclusteredFaces,
  getFilteredOutFaces,
  getWontAssignFaces,
  clusterUnassignedFaces,
  reclusterFaces,
  createClusterFromFace,
  assignFaceToCluster,
  mergeClusters,
  markFaceWontAssign,
  restoreFaceAssignment,
  removeFaceFromCluster,
  nameCluster,
  renameCluster,
} from "../../db/clusters.js";
import type { ClusterStrategy } from "../../db/clusters.js";

const clusters = new Hono();

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
  const faces = await getUnclusteredFaces();
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

  const result = await createClusterFromFace(body.faceId);
  return c.json({ id: result.clusterId, faceCount: 1 }, 201);
});

// Run clustering on unassigned faces (non-destructive)
clusters.post("/run", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const threshold: number = body.threshold ?? 0.6;
  const strategy: ClusterStrategy = body.strategy ?? "first";

  const result = await clusterUnassignedFaces({ threshold, strategy });
  return c.json(result);
});

// Recluster all faces (destructive for unnamed clusters, preserves named + manual)
clusters.post("/recluster", async (c) => {
  const body = await c.req.json<{ threshold: number; strategy: ClusterStrategy }>();

  if (typeof body.threshold !== "number" || !["first", "average"].includes(body.strategy)) {
    return c.json({ error: "threshold (number) and strategy ('first' | 'average') are required" }, 400);
  }

  const result = await reclusterFaces({
    threshold: body.threshold,
    strategy: body.strategy,
  });
  return c.json(result);
});

// Name a cluster (creates person, locks all faces)
clusters.post("/:id/name", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ name: string }>();

  if (!body.name?.trim()) {
    return c.json({ error: "Name is required" }, 400);
  }

  const result = await nameCluster(id, body.name);
  return c.json(result);
});

// Rename a cluster's person
clusters.put("/:id/name", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ name: string }>();

  if (!body.name?.trim()) {
    return c.json({ error: "Name is required" }, 400);
  }

  await renameCluster(id, body.name);
  return c.json({ success: true });
});

// Manually assign a face to a cluster
clusters.post("/:id/faces/:faceId", async (c) => {
  const clusterId = c.req.param("id");
  const faceId = c.req.param("faceId");

  await assignFaceToCluster(faceId, clusterId);
  return c.json({ success: true });
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
    throw error;
  }
});

// Remove a face from a cluster (with rejection tracking)
clusters.delete("/:id/faces/:faceId", async (c) => {
  const clusterId = c.req.param("id");
  const faceId = c.req.param("faceId");

  await removeFaceFromCluster(faceId, clusterId);
  return c.json({ success: true });
});

export default clusters;
