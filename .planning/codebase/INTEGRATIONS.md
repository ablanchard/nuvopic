# External Integrations

**Analysis Date:** 2026-02-26

## APIs & External Services

**Modal GPU Inference (Optional):**
- Service: Modal - GPU-accelerated machine learning inference
- What it's used for: Image captioning and face detection (GPU-accelerated alternative to local processing)
- SDK/Client: HTTPS POST to custom endpoint
- Auth: Modal proxy authentication via headers `Modal-Key` and `Modal-Secret`
- Env vars: `MODAL_ENDPOINT_URL`, `MODAL_PROXY_KEY`, `MODAL_PROXY_SECRET`
- Implementation: `src/extractors/modal-client.ts`
- Behavior: 30-second timeout with 1 retry on 5xx errors; 4xx errors fail immediately
- Payload: Base64-encoded image in JSON body

**S3 Webhooks (Inbound):**
- Service: S3 bucket notifications (MinIO, AWS S3, Scaleway, etc.)
- What it's used for: Auto-trigger photo processing when images are uploaded
- Endpoint: `POST /webhook/s3` (public, optional WEBHOOK_SECRET token param)
- Handler: `src/server.ts` (lines 27-61)
- Payload: S3 event format or MinIO normalized format
- Processing: Asynchronous, returns 202 Accepted immediately
- Webhook secret: Optional bearer token via `?token=` query parameter (`WEBHOOK_SECRET` env var)

## Data Storage

**Databases:**
- PostgreSQL 16 (pgvector extension required)
  - Connection: `DATABASE_URL` environment variable
  - Supports: AWS RDS, Supabase, Neon, self-hosted, Scaleway
  - SSL: Auto-enabled if `DATABASE_SSL=true` or connection string includes `sslmode=require`
  - Client: pg library with connection pooling (max 10 connections, 30s idle timeout)
  - Operations: `src/db/client.ts`, `src/db/queries.ts`
  - Tables: photos, faces, persons, tags, photo_tags, photo_persons (implied by code)
  - Vector search: Uses pgvector extension for face embedding similarity searches

**File Storage:**
- S3-compatible object storage (required)
  - Providers: AWS S3, Scaleway Object Storage, Cloudflare R2, MinIO
  - Connection: `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_BUCKET`
  - Custom endpoint: `S3_ENDPOINT` (optional for non-AWS providers)
  - Path style: `S3_FORCE_PATH_STYLE` (required for MinIO and some providers)
  - Client: AWS SDK v3 (`@aws-sdk/client-s3`)
  - Operations: `src/s3/client.ts` - GetObject, ListObjectsV2, stream processing
  - Bucket structure: Photos stored with arbitrary keys, webhook notifications on `.jpg`, `.jpeg`, `.png`, `.heic`, `.webp`

**Caching:**
- In-memory caching only (no Redis/Memcached)
- Modal caption pipeline cached in memory after first load: `src/extractors/caption.ts`
- Face-api.js models cached in memory after first load: `src/extractors/faces.ts`

## Authentication & Identity

**Auth Provider:**
- Custom single-user password-based authentication
  - Implementation: Password + JWT session tokens in HTTP-only cookies
  - Enabled only if `AUTH_PASSWORD` environment variable is set
  - Code: `src/auth/handlers.ts`, `src/auth/jwt.ts`
  - Session duration: 7 days
  - Cookie name: `session`
  - Cookie settings: httpOnly, secure (in production), sameSite=Lax
  - JWT secret: `JWT_SECRET` environment variable (required if auth enabled)
  - No OAuth, SAML, or third-party identity providers

**Public Endpoints:**
- `/health` - Health check (always public)
- `/login` - Login page and form submission (always public)
- `/webhook/s3` - S3 webhook receiver (public, optionally secured via WEBHOOK_SECRET)
- All other endpoints require valid session cookie

## Monitoring & Observability

**Error Tracking:**
- None detected - No Sentry, Rollbar, or similar integration

**Logs:**
- Custom logger implementation: `src/logger.ts`
- Output: Console (stdout/stderr)
- Levels: info, warn, debug, error
- No centralized log aggregation detected
- Log level configurable via `LOG_LEVEL` environment variable

