import { Hono } from "hono";
import {
  getAllClusters,
  getClusterFaces,
  getUnclusteredFaces,
  clusterUnassignedFaces,
  reclusterFaces,
  createClusterFromFace,
  assignFaceToCluster,
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
            thumbnailUrl: `/api/v1/photos/${cl.representative_photo_id}/thumbnail`,
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
      thumbnailUrl: `/api/v1/photos/${f.photo_id}/thumbnail`,
      photoWidth: f.photo_width,
      photoHeight: f.photo_height,
    })),
  });
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
      thumbnailUrl: `/api/v1/photos/${f.photo_id}/thumbnail`,
      photoWidth: f.photo_width,
      photoHeight: f.photo_height,
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

// Remove a face from a cluster (with rejection tracking)
clusters.delete("/:id/faces/:faceId", async (c) => {
  const clusterId = c.req.param("id");
  const faceId = c.req.param("faceId");

  await removeFaceFromCluster(faceId, clusterId);
  return c.json({ success: true });
});

export default clusters;
