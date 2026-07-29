#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"

usage() {
  echo "Usage: RESTORE_CONFIRM=TARGET_DATABASE RESTORE_OWNER=ROLE $0 ARCHIVE.dump TARGET_DATABASE" >&2
  echo "TARGET_DATABASE must already exist and should be an isolated restore target." >&2
}

if [[ $# -ne 2 ]]; then
  usage
  exit 64
fi

archive="$1"
target_database="$2"

if [[ ! -f "${archive}" || ! -r "${archive}" ]]; then
  echo "Archive is not a readable regular file: ${archive}" >&2
  exit 66
fi
archive="$(cd -- "$(dirname -- "${archive}")" && pwd -P)/$(basename -- "${archive}")"

if [[ ! "${target_database}" =~ ^nuvopic_(control_restore_[a-z0-9_]+|ws_[0-9a-f_]{36}_restore_[a-z0-9_]+)$ ]]; then
  echo "Target must be a dedicated NuvoPic restore database ending in _restore_NAME." >&2
  exit 64
fi
if [[ "${RESTORE_CONFIRM:-}" != "${target_database}" ]]; then
  echo "Set RESTORE_CONFIRM=${target_database} to confirm replacement of that target." >&2
  exit 64
fi
restore_owner="${RESTORE_OWNER:-}"
if [[ ! "${restore_owner}" =~ ^nuvopic_(control|ws_[0-9a-f]{32})$ ]]; then
  echo "RESTORE_OWNER must be the explicit NuvoPic runtime role for this restore." >&2
  exit 64
fi

cd -- "${PROJECT_DIR}"
postgres_user="$(docker compose exec -T postgres printenv POSTGRES_USER)"
target_exists="$(
  docker compose exec -T postgres psql \
    --tuples-only --no-align \
    --set=target_database="${target_database}" \
    -U "${postgres_user}" -d postgres \
    -c "SELECT count(*) FROM pg_database WHERE datname = :'target_database';"
)"
if [[ "${target_exists}" != "1" ]]; then
  echo "Target database does not exist: ${target_database}" >&2
  exit 65
fi
owner_exists="$(
  docker compose exec -T postgres psql \
    --tuples-only --no-align \
    --set=restore_owner="${restore_owner}" \
    -U "${postgres_user}" -d postgres \
    -c "SELECT count(*) FROM pg_roles WHERE rolname = :'restore_owner';"
)"
if [[ "${owner_exists}" != "1" ]]; then
  echo "Restore owner role does not exist: ${restore_owner}" >&2
  exit 65
fi

docker compose exec -T postgres pg_restore --list <"${archive}" >/dev/null
docker compose exec -T postgres pg_restore \
  --exit-on-error --clean --if-exists --no-owner --no-privileges \
  --role="${restore_owner}" \
  -U "${postgres_user}" -d "${target_database}" <"${archive}"

echo "Restored ${archive} into ${target_database}."
echo "Run application smoke tests before changing any workspace route."