**Health Check:**
- Endpoint: `GET /health`
- Response: `{ "status": "ok" }`
- Docker healthcheck: Poll `http://localhost:8080/health` every 30 seconds

## CI/CD & Deployment

**Hosting:**
- Container-based deployment (Docker)
- Deployment targets: Any container platform (Kubernetes, Docker Compose, Cloud Run, etc.)
- Image: `node:20-slim` base
- Multi-stage build: Backend TypeScript → Frontend Vite → Production runtime
- Dockerfile: `deploy/docker/Dockerfile`
- Port: 8080 (configurable via `PORT` env var)

**CI Pipeline:**
- GitHub Actions
- Configuration: `.github/workflows/ci.yml`
- Triggers: Push to main, pull requests to main
- Jobs:
  1. Build & Test: Backend build, unit tests, webapp build (runs on ubuntu-latest)
  2. Docker Build: Downloads face-api models, builds Docker image
- Node.js version pinned to 20
- npm cache enabled for faster builds

## Environment Configuration

**Required env vars:**
- `DATABASE_URL` - PostgreSQL connection string
- `S3_ACCESS_KEY_ID` - S3 access key
- `S3_SECRET_ACCESS_KEY` - S3 secret key
- `S3_REGION` - S3 region (e.g., us-east-1)
- `S3_BUCKET` - S3 bucket name

**Optional env vars:**
- `PORT` - Server port (default 8080)
- `LOG_LEVEL` - Logging level (default info)
- `DATABASE_SSL` - Enable SSL for PostgreSQL (default false)
- `S3_ENDPOINT` - Custom S3 endpoint (for MinIO, Scaleway, etc.)
- `S3_FORCE_PATH_STYLE` - Force path-style S3 URLs (for MinIO, etc.)
- `AUTH_PASSWORD` - Enable password-based authentication
- `JWT_SECRET` - Secret for signing JWT tokens (required if AUTH_PASSWORD set)
- `WEBHOOK_SECRET` - Optional token for securing S3 webhook endpoint
- `PROCESSING_MODE` - "modal" or "local" (auto-detects based on MODAL_ENDPOINT_URL)
- `MODAL_ENDPOINT_URL` - Modal inference endpoint URL
- `MODAL_PROXY_KEY` - Modal proxy authentication key
- `MODAL_PROXY_SECRET` - Modal proxy authentication secret
- `NODE_ENV` - "production" for secure cookies, other for development

**Secrets location:**
- Environment variables via `.env` file (development)
- Container environment variables (production deployment)
- No secrets committed to git (`.env` in `.gitignore`)

## Webhooks & Callbacks

**Incoming:**
- `POST /webhook/s3` - Receives S3 event notifications from MinIO, AWS S3, Scaleway
  - Triggered by: Object put events (photos uploaded)
  - Supported extensions: .jpg, .jpeg, .png, .heic, .webp
  - Processing: Asynchronous, returns 202 immediately
  - Auto-processes new photos through caption + face detection pipeline

**Outgoing:**
- None detected - Application is consumer-only, does not call external webhooks

## Data Processing Flow

**Image Upload Processing:**
1. S3 bucket receives image via webhook notification
2. Server receives `POST /webhook/s3` event
3. Asynchronous processing invoked:
   - Download image from S3 via `getObjectAsBuffer()` (`src/s3/client.ts`)
   - Extract EXIF metadata (date taken, GPS location) via sharp + exif-reader
   - Generate thumbnail via sharp
   - Detect faces via Modal API or local face-api.js
   - Generate caption via Modal API or local @xenova/transformers
4. Store results in PostgreSQL:
   - Photo metadata (s3Path, date, location, caption)
   - Face embeddings and bounding boxes
   - Processing version for versioned reprocessing
5. Return 200 OK to webhook immediately

**Image Query & Search:**
- Client queries `GET /api/v1/photos` endpoint
- Backend searches PostgreSQL using pgvector for similarity (person embeddings)
- Returns paginated results with thumbnail URLs
- S3 serves static photo files and thumbnails

---

*Integration audit: 2026-02-26*
