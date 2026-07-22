import "dotenv/config";
import { upsertSettings, getS3ConfigInfo } from "../src/db/settings.js";
import { validateS3Connection } from "../src/s3/client.js";

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for S3 settings migration`);
  }
  return value;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  if (!process.env.SETTINGS_KEK?.trim()) {
    throw new Error("SETTINGS_KEK is required");
  }

  const settings = {
    s3_bucket: readRequiredEnv("S3_BUCKET"),
    s3_region: readRequiredEnv("S3_REGION"),
    s3_access_key_id: readRequiredEnv("S3_ACCESS_KEY_ID"),
    s3_secret_access_key: readRequiredEnv("S3_SECRET_ACCESS_KEY"),
  } as Record<string, string>;

  const endpoint = process.env.S3_ENDPOINT?.trim();
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE?.trim();
  if (endpoint) {
    settings.s3_endpoint = endpoint;
  }
  if (forcePathStyle) {
    settings.s3_force_path_style = forcePathStyle;
  }

  console.log("Validating S3 configuration...");
  await validateS3Connection(
    {
      region: settings.s3_region,
      accessKeyId: settings.s3_access_key_id,
      secretAccessKey: settings.s3_secret_access_key,
      endpoint: settings.s3_endpoint,
      forcePathStyle: settings.s3_force_path_style === "true" ? true : undefined,
    },
    settings.s3_bucket
  );

  console.log("Writing encrypted S3 settings to database...");
  await upsertSettings(settings);

  const info = await getS3ConfigInfo();
  console.log("Migration complete.");
  console.log(`Bucket: ${info.s3_bucket?.effectiveValue ?? "(missing)"}`);
  console.log(`Region: ${info.s3_region?.effectiveValue ?? "(missing)"}`);
  console.log(`Access key: ${info.s3_access_key_id?.effectiveValue ?? "(missing)"}`);
  console.log(`Secret key: ${info.s3_secret_access_key?.effectiveValue ?? "(missing)"}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
