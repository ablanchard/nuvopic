# Multi-stage build for smaller image
# This Dockerfile is provider-agnostic and works on any container platform.

# ---- Build stage: backend ----
FROM node:20-slim AS backend-builder

WORKDIR /app

# Install build dependencies for native modules (sharp, canvas)
RUN apt-get update && apt-get install -y \
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

# ---- Build stage: webapp ----
FROM node:20-slim AS webapp-builder

WORKDIR /app/webapp

# Copy webapp package files
COPY webapp/package*.json ./

# Install webapp dependencies
RUN npm ci

# Copy webapp source and config files
COPY webapp/tsconfig*.json ./
COPY webapp/vite.config.ts ./
COPY webapp/index.html ./
COPY webapp/src ./src

# Build webapp
RUN npm run build

# ---- Production stage ----
FROM node:20-slim

WORKDIR /app

# Install runtime dependencies for native modules
RUN apt-get update && apt-get install -y \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built backend from builder
COPY --from=backend-builder /app/dist ./dist

# Copy built webapp from builder
COPY --from=webapp-builder /app/webapp/dist ./webapp/dist

# Copy models
COPY models ./models

# Create non-root user
RUN useradd -m -u 1001 appuser
USER appuser

# Set environment variables
ENV NODE_ENV=production

# Expose port for HTTP invocation
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s \
    CMD node -e "require('http').get('http://localhost:8080/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start the server
CMD ["node", "dist/server.js"]
