import { Hono } from "hono";
import crypto from "node:crypto";
import {
  getAllSettings,
  getAllRuntimeSettings,
  getSetting,
  upsertSettings,
  getS3ConfigInfo,
  SECRET_SETTING_KEYS,
  MASKED_VALUE,
  buildResolvedS3ConfigFromSettings,
} from "../../db/settings.js";
import { invalidateS3Client, validateS3Connection } from "../../s3/client.js";
import {
  beginAwsConnection,
  getAwsConnectionStatus,
  verifyAwsConnection,
} from "../../s3/aws-connection.js";
import { getAuthInfo } from "../../auth/handlers.js";

/** Setting key prefixes that relate to S3 configuration. */
const S3_SETTING_PREFIX = "s3_";
const S3_REQUIRED_KEYS = [
  "s3_bucket",
  "s3_region",
  "s3_access_key_id",
  "s3_secret_access_key",
] as const;
const AUTO_IMPORT_KEYS = new Set([
  "storage_provider",
  "auto_import_enabled",
  "auto_import_prefixes",
  "auto_import_initial_mode",
  "auto_import_gpu_mode",
  "auto_import_scan_interval_minutes",
]);
const AWS_CONNECTOR_SETTING_KEYS = new Set([
  "s3_auth_mode",
  "s3_role_arn",
  "s3_external_id",
  "aws_connect_account_id",
  "aws_connect_bucket",
  "aws_connect_region",
  "aws_connect_role_name",
  "aws_connect_pending",
]);

const settings = new Hono();

function hasAnyS3Value(settingsMap: Record<string, string>): boolean {
  return Object.keys(settingsMap).some((key) => {
    if (!key.startsWith(S3_SETTING_PREFIX)) return false;
    return settingsMap[key]?.trim().length > 0;
  });
}

function findMissingRequiredS3Fields(settingsMap: Record<string, string>): string[] {
  if (settingsMap.s3_auth_mode === "aws-role") {
    return ["s3_bucket", "s3_region", "s3_role_arn", "s3_external_id"].filter(
      (key) => !settingsMap[key]?.trim()
    );
  }
  return S3_REQUIRED_KEYS.filter((key) => !settingsMap[key]?.trim());
}

function requireStorageOwner(c: Parameters<typeof getAuthInfo>[0]): Response | null {
  const role = getAuthInfo(c).role;
  if (role === "owner" || role === "admin") return null;
  return c.json({ error: "Only a workspace owner can connect storage" }, 403);
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

settings.get("/aws/connect", async (c) => {
  const forbidden = requireStorageOwner(c);
  if (forbidden) return forbidden;

  return c.json(await getAwsConnectionStatus(), 200, {
    "Cache-Control": "no-store",
  });
});

settings.post("/aws/connect", async (c) => {
  const forbidden = requireStorageOwner(c);
  if (forbidden) return forbidden;

  const body = await c.req.json<{
    bucket?: unknown;
    region?: unknown;
    accountId?: unknown;
  }>();
  if (
    typeof body.bucket !== "string" ||
    typeof body.region !== "string" ||
    typeof body.accountId !== "string"
  ) {
    return c.json({ error: "Bucket, region, and AWS account ID are required" }, 400);
  }

  try {
    return c.json(await beginAwsConnection({
      bucket: body.bucket,
      region: body.region,
      accountId: body.accountId,
    }), 200, { "Cache-Control": "no-store" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start AWS setup";
    const status = message.includes("not configured") ? 503 : 400;
    return c.json({ error: message }, status, { "Cache-Control": "no-store" });
  }
});

settings.post("/aws/connect/verify", async (c) => {
  const forbidden = requireStorageOwner(c);
  if (forbidden) return forbidden;

  try {
    return c.json(await verifyAwsConnection(), 200, {
      "Cache-Control": "no-store",
    });
  } catch (error) {
    return c.json(
      {
        error:
          "CloudFormation connection could not be verified: " +
          (error instanceof Error ? error.message : "Unknown AWS error"),
      },
      400,
      { "Cache-Control": "no-store" }
    );
  }
});

// PUT /api/v1/settings — upsert settings from { key: value } pairs
settings.put("/", async (c) => {
  const body = await c.req.json();

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "Expected a JSON object of { key: value } pairs" }, 400);
  }

  const currentSettings = await getAllRuntimeSettings();
  const entries: Record<string, string> = {};
  let hasS3Change = false;

  for (const [key, value] of Object.entries(body)) {
    if (AWS_CONNECTOR_SETTING_KEYS.has(key)) {
      return c.json({ error: `Setting "${key}" is managed by the AWS connector` }, 400);
    }
    if (typeof value !== "string") {
      return c.json({ error: `Value for "${key}" must be a string` }, 400);
    }
    if (value === MASKED_VALUE) continue;
    entries[key] = value;
    if (key.startsWith(S3_SETTING_PREFIX)) hasS3Change = true;
  }

  if (
    (entries.storage_provider && entries.storage_provider !== "amazon-s3") ||
    entries.s3_access_key_id ||
    entries.s3_secret_access_key
  ) {
    entries.s3_auth_mode = "access-key";
  }

  if (entries.auto_import_enabled && !["true", "false"].includes(entries.auto_import_enabled)) {
    return c.json({ error: "auto_import_enabled must be true or false" }, 400);
  }
  if (
    entries.auto_import_initial_mode &&
    !["new_only", "all"].includes(entries.auto_import_initial_mode)
  ) {
    return c.json({ error: "auto_import_initial_mode must be new_only or all" }, 400);
  }
  if (
    entries.auto_import_gpu_mode &&
    !["all", "caption-only", "faces-only", "skip"].includes(entries.auto_import_gpu_mode)
  ) {
    return c.json({ error: "Invalid auto_import_gpu_mode" }, 400);
  }
  if (entries.auto_import_scan_interval_minutes) {
    const interval = Number(entries.auto_import_scan_interval_minutes);
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > 10080) {
      return c.json(
        { error: "auto_import_scan_interval_minutes must be between 1 and 10080" },
        400
      );
    }
  }
  for (const key of Object.keys(entries)) {
    if (key.startsWith("auto_import_") && !AUTO_IMPORT_KEYS.has(key)) {
      return c.json({ error: `Unknown automatic import setting: ${key}` }, 400);
    }
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
          s3Config.authMode === "aws-role"
            ? {
                region: s3Config.region!,
                roleArn: s3Config.roleArn!,
                externalId: s3Config.externalId!,
              }
            : {
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
