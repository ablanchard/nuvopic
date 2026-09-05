import { describe, expect, it } from "vitest";
import {
  buildCloudFormationLaunchUrl,
  normalizeAwsAccountId,
  normalizeAwsBucket,
  normalizeAwsRegion,
} from "../../src/s3/aws-connection.js";

describe("AWS S3 CloudFormation connection", () => {
  it("accepts a bucket name or S3 URL and normalizes AWS identifiers", () => {
    expect(normalizeAwsBucket("s3://Family-Photos/iphone/")).toBe("family-photos");
    expect(normalizeAwsRegion(" EU-WEST-1 ")).toBe("eu-west-1");
    expect(normalizeAwsAccountId("123456789012")).toBe("123456789012");
  });

  it("rejects invalid bucket names, regions, and account IDs", () => {
    expect(() => normalizeAwsBucket("s3://bad_bucket")).toThrow("valid Amazon S3 bucket");
    expect(() => normalizeAwsRegion("europe")).toThrow("valid AWS region");
    expect(() => normalizeAwsAccountId("1234")).toThrow("exactly 12 digits");
  });

  it("builds a pre-filled CloudFormation Quick Create link", () => {
    const url = buildCloudFormationLaunchUrl({
      templateUrl: "https://nuvopic-assets.s3.eu-west-1.amazonaws.com/cloudformation.yaml",
      principalArn: "arn:aws:iam::111122223333:role/NuvoPicConnector",
      externalId: "nuvopic-workspace-123",
      bucket: "family-photos",
      region: "eu-west-1",
      roleName: "NuvoPicRead-abc123",
    });

    expect(url).toContain("eu-west-1.console.aws.amazon.com/cloudformation/home");
    expect(url).toContain("param_BucketName=family-photos");
    expect(url).toContain("param_ExternalId=nuvopic-workspace-123");
    expect(url).toContain("param_RoleName=NuvoPicRead-abc123");
    expect(url).toContain("param_NuvoPicPrincipalArn=arn%3Aaws%3Aiam%3A%3A111122223333%3Arole%2FNuvoPicConnector");
  });
});
