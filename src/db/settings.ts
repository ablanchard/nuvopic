import crypto from "node:crypto";
import { query } from "./client.js";
import { getSettingsKek } from "../config/runtime.js";

export interface SettingRecord {
  key: string;
  value: string;
  updated_at: Date;
}

export interface S3ConfigInfo {
  envValue: string | null;
  effectiveValue: string | null;
  effectiveSource: "db" | "env" | null;
}

export interface ResolvedS3Config {
  bucket: string | null;
  region: string | null;
  endpoint: string | null;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  forcePathStyle: boolean;
}

export interface FaceQualitySettings {
  minConfidence: number;
  minSize: number;
}

const DEFAULTS: FaceQualitySettings = {
  minConfidence: 0.7,
  minSize: 2500,
};

export const SECRET_SETTING_KEYS = new Set([
  "s3_secret_access_key",
  "webhook_secret",
]);

export const MASKED_VALUE = "__MASKED__";

const INTERNAL_SETTING_KEYS = new Set(["__settings_wrapped_dek_v1"]);
const HIDDEN_SETTING_KEYS = new Set(["webhook_secret"]);
const WRAPPED_DEK_SETTING_KEY = "__settings_wrapped_dek_v1";
const ENCRYPTED_VALUE_PREFIX = "enc:v1";
const WRAPPED_KEY_PREFIX = "wrap:v1";

function encodeEnvelope(
  prefix: string,
  iv: Buffer,
  tag: Buffer,
  ciphertext: Buffer
): string {
  return [
    prefix,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

function decodeEnvelope(
  value: string,
  prefix: string
): { iv: Buffer; tag: Buffer; ciphertext: Buffer } | null {
  if (!value.startsWith(`${prefix}:`)) {
    return null;
  }

  const payload = value.slice(prefix.length + 1);
  const parts = payload.split(":");
  if (parts.length !== 3) {
    return null;
  }

  const [iv, tag, ciphertext] = parts;
  return {
    iv: Buffer.from(iv, "base64url"),
    tag: Buffer.from(tag, "base64url"),
    ciphertext: Buffer.from(ciphertext, "base64url"),
  };
}

function deriveKek(): Buffer {
  const raw = getSettingsKek();
  if (!raw) {
    throw new Error("SETTINGS_KEK environment variable is required");
  }

  return crypto.createHash("sha256").update(raw).digest();
}

function wrapDek(dek: Buffer): string {
  const kek = deriveKek();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", kek, iv);
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return encodeEnvelope(WRAPPED_KEY_PREFIX, iv, tag, ciphertext);
}

function unwrapDek(wrappedDek: string): Buffer {
  const parsed = decodeEnvelope(wrappedDek, WRAPPED_KEY_PREFIX);
  if (!parsed) {
    throw new Error("Invalid wrapped settings key");
  }

  const kek = deriveKek();
  const decipher = crypto.createDecipheriv("aes-256-gcm", kek, parsed.iv);
  decipher.setAuthTag(parsed.tag);
  return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
}

function encryptSecretValue(value: string, dek: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dek, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return encodeEnvelope(ENCRYPTED_VALUE_PREFIX, iv, tag, ciphertext);
}

function decryptSecretValue(value: string, dek: Buffer): string {
  const parsed = decodeEnvelope(value, ENCRYPTED_VALUE_PREFIX);
  if (!parsed) {
    return value;
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", dek, parsed.iv);
  decipher.setAuthTag(parsed.tag);
  return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]).toString("utf-8");
}

async function getRawSettings(): Promise<Record<string, string>> {
  const result = await query<SettingRecord>("SELECT key, value FROM settings");
  const map: Record<string, string> = {};
  for (const row of result.rows) {
    map[row.key] = row.value;
  }
  return map;
}

async function getWrappedDek(): Promise<string | null> {
  const result = await query<{ value: string }>(
    "SELECT value FROM settings WHERE key = $1",
    [WRAPPED_DEK_SETTING_KEY]
  );
  return result.rows[0]?.value ?? null;
}

async function ensureWorkspaceDek(): Promise<Buffer> {
  const wrappedDek = await getWrappedDek();
  if (wrappedDek) {
    return unwrapDek(wrappedDek);
  }

  const dek = crypto.randomBytes(32);
  await query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [WRAPPED_DEK_SETTING_KEY, wrapDek(dek)]
  );
  return dek;
}

function unwrapWorkspaceDek(raw: Record<string, string>): Buffer | null {
  const wrappedDek = raw[WRAPPED_DEK_SETTING_KEY];
  if (!wrappedDek) return null;
  return unwrapDek(wrappedDek);
}

