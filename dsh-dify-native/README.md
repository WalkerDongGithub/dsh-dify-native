# dsh-dify-native

Run a real Dify workflow `.yml` on the harness's own capabilities — no
self-written scheduler, executor, sandbox, or LLM client.

```
Dify .yml
  → lib/dsl.js      parse workflow.graph, order nodes, compile an orchestration script
  → ctx.workflowEngine  existing dsh loop (deployed: @deepseek-ai/dsh-workflow-ptc)
  → ctx.subagents   existing provider seam, registered as `dify-node`
  → ctx.llm.stream  existing provider-neutral LLM service (DSL model → usable route)
  → ctx.sandbox.confine  existing landlock/bwrap confinement for code nodes
```

## Tools

- `dify_native_inspect({ path })` — parse + compile preview, unsupported nodes listed.
- `dify_native_services()` — engine/sandbox/subagent providers, LLM providers,
  models, and the profile's default route.
- `dify_native_sandbox_probe({ workspaceRoot? })` — proves write and read-only denial in the live harness.
- `dify_native_run({ path, inputs, timeout?, tracePath? })` — compile and execute;
  returns the workflow's final `outputs` plus one record per executed node.

## Supported graph (v2)

An acyclic graph from one `start` to one `end` with:

| node | execution |
| --- | --- |
| `llm` | `ctx.llm.stream`; prompt `{{#node.var#}}` refs resolved before the call |
| `code` | `ctx.sandbox.confine` + Python trampoline (`python3` only) |
| `if-else` | condition evaluation in the provider; chosen branch id drives edge guards |
| `variable-aggregator` | compiled to plain JS (first non-null branch value), no agent call |
| `template-transform` | compiled to plain JS string concatenation, no agent call |

Branching compiles to ordinary `if` blocks with an activation guard per node; an
inactive node leaves its result variable `undefined`, so joins need no runtime
scheduler. `answer`, `assigner`, `tool`, `question-classifier`,
`knowledge-retrieval`, iteration, and chat-mode nodes are rejected before
execution with the offending node ids — never silently skipped.

## LLM routing

The DSL's `model.provider`/`model.name` is a *request*. The provider picks a
route the mounted `llm` service can actually serve, in this order:

1. `DIFY_LLM_PROVIDER` + `DIFY_LLM_MODEL` when set;
2. the DSL route, when that provider is registered;
3. the profile's default model (`agentDefaultModel`).

Every LLM node's record carries `meta.provider`, `meta.model`,
`meta.requested` (the DSL's ask) and `meta.routeSource`. This is how the
bundled `translation.yml` asks for `deepseek/deepseek-chat` and still runs on
this box's `zai/glm-4.5-air` without an LLM adapter subprocess.

## Why a subagent provider for nodes

The workflow engines expose exactly one host hook to a script: `agent(prompt,
opts)`. `opts.provider` selects an **LLM route**, not a subagent provider; the
subagent provider is fixed for the whole run. So the runtime extension point is
the run's provider: `dify-node` receives one JSON node request per `agent()`
call and dispatches by node kind. This reuses the existing loop, cancellation,
concurrency caps, and result materialization without modifying any dsh package.

## Reproduce

Offline compiler + branch-logic checks (no harness, no model calls):

```sh
cd /home/walker/dify-test/dsh-dify-native
node tests/dsl.test.mjs
node tests/translation-script.test.mjs
```

Offline end-to-end in the rc.7 source tree (imports
`@deepseek-ai/dsh-workflow-worker-thread` directly):

```sh
cd /home/walker/dify-test/harness-spikes
node spike-b1-worker-thread.mjs   # imported loop, pure-JS orchestration
node spike-c-dify-offline.mjs     # Dify .yml → loop → provider → ctx.sandbox
```

Live harness (deployed dsh 0.2.0-rc.2, `difynative` profile):

```sh
/home/walker/node/bin/dsh --profile difynative - < /tmp/dify-run-translation-true2.txt
```

The run record is written to `runs/native-*.json` when `tracePath` is given.
