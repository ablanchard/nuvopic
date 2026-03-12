import { Hono } from "hono";
import {
  getAllSettings,
  upsertSettings,
  getS3Bucket,
  getS3ConfigInfo,
  SECRET_SETTING_KEYS,
  MASKED_VALUE,
} from "../../db/settings.js";
import { invalidateS3Client } from "../../s3/client.js";

/** Setting key prefixes that relate to S3 configuration. */
const S3_SETTING_PREFIX = "s3_";

const settings = new Hono();

// GET /api/v1/settings — returns all settings as { key: value }
// Secret values are replaced with a masked sentinel.
settings.get("/", async (c) => {
  const all = await getAllSettings();
  for (const key of Object.keys(all)) {
    if (SECRET_SETTING_KEYS.has(key)) {
      all[key] = MASKED_VALUE;
    }
  }
  return c.json(all);
});

// GET /api/v1/settings/s3 — returns S3 config info for the settings UI
settings.get("/s3", async (c) => {
  const info = await getS3ConfigInfo();
  return c.json(info);
});

// PUT /api/v1/settings — upsert settings from { key: value } pairs
settings.put("/", async (c) => {
  const body = await c.req.json();

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "Expected a JSON object of { key: value } pairs" }, 400);
  }

  // Validate all values are strings, skip masked sentinel values
  const entries: Record<string, string> = {};
  let hasS3Change = false;

  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== "string") {
      return c.json({ error: `Value for "${key}" must be a string` }, 400);
    }
    // Skip the masked sentinel — user didn't change the secret
    if (value === MASKED_VALUE) continue;
    entries[key] = value;
    if (key.startsWith(S3_SETTING_PREFIX)) hasS3Change = true;
  }

  if (Object.keys(entries).length > 0) {
    await upsertSettings(entries);
  }

  // Invalidate cached S3 client when S3 settings change
  if (hasS3Change) {
    invalidateS3Client();
  }

  // Return updated settings (with secrets masked)
  const all = await getAllSettings();
  for (const key of Object.keys(all)) {
    if (SECRET_SETTING_KEYS.has(key)) {
      all[key] = MASKED_VALUE;
    }
  }
  return c.json(all);
});

export default settings;
