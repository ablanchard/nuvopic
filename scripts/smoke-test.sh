#!/usr/bin/env bash
set -Eeuo pipefail

origin="${NUVOPIC_ORIGIN:-https://nuvopic.app}"
origin="${origin%/}"

if [[ $# -ne 0 ]]; then
  echo "Usage: NUVOPIC_ORIGIN=https://nuvopic.app $0" >&2
  exit 64
fi
if [[ ! "${origin}" =~ ^https?://[^/]+$ ]]; then
  echo "NUVOPIC_ORIGIN must contain only an http(s) origin." >&2
  exit 64
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required." >&2
  exit 69
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/nuvopic-smoke.XXXXXX")"
cleanup() {
  rm -rf -- "${tmp_dir}"
}
trap cleanup EXIT

request() {
  local path="$1"
  local output="$2"
  curl --silent --show-error --fail-with-body \
    --connect-timeout 10 --max-time 30 \
    "${origin}${path}" -o "${output}"
}

echo "Checking data-plane health..."
request "/health" "${tmp_dir}/health.json"
if ! grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' "${tmp_dir}/health.json"; then
  echo "Unexpected /health response." >&2
  exit 1
fi

echo "Checking public runtime configuration..."
request "/api/v1/runtime" "${tmp_dir}/runtime.json"

echo "Checking control-plane JWKS..."
request "/.well-known/jwks.json" "${tmp_dir}/jwks.json"
if ! grep -q '"keys"[[:space:]]*:' "${tmp_dir}/jwks.json"; then
  echo "JWKS response does not contain a keys member." >&2
  exit 1
fi

echo "Checking control-plane profile routing..."
profile_status="$(
  curl --silent --show-error --output /dev/null \
    --connect-timeout 10 --max-time 30 \
    --write-out '%{http_code}' "${origin}/profile"
)"
if [[ "${profile_status}" != "200" && "${profile_status}" != "302" && "${profile_status}" != "303" ]]; then
  echo "Unexpected /profile status: ${profile_status}" >&2
  exit 1
fi

echo "Checking that the workspace directory is not public..."
internal_status="$(
  curl --silent --show-error --output /dev/null \
    --connect-timeout 10 --max-time 30 \
    --write-out '%{http_code}' \
    "${origin}/internal/workspaces/resolve?workspaceId=00000000-0000-0000-0000-000000000000"
)"
if [[ "${internal_status}" != "404" ]]; then
  echo "Public internal route returned ${internal_status}, expected 404." >&2
  exit 1
fi

if [[ "${origin}" == https://* ]]; then
  http_origin="http://${origin#https://}"
  redirect_url="$(
    curl --silent --show-error --output /dev/null \
      --connect-timeout 10 --max-time 30 \
      --write-out '%{redirect_url}' "${http_origin}/health"
  )"
  if [[ "${redirect_url}" != https://* ]]; then
    echo "HTTP did not redirect to HTTPS." >&2
    exit 1
  fi
fi

echo "Smoke tests passed for ${origin}."
