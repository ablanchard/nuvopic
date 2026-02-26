# Technology Stack

**Analysis Date:** 2026-02-26

## Languages

**Primary:**
- TypeScript 5.7.0 - Backend API and business logic
- TypeScript 5.9.3 - Frontend/webapp code

**Secondary:**
- JavaScript (Node.js runtime, fallback for web)
- Shell (Docker build scripts, deployment scripts)

## Runtime

**Environment:**
- Node.js 20.0.0+ - Backend server, build tools, CLI utilities

**Package Manager:**
- npm - Dependencies and scripts
- Lockfile: `package-lock.json` present

## Frameworks

**Core Backend:**
- Hono 4.11.7 - HTTP framework with middleware support
- @hono/node-server 1.19.9 - Node.js runtime adapter for Hono

**Frontend:**
- Preact 10.27.2 - Lightweight React alternative
- @preact/signals 2.6.2 - Reactive state management
- preact-router 4.1.2 - Client-side routing

**Build/Dev:**
- Vite 7.2.4 - Frontend build tool and dev server
- @preact/preset-vite 2.10.2 - Vite plugin for Preact
- TypeScript Compiler (tsc) - Backend compilation
- tsx 4.19.0 - TypeScript executor for Node.js scripts

**Testing:**
- Vitest 2.1.0 - Unit tests and integration tests
- Config: `vitest.config.ts` for unit tests
- Config: `vitest.integration.config.ts` for integration tests

## Key Dependencies

**Critical:**
- pg 8.13.0 - PostgreSQL client for database connections
- @aws-sdk/client-s3 3.700.0 - S3-compatible object storage client (works with AWS S3, Scaleway, MinIO, etc.)
- sharp 0.33.5 - Image processing library (EXIF, thumbnails, metadata)
- exif-reader 2.0.1 - EXIF metadata parsing for photos

**Infrastructure:**
- @types/node 22.10.0 - TypeScript type definitions for Node.js
- @types/pg 8.11.10 - TypeScript types for PostgreSQL client
- crypto (built-in) - JWT token signing and verification
- hono/cookie - Cookie middleware for session management
- hono/cors - CORS middleware for API

**Image Processing (Local Mode):**
- @xenova/transformers - Optional: Image captioning models for local processing
- face-api.js - Optional: Face detection for local processing (models in `./models` directory)
- canvas - Optional: Canvas rendering for face detection in Node.js

**Hosted Processing:**
- Modal (via MODAL_ENDPOINT_URL) - Optional GPU-accelerated inference endpoint

## Configuration

**Environment:**
- Configuration via environment variables (.env file)
- Critical variables required: DATABASE_URL, S3_* credentials
- Optional variables: AUTH_PASSWORD, JWT_SECRET, PROCESSING_MODE, MODAL_* endpoints

**Build:**
- `tsconfig.json` - TypeScript compiler options (target: ES2022, strict mode enabled)
- `webapp/tsconfig.app.json` - Frontend TypeScript configuration
- `webapp/vite.config.ts` - Frontend build configuration with Preact plugin
- `deploy/docker/Dockerfile` - Multi-stage Docker build (backend builder, webapp builder, production)

**Development:**
- Dev server proxy configured in `webapp/vite.config.ts` - `/api` routes proxy to `http://localhost:8080`

## Platform Requirements

**Development:**
- Node.js 20.0.0+
- PostgreSQL with pgvector extension (via docker-compose or cloud provider)
- S3-compatible object storage (MinIO, AWS S3, Scaleway, etc.)
- Optional: Modal account for GPU inference

**Production:**
- Node.js 20-slim base image (Docker)
- PostgreSQL with pgvector (any provider: Supabase, Neon, AWS RDS, self-hosted)
- S3-compatible storage (AWS S3, Scaleway Object Storage, Cloudflare R2, MinIO)
- Memory: ~512MB minimum (Node.js + dependencies)
- CPU: 1+ cores sufficient for most workloads
- Disk: ~1GB for built artifacts + models directory

**Docker Image Dependencies:**
- libcairo2, libpango, libjpeg, libgif, librsvg2 - Image processing libraries for sharp/canvas

---

*Stack analysis: 2026-02-26*
