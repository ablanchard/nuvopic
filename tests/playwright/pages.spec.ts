import { expect, test, type Page } from "@playwright/test";

type JsonValue = Record<string, unknown> | unknown[];

const configuredSettings = {
  s3_bucket: "playwright-bucket",
  s3_region: "us-east-1",
  s3_endpoint: "",
  s3_access_key_id: "playwright-access-key",
  s3_secret_access_key: "__MASKED__",
  s3_force_path_style: "false",
};

function pipelineStats() {
  return {
    versions: { v1: 0 },
    latestVersion: "v1",
    outdated: 0,
    changelog: { v1: "Current" },
  };
}

async function mockApi(page: Page, storageConfigured = true): Promise<string[]> {
  const unexpectedRequests: string[] = [];

  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let json: JsonValue | undefined;

    if (path === "/api/v1/runtime") {
      json = {
        deployMode: "standalone",
        managedTokenEndpoint: null,
        profilePath: null,
        adminPath: null,
        storageSetupPath: "/app/setup/storage",
      };
    } else if (path === "/api/v1/runtime/session") {
      json = {
        deployMode: "standalone",
        role: "owner",
        subject: "playwright-user",
        workspaceId: null,
        storageConfigured,
        storageSetupPath: "/app/setup/storage",
        profilePath: null,
        adminPath: null,
      };
    } else if (path === "/api/v1/settings/s3") {
      json = Object.fromEntries(
        Object.entries(configuredSettings).map(([key, value]) => [
          key,
          {
            envValue: null,
            effectiveValue: value || null,
            effectiveSource: value ? "db" : null,
          },
        ])
      );
    } else if (path === "/api/v1/settings") {
      json = configuredSettings;
    } else if (path === "/api/v1/photos/timeline") {
      json = { groups: [], total: 0 };
    } else if (path === "/api/v1/photos/reprocess/stats") {
      json = {
        totalPhotos: 0,
        pathPrefix: null,
        process: pipelineStats(),
        caption: pipelineStats(),
        faces: pipelineStats(),
        estimates: {
          gpuEnabled: false,
          provider: "local",
          secsPerPhoto: 0,
          costPerHour: 0,
        },
      };
    } else if (path === "/api/v1/photos") {
      json = {
        photos: [],
        pagination: { page: 1, limit: 50, total: 0, hasMore: false },
      };
    } else if (path === "/api/v1/persons") {
      json = { persons: [] };
    } else if (path === "/api/v1/tags") {
      json = { tags: [] };
    } else if (path === "/api/v1/clusters/unassigned") {
      json = { faces: [] };
    } else if (path === "/api/v1/clusters") {
      json = { clusters: [] };
    } else if (path === "/api/v1/gpu-logs") {
      json = {
        logs: [],
        pagination: { page: 1, limit: 20, total: 0, hasMore: false },
      };
    } else if (path === "/api/v1/smart-tags/fields") {
      json = { fields: ["s3_path", "taken_at", "description"] };
    } else if (path === "/api/v1/smart-tags/facets") {
      const field = url.searchParams.get("field");
      json = field === "s3_path"
        ? { type: "path", facets: [] }
        : field === "taken_at"
          ? { type: "date", facets: [] }
          : { type: "text", facets: [] };
    } else if (path === "/api/v1/smart-tags") {
      json = { smartTags: [] };
    } else if (path === "/api/v1/storage/browse") {
      json = {
        bucket: "playwright-bucket",
        prefix: "",
        folders: [],
        imageCount: 0,
        importedCount: 0,
        missingCount: 0,
      };
    } else if (path === "/api/v1/storage/browse-counts") {
      json = { prefix: "", imageCount: 0, folders: [] };
    }

    if (json === undefined) {
      unexpectedRequests.push(`${route.request().method()} ${path}`);
      await route.fulfill({
        status: 501,
        json: { error: `No Playwright mock for ${path}` },
      });
      return;
    }

    await route.fulfill({ json });
  });

  return unexpectedRequests;
}

