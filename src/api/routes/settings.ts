import { Hono } from "hono";
import crypto from "node:crypto";
import {
  getAllSettings,
  getSetting,
  upsertSettings,
  getS3ConfigInfo,
  SECRET_SETTING_KEYS,
  MASKED_VALUE,
  buildResolvedS3ConfigFromSettings,
} from "../../db/settings.js";
import { invalidateS3Client, validateS3Connection } from "../../s3/client.js";

/** Setting key prefixes that relate to S3 configuration. */
const S3_SETTING_PREFIX = "s3_";
const S3_REQUIRED_KEYS = [
  "s3_bucket",
  "s3_region",
  "s3_access_key_id",
  "s3_secret_access_key",
] as const;

const settings = new Hono();

function hasAnyS3Value(settingsMap: Record<string, string>): boolean {
  return Object.keys(settingsMap).some((key) => {
    if (!key.startsWith(S3_SETTING_PREFIX)) return false;
    return settingsMap[key]?.trim().length > 0;
  });
}

function findMissingRequiredS3Fields(settingsMap: Record<string, string>): string[] {
  return S3_REQUIRED_KEYS.filter((key) => !settingsMap[key]?.trim());
}

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

  const currentSettings = await getAllSettings();
  const entries: Record<string, string> = {};
  let hasS3Change = false;

  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== "string") {
      return c.json({ error: `Value for "${key}" must be a string` }, 400);
    }
    if (value === MASKED_VALUE) continue;
    entries[key] = value;
    if (key.startsWith(S3_SETTING_PREFIX)) hasS3Change = true;
  }

  if (hasS3Change) {
    const mergedSettings = { ...currentSettings, ...entries };
    const existingWebhookSecret = await getSetting("webhook_secret");
    if (hasAnyS3Value(mergedSettings)) {
      const missingFields = findMissingRequiredS3Fields(mergedSettings);
      if (missingFields.length > 0) {
        return c.json(
          {
            error: `Incomplete S3 configuration. Missing: ${missingFields.join(", ")}`,
          },
          400
        );
      }

      const s3Config = buildResolvedS3ConfigFromSettings(mergedSettings);
      try {
        await validateS3Connection(
          {
            endpoint: s3Config.endpoint || undefined,
            region: s3Config.region!,
            accessKeyId: s3Config.accessKeyId!,
            secretAccessKey: s3Config.secretAccessKey!,
            forcePathStyle: s3Config.forcePathStyle || undefined,
          },
          s3Config.bucket!
        );
      } catch (error) {
        return c.json(
          {
            error: `Unable to validate S3 configuration: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
          400
        );
      }

      if (!existingWebhookSecret && !entries.webhook_secret) {
        entries.webhook_secret = crypto.randomBytes(24).toString("hex");
      }
    }
  }

  if (Object.keys(entries).length > 0) {
    await upsertSettings(entries);
  }

  if (hasS3Change) {
    invalidateS3Client();
  }

  const all = await getAllSettings();
  for (const key of Object.keys(all)) {
    if (SECRET_SETTING_KEYS.has(key)) {
      all[key] = MASKED_VALUE;
    }
  }
  return c.json(all);
});

export default settings;
