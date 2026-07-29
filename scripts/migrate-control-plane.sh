#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"

if [[ $# -ne 0 ]]; then
  echo "Usage: $0" >&2
  exit 64
fi

if [[ ! -f "${PROJECT_DIR}/.env" ]]; then
  echo "Missing ${PROJECT_DIR}/.env." >&2
  exit 66
fi

cd -- "${PROJECT_DIR}"
docker compose up -d postgres
docker compose --profile migration run --rm control-plane-migrate
