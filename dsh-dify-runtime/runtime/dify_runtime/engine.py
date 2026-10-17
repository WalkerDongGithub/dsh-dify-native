"""Deterministic DAG scheduler for a normalized Dify workflow.

The scheduler — not the model — decides which node runs next and which edge is
taken.  Conditional nodes return a branch id; this module activates only the
edges whose ``sourceHandle`` equals that id.  A node runs when every
predecessor is resolved and at least one incoming edge is active; it is marked
``skipped`` when all incoming edges are inactive.  Unsupported nodes are
rejected during preflight, before any node executes.
"""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .dsl import Workflow
from .llm import LlmClient, LlmError
from .nodes import ExecContext, NodeError, UnsupportedNode, execute
from .refs import Scope


@dataclass
class RunOptions:
    max_steps: int = 200
    node_timeout_s: float = 30.0
    trace_path: str | None = None
    allow_unsupported: bool = False
    llm: LlmClient | None = None
    use_llm: bool = True


@dataclass
class RunResult:
    run_id: str
    status: str = "running"  # running | succeeded | failed | rejected
    outputs: dict[str, Any] = field(default_factory=dict)
    answers: list[str] = field(default_factory=list)
    nodes: dict[str, dict[str, Any]] = field(default_factory=dict)
    trace: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    started_at: float = 0.0
    finished_at: float = 0.0
    usage: dict[str, Any] = field(default_factory=dict)

    def to_dict(self, include_trace: bool = True) -> dict[str, Any]:
        out = {
            "runId": self.run_id,
            "status": self.status,
            "outputs": self.outputs,
            "answers": self.answers,
            "nodes": self.nodes,
            "error": self.error,
            "durationMs": round((self.finished_at - self.started_at) * 1000, 1),
            "usage": self.usage,
        }
        if include_trace:
            out["trace"] = self.trace
        return out


class PreflightError(Exception):
    def __init__(self, message: str, issues: list[dict[str, Any]] | None = None) -> None:
        super().__init__(message)
        self.issues = issues or []


def preflight(wf: Workflow, inputs: dict[str, Any], options: RunOptions) -> None:
    issues: list[dict[str, Any]] = []
    for issue in wf.validate():
        issues.append({"kind": "graph", "detail": issue})
    for item in wf.unsupported():
        issues.append({"kind": "unsupported-node", **item})
    if issues and not options.allow_unsupported:
        raise PreflightError(
            "workflow rejected before execution: " + "; ".join(f"{i.get('kind')}: {i.get('detail') or i.get('type')} ({i.get('id')})" for i in issues),
            issues,
        )
    start_inputs = wf.start_inputs
    missing = [name for name in start_inputs if inputs.get(name) is None]
    required = {
        str(v.get("variable"))
        for v in wf.start.data.get("variables", [])
        if v.get("variable") and v.get("required")
    }
    missing_required = [name for name in missing if name in required]
    if missing_required:
        raise PreflightError(
            f"missing required start input(s): {', '.join(missing_required)}",
            [{"kind": "missing-input", "detail": name} for name in missing_required],
        )


def _preview(value: Any, limit: int = 240) -> Any:
    if isinstance(value, str) and len(value) > limit:
        return value[:limit] + f"... <{len(value)} chars>"
    if isinstance(value, (list, dict)):
        text = json.dumps(value, ensure_ascii=False)
        return text[:limit] + ("..." if len(text) > limit else "")
    return value


