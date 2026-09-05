import crypto from "node:crypto";
import {
  getAwsConnectPrincipalArn,
  getAwsConnectTemplateUrl,
} from "../config/runtime.js";
import {
  deleteSetting,
  getAllRuntimeSettings,
  upsertSettings,
} from "../db/settings.js";
import { invalidateS3Client, validateS3Connection } from "./client.js";

const AWS_ACCOUNT_ID_PATTERN = /^\d{12}$/;
const AWS_BUCKET_PATTERN = /^(?!xn--)(?!sthree-)(?!amzn_s3_demo_)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const AWS_PRINCIPAL_PATTERN = /^arn:aws:iam::\d{12}:(?:role\/[A-Za-z0-9+=,.@_\/-]+|user\/[A-Za-z0-9+=,.@_\/-]+)$/;

const CONNECT_ACCOUNT_ID = "aws_connect_account_id";
const CONNECT_BUCKET = "aws_connect_bucket";
const CONNECT_REGION = "aws_connect_region";
const CONNECT_ROLE_NAME = "aws_connect_role_name";
const CONNECT_PENDING = "aws_connect_pending";

export interface AwsConnectionStatus {
  state: "not_started" | "pending" | "connected";
  available: boolean;
  bucket: string | null;
  region: string | null;
  accountId: string | null;
  roleName: string | null;
  roleArn: string | null;
  launchUrl: string | null;
}

export interface BeginAwsConnectionInput {
  bucket: string;
  region: string;
  accountId: string;
}

function connectorConfiguration(): { principalArn: string; templateUrl: string } | null {
  const principalArn = getAwsConnectPrincipalArn();
  const templateUrl = getAwsConnectTemplateUrl();
  if (!principalArn || !templateUrl) return null;

  if (!AWS_PRINCIPAL_PATTERN.test(principalArn)) {
    throw new Error("AWS_CONNECT_PRINCIPAL_ARN is not a valid AWS IAM principal ARN");
  }

  let parsedTemplateUrl: URL;
  try {
    parsedTemplateUrl = new URL(templateUrl);
  } catch {
    throw new Error("AWS_CONNECT_TEMPLATE_URL is not a valid URL");
  }
  if (parsedTemplateUrl.protocol !== "https:") {
    throw new Error("AWS_CONNECT_TEMPLATE_URL must use HTTPS");
  }

  return { principalArn, templateUrl: parsedTemplateUrl.toString() };
}

