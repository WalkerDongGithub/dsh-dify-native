#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
target="${DIFY_EVENTS_VENDOR:-$PWD/.vendor-events}"
if [[ -e "$target" ]]; then
  echo "Target exists: $target; select a NEW DIFY_EVENTS_VENDOR directory." >&2
  exit 1
fi
"${DIFY_RUNTIME_PYTHON:-python3}" -m pip install --target "$target" -r requirements-events.txt