class Engine:
    def run(self, wf: Workflow, inputs: dict[str, Any], options: RunOptions | None = None) -> RunResult:
        options = options or RunOptions()
        started = time.time()
        run_id = f"dify-{int(started)}-{uuid.uuid4().hex[:8]}"
        result = RunResult(run_id=run_id, status="running", started_at=started)

        try:
            preflight(wf, inputs, options)
        except PreflightError as exc:
            result.status = "rejected"
            result.error = str(exc)
            result.finished_at = time.time()
            result.trace.append({"event": "preflight-rejected", "error": str(exc), "issues": exc.issues})
            self._write_trace(options.trace_path, result.trace)
            return result

        scope = Scope()
        for var in wf.environment_variables:
            if var.get("name"):
                scope.env[str(var["name"])] = var.get("value")
        for var in wf.conversation_variables:
            if var.get("name"):
                scope.conversation[str(var["name"])] = var.get("value")

        llm = options.llm
        if llm is None and options.use_llm:
            try:
                llm = LlmClient()
            except LlmError as exc:
                result.status = "failed"
                result.error = str(exc)
                result.finished_at = time.time()
                result.trace.append({"event": "llm-init-failed", "error": str(exc)})
                self._write_trace(options.trace_path, result.trace)
                return result

        ctx = ExecContext(scope=scope, llm=llm, timeout_s=options.node_timeout_s)

        nodes = {n.id: n for n in wf.nodes}
        topo = wf.topo_order()
        incoming: dict[str, list[int]] = {n.id: [] for n in wf.nodes}
        outgoing: dict[str, list[int]] = {n.id: [] for n in wf.nodes}
        for idx, edge in enumerate(wf.edges):
            if edge.target in incoming:
                incoming[edge.target].append(idx)
            if edge.source in outgoing:
                outgoing[edge.source].append(idx)

        status: dict[str, str] = {n.id: "pending" for n in wf.nodes}
        active_edges: set[int] = set()
        resolved: set[str] = set()
        end_outputs: dict[str, Any] = {}
        answers: list[str] = []

        def log(entry: dict[str, Any]) -> None:
            result.trace.append(entry)

        log({"event": "run-start", "runId": run_id, "workflow": wf.app_name, "mode": wf.app_mode, "order": topo})

        steps = 0
        while True:
            steps += 1
            if steps > options.max_steps:
                result.status = "failed"
                result.error = f"step limit {options.max_steps} exceeded"
                break

            # Resolve nodes whose predecessors are all done but have no active
            # incoming edge: they are on an untaken branch.
            changed = True
            while changed:
                changed = False
                for node_id in topo:
                    if status[node_id] != "pending":
                        continue
                    preds = {wf.edges[i].source for i in incoming[node_id]}
                    if preds <= resolved and not any(i in active_edges for i in incoming[node_id]) and preds:
                        status[node_id] = "skipped"
                        resolved.add(node_id)
                        changed = True
                        skipped = {"node": node_id, "type": nodes[node_id].type, "title": nodes[node_id].title, "status": "skipped", "reason": "inactive incoming branch"}
                        result.nodes[node_id] = skipped
                        log({"event": "node-skipped", **skipped})

            ready: list[str] = []
            for node_id in topo:
                if status[node_id] != "pending":
                    continue
                preds = {wf.edges[i].source for i in incoming[node_id]}
                if not preds <= resolved:
                    continue
                if incoming[node_id] and not any(i in active_edges for i in incoming[node_id]):
                    continue
                ready.append(node_id)
            if not ready:
                break

            node_id = ready[0]
            node = nodes[node_id]
            status[node_id] = "running"
            t0 = time.time()
            node_entry: dict[str, Any] = {
                "node": node_id,
                "type": node.type,
                "title": node.title,
                "status": "running",
            }
            try:
                node_result = execute(node, ctx, inputs)
                status[node_id] = "success"
                if node_result.outputs:
                    scope.set_node(node_id, node_result.outputs)
                node_entry["status"] = "success"
                node_entry["branch"] = node_result.branch
                node_entry["outputs"] = {k: _preview(v) for k, v in node_result.outputs.items()}
                if node_result.meta:
                    node_entry["meta"] = node_result.meta
                if node.type == "end":
                    end_outputs.update(node_result.outputs)
                if node.type == "answer":
                    answers.append(str(node_result.outputs.get("answer", "")))
                chosen = node_result.branch
                for idx in outgoing[node_id]:
                    edge = wf.edges[idx]
                    if chosen is None or edge.source_handle is None or str(edge.source_handle) == str(chosen):
                        active_edges.add(idx)
                node_entry["activeEdges"] = [
                    {"source": wf.edges[i].source, "target": wf.edges[i].target, "sourceHandle": wf.edges[i].source_handle}
                    for i in outgoing[node_id]
                    if i in active_edges
                ]
            except UnsupportedNode as exc:
                status[node_id] = "failed"
                node_entry["status"] = "failed"
                node_entry["error"] = str(exc)
                result.status = "failed"
                result.error = str(exc)
                result.nodes[node_id] = node_entry
                result.trace.append(node_entry)
                break
            except (NodeError, LlmError) as exc:
                status[node_id] = "failed"
                node_entry["status"] = "failed"
                node_entry["error"] = str(exc)
                strategy = str(node.data.get("error_strategy") or "")
                if strategy in ("continue-on-error", "default-value"):
                    defaults = {}
                    for item in node.data.get("default_value") or []:
                        if isinstance(item, dict) and item.get("key") is not None:
                            defaults[str(item["key"])] = item.get("value")
                    scope.set_node(node_id, defaults)
                    status[node_id] = "success"
                    node_entry["status"] = "recovered"
                    node_entry["outputs"] = defaults
                    log(node_entry)
                    resolved.add(node_id)
                    for idx in outgoing[node_id]:
                        active_edges.add(idx)
                    result.nodes[node_id] = node_entry
                    continue
                result.status = "failed"
                result.error = str(exc)
                result.nodes[node_id] = node_entry
                result.trace.append(node_entry)
                break

            node_entry["durationMs"] = round((time.time() - t0) * 1000, 1)
            result.nodes[node_id] = node_entry
            log(node_entry)
            resolved.add(node_id)

        if result.status == "running":
            result.status = "succeeded"
        result.outputs = end_outputs
        result.answers = answers
        result.finished_at = time.time()
        usage = {"llmCalls": sum(1 for e in result.trace if e.get("type") == "llm" and e.get("status") == "success")}
        result.usage = usage
        log(
            {
                "event": "run-finish",
                "status": result.status,
                "durationMs": round((result.finished_at - result.started_at) * 1000, 1),
            }
        )
        self._write_trace(options.trace_path, result.trace)
        return result

    @staticmethod
    def _write_trace(path: str | None, trace: list[dict[str, Any]]) -> None:
        if not path:
            return
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("w", encoding="utf-8") as fh:
            for entry in trace:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
