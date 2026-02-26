# Architecture

**Analysis Date:** 2026-02-26

## Pattern Overview

**Overall:** Layered architecture with asynchronous processing pipeline

**Key Characteristics:**
- Dual-mode processing (GPU-accelerated via Modal or local CPU-based fallback)
- Event-driven photo ingestion (S3 webhooks + manual import)
- RESTful API backend with modular route handlers
- Separation of concerns: extraction, storage, API, authentication
- Promise-based concurrency management for bulk operations

## Layers

**API Layer:**
- Purpose: HTTP request handling, route dispatch, response serialization
- Location: `src/api/router.ts`, `src/api/routes/`
- Contains: Route handlers for photos, persons, tags; middleware for CORS and error handling
- Depends on: Database query layer, processor, authentication
- Used by: HTTP clients (web frontend, webhooks)

**Processing Pipeline:**
- Purpose: Extract metadata and AI insights from photos
- Location: `src/processor.ts`, `src/extractors/`
- Contains: Photo processing orchestration, conditional GPU/CPU selection, face embeddings, captions, thumbnails
- Depends on: S3 client, database queries, extractor modules (exif, caption, faces, thumbnail)
- Used by: Index handler (Lambda), API routes (/process, /import, /reprocess)

**Database Abstraction:**
- Purpose: PostgreSQL connection pooling and parameterized queries
- Location: `src/db/client.ts` (low-level), `src/db/queries.ts` (typed operations), `src/db/search.ts` (complex queries)
- Contains: Connection pool, typed query builders, CRUD operations for photos/faces/persons/tags
- Depends on: PostgreSQL driver (pg)
- Used by: Routes, processor

**Extraction Modules:**
- Purpose: Extract individual metadata types from image buffers
- Location: `src/extractors/`
- Contains: EXIF (piexifjs), thumbnail generation (sharp), captions (local BLIP or Modal GPU), face detection (InsightFace)
- Depends on: Modal SDK (optional), local ML libraries
- Used by: Processor pipeline

**Storage Integration:**
- Purpose: S3-compatible object storage operations
- Location: `src/s3/client.ts`
- Contains: S3 client initialization, GetObject, ListObjects, buffer streaming, path helpers
- Depends on: AWS SDK, environment configuration
- Used by: Processor (photo download), API routes (bulk import)

**Authentication:**
- Purpose: Session management and access control
- Location: `src/auth/handlers.ts`, `src/auth/jwt.ts`
- Contains: Password-based login, JWT token creation/verification, session cookies, middleware guard
- Depends on: Hono cookie/crypto utilities
- Used by: Server middleware, login endpoints

**Server Entry Point:**
- Purpose: HTTP server lifecycle and middleware composition
- Location: `src/server.ts`
- Contains: Hono app setup, route mounting, static file serving, auth middleware, webhook endpoint
- Depends on: All layers above
- Used by: Application startup

## Data Flow

**Photo Ingestion (Event-Driven):**

1. S3 uploads trigger MinIO/S3 event notification
2. Webhook received at `POST /webhook/s3` (public, optionally token-protected)
3. Handler invokes `processPhoto({ s3Bucket, s3Key })`
4. Async processing (fire-and-forget) returns 202 Accepted immediately
5. Background processing updates database with extracted metadata

**Photo Ingestion (Manual Import):**

1. User calls `POST /api/v1/photos/import` with bucket/prefix/limit
2. API lists S3 objects, filters images, checks database for existing entries
3. Auto-detects concurrency (CPU cores, memory budget, or Modal I/O capacity)
4. Worker pool processes photos with bounded concurrency
5. Results streamed back with progress metrics

**Photo Processing (Core Pipeline):**

1. Download image buffer from S3 (`getObjectAsBuffer`)
2. Parallel extraction (Promise.allSettled):
   - EXIF extraction + date parsing
   - Thumbnail generation (sharp)
   - Caption + face detection (conditional):
     - If Modal enabled: single HTTP call to Modal (GPU)
     - Otherwise: local CPU inference
3. Insert photo record (upsert on s3_path conflict)
4. Delete old faces if updating existing photo
5. Insert face records with embeddings
6. Return `ProcessPhotoOutput` with metadata and error tracking

**Search and Query:**

1. User filters photos via `GET /api/v1/photos` (search, date range, person, tags)
2. Dynamic WHERE clause built from filter parameters
3. Count total results, fetch paginated slice with photo stats
4. Face count and tag arrays aggregated via SQL joins
5. JSON response with pagination metadata