export function normalizeAwsBucket(value: string): string {
  const trimmed = value.trim();
  const withoutScheme = trimmed.replace(/^s3:\/\//i, "");
  const bucket = withoutScheme.split("/", 1)[0].trim().toLowerCase();

  if (!AWS_BUCKET_PATTERN.test(bucket) || bucket.includes("..") || /^\d+\.\d+\.\d+\.\d+$/.test(bucket)) {
    throw new Error("Enter a valid Amazon S3 bucket name or s3:// URL");
  }
  return bucket;
}

export function normalizeAwsRegion(value: string): string {
  const region = value.trim().toLowerCase();
  if (!AWS_REGION_PATTERN.test(region)) {
    throw new Error("Enter a valid AWS region, for example us-east-1");
  }
  return region;
}

export function normalizeAwsAccountId(value: string): string {
  const accountId = value.trim();
  if (!AWS_ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("AWS account ID must contain exactly 12 digits");
  }
  return accountId;
}

export function buildCloudFormationLaunchUrl(input: {
  templateUrl: string;
  principalArn: string;
  externalId: string;
  bucket: string;
  region: string;
  roleName: string;
}): string {
  const stackName = `NuvoPic-S3-${input.roleName.slice(-12)}`;
  const parameters = new URLSearchParams({
    templateURL: input.templateUrl,
    stackName,
    param_BucketName: input.bucket,
    param_ExternalId: input.externalId,
    param_NuvoPicPrincipalArn: input.principalArn,
    param_RoleName: input.roleName,
  });
  return `https://${input.region}.console.aws.amazon.com/cloudformation/home?region=${encodeURIComponent(input.region)}#/stacks/create/review?${parameters.toString()}`;
}

function pendingLaunchUrl(
  settings: Record<string, string>,
  configuration: { principalArn: string; templateUrl: string } | null
): string | null {
  const externalId = settings.s3_external_id;
  const bucket = settings[CONNECT_BUCKET];
  const region = settings[CONNECT_REGION];
  const roleName = settings[CONNECT_ROLE_NAME];
  if (!configuration || !externalId || !bucket || !region || !roleName) return null;

  return buildCloudFormationLaunchUrl({
    ...configuration,
    externalId,
    bucket,
    region,
    roleName,
  });
}

export async function getAwsConnectionStatus(): Promise<AwsConnectionStatus> {
  const settings = await getAllRuntimeSettings();
  const configuration = connectorConfiguration();
  const connected =
    settings[CONNECT_PENDING] !== "true" &&
    settings.s3_auth_mode === "aws-role" &&
    Boolean(settings.s3_role_arn && settings.s3_external_id && settings.s3_bucket && settings.s3_region);
  const pending = settings[CONNECT_PENDING] === "true" && Boolean(
    settings[CONNECT_ACCOUNT_ID] &&
      settings[CONNECT_BUCKET] &&
      settings[CONNECT_REGION] &&
      settings[CONNECT_ROLE_NAME] &&
      settings.s3_external_id
  );

  return {
    state: connected ? "connected" : pending ? "pending" : "not_started",
    available: Boolean(configuration),
    bucket: pending
      ? settings[CONNECT_BUCKET] ?? null
      : settings.s3_bucket ?? settings[CONNECT_BUCKET] ?? null,
    region: pending
      ? settings[CONNECT_REGION] ?? null
      : settings.s3_region ?? settings[CONNECT_REGION] ?? null,
    accountId: settings[CONNECT_ACCOUNT_ID] ?? null,
    roleName: settings[CONNECT_ROLE_NAME] ?? null,
    roleArn: settings.s3_role_arn ?? null,
    launchUrl: connected ? null : pendingLaunchUrl(settings, configuration),
  };
}

export async function beginAwsConnection(
  input: BeginAwsConnectionInput
): Promise<AwsConnectionStatus> {
  const configuration = connectorConfiguration();
  if (!configuration) {
    throw new Error("Amazon S3 guided setup is not configured on this NuvoPic server");
  }

  const bucket = normalizeAwsBucket(input.bucket);
  const region = normalizeAwsRegion(input.region);
  const accountId = normalizeAwsAccountId(input.accountId);
  const current = await getAllRuntimeSettings();
  const samePendingRole =
    current[CONNECT_PENDING] === "true" &&
    current[CONNECT_BUCKET] === bucket &&
    current[CONNECT_REGION] === region &&
    current[CONNECT_ROLE_NAME] &&
    current.s3_external_id;

  const connectionId = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  await upsertSettings({
    storage_provider: "amazon-s3",
    [CONNECT_BUCKET]: bucket,
    [CONNECT_REGION]: region,
    [CONNECT_ACCOUNT_ID]: accountId,
    [CONNECT_ROLE_NAME]: samePendingRole
      ? current[CONNECT_ROLE_NAME]
      : `NuvoPicRead-${connectionId}`,
    s3_external_id: samePendingRole
      ? current.s3_external_id
      : `nuvopic-${crypto.randomUUID()}`,
    [CONNECT_PENDING]: "true",
  });

  return getAwsConnectionStatus();
}

export async function verifyAwsConnection(): Promise<AwsConnectionStatus> {
  const settings = await getAllRuntimeSettings();
  const accountId = settings[CONNECT_ACCOUNT_ID];
  const bucket = settings[CONNECT_BUCKET];
  const region = settings[CONNECT_REGION];
  const roleName = settings[CONNECT_ROLE_NAME];
  const externalId = settings.s3_external_id;

  if (!accountId || !bucket || !region || !roleName || !externalId) {
    throw new Error("Start the AWS CloudFormation setup before verifying the connection");
  }

  const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
  await validateS3Connection(
    { region, roleArn, externalId },
    bucket
  );

  await upsertSettings({
    storage_provider: "amazon-s3",
    s3_auth_mode: "aws-role",
    s3_bucket: bucket,
    s3_region: region,
    s3_endpoint: "",
    s3_force_path_style: "false",
    s3_role_arn: roleArn,
    s3_external_id: externalId,
    [CONNECT_PENDING]: "false",
  });
  await deleteSetting("s3_access_key_id");
  await deleteSetting("s3_secret_access_key");
  invalidateS3Client();

  return getAwsConnectionStatus();
}
