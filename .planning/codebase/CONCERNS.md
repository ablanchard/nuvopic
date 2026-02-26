# Codebase Concerns

**Analysis Date:** 2026-02-26

## Tech Debt

**Memory-intensive Image Processing:**
- Issue: `src/processor.ts` loads full image buffers into memory for multiple processing steps (EXIF, thumbnail, caption, faces). With large images or Modal mode, this can cause OOM errors.
- Files: `src/processor.ts`, `src/extractors/faces.ts`, `src/extractors/caption.ts`
- Impact: Concurrent photo imports fail unpredictably on memory-constrained systems. No streaming or chunked processing.
- Fix approach: Implement streaming image pipeline using sharp transforms, process faces/captions from disk temp files instead of memory buffers.

**Weak Password Authentication:**
- Issue: `src/auth/handlers.ts` uses simple plaintext password comparison. AUTH_PASSWORD stored in environment variable is vulnerable to exposure in logs/errors.
- Files: `src/auth/handlers.ts` (lines 15-20, 89)
- Impact: No rate limiting on login attempts. Single password for all users. Weak against brute force.
- Fix approach: Add login attempt rate limiting using Redis or in-memory store, implement bcrypt password hashing, support per-user accounts.

**No Input Validation on API Routes:**
- Issue: Photo API routes accept raw query parameters without validation. S3Path format is trusted from database but webhook input from `/webhook/s3` is minimally validated.
- Files: `src/api/routes/photos.ts` (lines 15-30, 218-263), `src/server.ts` (lines 29-61)
- Impact: Injection attacks possible if S3 path handling is flawed. Webhook endpoint could accept malformed events.
- Fix approach: Add Zod/Yup validation for all API inputs, sanitize S3 paths, validate webhook event structure before processing.

**SSL Certificate Rejection Disabled in Production:**
- Issue: `src/db/client.ts` line 23 sets `rejectUnauthorized: false` for SSL connections, allowing MITM attacks.
- Files: `src/db/client.ts` (line 23)
- Impact: Database connections vulnerable to interception in production.
- Fix approach: Set `rejectUnauthorized: true` by default, only allow false in development via explicit `DATABASE_SSL_INSECURE` flag.

**No Error Recovery for Modal Failures:**
- Issue: `src/extractors/modal-client.ts` has 30s timeout and 1 retry, but if Modal service fails, entire photo fails to process. No fallback to local processing.
- Files: `src/extractors/modal-client.ts` (lines 12-13, 44-99)
- Impact: Single point of failure for GPU-accelerated features. Photos stuck in partial state if Modal is down.
- Fix approach: Implement fallback logic: if Modal fails, retry with local processing instead of failing completely.

**Face Embeddings Stored as JSON String, Not Vector:**
- Issue: `src/db/queries.ts` line 90 stores embeddings as stringified JSON (`[${params.embedding.join(",")}]`) instead of using pgvector native type.
- Files: `src/db/queries.ts` (lines 82-95), `src/db/schema.sql` (line 24)
- Impact: Cannot use vector similarity search (KNN) for face clustering. Comparisons would be slow string operations.
- Fix approach: Store embeddings as proper pgvector type using native array input, implement face clustering queries using pgvector operations.

**Database Connection Pool Not Properly Closed:**
- Issue: `src/db/client.ts` lazy-initializes pool but `closePool()` is rarely called. Server shutdown may leak connections.
- Files: `src/db/client.ts` (lines 5-42)
- Impact: Database connections hang on graceful shutdown, timeouts on process exit.
- Fix approach: Call `closePool()` in server shutdown handler, use connection timeout for graceful draining.

**No Transaction Support for Photo Processing:**
- Issue: `src/processor.ts` performs multiple DB operations (insertPhoto, deleteFacesByPhotoId, insertFace loop) without a transaction.
- Files: `src/processor.ts` (lines 128-150), `src/db/queries.ts`
- Impact: If one operation fails mid-process, photo record exists but faces may be incomplete or orphaned.
- Fix approach: Wrap insertPhoto + face operations in a single transaction, rollback on any failure.

---

## Known Bugs