const pages = [
  {
    name: "photos",
    path: "/app/photos",
    assert: async (page: Page) => {
      await expect(page.getByRole("link", { name: "Photos" })).toHaveClass(/nav-link--active/);
      await expect(page.getByText("No photos found", { exact: true })).toBeVisible();
    },
  },
  {
    name: "faces",
    path: "/app/faces",
    assert: async (page: Page) => {
      await expect(page.getByRole("link", { name: "Faces" })).toHaveClass(/nav-link--active/);
      await expect(page.getByRole("heading", { name: "Face Quality" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Face Clustering" })).toBeVisible();
    },
  },
  {
    name: "general settings",
    path: "/app/settings",
    assert: async (page: Page) => {
      await expect(page.getByRole("link", { name: "General" })).toHaveClass(/settings-nav-link--active/);
      await expect(page.getByRole("heading", { name: "S3 Storage" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Save Settings" })).toBeVisible();
    },
  },
  {
    name: "GPU logs",
    path: "/app/settings/gpu-logs",
    assert: async (page: Page) => {
      await expect(page.getByRole("link", { name: "GPU Logs" })).toHaveClass(/settings-nav-link--active/);
      await expect(page.getByText("No GPU logs found.", { exact: true })).toBeVisible();
    },
  },
  {
    name: "smart tags",
    path: "/app/settings/smart-tags",
    assert: async (page: Page) => {
      await expect(page.getByRole("link", { name: "Smart Tags" })).toHaveClass(/settings-nav-link--active/);
      await expect(page.getByRole("heading", { name: "Smart Tags" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Create New Smart Tag" })).toBeVisible();
    },
  },
  {
    name: "storage",
    path: "/app/settings/storage",
    assert: async (page: Page) => {
      await expect(page.getByRole("link", { name: "Storage" })).toHaveClass(/settings-nav-link--active/);
      await expect(page.getByRole("heading", { name: "S3 Folders" })).toBeVisible();
      await expect(page.getByText("No folders found in bucket.", { exact: true })).toBeVisible();
    },
  },
  {
    name: "reprocess",
    path: "/app/settings/reprocess",
    assert: async (page: Page) => {
      await expect(page.getByRole("link", { name: "Reprocess" })).toHaveClass(/settings-nav-link--active/);
      await expect(page.getByRole("heading", { name: "0 photos" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Reprocess Options" })).toBeVisible();
    },
  },
] as const;

test.describe("current NuvoPic pages", () => {
  test("renders the standalone login and signs in", async ({ page }) => {
    const unexpectedRequests = await mockApi(page);
    const response = await page.goto("http://127.0.0.1:4174/login");

    expect(response?.ok()).toBe(true);
    await expect(page).toHaveTitle("Login");
    await expect(page.getByRole("heading", { name: "Photos" })).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill("playwright-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL("http://127.0.0.1:4174/app/photos");
    await expect(page.getByRole("heading", { name: "NuvoPic" })).toBeVisible();
    expect(unexpectedRequests).toEqual([]);
  });

  for (const currentPage of pages) {
    test(`renders ${currentPage.name}`, async ({ page }) => {
      const unexpectedRequests = await mockApi(page);
      const response = await page.goto(currentPage.path);

      expect(response?.ok()).toBe(true);
      await expect(page).toHaveURL(currentPage.path);
      await expect(page).toHaveTitle("NuvoPic");
      await expect(page.getByRole("heading", { name: "NuvoPic" })).toBeVisible();
      await currentPage.assert(page);
      expect(unexpectedRequests).toEqual([]);
    });
  }

  test("renders storage onboarding", async ({ page }) => {
    const unexpectedRequests = await mockApi(page, false);
    const response = await page.goto("/app/setup/storage");

    expect(response?.ok()).toBe(true);
    await expect(page).toHaveURL("/app/setup/storage");
    await expect(page.getByRole("heading", { name: "Connect Your Bucket" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect Bucket" })).toBeVisible();
    expect(unexpectedRequests).toEqual([]);
  });
});
