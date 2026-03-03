# NuvoPic

A self-hosted app to visualize and organize your photos stored on cloud storage, with AI-powered photo processing. Runs on any cloud provider or your own server.

## Features

- **EXIF extraction**: Date taken, GPS coordinates
- **AI-generated descriptions**: GPU-accelerated via Modal or Vast.ai (BLIP model), with local fallback
- **Face detection & recognition**: InsightFace with 512-dim embeddings via Modal or Vast.ai GPU
- **Thumbnails**: 200x200 JPEG for fast UI loading
- **Tags**: User-defined tags for organizing photos
- **Web UI**: Responsive photo gallery with search, filters, and face management
- **Authentication**: Built-in password auth (optional)
- **S3 triggers**: Automatic processing when photos are uploaded

## Architecture

```
                                         ┌─────────────────────────────┐
                                         │  Modal (Python + T4 GPU)    │
                              realtime   │  - Serverless, scale-to-zero│
                           ┌────────────>│  - S3 webhook triggers      │
                           │  POST       │  - Image captioning (BLIP)  │
┌──────────────────────────┤  /analyze   │  - Face detection/embedding │
│  NuvoPic Server (Node.js)│             └─────────────────────────────┘
│  - Hono HTTP + webapp    │
│  - S3 download           │             ┌─────────────────────────────┐
│  - EXIF extraction       │             │  Vast.ai (RTX 4090 GPU)    │
│  - Thumbnails (sharp)    │   batch     │  - On-demand instances      │
│  - Filename date parsing │ ┌──────────>│  - Auto-provision & destroy │
│  - DB insert             │ │  POST     │  - Image captioning (BLIP)  │
│  - GPU client abstraction├─┘  /analyze │  - Face detection/embedding │
└──────────┬───────────────┘             └─────────────────────────────┘
           │
           ├──────────────────────────────┐
           │                              │
   ┌───────▼────────────────┐    ┌────────▼───────────────────┐
   │ PostgreSQL + pgvector   │    │ S3-compatible Storage      │
   │ (any provider)          │    │ (any provider)             │
   └─────────────────────────┘    └────────────────────────────┘
```

Node.js handles: S3 download, EXIF, thumbnails, filename date parsing, DB writes. These are fast and don't need GPU.

**GPU providers** (same inference code, different hosting):
- **Modal** — serverless, scale-to-zero. Best for real-time processing (S3 webhook triggers). Low latency, pay-per-second.
- **Vast.ai** — on-demand GPU instances. Best for batch processing (import/reprocess). Cheaper per-hour rates, auto-provisioned and destroyed per batch.

Both providers run the same Python inference server (BLIP captioning + InsightFace face detection) and expose the same `POST /analyze` HTTP API. The Node.js server uses a generic `GpuClient` interface so it is provider-agnostic.

A **local fallback mode** (`PROCESSING_MODE=local`) uses CPU-based extractors for development without any GPU provider.

## Tech Stack

