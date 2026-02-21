#!/usr/bin/env bash
#
# Scaleway - Build and Deploy
#
# Builds the Docker image, pushes to Scaleway Container Registry,
# and deploys to Scaleway Serverless Containers.
#
# Prerequisites:
#   - Run setup.sh first
#   - Scaleway CLI installed and configured
#   - Docker installed and running
#
# Usage:
#   ./deploy.sh [tag]
#
# Arguments:
#   tag  - Docker image tag (default: latest)

set -euo pipefail

# Configuration
PROJECT_NAME="${PROJECT_NAME:-nuvopic}"
SCW_REGION="${SCW_REGION:-fr-par}"
IMAGE_TAG="${1:-latest}"

echo "=== Deploying ${PROJECT_NAME} to Scaleway ==="
echo ""

# Check prerequisites
if ! command -v scw &> /dev/null; then
    echo "Error: Scaleway CLI (scw) is not installed."
    exit 1
fi

if ! command -v docker &> /dev/null; then
    echo "Error: Docker is not installed."
    exit 1
fi

# Get registry endpoint
REGISTRY_NS=$(scw registry namespace list -o json | jq -r ".[] | select(.name == \"${PROJECT_NAME}\") | .id")
if [ -z "$REGISTRY_NS" ]; then
    echo "Error: Registry namespace '${PROJECT_NAME}' not found. Run setup.sh first."
    exit 1
fi
REGISTRY_ENDPOINT=$(scw registry namespace get "${REGISTRY_NS}" -o json | jq -r '.endpoint')

# Get container ID
CONTAINER_NS=$(scw container namespace list -o json | jq -r ".[] | select(.name == \"${PROJECT_NAME}\") | .id")
if [ -z "$CONTAINER_NS" ]; then
    echo "Error: Container namespace '${PROJECT_NAME}' not found. Run setup.sh first."
    exit 1
fi
CONTAINER_ID=$(scw container container list namespace-id="${CONTAINER_NS}" -o json | jq -r ".[] | select(.name == \"${PROJECT_NAME}\") | .id")
if [ -z "$CONTAINER_ID" ]; then
    echo "Error: Container '${PROJECT_NAME}' not found. Run setup.sh first."
    exit 1
fi

IMAGE_FULL="${REGISTRY_ENDPOINT}/${PROJECT_NAME}:${IMAGE_TAG}"

# Step 1: Authenticate Docker with Scaleway Registry
echo "--- Step 1: Docker login to Scaleway Registry ---"
scw registry login

# Step 2: Build the Docker image
echo ""
echo "--- Step 2: Building Docker image ---"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

docker build \
    -f "${PROJECT_ROOT}/deploy/docker/Dockerfile" \
    -t "${IMAGE_FULL}" \
    "${PROJECT_ROOT}"

echo "Built: ${IMAGE_FULL}"

# Step 3: Push to registry
echo ""
echo "--- Step 3: Pushing to Scaleway Registry ---"
docker push "${IMAGE_FULL}"
echo "Pushed: ${IMAGE_FULL}"

# Step 4: Deploy the container
echo ""
echo "--- Step 4: Deploying Serverless Container ---"
scw container container deploy "${CONTAINER_ID}"

# Wait a moment and get the status
sleep 3
CONTAINER_INFO=$(scw container container get "${CONTAINER_ID}" -o json)
CONTAINER_URL=$(echo "${CONTAINER_INFO}" | jq -r '.domain_name')
CONTAINER_STATUS=$(echo "${CONTAINER_INFO}" | jq -r '.status')

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Status: ${CONTAINER_STATUS}"
echo "URL:    https://${CONTAINER_URL}"
echo ""
echo "Check logs:"
echo "  scw container container logs ${CONTAINER_ID}"
