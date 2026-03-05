import { Hono } from "hono";
import { getAllSettings, upsertSettings } from "../../db/settings.js";

const settings = new Hono();

// GET /api/v1/settings — returns all settings as { key: value }
settings.get("/", async (c) => {
  const all = await getAllSettings();
  return c.json(all);
});

// PUT /api/v1/settings — upsert settings from { key: value } pairs
settings.put("/", async (c) => {
  const body = await c.req.json();

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "Expected a JSON object of { key: value } pairs" }, 400);
  }

  // Validate all values are strings
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== "string") {
      return c.json({ error: `Value for "${key}" must be a string` }, 400);
    }
    entries[key] = value;
  }

  await upsertSettings(entries);

  // Return updated settings
  const all = await getAllSettings();
  return c.json(all);
});

export default settings;
