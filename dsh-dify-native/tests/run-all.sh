#!/usr/bin/env bash
# Run unit tests and the installed-harness E2E suite (no model API calls).
set -euo pipefail
cd "$(dirname "$0")/.."

for test in \
  tests/dsl.test.mjs \
  tests/nodes.test.mjs \
  tests/nodes-new.test.mjs \
  tests/control-semantics.test.mjs \
  tests/coverage.test.mjs \
  tests/diagnostics.test.mjs \
  tests/template-jinja.test.mjs \
  tests/session-memory.test.mjs \
  tests/sys-vars.test.mjs \
  tests/code-file-input.test.mjs \
  tests/provider.test.mjs \
  tests/tool-contracts.test.mjs \
  tests/tool-node.test.mjs \
  tests/structured-output.test.mjs \
  tests/translation-script.test.mjs \
  tests/container-scope.test.mjs \
  tests/engine-e2e.test.mjs \
  tests/engine-nested.test.mjs
do
  echo "== $test"
  node "$test"
done
echo "ALL TESTS OK"