- **Runtime**: Node.js 20+ / TypeScript
- **HTTP framework**: Hono
- **Image captioning**: BLIP (Salesforce/blip-image-captioning-base) on Modal GPU
- **Face detection**: InsightFace (buffalo_l) with 512-dim embeddings on Modal GPU
- **Thumbnails**: sharp
- **Frontend**: Preact + Vite
- **Database**: PostgreSQL with pgvector (any provider)
- **Storage**: Any S3-compatible storage (AWS S3, Scaleway, Cloudflare R2, MinIO)
- **GPU inference**: [Modal](https://modal.com) (T4 GPU, scale-to-zero) or [Vast.ai](https://vast.ai) (RTX 4090, on-demand batch)

## Quick Start (Local Development)

### 1. Install dependencies

```bash
npm install
cd webapp && npm install && cd ..
```

### 2. Start local services

```bash
npm run docker:up
```

This starts PostgreSQL (with pgvector) and MinIO (S3-compatible storage).

### 3. Configure environment

```bash
cp .env.local .env
```

### 4. Initialize database

```bash
npm run init-db
```

### 5. Run the server

```bash
# Backend (port 8080)
npm run dev

# Frontend (port 5173, proxies API to 8080)
npm run webapp:dev
```

By default, without `MODAL_ENDPOINT_URL` set, processing falls back to local mode (CPU-based). See [Modal Setup](#modal-setup-real-time-gpu-processing) for real-time GPU processing or [Vast.ai Setup](#vastai-setup-batch-gpu-processing) for cheaper batch processing.

## Modal Setup (Real-time GPU Processing)

Modal provides serverless GPU inference with scale-to-zero — ideal for real-time processing triggered by S3 webhooks.

### 1. Install Modal CLI

```bash
pip install modal
modal setup
```

### 2. Deploy the inference endpoint

```bash
modal deploy modal/inference.py
```

This builds a container image with BLIP + InsightFace models baked in and deploys it as an HTTPS endpoint.

### 3. Configure environment

Add these to your `.env`:

```bash
MODAL_ENDPOINT_URL=https://your-workspace--nuvopic-inference-analyze.modal.run
MODAL_PROXY_KEY=ak-xxx
MODAL_PROXY_SECRET=as-xxx
```

Get your proxy key/secret from the [Modal dashboard](https://modal.com/settings).

### 4. Run the DB migration

The face embedding column changes from `VECTOR(128)` to `VECTOR(512)`:

```bash
npm run init-db
```

This truncates existing face data and alters the column. All photos must be reprocessed afterward.

### 5. Reprocess all photos

```bash
curl -X POST http://localhost:8080/api/v1/photos/reprocess
```

### Performance

| | Local (CPU) | Modal (T4 GPU) |
|---|---|---|
| Caption inference | ~5s (blocks event loop) | ~0.2-0.5s |
| Face detection | ~5s (blocks event loop) | ~0.1-0.3s |
| Total per photo | ~11s (blocking) | ~2-3s (non-blocking) |
| 100 photos | ~23 min | ~3-5 min |
| UI responsive during import? | No | Yes |

### Cost

- T4 GPU at $0.59/hr on Modal
- 100 photos: ~$0.008 (less than 1 cent)
- $30/mo free credits covers ~360,000 photos/month
- Scale-to-zero: zero cost when not processing

### Benchmarks

| Metric | Value |
|---|---|
| Photos processed | 90 |
| GPU | 1x NVIDIA T4 (Modal) |
| Total time | 3.5 minutes |
| Per photo | ~2.3s |
| Modal cost | $0.04 |

## Vast.ai Setup (Batch GPU Processing)

Vast.ai provides on-demand GPU instances at lower hourly rates than serverless providers. NuvoPic auto-provisions an instance at the start of a batch (import/reprocess), processes all photos, then destroys the instance. No manual server management required.

**When to use Vast.ai vs Modal:**
- **Modal** — best for real-time (S3 triggers). Scale-to-zero, pay-per-second, low latency.
- **Vast.ai** — best for batch (import/reprocess). RTX 4090 at ~$0.35/hr vs T4 at $0.59/hr, and faster inference per photo.

> **Note:** `PROCESSING_MODE=vastai` is NOT supported for real-time processing (each photo would spin up a new instance). Use `BATCH_GPU_PROVIDER=vastai` to use Vast.ai for batch operations while keeping Modal for real-time.

### 1. Get a Vast.ai API key

Sign up at [vast.ai](https://vast.ai) and generate an API key from your account settings.

### 2. Build and push the inference Docker image

The inference image packages BLIP + InsightFace models and a FastAPI server. It is ~15GB due to baked-in model weights.

```bash
# Build (requires amd64 — use GitHub Actions for ARM Macs)
docker build -f modal/Dockerfile -t bobmoriss/nuvopic-inference:latest .

# Push to Docker Hub
docker push bobmoriss/nuvopic-inference:latest
```

A GitHub Actions workflow (`.github/workflows/inference-docker.yml`) automates this build on push to the `modal/` directory.

### 3. Configure environment

Add these to your `.env`:

```bash
# Use Vast.ai for batch processing (import/reprocess)
BATCH_GPU_PROVIDER=vastai

# Vast.ai credentials
VAST_API_KEY=your-vast-api-key
VAST_DOCKER_IMAGE=bobmoriss/nuvopic-inference:latest
VAST_INFERENCE_API_KEY=your-secret-bearer-token

# Instance configuration (optional — sensible defaults)
VAST_GPU_TYPE=RTX 4090
VAST_MAX_PRICE_PER_HOUR=0.50
VAST_DISK_GB=20
```

### 4. Run batch processing

```bash
# Import new photos from S3
curl -X POST http://localhost:8080/api/v1/photos/import

# Reprocess all existing photos (force re-analyze)
curl -X POST http://localhost:8080/api/v1/photos/reprocess \
  -H "Content-Type: application/json" \
  -d '{"force": true}'
```

The server will automatically:
1. Search for available RTX 4090 datacenter offers on Vast.ai
2. Provision the cheapest instance matching your criteria
3. Wait for the Docker image to pull and the inference server to become healthy (~5-6 min on first run)
4. Process all photos in parallel chunks
5. Destroy the instance when done (or on error)

### Vast.ai Cost

- RTX 4090 datacenter instances: ~$0.29-$0.40/hr
- 90 photos: ~$0.06 (10 min total including provisioning)
- Instance is destroyed after each batch — no idle cost
- First run is slower due to 15GB Docker image pull (~5.5 min); subsequent runs on the same machine are faster

### Vast.ai Benchmarks

| Metric | Value |
|---|---|
| Photos processed | 90 |
| GPU | 1x NVIDIA RTX 4090 (Vast.ai datacenter) |
| Instance cost | $0.349/hr |
| Provisioning time | ~5.5 min (Docker image pull) |
| Inference time (90 photos) | ~3-4 min |
| Per photo (avg) | ~2-2.5s |
| Total wall time | ~9-10 min |
| Batch cost | ~$0.06 |

### GPU Provider Comparison

| | Local (CPU) | Modal (T4 GPU) | Vast.ai (RTX 4090) |
|---|---|---|---|
| Best for | Development | Real-time (webhooks) | Batch (import/reprocess) |
| Per photo | ~11s (blocking) | ~2-3s | ~2-2.5s |
| 90 photos | ~17 min | ~3.5 min | ~3-4 min (+ ~6 min provision) |
| Hourly cost | Free | $0.59/hr (T4) | ~$0.35/hr (RTX 4090) |
| Batch cost (90 photos) | $0 | ~$0.04 | ~$0.06 |
| Idle cost | $0 | $0 (scale-to-zero) | $0 (destroyed after batch) |
| Setup | None | Modal account + deploy | Vast.ai account + Docker image |
| Provisioning | Instant | ~1-2s cold start | ~5-6 min first run |

## Self-Hosting

The application is designed to be deployed on **any cloud provider** that supports Docker containers.

### Requirements

- **Docker** (or Node.js 20+)
- **PostgreSQL** with the [pgvector](https://github.com/pgvector/pgvector) extension
- **S3-compatible object storage** for photo files
- **Modal account** (optional, for real-time GPU processing)
- **Vast.ai account** (optional, for batch GPU processing)

### Generic Docker Deployment

```bash
# Build the image
docker build -f deploy/docker/Dockerfile -t nuvopic .

# Run with environment variables
docker run -p 8080:8080 \
  -e DATABASE_URL='postgres://user:pass@host:5432/db' \
  -e DATABASE_SSL='true' \
  -e S3_BUCKET='my-photos' \
  -e S3_ACCESS_KEY_ID='...' \
  -e S3_SECRET_ACCESS_KEY='...' \
  -e S3_REGION='us-east-1' \
  -e S3_ENDPOINT='https://s3.provider.com' \
  -e MODAL_ENDPOINT_URL='https://your-workspace--nuvopic-inference-analyze.modal.run' \
  -e MODAL_PROXY_KEY='ak-xxx' \
  -e MODAL_PROXY_SECRET='as-xxx' \
  -e AUTH_PASSWORD='your-password' \
  -e JWT_SECRET='your-secret' \
  nuvopic
```

### Provider-Specific Guides

| Provider | Guide | Scale to Zero |
|----------|-------|---------------|
| **Scaleway** | [deploy/scaleway/README.md](deploy/scaleway/README.md) | Yes (Serverless Containers) |
| **AWS** | [deploy/aws-lambda/](deploy/aws-lambda/) | Yes (Lambda) |
| **Any Docker host** | See above | No |

### Database Providers

Any PostgreSQL provider with pgvector support works:

- [Supabase](https://supabase.com) - Free tier available
- [Neon](https://neon.tech) - Free tier, serverless PostgreSQL
- [Scaleway Serverless SQL](https://www.scaleway.com/en/serverless-sql-database/) - pgvector supported
- Self-hosted PostgreSQL with pgvector extension

### Storage Providers

Any S3-compatible object storage works:

- [Scaleway Object Storage](https://www.scaleway.com/en/object-storage/)
- [AWS S3](https://aws.amazon.com/s3/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [MinIO](https://min.io/) (self-hosted)

## Configuration

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `DATABASE_URL` | Yes | PostgreSQL connection string | |
| `DATABASE_SSL` | No | Enable SSL for database connections | `false` |
| `S3_BUCKET` | Yes | S3 bucket name | |
| `S3_ACCESS_KEY_ID` | Yes | S3 access key | |
| `S3_SECRET_ACCESS_KEY` | Yes | S3 secret key | |
| `S3_REGION` | Yes | S3 region | |
| `S3_ENDPOINT` | No | Custom S3 endpoint (non-AWS providers) | AWS default |
| `S3_FORCE_PATH_STYLE` | No | Use path-style S3 URLs (MinIO) | `false` |
| `PROCESSING_MODE` | No | `"modal"`, `"vastai"`, or `"local"` | Auto-detect |
| `BATCH_GPU_PROVIDER` | No | GPU provider for batch ops: `"modal"`, `"vastai"`, or `"local"` | Same as PROCESSING_MODE |
| `MODAL_ENDPOINT_URL` | No* | Modal inference endpoint URL | |
| `MODAL_PROXY_KEY` | No* | Modal proxy auth key | |
| `MODAL_PROXY_SECRET` | No* | Modal proxy auth secret | |
| `VAST_API_KEY` | No** | Vast.ai API key | |
| `VAST_DOCKER_IMAGE` | No** | Docker image for Vast.ai inference | `bobmoriss/nuvopic-inference:latest` |
| `VAST_INFERENCE_API_KEY` | No** | Bearer token for inference server auth | |
| `VAST_GPU_TYPE` | No | GPU type to request on Vast.ai | `RTX 4090` |
| `VAST_MAX_PRICE_PER_HOUR` | No | Max $/hr for Vast.ai offers | `0.50` |
| `VAST_DISK_GB` | No | Disk space (GB) for Vast.ai instance | `20` |
| `AUTH_PASSWORD` | No | Password for app access | Disabled |
| `JWT_SECRET` | No*** | Secret for session tokens | Required if AUTH_PASSWORD is set |
| `PORT` | No | HTTP server port | `8080` |
| `LOG_LEVEL` | No | Logging level | `info` |

\* Required when `PROCESSING_MODE=modal` or when GPU processing is desired.

\** Required when `BATCH_GPU_PROVIDER=vastai`.

\*** Required when `AUTH_PASSWORD` is set. Generate with: `openssl rand -hex 32`

## Usage

### Process a photo via HTTP

```bash
curl -X POST http://localhost:8080/process \
  -H "Content-Type: application/json" \
  -d '{"s3Bucket": "photos", "s3Key": "vacation/beach.jpg"}'
```

### Response

```json
{
  "processed": 1,
  "results": [{
    "photoId": "550e8400-e29b-41d4-a716-446655440000",
    "s3Path": "s3://photos/vacation/beach.jpg",
    "takenAt": "2024-06-15T14:30:00.000Z",
    "location": { "lat": 43.7102, "lng": 7.2620 },
    "description": "a beach with palm trees and blue water",
    "facesDetected": 2,
    "thumbnailSize": 12543,
    "errors": []
  }]
}
```

## Database Schema

### photos
| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| s3_path | TEXT | S3 URI (unique) |
| taken_at | TIMESTAMP | When photo was taken |
| location_lat | DOUBLE | GPS latitude |
| location_lng | DOUBLE | GPS longitude |
| description | TEXT | AI-generated caption |
| thumbnail | BYTEA | 200x200 JPEG |

### faces
| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| photo_id | UUID | FK to photos |
| bounding_box | JSONB | {x, y, width, height} |
| embedding | VECTOR(512) | InsightFace descriptor for matching |
| person_id | UUID | FK to persons (nullable) |

### tags / photo_tags
Many-to-many relationship for user-defined tags.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript (backend) |
| `npm run dev` | Run backend dev server with hot reload |
| `npm start` | Run production server |
| `npm run webapp:dev` | Run frontend dev server |
| `npm run webapp:build` | Build frontend for production |
| `npm run build:all` | Build backend + frontend |
| `npm run init-db` | Initialize database schema |
| `npm run docker:up` | Start local PostgreSQL + MinIO |
| `npm run docker:down` | Stop local services |

## Face Recognition

Face detection extracts 512-dimensional embeddings (InsightFace buffalo_l) for recognition. The workflow:

1. Pipeline detects faces and stores embeddings
2. User assigns faces to persons in the UI
3. New faces can be matched against known persons using cosine similarity:

```sql
SELECT p.name, 1 - (f.embedding <=> $1) as similarity
FROM faces f
JOIN persons p ON f.person_id = p.id
WHERE f.person_id IS NOT NULL
ORDER BY f.embedding <=> $1
LIMIT 5;
```

## Testing

### Unit Tests

```bash
npm test
```

### End-to-End Tests

E2E tests require Docker for PostgreSQL and MinIO:

```bash
npm run docker:up
npm run test:integration
```

## License

MIT
