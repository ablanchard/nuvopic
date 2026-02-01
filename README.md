# GPhoto

A Google Photos alternative with serverless photo processing. Photos are stored in S3, metadata is extracted and stored in PostgreSQL for fast querying by the web UI.

## Features

- **EXIF extraction**: Date taken, GPS coordinates
- **AI-generated descriptions**: Using Transformers.js (runs locally, no API calls)
- **Face detection**: Extracts face bounding boxes and embeddings for later recognition
- **Thumbnails**: 200x200 JPEG for fast UI loading
- **Tags**: User-defined tags for organizing photos
- **S3 triggers**: Automatic processing when photos are uploaded

## Architecture

```
S3 Photo → Serverless Function → PostgreSQL (Supabase)
                ↓
    ┌──────────┬──────────┬──────────┬──────────┐
    │ EXIF     │ AI       │ Face     │ Thumbnail │
    │ Parser   │ Caption  │ Detector │ Generator │
    └──────────┴──────────┴──────────┴──────────┘
```

## Tech Stack

- **Runtime**: Node.js 20+ / TypeScript
- **Image captioning**: Transformers.js with ViT-GPT2
- **Face detection**: face-api.js with SSD MobileNet
- **Thumbnails**: sharp
- **Database**: PostgreSQL with pgvector (Supabase)
- **Storage**: Any S3-compatible storage (AWS S3, MinIO, Cloudflare R2)

## Quick Start

### 1. Install dependencies

```bash
npm install
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
# Edit .env if needed
```

### 5. Initialize database

```bash
npm run init-db
```

### 6. Run the server

```bash
npm run dev
```

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

## Deployment

### AWS Lambda

```bash
cd deploy/aws-lambda
npm install -g serverless
serverless deploy
```

The S3 trigger automatically processes new photos when uploaded.

### Docker (Cloud Run, etc.)

```bash
docker build -f deploy/docker/Dockerfile -t gphoto .
docker run -p 8080:8080 --env-file .env gphoto
```

## Configuration

| Variable | Description | Example |
|----------|-------------|---------|
| DATABASE_URL | PostgreSQL connection string | `postgres://user:pass@host:5432/db` |
| S3_ENDPOINT | S3 endpoint (optional for AWS) | `http://localhost:9000` |
| S3_BUCKET | Bucket name | `photos` |
| S3_ACCESS_KEY_ID | AWS access key | |
| S3_SECRET_ACCESS_KEY | AWS secret key | |
| S3_REGION | AWS region | `us-east-1` |
| S3_FORCE_PATH_STYLE | Use path-style URLs (for MinIO) | `true` |

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript |
| `npm run dev` | Run dev server with hot reload |
| `npm run start` | Run production server |
| `npm run download-models` | Download face-api.js models |
| `npm run init-db` | Initialize database schema |
| `npm run docker:up` | Start local PostgreSQL + MinIO |
| `npm run docker:down` | Stop local services |

## Face Recognition

Face detection extracts 128-dimensional embeddings that can be used for recognition. The recognition workflow:

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

Run unit tests (no external services required):

```bash
npm test
```

### End-to-End Tests

E2E tests require Docker for PostgreSQL and MinIO:

```bash
# Start services
npm run docker:up

# Download models (required for face/caption tests)
npm run download-models

# Run E2E tests
npm run test:integration
```

The E2E tests:
- Upload a test image to MinIO
- Process it through the full pipeline
- Verify metadata is stored correctly in PostgreSQL
- Test S3 event format handling
- Test tag functionality
- Verify idempotent reprocessing (upsert)

## License

MIT
