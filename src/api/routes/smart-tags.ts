import { Hono } from "hono";
import {
  listSmartTags,
  createSmartTag,
  updateSmartTag,
  deleteSmartTag,
  countPhotosForSmartTag,
  getPathFacets,
  getDateFacets,
  getTextFacets,
  isAllowedField,
  getAllowedFields,
} from "../../db/queries.js";

const smartTags = new Hono();

// GET /api/v1/smart-tags — list all smart tags with photo counts
smartTags.get("/", async (c) => {
  const allTags = await listSmartTags();

  const tagsWithCounts = await Promise.all(
    allTags.map(async (t) => ({
      id: t.id,
      label: t.label,
      field: t.field,
      values: t.values,
      rule: t.rule,
      sortOrder: t.sort_order,
      photoCount: await countPhotosForSmartTag(t),
      createdAt: t.created_at,
    }))
  );

  return c.json({ smartTags: tagsWithCounts });
});

// GET /api/v1/smart-tags/fields — list available fields
smartTags.get("/fields", (c) => {
  return c.json({ fields: getAllowedFields() });
});

// GET /api/v1/smart-tags/facets?field=<field> — facets for a field
smartTags.get("/facets", async (c) => {
  const field = c.req.query("field");
  if (!field) {
    return c.json({ error: "field query parameter is required" }, 400);
  }
  if (!isAllowedField(field)) {
    return c.json({ error: `Field "${field}" is not allowed. Allowed: ${getAllowedFields().join(", ")}` }, 400);
  }

  if (field === "s3_path") {
    const facets = await getPathFacets();
    return c.json({ type: "path", facets });
  }

  if (field === "taken_at") {
    const facets = await getDateFacets();
    return c.json({ type: "date", facets });
  }

  // Text fields
  const facets = await getTextFacets(field);
  return c.json({ type: "text", facets });
});

// POST /api/v1/smart-tags — create a new smart tag
smartTags.post("/", async (c) => {
  const body = await c.req.json();
  const { label, field, values, rule, sortOrder } = body;

  if (!label || typeof label !== "string") {
    return c.json({ error: "label is required and must be a string" }, 400);
  }
  if (!field || !isAllowedField(field)) {
    return c.json({ error: `field must be one of: ${getAllowedFields().join(", ")}` }, 400);
  }
  if (!Array.isArray(values) || values.length === 0) {
    return c.json({ error: "values must be a non-empty array of strings" }, 400);
  }
  const validRules = ["any", "all", "none"];
  const tagRule = validRules.includes(rule) ? rule : "any";

  try {
    const tag = await createSmartTag({
      label,
      field,
      values,
      rule: tagRule,
      sortOrder: typeof sortOrder === "number" ? sortOrder : undefined,
    });

    return c.json({
      id: tag.id,
      label: tag.label,
      field: tag.field,
      values: tag.values,
      rule: tag.rule,
      sortOrder: tag.sort_order,
      photoCount: await countPhotosForSmartTag(tag),
      createdAt: tag.created_at,
    }, 201);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("unique")) {
      return c.json({ error: `A smart tag with label "${label}" already exists` }, 409);
    }
    throw err;
  }
});

// PUT /api/v1/smart-tags/:id — update a smart tag
smartTags.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { label, field, values, rule, sortOrder } = body;

  const updated = await updateSmartTag(id, {
    label: typeof label === "string" ? label : undefined,
    field: typeof field === "string" && isAllowedField(field) ? field : undefined,
    values: Array.isArray(values) ? values : undefined,
    rule: typeof rule === "string" && ["any", "all", "none"].includes(rule) ? rule : undefined,
    sortOrder: typeof sortOrder === "number" ? sortOrder : undefined,
  });

  if (!updated) {
    return c.json({ error: "Smart tag not found" }, 404);
  }

  return c.json({
    id: updated.id,
    label: updated.label,
    field: updated.field,
    values: updated.values,
    rule: updated.rule,
    sortOrder: updated.sort_order,
    photoCount: await countPhotosForSmartTag(updated),
    createdAt: updated.created_at,
  });
});

// DELETE /api/v1/smart-tags/:id — delete a smart tag
smartTags.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const deleted = await deleteSmartTag(id);

  if (!deleted) {
    return c.json({ error: "Smart tag not found" }, 404);
  }

  return c.json({ ok: true });
});

export default smartTags;
