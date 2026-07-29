#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"

usage() {
  echo "Usage: $0 WORKSPACE_UUID" >&2
  echo "Creates and migrates an isolated database, then activates its control-plane route." >&2
}

if [[ $# -ne 1 ]]; then
  usage
  exit 64
fi

workspace_id="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
if [[ ! "${workspace_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "WORKSPACE_UUID must be a canonical UUID." >&2
  exit 64
fi

if [[ ! -f "${PROJECT_DIR}/.env" ]]; then
  echo "Missing ${PROJECT_DIR}/.env; run scripts/bootstrap.sh first." >&2
  exit 66
fi

database_suffix="${workspace_id//-/_}"
database_name="nuvopic_ws_${database_suffix}"
database_role="nuvopic_ws_${workspace_id//-/}"
database_password="$(openssl rand -hex 32)"

cd -- "${PROJECT_DIR}"

postgres_user="$(docker compose exec -T postgres printenv POSTGRES_USER)"
control_database="$(docker compose exec -T postgres printenv POSTGRES_DB)"

workspace_exists="$(
  docker compose exec -T postgres psql \
    --set=ON_ERROR_STOP=1 \
    --tuples-only --no-align \
    --set=workspace_id="${workspace_id}" \
    -U "${postgres_user}" -d "${control_database}" \
    -c "SELECT count(*) FROM workspace WHERE id = :'workspace_id';"
)"
if [[ "${workspace_exists}" != "1" ]]; then
  echo "Workspace ${workspace_id} does not exist in the control plane." >&2
  echo "Have the owner sign in once, then retry." >&2
  exit 65
fi

route_conflicts="$(
  docker compose exec -T postgres psql \
    --set=ON_ERROR_STOP=1 \
    --tuples-only --no-align \
    --set=database_marker="/${database_name}" \
    --set=workspace_id="${workspace_id}" \
    -U "${postgres_user}" -d "${control_database}" \
    -c "SELECT count(*) FROM workspace WHERE id <> :'workspace_id' AND split_part(database_url, '?', 1) LIKE '%' || :'database_marker';"
)"
if [[ "${route_conflicts}" != "0" ]]; then
  echo "Database route ${database_name} is already assigned to another workspace." >&2
  exit 65
fi

database_exists="$(
  docker compose exec -T postgres psql \
    --set=ON_ERROR_STOP=1 \
    --tuples-only --no-align \
    --set=database_name="${database_name}" \
    -U "${postgres_user}" -d postgres \
    -c "SELECT count(*) FROM pg_database WHERE datname = :'database_name';"
)"
if [[ "${database_exists}" != "0" ]]; then
  echo "Refusing to reuse existing database ${database_name}." >&2
  exit 65
fi

docker compose exec -T postgres psql \
  --set=ON_ERROR_STOP=1 \
  --set=database_role="${database_role}" \
  --set=database_password="${database_password}" \
  --set=database_name="${database_name}" \
  -U "${postgres_user}" -d postgres <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'database_role', :'database_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'database_role') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'database_role', :'database_password') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'database_name', :'database_role') \gexec
SQL

workspace_database_url="postgres://${database_role}:${database_password}@postgres:5432/${database_name}"

if ! WORKSPACE_DATABASE_URL="${workspace_database_url}" \
  "${SCRIPT_DIR}/migrate-workspace.sh"; then
  echo "Migration failed; the workspace route was not changed." >&2
  echo "Database ${database_name} and role ${database_role} require operator cleanup." >&2
  exit 70
fi

docker compose exec -T postgres psql \
  --set=ON_ERROR_STOP=1 \
  --set=workspace_id="${workspace_id}" \
  --set=database_url="${workspace_database_url}" \
  -U "${postgres_user}" -d "${control_database}" \
  -c "UPDATE workspace SET database_url = :'database_url', database_ssl = false, status = 'active' WHERE id = :'workspace_id';"

unset database_password workspace_database_url
echo "Provisioned ${database_name} with dedicated role ${database_role}."
echo "The credential was saved only in the protected control database route."
