import { Hono } from "hono";
import {
  listPhotoSources,
  createPhotoSource,
  updatePhotoSource,
  deletePhotoSource,
  countPhotosForPrefixes,
  getPathBreakdown,
} from "../../db/queries.js";

const sources = new Hono();

// GET /api/v1/sources — list all sources with photo counts
sources.get("/", async (c) => {
  const allSources = await listPhotoSources();

  const sourcesWithCounts = await Promise.all(
    allSources.map(async (s) => ({
      id: s.id,
      label: s.label,
      pathPrefixes: s.path_prefixes,
      sortOrder: s.sort_order,
      photoCount: await countPhotosForPrefixes(s.path_prefixes),
      createdAt: s.created_at,
    }))
  );

  return c.json({ sources: sourcesWithCounts });
});

// GET /api/v1/sources/path-breakdown — level 1+2 prefix tree with counts
sources.get("/path-breakdown", async (c) => {
  const breakdown = await getPathBreakdown();
  return c.json({ breakdown });
});

// POST /api/v1/sources — create a new source
sources.post("/", async (c) => {
  const body = await c.req.json();
  const { label, pathPrefixes, sortOrder } = body;

  if (!label || typeof label !== "string") {
    return c.json({ error: "label is required and must be a string" }, 400);
  }
  if (!Array.isArray(pathPrefixes) || pathPrefixes.length === 0) {
    return c.json({ error: "pathPrefixes must be a non-empty array of strings" }, 400);
  }

  try {
    const source = await createPhotoSource({
      label,
      pathPrefixes,
      sortOrder: typeof sortOrder === "number" ? sortOrder : undefined,
    });

    return c.json({
      id: source.id,
      label: source.label,
      pathPrefixes: source.path_prefixes,
      sortOrder: source.sort_order,
      photoCount: await countPhotosForPrefixes(source.path_prefixes),
      createdAt: source.created_at,
    }, 201);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("unique")) {
      return c.json({ error: `A source with label "${label}" already exists` }, 409);
    }
    throw err;
  }
});

// PUT /api/v1/sources/:id — update a source
sources.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { label, pathPrefixes, sortOrder } = body;

  const updated = await updatePhotoSource(id, {
    label: typeof label === "string" ? label : undefined,
    pathPrefixes: Array.isArray(pathPrefixes) ? pathPrefixes : undefined,
    sortOrder: typeof sortOrder === "number" ? sortOrder : undefined,
  });

  if (!updated) {
    return c.json({ error: "Source not found" }, 404);
  }

  return c.json({
    id: updated.id,
    label: updated.label,
    pathPrefixes: updated.path_prefixes,
    sortOrder: updated.sort_order,
    photoCount: await countPhotosForPrefixes(updated.path_prefixes),
    createdAt: updated.created_at,
  });
});

// DELETE /api/v1/sources/:id — delete a source
sources.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const deleted = await deletePhotoSource(id);

  if (!deleted) {
    return c.json({ error: "Source not found" }, 404);
  }

  return c.json({ ok: true });
});

export default sources;
