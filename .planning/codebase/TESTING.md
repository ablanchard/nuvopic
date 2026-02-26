# Testing Patterns

**Analysis Date:** 2026-02-26

## Test Framework

**Runner:**
- Vitest 2.1.0
- Config: `vitest.config.ts` (unit tests), `vitest.integration.config.ts` (e2e tests)
- Environment: Node.js

**Assertion Library:**
- Vitest built-in expect API (no separate assertion library)

**Run Commands:**
```bash
npm run test                    # Run unit tests
npm run test:integration       # Run e2e/integration tests
vitest run                     # Run unit tests (direct command)
vitest run --config vitest.integration.config.ts  # Run integration tests
```

**Configuration Files:**

`vitest.config.ts` - Unit tests:
```typescript
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    testTimeout: 30000,
  },
});
```

`vitest.integration.config.ts` - E2E/Integration tests:
```typescript
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/e2e/**/*.test.ts"],
    testTimeout: 120000,
    setupFiles: ["tests/e2e/setup.ts"],
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    env: {
      LOG_LEVEL: "error",
    },
  },
});
```

## Test File Organization

**Location:**
- Unit tests: `tests/unit/*.test.ts`
- Integration/E2E tests: `tests/e2e/*.test.ts`
- Test fixtures (sample data): `tests/fixtures/`
- Setup/utilities: `tests/e2e/setup.ts`

**Naming:**
- Test files follow source module name with `.test.ts`: `extractors.test.ts`, `process-photo.test.ts`

**Structure:**
```
tests/
├── unit/
│   ├── extractors.test.ts       # Unit tests for extractor functions
│   └── ...
├── e2e/
│   ├── setup.ts                 # Database/service initialization
│   ├── process-photo.test.ts    # Full integration tests
│   └── ...
└── fixtures/
    ├── christopher-campbell-*.jpg
    ├── jurica-koletic-*.jpg
    └── ...
```

## Test Structure

**Suite Organization:**

From `tests/unit/extractors.test.ts`:
```typescript
describe("Thumbnail Extractor", () => {
  it("should generate a 200x200 JPEG thumbnail", async () => {
    // Test implementation
  });

  it("should handle portrait images", async () => {
    // Test implementation
  });
});

describe("EXIF Extractor", () => {
  it("should return null values for image without EXIF", async () => {
    // Test implementation
  });
});

describe("parseDateFromFilename", () => {
  it("should parse Android-style IMG_YYYYMMDD_HHMMSS", () => {
    // Test implementation
  });
});
```

**Patterns:**
- Use `describe()` blocks to group related tests by component/function
- Use `it()` for individual test cases with descriptive names
- Use `beforeAll()` and `afterAll()` for setup/teardown across entire suite
- Use `expect()` assertions from Vitest globals

## Mocking

**Framework:** No mocking library explicitly configured; tests use real implementations

**Patterns:**
- Unit tests use real modules (e.g., `sharp` for image processing)
- Integration tests use real services (PostgreSQL, MinIO via docker-compose)
- No mock functions or stubs used in visible tests

**What to Mock:**
- External HTTP services (not currently mocked; Modal API is tested via integration tests)
- File system operations (not mocked; tests use real files from `tests/fixtures/`)

**What NOT to Mock:**
- Image processing (sharp library is real in unit tests)
- Database operations (real PostgreSQL in integration tests)
- S3 operations (real MinIO in integration tests)
- Extractor logic (tested with real implementations)

## Fixtures and Factories

**Test Data:**

Unit test image creation:
```typescript
const testImage = await sharp({
  create: {
    width: 1920,
    height: 1080,
    channels: 3,
    background: { r: 255, g: 0, b: 0 },
  },
})
  .jpeg()
  .toBuffer();
```

**Location:**
- Real photo fixtures: `tests/fixtures/` (Unsplash stock photos: christopher-campbell-*.jpg, jurica-koletic-*.jpg, etc.)
- Programmatic fixtures created in tests with `sharp.create()`
- Database fixtures: created in `tests/e2e/setup.ts` via SQL schema

## Coverage

**Requirements:** Not enforced (no coverage config in vitest)

**View Coverage:**
- Not configured; no coverage reporting tool set up

## Test Types

**Unit Tests:**
- Scope: Individual functions in isolation (`extractExif()`, `generateThumbnail()`, `parseDateFromFilename()`)
- Approach: Create test input, call function, assert output
- Location: `tests/unit/extractors.test.ts`
- Run time: ~30 seconds total (30000ms timeout per test)

**Integration Tests:**
- Scope: Full photo processing pipeline with real services (S3, database, models)
- Approach: Upload photo to MinIO, trigger handler, verify database records
- Location: `tests/e2e/process-photo.test.ts`
- Run time: ~5 minutes (120000ms timeout per test, sequential execution)
- Setup: `beforeAll()` loads AI models (3-minute timeout), initializes PostgreSQL/MinIO
- Teardown: `afterAll()` cleans up S3 objects and database

**E2E Tests:**
- Not traditional Selenium/browser tests
- API-level integration tests simulating S3 events and handler responses

## Common Patterns

**Async Testing:**