**Reprocessing (Versioned):**

1. Admin calls `GET /api/v1/photos/reprocess` to preview outdated photos
2. Photos with `process_version < PROCESS_VERSION` are candidates
3. `POST /api/v1/photos/reprocess` re-invokes `processPhoto` on outdated batch
4. Worker pool processes with same concurrency logic as import
5. Faces replaced (delete old, insert new embeddings)

**State Management:**

- **Photo state:** Stored in PostgreSQL (`photos` table) with upsert-on-conflict logic
- **Extraction state:** Process version tracked per photo (enables rollout of new extractors)
- **Face state:** Linked to photos, supports assignment to persons
- **Transient state:** Worker concurrency, progress tracking (in-memory only, no persistence)

## Key Abstractions

**ProcessPhoto Function:**
- Purpose: Unified entry point for all photo processing regardless of trigger
- Location: `src/processor.ts`
- Examples: Called from Lambda handler, webhook, API routes
- Pattern: Accepts S3 bucket/key, returns structured metadata with error list

**Database Client:**
- Purpose: Abstract PostgreSQL interaction with connection pooling
- Location: `src/db/client.ts`
- Pattern: Singleton pool, generic `query<T>()` for type-safe results

**Extractors Index:**
- Purpose: Export all extraction functions with consistent interfaces
- Location: `src/extractors/index.ts`
- Pattern: Named exports per extractor, re-exported for clean imports

**Modal Abstraction:**
- Purpose: Conditional GPU processing (analyzeWithModal vs local inference)
- Location: `src/extractors/modal-client.ts`
- Pattern: `isModalEnabled()` feature flag, fallback to CPU if Modal unavailable

**Worker Pool Pattern:**
- Purpose: Bounded concurrency for bulk photo processing
- Location: `src/api/routes/photos.ts` (`runWithConcurrency` function)
- Pattern: Index-based task distribution, progress callback, `Promise.all()` on workers

## Entry Points

**Lambda Handler (S3 Events):**
- Location: `src/index.ts`
- Triggers: S3 bucket notifications (new uploads)
- Responsibilities: Validate event type, filter unsupported files, invoke `processPhoto` for each record, aggregate results/errors

**HTTP Webhook:**
- Location: `src/server.ts` (POST /webhook/s3)
- Triggers: MinIO/S3 event notification payloads
- Responsibilities: Verify optional webhook secret, normalize S3 event format, fire async processing, return 202

**HTTP Server:**
- Location: `src/server.ts`
- Triggers: Node.js application startup
- Responsibilities: Compose middleware (auth, CORS), mount routes, serve static webapp, listen on PORT

**API Routes:**
- Location: `src/api/routes/*.ts`
- Triggers: Client HTTP requests
- Responsibilities: Parse query/body params, invoke database/processor functions, serialize responses

## Error Handling

**Strategy:** Try-catch with accumulation and partial success

**Patterns:**

- **Processor:** `Promise.allSettled` for parallel extraction tasks; individual failures collected in `errors[]` array but don't block photo insertion
- **Routes:** Wrap JSON parsing and database calls in try-catch, return error JSON with appropriate status code
- **Middleware:** Global error handler in API router logs errors and returns 500 with message
- **Webhook:** Async processing errors logged but don't block 202 response
- **Extraction Fallback:** Missing EXIF, caption, faces default to null/empty with error logged; thumbnails optional (can be null)

## Cross-Cutting Concerns

**Logging:**

- Single `logger` module (`src/logger.ts`) with debug/info/warn/error levels
- Controlled by `LOG_LEVEL` environment variable (default: "info")
- Used throughout: processor, routes, auth, server startup

**Validation:**

- Query parameter parsing with parseInt, string checks
- Database constraints: UNIQUE on s3_path, NOT NULL on required fields
- EXIF date fallback to filename parsing if missing
- File extension filtering (whitelist: .jpg, .jpeg, .png, .heic, .webp)

**Authentication:**

- Password-based login (single password in AUTH_PASSWORD env var)
- Session cookie with JWT token (7-day expiry)
- Middleware guard checks cookie validity; public paths (/health, /login) bypass
- Disabled if AUTH_PASSWORD not set (pass-through)

**Concurrency Control:**

- CPU-based: `maxByCpu = cpuCores - 2`, `maxByMem = availableMem / 200MB per worker`
- Modal I/O-based: fixed concurrency=5 (non-blocking HTTP calls, cap on memory for buffers)
- Auto-detection in `getOptimalConcurrency()`, overridable via request body
