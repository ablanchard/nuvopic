import { expect, test, type Page } from "@playwright/test";

type JsonValue = Record<string, unknown> | unknown[];

const configuredSettings = {
  storage_provider: "s3-compatible",
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
  let currentStorageConfigured = storageConfigured;
  let awsConnectionState: "not_started" | "pending" | "connected" = "not_started";

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
        storageConfigured: currentStorageConfigured,
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
    } else if (path === "/api/v1/settings/aws/connect") {
      if (route.request().method() === "POST") {
        awsConnectionState = "pending";
      }
      json = {
        state: awsConnectionState,
        available: true,
        bucket: awsConnectionState === "not_started" ? null : "family-photos",
        region: awsConnectionState === "not_started" ? null : "eu-west-1",
        accountId: awsConnectionState === "not_started" ? null : "123456789012",
        roleName: awsConnectionState === "not_started" ? null : "NuvoPicRead-playwright",
        roleArn: null,
        launchUrl: awsConnectionState === "pending"
          ? "https://eu-west-1.console.aws.amazon.com/cloudformation/home"
          : null,
      };
    } else if (path === "/api/v1/settings/aws/connect/verify") {
      awsConnectionState = "connected";
      currentStorageConfigured = true;
      json = {
        state: "connected",
        available: true,
        bucket: "family-photos",
        region: "eu-west-1",
        accountId: "123456789012",
        roleName: "NuvoPicRead-playwright",
        roleArn: "arn:aws:iam::123456789012:role/NuvoPicRead-playwright",
        launchUrl: null,
      };
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
    } else if (path === "/api/v1/photos/location-facets") {
      json = { facets: [] };
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
      if (url.searchParams.get("limit") !== "40" || url.searchParams.get("offset") !== "0") {
        unexpectedRequests.push(`${route.request().method()} ${url.pathname}${url.search}`);
      }
      json = { faces: [], total: 0, hasMore: false };
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

  test("guides Amazon S3 setup through CloudFormation", async ({ page }) => {
    const unexpectedRequests = await mockApi(page, false);
    await page.goto("/app/setup/storage");

    await page.getByLabel("Storage Provider").selectOption("amazon-s3");
    await expect(page.getByText("Connect Amazon S3 securely")).toBeVisible();
    await expect(page.getByLabel("Access Key ID")).toHaveCount(0);
    await expect(page.getByLabel("Secret Access Key")).toHaveCount(0);

    await page.getByLabel("Bucket name or S3 URL").fill("s3://family-photos");
    await page.getByLabel("AWS region").fill("eu-west-1");
    await page.getByLabel("AWS account ID").fill("123456789012");
    await page.getByRole("button", { name: "Prepare AWS setup" }).click();

    const launch = page.getByRole("link", { name: "Open AWS CloudFormation ↗" });
    await expect(launch).toBeVisible();
    await expect(launch).toHaveAttribute("target", "_blank");
    await page.getByRole("button", { name: "I created the stack — verify" }).click();
    await expect(page).toHaveURL("/app/photos");
    expect(unexpectedRequests).toEqual([]);
  });

  test("keeps mobile navigation and settings controls readable", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const unexpectedRequests = await mockApi(page);
    await page.goto("/app/settings");

    const nav = page.locator(".nav-links");
    await nav.evaluate((element) => {
      for (const label of ["Profile", "Admin"]) {
        const link = element.ownerDocument.createElement("a");
        link.className = "nav-link";
        link.textContent = label;
        element.append(link);
      }
    });
    const firstNavLink = nav.locator(".nav-link").first();
    const lastNavLink = nav.locator(".nav-link").last();
    const firstRow = page.locator(".setting-row").first();
    const firstInfo = firstRow.locator(".setting-info");
    const firstControl = firstRow.locator(".setting-control");
    const providerSelect = page.locator("#setting-storage_provider");

    const [firstLinkBox, lastLinkBox, rowBox, infoBox, controlBox] = await Promise.all([
      firstNavLink.boundingBox(),
      lastNavLink.boundingBox(),
      firstRow.boundingBox(),
      firstInfo.boundingBox(),
      firstControl.boundingBox(),
    ]);

    expect(firstLinkBox?.x).toBeGreaterThanOrEqual(16);
    expect((lastLinkBox?.x ?? 0) + (lastLinkBox?.width ?? 0)).toBeLessThanOrEqual(344);
    expect(controlBox?.y).toBeGreaterThanOrEqual((infoBox?.y ?? 0) + (infoBox?.height ?? 0));
    expect(controlBox?.width).toBeCloseTo(rowBox?.width ?? 0, 0);
    await expect(providerSelect).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(providerSelect).toHaveCSS("color", "rgb(34, 34, 34)");
    expect(unexpectedRequests).toEqual([]);
  });
});

