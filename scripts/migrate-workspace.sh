#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"

if [[ $# -ne 0 ]]; then
  echo "Usage: WORKSPACE_DATABASE_URL=postgres://... $0" >&2
  exit 64
fi

if [[ -z "${WORKSPACE_DATABASE_URL:-}" ]]; then
  echo "WORKSPACE_DATABASE_URL is required and must identify one workspace database." >&2
  exit 64
fi

case "${WORKSPACE_DATABASE_URL}" in
  postgres://*/*|postgresql://*/*) ;;
  *)
    echo "WORKSPACE_DATABASE_URL must be a PostgreSQL URL." >&2
    exit 64
    ;;
esac

database_path="${WORKSPACE_DATABASE_URL%%\?*}"
database_name="${database_path##*/}"
if [[ ! "${database_name}" =~ ^nuvopic_ws_[0-9a-f_]{36}$ ]]; then
  echo "Refusing to migrate unexpected database name: ${database_name}" >&2
  exit 64
fi

cd -- "${PROJECT_DIR}"
docker compose up -d postgres
docker compose --profile migration run --rm \
  -e DATABASE_URL="${WORKSPACE_DATABASE_URL}" \
  -e DATABASE_SSL="${WORKSPACE_DATABASE_SSL:-false}" \
  data-plane-migrate
