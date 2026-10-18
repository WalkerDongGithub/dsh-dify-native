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
  tests/engine-nested.test.mjs \
  tests/engine-http-tls.test.mjs \
  tests/engine-extraction.test.mjs \
  tests/engine-extraction-differential.test.mjs \
  tests/engine-datasource.test.mjs \
  tests/engine-agent-loop.test.mjs \
  tests/engine-conversation.test.mjs \
  tests/engine-events.test.mjs \
  tests/engine-schedule.test.mjs \
  tests/engine-human-wait.test.mjs \
  tests/engine-http-follow.test.mjs \
  tests/engine-human-form.test.mjs \
  tests/engine-schedule-visual.test.mjs \
  tests/engine-extraction-routing.test.mjs \
  tests/package-deployment.test.mjs \
  tests/engine-http-timeout.test.mjs \
  tests/research-samples.test.mjs \
  tests/tool-output-json.test.mjs \
  tests/human-inspect.test.mjs \
  tests/start-defaults.test.mjs \
  tests/template-mixed.test.mjs
do
  echo "== $test"
  node "$test"
done
echo "ALL TESTS OK"
