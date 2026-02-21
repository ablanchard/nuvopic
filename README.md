# NuvoPic

A self-hosted app to visualize and organize your photos stored on cloud storage, with AI-powered photo processing. Runs on any cloud provider or your own server.

## Features

- **EXIF extraction**: Date taken, GPS coordinates
- **AI-generated descriptions**: Using Transformers.js (runs locally, no external API)
- **Face detection**: Extracts face bounding boxes and embeddings for recognition
- **Thumbnails**: 200x200 JPEG for fast UI loading
- **Tags**: User-defined tags for organizing photos
- **Web UI**: Responsive photo gallery with search, filters, and face management
- **Authentication**: Built-in password auth (optional)
- **S3 triggers**: Automatic processing when photos are uploaded

## Architecture

```
                    ┌────────────────────────┐
                    │  Docker Container       │
                    │  ┌──────────────────┐   │
                    │  │ Hono HTTP Server │   │
    Browser ────────┼──│  ├─ Auth         │   │
                    │  │  ├─ API          │   │
                    │  │  └─ Static files  │   │
                    │  └──────────────────┘   │
                    │  ┌──────────────────┐   │
                    │  │ Photo Processor  │   │
                    │  │  ├─ EXIF         │   │
                    │  │  ├─ AI Caption   │   │
                    │  │  ├─ Faces        │   │
                    │  │  └─ Thumbnail    │   │
                    │  └──────────────────┘   │
                    └──────────┬──────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                                  │
   ┌──────────▼──────────┐         ┌─────────────▼──────────┐
   │ PostgreSQL + pgvector│         │ S3-compatible Storage  │
   │ (any provider)       │         │ (any provider)         │
   └──────────────────────┘         └────────────────────────┘
```

## Tech Stack

- **Runtime**: Node.js 20+ / TypeScript
- **HTTP framework**: Hono
- **Image captioning**: Transformers.js with ViT-GPT2
- **Face detection**: face-api.js with SSD MobileNet
- **Thumbnails**: sharp
- **Frontend**: Preact + Vite
- **Database**: PostgreSQL with pgvector (any provider)
- **Storage**: Any S3-compatible storage (AWS S3, Scaleway, Cloudflare R2, MinIO)

## Quick Start (Local Development)

### 1. Install dependencies

```bash
npm install
cd webapp && npm install && cd ..
```

### 2. Download AI models

```bash
npm run download-models
```

### 3. Start local services

```bash
npm run docker:up
```

This starts PostgreSQL (with pgvector) and MinIO (S3-compatible storage).

### 4. Configure environment

```bash
cp .env.local .env
```

### 5. Initialize database

```bash
npm run init-db
```

### 6. Run the server

```bash
# Backend (port 8080)
npm run dev

# Frontend (port 5173, proxies API to 8080)
npm run webapp:dev
```

## Self-Hosting

The application is designed to be deployed on **any cloud provider** that supports Docker containers.

### Requirements

- **Docker** (or Node.js 20+)
- **PostgreSQL** with the [pgvector](https://github.com/pgvector/pgvector) extension
- **S3-compatible object storage** for photo files

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
| `AUTH_PASSWORD` | No | Password for app access | Disabled |
| `JWT_SECRET` | No* | Secret for session tokens | Required if AUTH_PASSWORD is set |
| `PORT` | No | HTTP server port | `8080` |
| `LOG_LEVEL` | No | Logging level | `info` |

\* Required when `AUTH_PASSWORD` is set. Generate with: `openssl rand -hex 32`

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
| embedding | VECTOR(128) | Face descriptor for matching |
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
| `npm run download-models` | Download face-api.js models |
| `npm run init-db` | Initialize database schema |
| `npm run docker:up` | Start local PostgreSQL + MinIO |
| `npm run docker:down` | Stop local services |

## Face Recognition

Face detection extracts 128-dimensional embeddings for recognition. The workflow:

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
npm run download-models
npm run test:integration
```

## License

MIT
