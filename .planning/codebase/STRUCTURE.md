# Codebase Structure

**Analysis Date:** 2026-02-26

## Directory Layout

```
gphoto/
├── src/                       # Backend TypeScript source
│   ├── index.ts              # Lambda handler entry point (S3 events)
│   ├── server.ts             # HTTP server setup and Hono app
│   ├── processor.ts          # Photo processing orchestration
│   ├── logger.ts             # Logging utility
│   ├── version.ts            # Process version tracking and changelog
│   ├── api/                  # REST API routes
│   │   ├── router.ts         # Route mounting and error handling
│   │   └── routes/
│   │       ├── photos.ts     # GET /api/v1/photos, import, reprocess, details
│   │       ├── persons.ts    # Face-to-person assignment, person CRUD
│   │       └── tags.ts       # Tag management
│   ├── auth/                 # Authentication
│   │   ├── handlers.ts       # Login/logout endpoints, auth middleware
│   │   └── jwt.ts            # Token creation and verification
│   ├── db/                   # Database abstraction
│   │   ├── client.ts         # Connection pool, generic query runner
│   │   ├── queries.ts        # CRUD operations (photos, faces)
│   │   ├── search.ts         # Complex search with filters
│   │   ├── persons.ts        # Person CRUD and aggregations
│   │   └── tags.ts           # Tag operations
│   ├── extractors/           # Photo metadata extraction
│   │   ├── index.ts          # Barrel export of all extractors
│   │   ├── exif.ts           # EXIF data (date, location) + filename parsing
│   │   ├── thumbnail.ts      # JPEG thumbnail generation (sharp)
│   │   ├── caption.ts        # Image description (local BLIP or disabled)
│   │   ├── faces.ts          # Face detection (local face-api.js or disabled)
│   │   └── modal-client.ts   # GPU-accelerated processing via Modal
│   └── s3/                   # S3 storage integration
│       └── client.ts         # AWS SDK client, GetObject, ListObjects
├── webapp/                    # React frontend (separate build)
│   ├── src/
│   │   ├── main.tsx          # React entry point (Vite)
│   │   ├── app.tsx           # Root component with routing
│   │   ├── api/
│   │   │   └── client.ts     # API fetch helper
│   │   ├── state/
│   │   │   └── filters.ts    # Zustand store for search filters
│   │   ├── components/
│   │   │   ├── PhotoGrid.tsx # Infinite scroll photo grid
│   │   │   ├── PhotoCard.tsx # Individual photo card
│   │   │   ├── SearchBar.tsx # Search input
│   │   │   ├── DateFilter.tsx# Date range picker
│   │   │   ├── TagFilter.tsx # Tag multi-select
│   │   │   └── PersonList.tsx# Person management UI
│   │   └── assets/           # Images, styles (if any)
│   ├── dist/                 # Built webapp output (committed)
│   └── public/               # Static index.html, favicon
├── tests/                     # Test suites
│   ├── unit/                 # Unit tests (jest patterns)
│   ├── e2e/                  # End-to-end tests
│   └── fixtures/             # Test data
├── deploy/                    # Deployment configurations
│   ├── docker/               # Dockerfile, entrypoint script
│   ├── scaleway/             # Scaleway container registry setup
│   └── aws-lambda/           # AWS Lambda configuration (if using serverless)
├── scripts/                   # Utility scripts
│   └── init-db.ts           # Database schema initialization
├── modal/                     # Modal.com compute configuration (Python)
│   └── *.py                  # GPU image processing tasks
├── dist/                      # Compiled backend output (TypeScript → JavaScript)
├── package.json              # Backend dependencies
├── tsconfig.json             # TypeScript config
├── vitest.config.ts          # Unit test runner config
├── vitest.integration.config.ts # Integration test config
├── docker-compose.yml        # Local dev: PostgreSQL, MinIO, app
├── .env.example              # Environment variable template
└── README.md                 # Project documentation
```

## Directory Purposes

**`src/`:**
- Purpose: Backend TypeScript source code
- Contains: HTTP server, API routes, database layer, S3 integration, photo processing
- Key files: `server.ts` (app entry), `processor.ts` (core logic), `api/router.ts` (route setup)

**`src/api/`:**
- Purpose: REST API route handlers organized by resource
- Contains: Router setup, per-resource route modules (photos, persons, tags)
- Key files: `router.ts` (CORS, error handling), `routes/*.ts` (endpoints)

**`src/db/`:**
- Purpose: Data access abstraction layer
- Contains: PostgreSQL connection pooling, query builders, typed operations
- Key files: `client.ts` (pool), `queries.ts` (CRUD), `search.ts` (complex filtering)

**`src/extractors/`:**
- Purpose: Modular photo analysis functions
- Contains: Metadata extraction (EXIF, thumbnails, captions, face detection)
- Key files: `index.ts` (barrel export), `modal-client.ts` (GPU dispatch), individual extractor modules

**`src/auth/`:**
- Purpose: Authentication and session management
- Contains: Login/logout handlers, JWT token logic, auth middleware
- Key files: `handlers.ts` (endpoints), `jwt.ts` (token ops)

**`src/s3/`:**
- Purpose: Cloud storage abstraction
- Contains: AWS SDK wrapper, object download/listing, path normalization
- Key files: `client.ts` (singleton S3Client, operations)

**`webapp/src/`:**
- Purpose: React frontend (separate Node build)
- Contains: SPA components, state management, API client
- Key files: `app.tsx` (root), `components/` (UI modules)

**`tests/`:**
- Purpose: Test suites (unit, integration, e2e)
- Contains: Test files following project patterns
- Key files: vitest config files at root

