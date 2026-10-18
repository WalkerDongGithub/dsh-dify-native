#!/usr/bin/env bash
# Install one optional Python dependency set into a fresh plugin-local directory.
# Usage: install-vendor.sh <events|extraction>
# Refuses to overwrite an existing target: pick a new directory or a Python env.
set -euo pipefail
cd "$(dirname "$0")/.."

group="${1:?usage: install-vendor.sh <events|extraction>}"
var="DIFY_$(echo "$group" | tr '[:lower:]' '[:upper:]')_VENDOR"
target="${!var:-$PWD/.vendor-$group}"
if [[ -e "$target" ]]; then
  echo "Target exists: $target. Set a NEW $var directory; existing contents are never overwritten." >&2
  exit 1
fi
"${DIFY_RUNTIME_PYTHON:-python3}" -m pip install --target "$target" -r "requirements-$group.txt"