**Face Detection Models Required for Local Mode:**
- Symptoms: Local face detection fails silently if `models/face-api` directory missing. No error message, just empty faces array.
- Files: `src/extractors/faces.ts` (lines 46-52)
- Trigger: Run app in local mode (no MODAL_ENDPOINT_URL) without pre-loaded models
- Workaround: Download face-api models to `models/face-api` directory, or enable Modal mode

**Caption Model Loading Hangs on First Boot:**
- Symptoms: First request to process photo hangs for 30+ seconds while downloading transformer model (~3GB).
- Files: `src/extractors/caption.ts` (lines 9-20), `tests/e2e/process-photo.test.ts` (line 58 shows timeout)
- Trigger: First photo processed in local mode, or caption model not cached
- Workaround: Pre-load model on server startup, or use Modal mode which avoids model download

**Infinite Scroll Sentinel Observer Not Cleaned Up on Component Unmount:**
- Symptoms: Previous observer instances may remain attached if PhotoGrid component unmounts during scroll.
- Files: `webapp/src/components/PhotoGrid.tsx` (lines 83-110)
- Trigger: Rapidly navigate between views while scrolling
- Workaround: Cleanup function (line 101) disconnects observer, but race condition possible if rapid unmounts

**Database COUNT(*) Query on Every Page Load:**
- Symptoms: `/api/v1/photos` endpoint runs two queries: COUNT(*) for total, then paginated SELECT. For large photo libraries (100k+), COUNT is slow.
- Files: `src/db/search.ts` (lines 72-76)
- Trigger: Load photos list with large dataset
- Workaround: Cache total count, or use window function to get count and results in single query

---

## Security Considerations

**Unauthenticated S3 Webhook Endpoint:**
- Risk: `/webhook/s3` accepts photos if WEBHOOK_SECRET not set. Anyone can trigger processing.
- Files: `src/server.ts` (lines 28-61)
- Current mitigation: WEBHOOK_SECRET optional, passed as query parameter (weak since visible in logs)
- Recommendations: Make WEBHOOK_SECRET required in production, use Bearer token in Authorization header, implement webhook signature validation (S3 sends `x-amz-sns-message-signature`)

**No Rate Limiting on API Endpoints:**
- Risk: Attackers can DOS the app via bulk `/api/v1/photos/import` or `/api/v1/photos/reprocess` requests.
- Files: `src/api/routes/photos.ts` (lines 218-343)
- Current mitigation: Memory-based concurrency limits (5 for Modal, CPU-based for local)
- Recommendations: Add global request rate limiter, per-user quota for import/reprocess endpoints

**Secrets in Environment Variables Not Validated:**
- Risk: Missing or invalid AUTH_PASSWORD, MODAL_ENDPOINT_URL, S3 credentials cause runtime crashes with exposed env var names in error messages.
- Files: `src/auth/handlers.ts`, `src/s3/client.ts`, `src/extractors/modal-client.ts`
- Current mitigation: Error messages logged but not caught
- Recommendations: Validate all required env vars at startup, throw before server listens, mask secret values in logs

**ThumbnailUrl Directly Exposes Photo IDs:**
- Risk: Photos are identified by UUID in `/api/v1/photos/{id}/thumbnail` URL. Sequential guessing possible but mitigated by UUID randomness.
- Files: `src/api/routes/photos.ts` (line 39, 358)
- Current mitigation: UUID is cryptographically random, long
- Recommendations: Consider adding per-user request signing for sensitive endpoints

---

## Performance Bottlenecks

**Full S3 Listing on Every Import/Reprocess Preview:**
- Problem: `src/s3/client.ts` `listAllObjects()` downloads entire object list before filtering. For buckets with millions of objects, this is slow.
- Files: `src/s3/client.ts` (lines 104-138), `src/api/routes/photos.ts` (lines 218-263)
- Cause: No cursor-based pagination in preview endpoint. List is done client-side filtering.
- Improvement path: Add server-side pagination with prefix/limit, return cursors for client to fetch next batch

**SELECT COUNT(*) on Large Photo Tables:**
- Problem: Every photo list request runs COUNT(*). For 100k+ photos, this is a full sequential scan.
- Files: `src/db/search.ts` (lines 72-76)
- Cause: PostgreSQL can't use existing indexes for COUNT(*) efficiently without approximate counts
- Improvement path: Use window function to get total count in single query with results, or implement approximate count using `pg_stat_user_tables`

