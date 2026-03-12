import { query } from "./client.js";

export interface SettingRecord {
  key: string;
  value: string;
  updated_at: Date;
}

/** Get all settings as a key-value map. */
export async function getAllSettings(): Promise<Record<string, string>> {
  const result = await query<SettingRecord>("SELECT key, value FROM settings");
  const map: Record<string, string> = {};
  for (const row of result.rows) {
    map[row.key] = row.value;
  }
  return map;
}

/** Get a single setting by key. Returns null if not found. */
export async function getSetting(key: string): Promise<string | null> {
  const result = await query<{ value: string }>(
    "SELECT value FROM settings WHERE key = $1",
    [key]
  );
  return result.rows[0]?.value ?? null;
}

/** Upsert one or more settings. */
export async function upsertSettings(
  settings: Record<string, string>
): Promise<void> {
  for (const [key, value] of Object.entries(settings)) {
    await query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value]
    );
  }
}

/** Delete a setting by key. */
export async function deleteSetting(key: string): Promise<void> {
  await query("DELETE FROM settings WHERE key = $1", [key]);
}

// ---------------------------------------------------------------------------
// Typed helpers for face quality settings
// ---------------------------------------------------------------------------

export interface FaceQualitySettings {
  minConfidence: number;
  minSize: number;
}

const DEFAULTS: FaceQualitySettings = {
  minConfidence: 0.7,
  minSize: 2500,
};

/** Get face quality thresholds (parsed and with defaults). */
export async function getFaceQualitySettings(): Promise<FaceQualitySettings> {
  const all = await getAllSettings();
  return {
    minConfidence: parseFloat(all["face_min_confidence"] ?? "") || DEFAULTS.minConfidence,
    minSize: parseInt(all["face_min_size"] ?? "", 10) || DEFAULTS.minSize,
  };
}

/**
 * Returns a SQL WHERE fragment (without leading AND/WHERE) that filters faces
 * by quality settings. The fragment references the faces table via the given alias.
 *
 * Faces with NULL confidence are excluded (they need reprocessing).
 *
 * Example: faceQualityFilter("f") returns:
 *   "f.confidence >= 0.7 AND (f.bounding_box->>'width')::int * (f.bounding_box->>'height')::int >= 2500"
 */
export function faceQualityFilter(
  alias: string,
  settings: FaceQualitySettings
): string {
  return (
    `${alias}.confidence IS NOT NULL ` +
    `AND ${alias}.confidence >= ${settings.minConfidence} ` +
    `AND (${alias}.bounding_box->>'width')::int * (${alias}.bounding_box->>'height')::int >= ${settings.minSize}`
  );
}

// ---------------------------------------------------------------------------
// S3 configuration helpers
// ---------------------------------------------------------------------------

/** Keys that contain secrets and should be masked in API responses. */
export const SECRET_SETTING_KEYS = new Set(["s3_secret_access_key"]);

/** Sentinel value used in GET responses for masked secrets. */
export const MASKED_VALUE = "__MASKED__";

/**
 * Map of S3 setting keys to their corresponding environment variables.
 * DB setting takes precedence over the env var for each field.
 */
const S3_SETTING_ENV_MAP: Record<string, string> = {
  s3_bucket: "S3_BUCKET",
  s3_region: "S3_REGION",
  s3_endpoint: "S3_ENDPOINT",
  s3_access_key_id: "S3_ACCESS_KEY_ID",
  s3_secret_access_key: "S3_SECRET_ACCESS_KEY",
  s3_force_path_style: "S3_FORCE_PATH_STYLE",
};

/**
 * Resolve the effective S3 bucket name.
 * DB setting `s3_bucket` takes precedence over the `S3_BUCKET` env var.
 * Returns null if neither is configured.
 */
export async function getS3Bucket(): Promise<string | null> {
  const override = await getSetting("s3_bucket");
  if (override?.trim()) {
    return override.trim();
  }
  return process.env.S3_BUCKET || null;
}

export interface ResolvedS3Config {
  bucket: string | null;
  region: string | null;
  endpoint: string | null;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  forcePathStyle: boolean;
}

/**
 * Resolve the full S3 config from DB settings + env vars.
 * DB settings take precedence over env vars for each field.
 */
export async function getResolvedS3Config(): Promise<ResolvedS3Config> {
  const allSettings = await getAllSettings();

  function resolve(settingKey: string): string | null {
    const dbVal = allSettings[settingKey]?.trim();
    if (dbVal) return dbVal;
    const envVar = S3_SETTING_ENV_MAP[settingKey];
    return envVar ? process.env[envVar] || null : null;
  }

  return {
    bucket: resolve("s3_bucket"),
    region: resolve("s3_region"),
    endpoint: resolve("s3_endpoint"),
    accessKeyId: resolve("s3_access_key_id"),
    secretAccessKey: resolve("s3_secret_access_key"),
    forcePathStyle: resolve("s3_force_path_style") === "true",
  };
}

export interface S3ConfigInfo {
  envValue: string | null;
  effectiveValue: string | null;
  effectiveSource: "db" | "env" | null;
}

/**
 * Returns info about all S3 config fields for the settings UI.
 * Secret values are masked.
 */
export async function getS3ConfigInfo(): Promise<Record<string, S3ConfigInfo>> {
  const allSettings = await getAllSettings();
  const result: Record<string, S3ConfigInfo> = {};

  for (const [settingKey, envVar] of Object.entries(S3_SETTING_ENV_MAP)) {
    const dbVal = allSettings[settingKey]?.trim() || null;
    const envVal = process.env[envVar] || null;
    const isSecret = SECRET_SETTING_KEYS.has(settingKey);

    let effectiveValue: string | null = dbVal || envVal;
    let effectiveSource: "db" | "env" | null = null;
    if (dbVal) {
      effectiveSource = "db";
    } else if (envVal) {
      effectiveSource = "env";
    }

    // Mask secrets
    if (isSecret) {
      if (effectiveValue) {
        effectiveValue = "••••" + effectiveValue.slice(-4);
      }
      result[settingKey] = {
        envValue: envVal ? "••••" + envVal.slice(-4) : null,
        effectiveValue,
        effectiveSource,
      };
    } else {
      result[settingKey] = {
        envValue: envVal,
        effectiveValue,
        effectiveSource,
      };
    }
  }

  return result;
}
