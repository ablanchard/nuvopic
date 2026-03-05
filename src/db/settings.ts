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
