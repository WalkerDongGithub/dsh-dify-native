#!/usr/bin/env bash
# End-to-end verification against four real, unmodified Dify workflows.
# Requires: python3 with pyyaml+jinja2, LLM credentials for the z.ai route.
# Usage: bash tests/e2e.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
DSL="$REPO/../dsl"
OUT="$REPO/../runs"
mkdir -p "$OUT/ir"
export PYTHONPATH="$REPO/runtime"
export DIFY_PYLIB="$REPO/runtime/vendor"

run() { python3 -m dify_runtime "$@"; }

echo "== 1/6 json-repair (start -> code -> end, no LLM) =="
run translate "$DSL/json-repair.yml" -o "$OUT/ir/json-repair.ir.json" >/dev/null
run run "$DSL/json-repair.yml" \
  --input '{"llm_string":"{\"name\": \"dify\", \"items\": [1,2,], }"}' \
  --trace "$OUT/json-repair.trace.jsonl" > "$OUT/json-repair.json"
python3 - "$OUT/json-repair.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
assert d["status"]=="succeeded", d
assert d["outputs"]["output"]=='{"name": "dify", "items": [1, 2]}', d["outputs"]
assert d["usage"]["llmCalls"]==0
print("  output:", d["outputs"]["output"], "| nodes:", ",".join(n["status"] for n in d["nodes"].values()))
PY

echo "== 2/6 seo-slug (start -> llm -> end) =="
run translate "$DSL/seo-slug.yml" -o "$OUT/ir/seo-slug.ir.json" >/dev/null
run run "$DSL/seo-slug.yml" \
  --input '{"title":"Build a Dify workflow on a small server"}' \
  --max-tokens 128 --trace "$OUT/seo-slug.trace.jsonl" > "$OUT/seo-slug.json"
python3 - "$OUT/seo-slug.json" <<'PY'
import json,re,sys
d=json.load(open(sys.argv[1]))
assert d["status"]=="succeeded", d
out=d["outputs"]["output"]
assert re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", out), out
assert d["usage"]["llmCalls"]==1
print("  output:", out, "| llmCalls:", d["usage"]["llmCalls"])
PY

echo "== 3/6 translation, country empty (if-else true branch + aggregator) =="
run translate "$DSL/translation.yml" -o "$OUT/ir/translation.ir.json" >/dev/null
run run "$DSL/translation.yml" \
  --input '{"target_lang":"Chinese","source_text":"The quick brown fox jumps over the lazy dog.","source_lang":"English","country":""}' \
  --max-tokens 256 --trace "$OUT/translation-true.trace.jsonl" > "$OUT/translation-true.json"
python3 - "$OUT/translation-true.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
assert d["status"]=="succeeded", d
assert d["outputs"]["output"].strip(), d
ifn=[n for n in d["nodes"].values() if n["type"]=="if-else"][0]
assert ifn["branch"]=="true", ifn
assert d["usage"]["llmCalls"]==3, d["usage"]
print("  branch:", ifn["branch"], "| output:", d["outputs"]["output"][:80], "| llmCalls:", d["usage"]["llmCalls"])
PY

echo "== 4/6 translation, country set (if-else false branch) =="
run run "$DSL/translation.yml" \
  --input '{"target_lang":"Portuguese","source_text":"Good morning, how are you?","source_lang":"English","country":"Brazil"}' \
  --max-tokens 256 --trace "$OUT/translation-false.trace.jsonl" > "$OUT/translation-false.json"
python3 - "$OUT/translation-false.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
assert d["status"]=="succeeded", d
ifn=[n for n in d["nodes"].values() if n["type"]=="if-else"][0]
assert ifn["branch"]=="false", ifn
skipped=[n for n in d["nodes"].values() if n["status"]=="skipped"]
assert skipped, "expected the untaken branch node to be recorded as skipped"
print("  branch:", ifn["branch"], "| output:", d["outputs"]["output"][:80], "| skipped:", len(skipped))
PY

echo "== 5/6 form-demo (template-transform / answer / assigner) =="
run translate "$DSL/form-demo.yml" -o "$OUT/ir/form-demo.ir.json" >/dev/null
run run "$DSL/form-demo.yml" \
  --input '{"sys.query":"{\"username\":\"guest\",\"password\":\"x\"}"}' \
  --trace "$OUT/form-demo.trace.jsonl" > "$OUT/form-demo.json"
python3 - "$OUT/form-demo.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
assert d["status"]=="succeeded", d
assert any("<form" in a for a in d["answers"]), d["answers"]
assert any(n["type"]=="template-transform" and n["status"]=="success" for n in d["nodes"].values())
print("  answers:", len(d["answers"]), "| template node: success")
PY

echo "== 6/6 unsupported nodes are rejected up front =="
set +e
run run "$DSL/lang-consistency.yml" --input '{}' > "$OUT/lang-consistency.json"
CODE=$?
set -e
python3 - "$OUT/lang-consistency.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
assert d["status"]=="rejected", d
assert d["nodes"]=={}
assert "tool" in d["error"]
print("  rejected before execution:", d["error"][:120])
PY
[ "$CODE" -eq 2 ] || { echo "expected exit code 2, got $CODE"; exit 1; }

echo
echo "E2E OK — 4 workflows executed, 1 unsupported workflow explicitly rejected."
