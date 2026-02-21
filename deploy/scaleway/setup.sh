#!/usr/bin/env bash
#
# Scaleway - Initial Setup
#
# This script creates the required Scaleway resources:
# - Container Registry namespace
# - Serverless Container namespace and container
#
# Prerequisites:
#   - Scaleway CLI installed and configured (https://www.scaleway.com/en/cli/)
#   - Docker installed
#
# Usage:
#   ./setup.sh
#
# This script is idempotent - it's safe to run multiple times.

set -euo pipefail

# Configuration - override these via environment variables
PROJECT_NAME="${PROJECT_NAME:-nuvopic}"
SCW_REGION="${SCW_REGION:-fr-par}"
CONTAINER_PORT="${CONTAINER_PORT:-8080}"
CONTAINER_MIN_SCALE="${CONTAINER_MIN_SCALE:-0}"
CONTAINER_MAX_SCALE="${CONTAINER_MAX_SCALE:-1}"
CONTAINER_MEMORY="${CONTAINER_MEMORY:-2048}"  # MB - needed for AI models
CONTAINER_TIMEOUT="${CONTAINER_TIMEOUT:-300}" # seconds

echo "=== Scaleway Setup for ${PROJECT_NAME} ==="
echo ""
echo "Region:    ${SCW_REGION}"
echo "Memory:    ${CONTAINER_MEMORY}MB"
echo "Min scale: ${CONTAINER_MIN_SCALE}"
echo "Max scale: ${CONTAINER_MAX_SCALE}"
echo ""

# Check prerequisites
if ! command -v scw &> /dev/null; then
    echo "Error: Scaleway CLI (scw) is not installed."
    echo "Install: https://www.scaleway.com/en/docs/developer-tools/scaleway-cli/quickstart/"
    exit 1
fi

if ! command -v docker &> /dev/null; then
    echo "Error: Docker is not installed."
    exit 1
fi

# Step 1: Create Container Registry namespace
echo "--- Step 1: Container Registry ---"
REGISTRY_NS=$(scw registry namespace list -o json | jq -r ".[] | select(.name == \"${PROJECT_NAME}\") | .id")

if [ -z "$REGISTRY_NS" ]; then
    echo "Creating registry namespace '${PROJECT_NAME}'..."
    REGISTRY_NS=$(scw registry namespace create name="${PROJECT_NAME}" region="${SCW_REGION}" -o json | jq -r '.id')
    echo "Created: ${REGISTRY_NS}"
else
    echo "Registry namespace already exists: ${REGISTRY_NS}"
fi

REGISTRY_ENDPOINT=$(scw registry namespace get "${REGISTRY_NS}" -o json | jq -r '.endpoint')
echo "Registry endpoint: ${REGISTRY_ENDPOINT}"

# Step 2: Create Serverless Container namespace
echo ""
echo "--- Step 2: Serverless Container Namespace ---"
CONTAINER_NS=$(scw container namespace list -o json | jq -r ".[] | select(.name == \"${PROJECT_NAME}\") | .id")

if [ -z "$CONTAINER_NS" ]; then
    echo "Creating container namespace '${PROJECT_NAME}'..."
    CONTAINER_NS=$(scw container namespace create name="${PROJECT_NAME}" region="${SCW_REGION}" -o json | jq -r '.id')
    echo "Created: ${CONTAINER_NS}"
else
    echo "Container namespace already exists: ${CONTAINER_NS}"
fi

# Step 3: Create the container
echo ""
echo "--- Step 3: Serverless Container ---"
CONTAINER_ID=$(scw container container list namespace-id="${CONTAINER_NS}" -o json | jq -r ".[] | select(.name == \"${PROJECT_NAME}\") | .id")

if [ -z "$CONTAINER_ID" ]; then
    echo "Creating container '${PROJECT_NAME}'..."
    CONTAINER_ID=$(scw container container create \
        namespace-id="${CONTAINER_NS}" \
        name="${PROJECT_NAME}" \
        registry-image="${REGISTRY_ENDPOINT}/${PROJECT_NAME}:latest" \
        port="${CONTAINER_PORT}" \
        min-scale="${CONTAINER_MIN_SCALE}" \
        max-scale="${CONTAINER_MAX_SCALE}" \
        memory-limit="${CONTAINER_MEMORY}" \
        timeout="${CONTAINER_TIMEOUT}s" \
        privacy=public \
        -o json | jq -r '.id')
    echo "Created: ${CONTAINER_ID}"
else
    echo "Container already exists: ${CONTAINER_ID}"
fi

# Print summary
CONTAINER_URL=$(scw container container get "${CONTAINER_ID}" -o json | jq -r '.domain_name')

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Registry endpoint:  ${REGISTRY_ENDPOINT}"
echo "Container ID:       ${CONTAINER_ID}"
echo "Container URL:      https://${CONTAINER_URL}"
echo ""
echo "Next steps:"
echo "  1. Set environment variables on the container (see README.md)"
echo "  2. Run ./deploy.sh to build and deploy"
echo ""
echo "To set env vars, run:"
echo "  scw container container update ${CONTAINER_ID} \\"
echo "    environment-variables.DATABASE_URL='postgres://...' \\"
echo "    environment-variables.S3_BUCKET='...' \\"
echo "    environment-variables.S3_ACCESS_KEY_ID='...' \\"
echo "    environment-variables.S3_SECRET_ACCESS_KEY='...' \\"
echo "    environment-variables.S3_REGION='...' \\"
echo "    environment-variables.S3_ENDPOINT='...' \\"
echo "    environment-variables.AUTH_PASSWORD='...' \\"
echo "    secret-environment-variables.0.key='JWT_SECRET' \\"
echo "    secret-environment-variables.0.value='...'"
