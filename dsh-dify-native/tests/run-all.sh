#!/usr/bin/env bash
# Run the whole offline test suite (no harness, no network, no model calls).
set -euo pipefail
cd "$(dirname "$0")/.."

for test in \
  tests/dsl.test.mjs \
  tests/nodes.test.mjs \
  tests/nodes-new.test.mjs \
  tests/coverage.test.mjs \
  tests/provider.test.mjs \
  tests/translation-script.test.mjs
do
  echo "== $test"
  node "$test"
done
echo "ALL TESTS OK"
