import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  validate: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("../../src/db/settings.js", () => ({
  getAllRuntimeSettings: vi.fn(async () => ({ ...state.settings })),
  upsertSettings: vi.fn(async (values: Record<string, string>) => {
    Object.assign(state.settings, values);
  }),
  deleteSetting: vi.fn(async (key: string) => {
    delete state.settings[key];
  }),
}));

vi.mock("../../src/s3/client.js", () => ({
  validateS3Connection: state.validate,
  invalidateS3Client: state.invalidate,
}));

import {
  beginAwsConnection,
  getAwsConnectionStatus,
  verifyAwsConnection,
} from "../../src/s3/aws-connection.js";

const originalPrincipalArn = process.env.AWS_CONNECT_PRINCIPAL_ARN;
const originalTemplateUrl = process.env.AWS_CONNECT_TEMPLATE_URL;

describe("AWS connection state transition", () => {
  beforeEach(() => {
    for (const key of Object.keys(state.settings)) delete state.settings[key];
    state.settings.s3_access_key_id = "old-customer-key";
    state.settings.s3_secret_access_key = "old-customer-secret";
    state.validate.mockReset().mockResolvedValue(undefined);
    state.invalidate.mockReset();
    process.env.AWS_CONNECT_PRINCIPAL_ARN =
      "arn:aws:iam::111122223333:role/NuvoPicConnector";
    process.env.AWS_CONNECT_TEMPLATE_URL =
      "https://nuvopic-assets.s3.us-east-1.amazonaws.com/cloudformation.yaml";
  });

  afterEach(() => {
    if (originalPrincipalArn === undefined) delete process.env.AWS_CONNECT_PRINCIPAL_ARN;
    else process.env.AWS_CONNECT_PRINCIPAL_ARN = originalPrincipalArn;
    if (originalTemplateUrl === undefined) delete process.env.AWS_CONNECT_TEMPLATE_URL;
    else process.env.AWS_CONNECT_TEMPLATE_URL = originalTemplateUrl;
  });

  it("moves from CloudFormation pending to a verified temporary-role connection", async () => {
    const pending = await beginAwsConnection({
      bucket: "s3://family-photos",
      region: "eu-west-1",
      accountId: "123456789012",
    });

    expect(pending.state).toBe("pending");
    expect(pending.launchUrl).toContain("cloudformation/home");
    expect(state.settings.s3_external_id).toMatch(/^nuvopic-/);
    expect(state.settings.aws_connect_role_name).toMatch(/^NuvoPicRead-/);

    const connected = await verifyAwsConnection();

    expect(state.validate).toHaveBeenCalledWith(
      {
        region: "eu-west-1",
        roleArn: `arn:aws:iam::123456789012:role/${state.settings.aws_connect_role_name}`,
        externalId: state.settings.s3_external_id,
      },
      "family-photos"
    );
    expect(connected.state).toBe("connected");
    expect(state.settings.s3_auth_mode).toBe("aws-role");
    expect(state.settings.s3_access_key_id).toBeUndefined();
    expect(state.settings.s3_secret_access_key).toBeUndefined();
    expect(state.invalidate).toHaveBeenCalledOnce();
    await expect(getAwsConnectionStatus()).resolves.toMatchObject({
      state: "connected",
      bucket: "family-photos",
    });
  });

  it("shows the new pending target when reconnecting from an existing bucket", async () => {
    Object.assign(state.settings, {
      s3_auth_mode: "aws-role",
      s3_bucket: "previous-photos",
      s3_region: "fr-par",
      s3_role_arn: "arn:aws:iam::123456789012:role/NuvoPicRead-previous",
      s3_external_id: "nuvopic-previous",
    });

    const pending = await beginAwsConnection({
      bucket: "replacement-photos",
      region: "eu-west-3",
      accountId: "123456789012",
    });

    expect(pending).toMatchObject({
      state: "pending",
      bucket: "replacement-photos",
      region: "eu-west-3",
      accountId: "123456789012",
    });
  });

  it("keeps the pending role when correcting only the AWS account ID", async () => {
    const initial = await beginAwsConnection({
      bucket: "family-photos",
      region: "eu-west-3",
      accountId: "123456789012",
    });
    const initialRoleName = initial.roleName;
    const initialExternalId = state.settings.s3_external_id;

    const corrected = await beginAwsConnection({
      bucket: "family-photos",
      region: "eu-west-3",
      accountId: "210987654321",
    });

    expect(corrected).toMatchObject({
      state: "pending",
      accountId: "210987654321",
      roleName: initialRoleName,
    });
    expect(state.settings.s3_external_id).toBe(initialExternalId);
  });
});