test('videos show duration, play in the viewer, and offer an original on failure', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/v1/photos?**', (route) => route.fulfill({ json: {
    photos: [{ id: 'video', mediaType: 'video', durationSeconds: 2,
      thumbnailUrl: '/api/v1/photos/video/thumbnail', fullImageUrl: '/api/v1/photos/video/image',
      placeholder: null, takenAt: null, dateUnknown: true, datePrecision: 'unknown', dateSource: 'unknown',
      description: null, width: 160, height: 90, faceCount: 0, tags: [], location: null }],
    pagination: { page: 1, limit: 50, total: 1, hasMore: false },
  } }));
  await page.route('**/api/v1/photos/timeline**', (route) => route.fulfill({ json: { groups: [{ year: null, month: null, count: 1 }], total: 1 } }));
  await page.route('**/api/v1/photos/video/thumbnail*', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/photos/video/image', (route) => route.fulfill({ json: { url: '/test-video.mp4' } }));
  await page.route('**/test-video.mp4', (route) => route.fulfill({ path: 'tests/fixtures/video.mp4', contentType: 'video/mp4' }));
  await page.goto('/app/photos');
  await expect(page.locator('.video-badge')).toHaveText('▶ 0:02');
  await page.locator('.photo-card').click();
  const video = page.locator('video');
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute('controls', '');
  await expect(video).toHaveAttribute('preload', 'auto');
  await expect.poll(() => video.evaluate((element) => (element as unknown as { duration: number }).duration)).toBe(2);
  await video.evaluate((element) => (element as unknown as { play(): Promise<void> }).play());
  await expect.poll(() => video.evaluate((element) => (element as unknown as { currentTime: number }).currentTime)).toBeGreaterThan(0);
  await video.dispatchEvent('error');
  await expect(page.getByRole('link', { name: 'Open original' })).toHaveAttribute('href', '/test-video.mp4');
});

test('video feed snapshots filters, navigates without repeats and stops on close', async ({ page }) => {
  await mockApi(page);
  let selectionQuery = '';
  await page.route('**/api/v1/photos/video-feed?**', (route) => {
    selectionQuery = new URL(route.request().url()).searchParams.get('q') || '';
    return route.fulfill({ json: { ids: ['one', 'two', 'three'] } });
  });
  await page.route('**/api/v1/photos/*/image', (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[4];
    return route.fulfill({ json: { url: `/feed-${id}.mp4` } });
  });
  await page.route('**/feed-*.mp4', (route) => route.fulfill({ path: 'tests/fixtures/video.mp4', contentType: 'video/mp4' }));
  await page.goto('/app/photos');
  await page.getByPlaceholder('Search by description or person...').filter({ visible: true }).fill('beach');
  await page.waitForResponse((response) => response.url().includes('/photos/timeline?') && response.url().includes('beach'));
  await page.getByRole('button', { name: 'Watch videos' }).click();
  const dialog = page.getByRole('dialog', { name: 'Video feed' });
  await expect(dialog).toBeVisible();
  expect(selectionQuery).toBe('beach');
  const video = dialog.locator('video[aria-label="Current video"]');
  const seen = new Set<string>();
  for (let i = 0; i < 3; i++) {
    await expect(video).toHaveAttribute('src', /feed-/);
    await video.evaluate((element: HTMLVideoElement) => { element.loop = true; });
    const src = (await video.getAttribute('src'))!;
    expect(seen.has(src)).toBe(false);
    seen.add(src);
    await expect(dialog).toContainText(`${i + 1} / 3`);
    if (i < 2) {
      await page.keyboard.press('ArrowDown');
      await expect(video).not.toHaveAttribute('src', src);
    }
  }
  await page.getByRole('button', { name: 'Previous video' }).click();
  await expect(dialog).toContainText('2 / 3');
  await dialog.locator('.video-feed-stage').evaluate((element) => {
    element.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [new Touch({ identifier: 0, target: element, clientY: 500 })] }));
    element.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [new Touch({ identifier: 0, target: element, clientY: 100 })] }));
  });
  await expect(dialog).toContainText('3 / 3');
  await page.getByRole('button', { name: 'Unmute videos', exact: true }).click();
  expect(await video.evaluate((element: HTMLVideoElement) => element.muted)).toBe(false);
  await video.dispatchEvent('ended');
  await expect(dialog).toContainText('1 / 3');
  await page.getByRole('button', { name: 'Close video feed' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('video')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Watch videos' })).toBeFocused();
});