**`deploy/`:**
- Purpose: Production deployment artifacts
- Contains: Docker image definitions, container registry config, Lambda setup
- Key files: `docker/Dockerfile` (app image), deployment scripts

**`scripts/`:**
- Purpose: Build and setup utilities
- Contains: Database schema initialization
- Key files: `init-db.ts` (creates tables)

**`modal/`:**
- Purpose: Modal.com GPU compute job definitions
- Contains: Python code for remote photo processing
- When used: If `MODAL_ENABLED=true` in environment

## Key File Locations

**Entry Points:**

- `src/index.ts`: Lambda handler for S3 events (exports `handler`)
- `src/server.ts`: HTTP server (Node.js, serves API + webapp)
- `webapp/src/main.tsx`: React frontend (Vite entry)

**Configuration:**

- `tsconfig.json`: TypeScript compiler options
- `vitest.config.ts`: Unit test configuration
- `docker-compose.yml`: Local development (PostgreSQL, MinIO)
- `.env.example`: Required environment variables

**Core Logic:**

- `src/processor.ts`: Photo extraction orchestration
- `src/api/routes/photos.ts`: Photo import/reprocess/search endpoints
- `src/db/queries.ts`: Photo/face database operations

**Testing:**

- `tests/unit/`: Unit test files (test.ts/test.tsx pattern)
- `tests/fixtures/`: Mock data for tests
- `vitest.integration.config.ts`: Integration test setup

## Naming Conventions

**Files:**

- `index.ts`: Barrel exports or module entry points
- `*.ts`: Source files (no `.js` extension; compiled by tsc)
- `*.tsx`: React components
- `*-client.ts`: Client/SDK wrappers (S3Client, ModalClient)
- `*-handlers.ts`: HTTP request handlers or middleware

**Directories:**

- `src/`: Source root (lowercase)
- `api/routes/`: Grouped by REST resource (photos, persons, tags)
- `db/`: Data access modules (client, queries, search, etc.)
- `extractors/`: Individual extraction modules

**Functions and Exports:**

- `camelCase` for functions: `processPhoto`, `getPhotoById`, `analyzeWithModal`
- `SCREAMING_SNAKE_CASE` for constants: `PROCESS_VERSION`, `PUBLIC_PATHS`, `SUPPORTED_EXTENSIONS`
- `PascalCase` for types/interfaces: `ProcessPhotoInput`, `PhotoRecord`, `S3Event`
- `isX()` for boolean predicates: `isSupportedImage()`, `isModalEnabled()`

**Variables:**

- `camelCase` for all variables: `s3Key`, `photoId`, `faceCount`
- Descriptive names: `processVersion`, `errorMessages` (not `pv`, `errs`)

## Where to Add New Code

**New Photo Extractor:**

1. Create `src/extractors/yourfeature.ts` with function like `export async function extractYourFeature(imageBuffer: Buffer): Promise<YourData>`
2. Add to barrel export in `src/extractors/index.ts`
3. Integrate into `src/processor.ts` in the appropriate Promise.allSettled section
4. Update `ProcessPhotoOutput` interface if adding to photo record

**New API Endpoint (e.g., locations):**

1. Create `src/api/routes/locations.ts` with Hono router
2. Add database module `src/db/locations.ts` for queries
3. Import and mount in `src/api/router.ts`: `api.route("/locations", locations);`
4. Add corresponding tests in `tests/unit/api/routes/`

**New Database Query:**

1. Add function to appropriate module in `src/db/`:
   - CRUD: `src/db/queries.ts` or `src/db/persons.ts`
   - Complex filtering: `src/db/search.ts`
2. Use typed `query<T>()` from `src/db/client.ts`
3. Define input/output interfaces
4. Export and use in routes

**New Auth Feature:**

1. Add to `src/auth/handlers.ts` or new file `src/auth/yourauth.ts`
2. If middleware needed: update `src/server.ts` app.use() or add to `authMiddleware`
3. Update `PUBLIC_PATHS` in `src/auth/handlers.ts` if needed

**New Frontend Component:**

1. Create `webapp/src/components/YourComponent.tsx` in React
2. Import API client if needed: `import { api } from "../api/client"`
3. Use Zustand store from `webapp/src/state/filters.ts` for state
4. Import and use in `webapp/src/app.tsx`

**New Test:**

- Unit tests: `tests/unit/your-module.test.ts`
- Integration tests: `tests/integration/your-module.test.ts`
- Use vitest syntax, fixtures from `tests/fixtures/`

## Special Directories

**`dist/`:**
- Purpose: Compiled JavaScript output from TypeScript
- Generated: Yes (by `npm run build`)
- Committed: No (gitignored)
- Run with: `npm start` (runs `node dist/server.js`)

**`webapp/dist/`:**
- Purpose: Built React app (static files)
- Generated: Yes (by `npm run build --prefix webapp`)
- Committed: Yes (speeds up Docker builds)
- Served by: `src/server.ts` via Hono static middleware

**`node_modules/`:**
- Purpose: Installed dependencies
- Generated: Yes (by `npm install`)
- Committed: No (gitignored)

**`.planning/codebase/`:**
- Purpose: Architecture and codebase analysis documents (this directory)
- Generated: Manually by `/gsd:map-codebase` agent
- Committed: Yes
- Documents: ARCHITECTURE.md, STRUCTURE.md, CONVENTIONS.md, TESTING.md, CONCERNS.md (as applicable)

**`deploy/docker/`:**
- Purpose: Multi-stage Dockerfile for containerization
- Generated: Manual configuration
- Committed: Yes
- Used by: Docker image builds for deployment

**`.github/workflows/`:**
- Purpose: CI/CD pipeline definitions
- Generated: Manual configuration
- Committed: Yes
- Runs: On push (tests, builds, deploys)
