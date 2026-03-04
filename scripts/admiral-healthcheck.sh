#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   admiral-healthcheck.sh [url]
# Example:
#   admiral-healthcheck.sh http://127.0.0.1:3031/api/health

HEALTH_URL="${1:-http://127.0.0.1:3031/api/health}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-5}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl not found" >&2
  systemctl restart admiral
  exit 1
fi

if ! curl --silent --show-error --fail --max-time "${TIMEOUT_SECONDS}" "${HEALTH_URL}" >/dev/null; then
  echo "Healthcheck failed for ${HEALTH_URL}, restarting admiral service..." >&2
  systemctl restart admiral
  exit 1
fi

exit 0