test('video feed handles empty filters and failed selections', async ({ page }) => {
  await mockApi(page);
  let failed = true;
  await page.route('**/api/v1/photos/video-feed?**', (route) => failed
    ? route.fulfill({ status: 500, json: { error: 'Unavailable' } })
    : route.fulfill({ json: { ids: [] } }));
  await page.goto('/app/photos');
  await page.getByRole('button', { name: 'Watch videos' }).click();
  await expect(page.getByRole('alert')).toContainText('Could not load videos');
  failed = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('No videos match your current filters.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Video feed' })).toHaveCount(0);
});

test('video feed reuses the silently preloaded player, including across shuffled rounds', async ({ page }) => {
  await mockApi(page);
  const signedRequests: Record<string, number> = {};
  await page.route('**/api/v1/photos/video-feed?**', (route) => route.fulfill({ json: { ids: ['alpha', 'beta'] } }));
  await page.route('**/api/v1/photos/*/image', (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[4];
    signedRequests[id] = (signedRequests[id] || 0) + 1;
    return route.fulfill({ json: { url: `/buffer-${id}.mp4?request=${signedRequests[id]}` } });
  });
  await page.route('**/buffer-*.mp4?**', (route) => route.fulfill({ path: 'tests/fixtures/video.mp4', contentType: 'video/mp4' }));
  await page.goto('/app/photos');
  await page.getByRole('button', { name: 'Watch videos' }).click();
  const active = page.locator('video[aria-label="Current video"]');
  const preloaded = page.locator('video[aria-label="Next video"]');
  for (let step = 0; step < 2; step++) {
    await active.evaluate((video: HTMLVideoElement) => { video.loop = true; });
    await expect.poll(() => preloaded.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(3);
    const nextUrl = (await preloaded.getAttribute('src'))!;
    expect(await preloaded.evaluate((video: HTMLVideoElement) => video.paused && video.muted && video.buffered.length > 0)).toBe(true);
    await preloaded.evaluate((video) => { video.setAttribute('data-preloaded', 'retained'); });
    const oldPlayer = await active.elementHandle();
    await page.getByRole('button', { name: 'Next video', exact: true }).click();
    await expect(active).toHaveAttribute('src', nextUrl);
    await expect(active).toHaveAttribute('data-preloaded', 'retained');
    expect(await oldPlayer!.evaluate((video: HTMLVideoElement) => video.paused && !video.hasAttribute('src'))).toBe(true);
    await expect(page.locator('.video-feed-stage video')).toHaveCount(2);
  }
  const players = await page.locator('.video-feed-stage video').elementHandles();
  await page.getByRole('button', { name: 'Close video feed' }).click();
  await expect(page.locator('video')).toHaveCount(0);
  for (const player of players) {
    expect(await player.evaluate((video: HTMLVideoElement) => video.paused && !video.hasAttribute('src'))).toBe(true);
  }
});
