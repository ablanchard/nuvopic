# Deploy to Scaleway

This guide deploys the application to **Scaleway Serverless Containers** with scale-to-zero support.

## Architecture

```
Scaleway Serverless Container (scale to 0)
    ├── Backend API (Hono)
    ├── Webapp (static files)
    └── Photo processor (inline)
         │
         ├── PostgreSQL + pgvector (any provider)
         └── Scaleway Object Storage (S3-compatible)
```

## Prerequisites

- [Scaleway account](https://www.scaleway.com)
- [Scaleway CLI (`scw`)](https://www.scaleway.com/en/docs/developer-tools/scaleway-cli/quickstart/) installed and configured
- [Docker](https://docs.docker.com/get-docker/) installed
- `jq` installed (`brew install jq` / `apt install jq`)
- A PostgreSQL database with pgvector extension (Supabase, Neon, Scaleway Serverless SQL, etc.)
- Your photos bucket already created on Scaleway Object Storage

## Step 1: Initial Setup

Run the setup script to create Scaleway resources:

```bash
cd deploy/scaleway
./setup.sh
```

This creates:
- A **Container Registry** namespace (to store Docker images)
- A **Serverless Container** namespace and container (scale-to-zero, 2048MB RAM)

## Step 2: Configure Environment Variables

Set the required environment variables on the container. Replace the placeholders:

```bash
# Get your container ID from the setup output, then:
CONTAINER_ID="your-container-id"

scw container container update "$CONTAINER_ID" \
    environment-variables.DATABASE_URL='postgres://user:pass@host:5432/db' \
    environment-variables.DATABASE_SSL='true' \
    environment-variables.S3_BUCKET='your-bucket' \
    environment-variables.S3_ACCESS_KEY_ID='your-scw-access-key' \
    environment-variables.S3_SECRET_ACCESS_KEY='your-scw-secret-key' \
    environment-variables.S3_REGION='fr-par' \
    environment-variables.S3_ENDPOINT='https://s3.fr-par.scw.cloud' \
    environment-variables.AUTH_PASSWORD='your-secure-password' \
    secret-environment-variables.0.key='JWT_SECRET' \
    secret-environment-variables.0.value="$(openssl rand -hex 32)"
```

> **Note**: `JWT_SECRET` is set as a **secret** environment variable (encrypted at rest by Scaleway).

## Step 3: Initialize the Database

Run the database schema against your PostgreSQL instance:

```bash
# From the project root
DATABASE_URL='postgres://user:pass@host:5432/db' npm run init-db
```

Make sure the `pgvector` extension is enabled in your database (most managed providers have it available).

## Step 4: Download AI Models

```bash
npm run download-models
```

The face-api.js models are included in the Docker image. The Transformers.js captioning model will be auto-downloaded on first use.

## Step 5: Deploy

```bash
cd deploy/scaleway
./deploy.sh
```

This builds the Docker image, pushes it to the registry, and deploys the container. The output shows your application URL.

## Step 6: Custom Domain (Optional)

1. Go to the [Scaleway Console](https://console.scaleway.com) > Serverless > Containers
2. Select your container > Settings > Custom domains
3. Add your domain and configure DNS as instructed

Scaleway handles TLS certificates automatically.

## Updating

To deploy a new version after code changes:

```bash
cd deploy/scaleway
./deploy.sh
```

## Cost Estimate

For a single user processing a few photos per month:

| Resource | Cost |
|---|---|
| Serverless Container | ~€0/month (within free tier: 400k GB-s) |
| Container Registry | Free (first 75GB) |
| Object Storage | Pay per GB stored (first 75GB free) |
| **Total** | **~€0/month** for light usage |

## Troubleshooting

### Check container logs
```bash
scw container container logs <container-id>
```

### Check container status
```bash
scw container container get <container-id>
```

### Cold starts
The container scales to zero when idle. The first request after idle will have a cold start (~10-30s depending on model loading). Subsequent requests are fast.

To reduce cold starts, set `CONTAINER_MIN_SCALE=1` in setup.sh (this keeps one instance always warm, but costs more).

### Memory issues
If you see OOM errors, increase `CONTAINER_MEMORY` in setup.sh. The AI models (face detection + captioning) need ~1.5GB.
