#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Refuse to overwrite an existing installation; use a new target or Python env.
target="${DIFY_EXTRACTION_VENDOR:-$PWD/.vendor-extraction}"
if [[ -e "$target" ]]; then
  echo "Target exists: $target. Choose a NEW DIFY_EXTRACTION_VENDOR directory; existing contents are never overwritten." >&2
  exit 1
fi
"${DIFY_RUNTIME_PYTHON:-python3}" -m pip install --target "$target" -r requirements-extraction.txt