**Modal Timeout Too Long for Concurrent Requests:**
- Problem: 30s timeout with 5 concurrent limit means import of 1000 photos takes ~200 minutes.
- Files: `src/extractors/modal-client.ts` (line 12)
- Cause: Modal inference time is 3-5s per photo, but timeout accounts for cold starts (15-20s)
- Improvement path: Use Modal's queue API for batch processing, implement request pooling to amortize cold starts

**Face Embedding Storage as Text Slows Down Clustering:**
- Problem: Storing 512-dim vectors as JSON strings makes similarity search impossible without fetching and parsing all embeddings in-app.
- Files: `src/db/queries.ts` (lines 82-95)
- Cause: Embeddings not using pgvector type
- Improvement path: Store as pgvector, implement face clustering with pgvector KNN queries in database

---

## Fragile Areas

**Image Extraction Pipeline (Processor):**
- Files: `src/processor.ts`, `src/extractors/*`
- Why fragile: Multiple fallible operations (EXIF, face detection, captioning) with Promise.allSettled masking errors. If multiple extractors fail, photo has partial metadata.
- Safe modification: Add detailed error logging per extractor, implement fallback values (empty strings, null values), test with corrupted/unsupported image formats
- Test coverage: `tests/unit/extractors.test.ts` covers thumbnail and EXIF parsing, but no tests for corrupt images, missing models, or modal service failures

**Webhook Handler (S3 Integration):**
- Files: `src/server.ts` (lines 29-61), `src/index.ts`
- Why fragile: Async handler returns 202 immediately, but errors logged asynchronously. No retry mechanism if handler crashes.
- Safe modification: Implement persistent queue (Redis/RabbitMQ) for failed events, add explicit error callbacks, require explicit ACK before webhook returns
- Test coverage: No tests for webhook endpoint, only e2e tests for photo processing via direct invocation

**Database Schema Migrations:**
- Files: `src/db/schema.sql` (lines 64-94)
- Why fragile: Migration logic uses DO blocks with exception handlers that silently fail. TRUNCATE FACES migration can data-loss without user consent.
- Safe modification: Separate schema creation from migrations, log migration status at startup, require explicit flag to allow truncation
- Test coverage: Integration tests check final schema, but not migration path from old databases

**Authentication Logic (Password-Only):**
- Files: `src/auth/handlers.ts`
- Why fragile: Single password shared by all users, no session expiration enforcement, no CSRF protection on POST /login
- Safe modification: Add CSRF tokens, implement per-user sessions with expiration, add password reset mechanism
- Test coverage: No tests for auth flows, session expiration, CSRF

---

## Scaling Limits

**Database Connection Pool (10 concurrent connections):**
- Current capacity: Default pool size is 10 connections (`src/db/client.ts` line 20)
- Limit: More than 10 concurrent API requests will queue, causing latency > 5 seconds
- Scaling path: Increase pool size to 30-50, use PgBouncer for connection pooling at database level, implement query timeout to prevent long-running queries hogging connections

**Modal GPU Concurrency (5 concurrent requests):**
- Current capacity: Hard-coded 5 concurrent HTTP requests to Modal endpoint (`src/api/routes/photos.ts` line 151)
- Limit: Import of 100 photos takes ~20 seconds; 1000 photos takes ~200 seconds
- Scaling path: Use Modal's batch API for multi-image processing, implement request queue with dynamic concurrency based on Modal latency, cache model warm-up

**In-Memory Face Embeddings for Clustering:**
- Current capacity: All face embeddings fetched into memory for similarity matching (not yet implemented)
- Limit: 100k faces × 512 dims × 4 bytes = ~200MB; 1M faces = 2GB
- Scaling path: Implement pgvector KNN queries, use Faiss or Annoy for approximate nearest neighbor search, implement distributed indexing

**Single-Node Image Processing:**
- Current capacity: Photo processing runs on single server; memory-constrained at ~2GB
- Limit: Large photos (50MB+) or concurrent processing of 10+ photos causes OOM
- Scaling path: Implement distributed worker queue (Bull, RQ), offload processing to separate service, use streaming image pipelines

---

## Dependencies at Risk

