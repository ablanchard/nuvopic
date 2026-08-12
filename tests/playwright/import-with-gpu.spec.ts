import { expect, test, type Page } from "@playwright/test";

const runFullStack = process.env.E2E_FULL_STACK === "true";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function chooseSeedFolder(page: Page, folder: string): Promise<void> {
  const row = page.locator(".storage-tree-row").filter({ hasText: `${folder}/` });
  await expect(row).toHaveCount(1);
  await row.getByRole("checkbox").check();
}

test.describe("isolated storage and GPU import", () => {
  test.skip(!runFullStack, "Set E2E_FULL_STACK=true to run infrastructure tests");

  test("configures its bucket and imports through GPU inference", async ({
    page,
  }) => {
    const appUrl = "http://127.0.0.1:4174";
    const bucket = requiredEnv("E2E_S3_BUCKET");
    const region = requiredEnv("E2E_S3_REGION");
    const endpoint = requiredEnv("E2E_S3_ENDPOINT");
    const accessKeyId = requiredEnv("E2E_S3_ACCESS_KEY_ID");
    const secretAccessKey = requiredEnv("E2E_S3_SECRET_ACCESS_KEY");
    const objectKey = requiredEnv("E2E_S3_OBJECT_KEY");
    const folder = objectKey.split("/")[0];

    await test.step("sign in to the isolated app", async () => {
      await page.goto(`${appUrl}/login`);
      await page.getByLabel("Password", { exact: true }).fill("playwright-password");
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page).toHaveURL(`${appUrl}/app/setup/storage`);
    });

    await test.step("configure and validate the MinIO bucket", async () => {
      await page.getByLabel("S3 Bucket", { exact: true }).fill(bucket);
      await page.getByLabel("S3 Region", { exact: true }).fill(region);
      await page.getByLabel("S3 Endpoint", { exact: true }).fill(endpoint);
      await page.getByLabel("Access Key ID", { exact: true }).fill(accessKeyId);
      await page
        .getByLabel("Secret Access Key", { exact: true })
        .fill(secretAccessKey);
      await page.getByLabel("Force Path Style", { exact: true }).check();
      await page.getByRole("button", { name: "Connect Bucket" }).click();
      await expect(page).toHaveURL(`${appUrl}/app/photos`);
    });

    await test.step("import one image with caption and face inference", async () => {
      await page.getByRole("link", { name: "Settings" }).click();
      await page.getByRole("link", { name: "Storage" }).click();
      await expect(page.getByRole("heading", { name: "S3 Folders" })).toBeVisible();
      await expect(page.getByLabel("Caption Processing")).toBeChecked();
      await expect(page.getByLabel("Face Detection")).toBeChecked();
      await page.getByLabel("Limit per folder").check();
      await page.locator(".storage-import-limit input[type='number']").fill("1");
      await chooseSeedFolder(page, folder);
      await page.getByRole("button", { name: "Import Selected (1)" }).click();
      await expect(page.locator(".settings-status")).toContainText(
        "Import complete: 1 processed, 0 failed",
        { timeout: 120_000 }
      );
    });

    await test.step("verify persisted inference results and GPU logs", async () => {
      const photosResponse = await page.request.get(`${appUrl}/api/v1/photos?limit=10`);
      expect(photosResponse.ok()).toBe(true);
      const photosBody = (await photosResponse.json()) as {
        photos: Array<{ description: string | null; faceCount: number }>;
      };
      expect(photosBody.photos).toHaveLength(1);
      expect(photosBody.photos[0]).toMatchObject({
        description: "A person photographed outdoors by the Playwright GPU fixture",
        faceCount: 1,
      });

      const logsResponse = await page.request.get(`${appUrl}/api/v1/gpu-logs`);
      expect(logsResponse.ok()).toBe(true);
      const logsBody = (await logsResponse.json()) as {
        logs: Array<{
          type: string;
          provider: string;
          gpuMode: string;
          status: string;
          photosSucceeded: number;
          photosFailed: number;
        }>;
      };
      expect(logsBody.logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "import",
            provider: "modal",
            gpuMode: "all",
            status: "completed",
            photosSucceeded: 1,
            photosFailed: 0,
          }),
        ])
      );

      const inferenceResponse = await page.request.get(
        `${requiredEnv("E2E_INFERENCE_URL")}/stats`
      );
      const inferenceBody = (await inferenceResponse.json()) as {
        requests: Array<{ path: string; imageBytes: number }>;
      };
      expect(inferenceBody.requests.map((request) => request.path).sort()).toEqual([
        "/caption",
        "/faces",
      ]);
      expect(
        inferenceBody.requests.every((request) => request.imageBytes > 0)
      ).toBe(true);
    });

    await page.getByRole("link", { name: "Photos" }).click();
    await expect(page.locator(".photo-card")).toHaveCount(1);
    await expect(page.locator(".photo-card-image")).toHaveAttribute("src", /^blob:/);
  });
});