From `tests/e2e/process-photo.test.ts`:
```typescript
it("should process a photo with a face and store metadata", async () => {
  const photoName = TEST_PHOTOS[0];
  const photoPath = path.join(FIXTURES_DIR, photoName);
  const photoBuffer = fs.readFileSync(photoPath);
  const testKey = `test-photos/${photoName}`;

  // Upload to S3
  await s3Client.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: testKey,
      Body: photoBuffer,
      ContentType: "image/jpeg",
    })
  );
  uploadedKeys.push(testKey);

  // Process the photo
  const response = await handler({
    s3Bucket: process.env.S3_BUCKET!,
    s3Key: testKey,
  });

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.processed).toBe(1);
  expect(body.results).toHaveLength(1);
}, 120000);
```

**Promise.allSettled() Testing:**

From unit tests - testing async operations that may fail independently:
```typescript
const [exifResult, thumbnailResult, modalResult] = await Promise.allSettled([
  extractExif(imageBuffer),
  generateThumbnail(imageBuffer),
  analyzeWithModal(imageBuffer),
]);

expect(exifResult.status).toBe("fulfilled");
expect(thumbnailResult.status).toBe("fulfilled");
```

**Error Testing:**

From `tests/e2e/process-photo.test.ts`:
```typescript
it("should skip unsupported file types", async () => {
  const response = await handler({
    s3Bucket: process.env.S3_BUCKET!,
    s3Key: "document.pdf",
  });

  expect(response.statusCode).toBe(400);
  const body = JSON.parse(response.body);
  expect(body.error).toContain("Unsupported file type");
});
```

**Idempotent Operation Testing:**

From `tests/e2e/process-photo.test.ts`:
```typescript
it("should update existing photo on reprocess (idempotent)", async () => {
  const testKey = `test-photos/${TEST_PHOTOS[0]}`;

  // First process
  const response1 = await handler({
    s3Bucket: process.env.S3_BUCKET!,
    s3Key: testKey,
  });
  const body1 = JSON.parse(response1.body);
  const photoId1 = body1.results[0].photoId;

  // Second process (same file)
  const response2 = await handler({
    s3Bucket: process.env.S3_BUCKET!,
    s3Key: testKey,
  });
  const body2 = JSON.parse(response2.body);
  const photoId2 = body2.results[0].photoId;

  // Should be the same photo ID (upsert)
  expect(photoId2).toBe(photoId1);

  // Should only have one record in database
  const countResult = await pool.query(
    "SELECT COUNT(*) FROM photos WHERE s3_path = $1",
    [`s3://${process.env.S3_BUCKET}/${testKey}`]
  );
  expect(parseInt(countResult.rows[0].count)).toBe(1);
}, 120000);
```

## Service Initialization

**E2E Setup (`tests/e2e/setup.ts`):**
- Waits for PostgreSQL to be ready (max 30 seconds)
- Waits for MinIO to be ready (max 30 seconds)
- Initializes database schema from `src/db/schema.sql`
- Pre-loads AI models (faces and caption models) with 3-minute timeout
- Cleans database with `TRUNCATE` before each test suite
- Runs automatically when integration tests start (`setupFiles` in vitest config)

**Test Setup Functions:**
```typescript
beforeAll(async () => {
  // Initialize clients
  s3Client = new S3Client({ /* config */ });
  pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Pre-load models
  console.log("Pre-loading AI models...");
  await Promise.all([
    loadFaceModels().catch((e) => console.warn("Face models not available:", e.message)),
    loadCaptionModel().catch((e) => console.warn("Caption model loading:", e.message)),
  ]);
  console.log("Models loaded");
}, 180000); // 3 minute timeout for model loading

afterAll(async () => {
  // Cleanup uploaded files
  for (const key of uploadedKeys) {
    await s3Client.send(new DeleteObjectCommand({ Bucket, Key: key }));
  }
  await pool.end();
});
```

## Environment Variables for Tests

**Unit Tests:**
- No special env vars required
- Sharp library works with default configuration

**Integration Tests:**
From `tests/e2e/setup.ts`:
```typescript
process.env.DATABASE_URL = "postgres://nuvopic:nuvopic@localhost:5432/nuvopic";
process.env.S3_ENDPOINT = "http://localhost:9000";
process.env.S3_BUCKET = "photos";
process.env.S3_ACCESS_KEY_ID = "minioadmin";
process.env.S3_SECRET_ACCESS_KEY = "minioadmin";
process.env.S3_REGION = "us-east-1";
process.env.S3_FORCE_PATH_STYLE = "true";
```

These are set by the setup file, so `docker-compose` must be running with services configured at these endpoints.

## Test Coverage Gaps

**Well-Tested Areas:**
- Extractor functions (EXIF parsing, thumbnail generation, date parsing from filenames)
- Semver comparison logic
- Full photo processing pipeline (S3 upload → processing → database)
- Idempotent operations (reprocessing existing photos)

**Partially Tested:**
- API endpoints (no dedicated endpoint tests; only via handler tests)
- Tag operations (tested in e2e but limited scope)
- Error handling (only explicit error cases like unsupported file types)

**Not Directly Tested:**
- Authentication middleware (`src/auth/handlers.ts`, `src/auth/jwt.ts`)
- API error handling and edge cases
- Database search logic (`src/db/search.ts`)
- Concurrent import/reprocess operations (tested with concurrency but not edge cases)
- Frontend components (no test setup for Preact components)

---

*Testing analysis: 2026-02-26*