function stripInternalKeys(raw: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!INTERNAL_SETTING_KEYS.has(key) && !HIDDEN_SETTING_KEYS.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function maybeDecryptSettings(
  raw: Record<string, string>
): Record<string, string> {
  const filtered = stripInternalKeys(raw);
  const dek = raw[WRAPPED_DEK_SETTING_KEY] ? unwrapWorkspaceDek(raw) : null;

  for (const key of Object.keys(filtered)) {
    if (SECRET_SETTING_KEYS.has(key) && dek) {
      filtered[key] = decryptSecretValue(filtered[key], dek);
    }
  }

  return filtered;
}

/** Get all settings as a key-value map. */
export async function getAllSettings(): Promise<Record<string, string>> {
  const raw = await getRawSettings();
  return maybeDecryptSettings(raw);
}

/** Get a single setting by key. Returns null if not found. */
export async function getSetting(key: string): Promise<string | null> {
  if (INTERNAL_SETTING_KEYS.has(key)) {
    return null;
  }

  const raw = await getRawSettings();
  const value = raw[key];
  if (value === undefined) {
    return null;
  }

  if (SECRET_SETTING_KEYS.has(key)) {
    const dek = raw[WRAPPED_DEK_SETTING_KEY] ? unwrapWorkspaceDek(raw) : null;
    return dek ? decryptSecretValue(value, dek) : value;
  }

  return value;
}

/** Upsert one or more settings. */
export async function upsertSettings(
  settings: Record<string, string>
): Promise<void> {
  const entries = Object.entries(settings).filter(
    ([key]) => !INTERNAL_SETTING_KEYS.has(key)
  );
  if (entries.length === 0) return;

  const requiresDek = entries.some(([key]) => SECRET_SETTING_KEYS.has(key));
  const dek = requiresDek ? await ensureWorkspaceDek() : null;

  for (const [key, value] of entries) {
    const storedValue =
      SECRET_SETTING_KEYS.has(key) && dek
        ? encryptSecretValue(value, dek)
        : value;

    await query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, storedValue]
    );
  }
}

/** Delete a setting by key. */
export async function deleteSetting(key: string): Promise<void> {
  if (INTERNAL_SETTING_KEYS.has(key)) {
    return;
  }

  await query("DELETE FROM settings WHERE key = $1", [key]);
}

/** Get face quality thresholds (parsed and with defaults). */
export async function getFaceQualitySettings(): Promise<FaceQualitySettings> {
  const all = await getAllSettings();
  const minConfidence = parseFloat(all["face_min_confidence"] ?? "");
  const minSize = parseInt(all["face_min_size"] ?? "", 10);

  return {
    minConfidence:
      Number.isFinite(minConfidence) && minConfidence >= 0 && minConfidence <= 1
        ? minConfidence
        : DEFAULTS.minConfidence,
    minSize:
      Number.isFinite(minSize) && minSize >= 0 ? minSize : DEFAULTS.minSize,
  };
}

/**
 * Returns a SQL WHERE fragment (without leading AND/WHERE) that filters faces
 * by quality settings. The fragment references the faces table via the given alias.
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

function resolveS3ConfigFromSettings(allSettings: Record<string, string>): ResolvedS3Config {
  function resolve(settingKey: string): string | null {
    const value = allSettings[settingKey]?.trim();
    return value ? value : null;
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

/**
 * Resolve the effective S3 bucket name from DB settings only.
 * Returns null if it is not configured.
 */
export async function getS3Bucket(): Promise<string | null> {
  const override = await getSetting("s3_bucket");
  return override?.trim() || null;
}

/** Resolve the full S3 config from DB settings only. */
export async function getResolvedS3Config(): Promise<ResolvedS3Config> {
  const allSettings = await getAllSettings();
  return resolveS3ConfigFromSettings(allSettings);
}

export async function isS3Configured(): Promise<boolean> {
  const resolved = await getResolvedS3Config();
  return Boolean(
    resolved.bucket &&
      resolved.region &&
      resolved.accessKeyId &&
      resolved.secretAccessKey
  );
}

/**
 * Returns info about all S3 config fields for the settings UI.
 * Secret values are masked and envValue is always null because runtime reads DB only.
 */
export async function getS3ConfigInfo(): Promise<Record<string, S3ConfigInfo>> {
  const allSettings = await getAllSettings();
  const resolved = resolveS3ConfigFromSettings(allSettings);
  const result: Record<string, S3ConfigInfo> = {};

  const settingKeys = [
    "s3_bucket",
    "s3_region",
    "s3_endpoint",
    "s3_access_key_id",
    "s3_secret_access_key",
    "s3_force_path_style",
  ] as const;

  for (const settingKey of settingKeys) {
    let effectiveValue: string | null;
    switch (settingKey) {
      case "s3_bucket":
        effectiveValue = resolved.bucket;
        break;
      case "s3_region":
        effectiveValue = resolved.region;
        break;
      case "s3_endpoint":
        effectiveValue = resolved.endpoint;
        break;
      case "s3_access_key_id":
        effectiveValue = resolved.accessKeyId;
        break;
      case "s3_secret_access_key":
        effectiveValue = resolved.secretAccessKey;
        break;
      case "s3_force_path_style":
        effectiveValue = allSettings[settingKey] ?? null;
        break;
    }

    if (SECRET_SETTING_KEYS.has(settingKey)) {
      result[settingKey] = {
        envValue: null,
        effectiveValue: effectiveValue ? "••••" + effectiveValue.slice(-4) : null,
        effectiveSource: effectiveValue ? "db" : null,
      };
      continue;
    }

    result[settingKey] = {
      envValue: null,
      effectiveValue,
      effectiveSource: effectiveValue ? "db" : null,
    };
  }

  return result;
}

export function buildResolvedS3ConfigFromSettings(
  settings: Record<string, string>
): ResolvedS3Config {
  return resolveS3ConfigFromSettings(settings);
}
