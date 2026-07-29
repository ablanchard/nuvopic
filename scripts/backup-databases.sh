#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/nuvopic}"

if [[ $# -ne 0 ]]; then
  echo "Usage: BACKUP_ROOT=/safe/path $0" >&2
  exit 64
fi

if command -v sha256sum >/dev/null 2>&1; then
  checksum_command=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  checksum_command=(shasum -a 256)
else
  echo "sha256sum or shasum is required." >&2
  exit 69
fi

mkdir -p -- "${BACKUP_ROOT}"
BACKUP_ROOT="$(cd -- "${BACKUP_ROOT}" && pwd -P)"
if [[ "${BACKUP_ROOT}" == "/" || "${BACKUP_ROOT}" == "${PROJECT_DIR}" ]]; then
  echo "Refusing unsafe BACKUP_ROOT: ${BACKUP_ROOT}" >&2
  exit 64
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="${BACKUP_ROOT}/${timestamp}"
mkdir -- "${backup_dir}"
chmod 700 "${backup_dir}"

cd -- "${PROJECT_DIR}"
postgres_user="$(docker compose exec -T postgres printenv POSTGRES_USER)"

docker compose exec -T postgres pg_dumpall \
  --globals-only --no-role-passwords \
  -U "${postgres_user}" >"${backup_dir}/globals.sql"

databases=()
while IFS= read -r database_name; do
  [[ -n "${database_name}" ]] && databases+=("${database_name}")
done < <(
  docker compose exec -T postgres psql \
    --tuples-only --no-align -U "${postgres_user}" -d postgres \
    -c "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate AND (datname = 'nuvopic_control' OR datname LIKE 'nuvopic_ws_%') ORDER BY datname;" |
    tr -d '\r'
)

if [[ ${#databases[@]} -eq 0 ]]; then
  echo "No NuvoPic databases found." >&2
  exit 65
fi

for database_name in "${databases[@]}"; do
  if [[ ! "${database_name}" =~ ^nuvopic_(control|ws_[0-9a-f_]{36})$ ]]; then
    echo "Refusing unexpected database name: ${database_name}" >&2
    exit 65
  fi
  echo "Backing up ${database_name}..."
  docker compose exec -T postgres pg_dump \
    --format=custom --no-owner --no-privileges \
    -U "${postgres_user}" -d "${database_name}" \
    >"${backup_dir}/${database_name}.dump"
done

(
  cd -- "${backup_dir}"
  "${checksum_command[@]}" ./*.dump globals.sql >SHA256SUMS
)
chmod 600 "${backup_dir}"/*

echo "Created ${backup_dir}."
echo "These archives are not encrypted. Encrypt and copy them off this VPS now."