**@xenova/transformers (Caption Model):**
- Risk: Heavy browser-focused library, loads 3GB model on first use, very slow
- Impact: Caption generation blocks API response, no timeouts enforced separately
- Migration plan: Switch to Modal GPU inference for captions, or use lightweight image-captioning API (OpenAI, Hugging Face Inference API)

**face-api.js (Face Detection):**
- Risk: Unmaintained library (last update 2021), requires node-canvas which needs system dependencies, poor documentation
- Impact: Local face detection unreliable, models not automatically downloaded, requires manual setup
- Migration plan: Switch to Modal-based face detection, or migrate to InsightFace + ONNX Runtime for better performance

**pg (PostgreSQL Client):**
- Risk: Native module, requires node-gyp and Python for installation
- Impact: Deployment issues on Alpine Linux, Docker build time increases
- Migration plan: Migrate to `postgres` package (pure JS) or `node-postgres` v9+ (better support)

**sharp (Image Processing):**
- Risk: Native module requiring system libvips, but well-maintained
- Impact: Required for thumbnail generation, currently no fallback
- Migration plan: Acceptable dependency, but consider using Canvas API fallback for browser compatibility

**@aws-sdk/client-s3:**
- Risk: Very large package (100MB+), but well-maintained
- Impact: Bundle size, slow npm installs
- Migration plan: Acceptable for backend, consider `aws-s3` or MinIO JS client if size matters

---

## Missing Critical Features

**No Face Clustering (Auto-Grouping Similar Faces):**
- Problem: All faces stored but no automatic grouping of same person. Manual UI tagging required.
- Blocks: Can't show "suggested people" or auto-group photos by person
- Workaround: Users must manually tag every face in `/persons` route

**No Reprocessing with Different Models:**
- Problem: Once photo processed with specific model version, can't switch inference backend (e.g., local → Modal) without manual reprocess
- Blocks: Can't A/B test different models, can't dynamically switch if one fails
- Workaround: Manual API call to trigger reprocess

**No Batch Tagging:**
- Problem: Tags applied one photo at a time in UI
- Blocks: Can't bulk-tag 100 photos from vacation folder at once
- Workaround: Use API directly

**No Photo Deletion:**
- Problem: `/api/v1/photos` has no DELETE endpoint
- Blocks: Users stuck with unwanted photos in database
- Workaround: Direct database query

**No Duplicate Detection:**
- Problem: Same photo uploaded twice creates two records
- Blocks: Large libraries may have duplicates, wasting storage
- Workaround: None; manual cleanup required

---

## Test Coverage Gaps

**Photo Processing Error Paths:**
- What's not tested: What happens when EXIF parsing fails with corrupted metadata, when face detection models are missing, when Modal timeout occurs
- Files: `src/processor.ts`, `src/extractors/faces.ts`, `src/extractors/caption.ts`
- Risk: Partial failures silently ignored (Promise.allSettled catches errors but doesn't validate they're acceptable)
- Priority: High

**Authentication Flows:**
- What's not tested: Session expiration, invalid JWT tokens, CSRF attacks on POST /login, rate limiting on failed attempts
- Files: `src/auth/handlers.ts`
- Risk: Auth bypass or account takeover possible
- Priority: High

**Webhook Event Handling:**
- What's not tested: Malformed S3 events, network errors during async processing, duplicate events, large batch of records
- Files: `src/server.ts` (webhook endpoint), `src/index.ts`
- Risk: Silent failures, unprocessed photos, infinite loops on retries
- Priority: High

**Database Schema Migrations:**
- What's not tested: Migration from old schema (128-dim embeddings), integrity of data after migrations
- Files: `src/db/schema.sql`
- Risk: Data loss during migrations
- Priority: Medium

**Concurrent Reprocessing:**
- What's not tested: Worker pool with actual concurrent failures, race conditions in face deletion, partial success scenarios
- Files: `src/api/routes/photos.ts` (reprocess endpoint)
- Risk: Photos in inconsistent state if some workers fail mid-process
- Priority: Medium

**Frontend Error Handling:**
- What's not tested: API errors (401, 500), slow network on infinite scroll, memory leaks from repeated observer creation
- Files: `webapp/src/api/client.ts`, `webapp/src/components/PhotoGrid.tsx`
- Risk: UI freezes, white screens, memory exhaustion on long-scroll sessions
- Priority: Medium

---

*Concerns audit: 2026-02-26*
