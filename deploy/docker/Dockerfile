# syntax=docker/dockerfile:1

# Multi-stage, provider-agnostic build for the NuvoPic data plane.

# ---- Build stage: backend ----
FROM node:20-bookworm-slim AS backend-builder

WORKDIR /app

# Install build dependencies for native modules.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install all dependencies
RUN npm ci

# Copy source files
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Keep a production-only dependency tree for the runtime image.
FROM backend-builder AS production-dependencies

RUN npm prune --omit=dev && npm cache clean --force

# ---- Build stage: webapp ----
FROM node:20-bookworm-slim AS webapp-builder

WORKDIR /app/webapp

# Copy webapp package files
COPY webapp/package*.json ./

# Install webapp dependencies
RUN npm ci

# Copy webapp source and config files
COPY webapp/tsconfig*.json ./
COPY webapp/vite.config.ts ./
COPY webapp/index.html ./
COPY webapp/public ./public
COPY webapp/src ./src

# Build webapp
RUN npm run build

# ---- Production runtime stage ----
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

# Install runtime dependencies for native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
    && rm -rf /var/lib/apt/lists/*

# Copy the production dependency tree and built application.
COPY package*.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=backend-builder /app/dist ./dist
COPY --from=webapp-builder /app/webapp/dist ./webapp/dist

# Create non-root user
RUN useradd --create-home --uid 10001 appuser
USER appuser

ENV NODE_ENV=production

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "dist/server.js"]

# ---- One-shot workspace migration stage ----
FROM node:20-bookworm-slim AS migration

WORKDIR /app

COPY package*.json ./
COPY --from=backend-builder /app/node_modules ./node_modules
COPY scripts/init-db.ts ./scripts/init-db.ts
COPY scripts/provision-workspaces.ts ./scripts/provision-workspaces.ts
COPY src/db/schema.sql ./src/db/schema.sql

RUN useradd --create-home --uid 10001 appuser
USER appuser

ENV NODE_ENV=production

CMD ["npm", "run", "init-db"]
