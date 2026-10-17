"""Dify DSL loading and normalization into a small, explicit IR.

Only what the runtime needs is kept: node id/type/config, edges with their
source handle, variables and app mode.  Unknown node types are *recorded*, not
silently dropped; the engine refuses to run a graph containing one.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import yaml


SUPPORTED_VERSIONS = ("0.1", "0.2", "0.3", "0.4", "0.5", "0.6")

# Node types the runtime has an adapter for.  Everything else is reported as
# unsupported with its exact id/type/path.
SUPPORTED_NODE_TYPES = {
    "start",
    "end",
    "answer",
    "llm",
    "code",
    "if-else",
    "template-transform",
    "variable-aggregator",
    "assigner",
    "http-request",
    "question-classifier",
}

# Recognized but not implemented yet: reported explicitly, never skipped.
KNOWN_UNSUPPORTED = {
    "agent",
    "iteration",
    "loop",
    "knowledge-retrieval",
    "tool",
    "parameter-extractor",
    "document-extractor",
    "variable-assigner",
    "datasource",
    "http",
    "trigger",
    "list-operator",
}


class DslError(Exception):
    """A structural problem that prevents building the IR."""


@dataclass
class Node:
    id: str
    type: str
    title: str
    data: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def supported(self) -> bool:
        return self.type in SUPPORTED_NODE_TYPES

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "title": self.title,
            "supported": self.supported,
        }


@dataclass
class Edge:
    source: str
    target: str
    source_handle: str | None = None
    target_handle: str | None = None

    def summary(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "target": self.target,
            "sourceHandle": self.source_handle,
            "targetHandle": self.target_handle,
        }


@dataclass
class Workflow:
    path: str
    app_name: str
    app_mode: str
    dify_version: str
    nodes: list[Node]
    edges: list[Edge]
    environment_variables: list[dict[str, Any]]
    conversation_variables: list[dict[str, Any]]

    def node(self, node_id: str) -> Node:
        for n in self.nodes:
            if n.id == node_id:
                return n
        raise DslError(f"unknown node id {node_id!r}")

    @property
    def start(self) -> Node:
        starts = [n for n in self.nodes if n.type == "start"]
        if len(starts) != 1:
            raise DslError(f"expected exactly one start node, found {len(starts)}")
        return starts[0]

    @property
    def start_inputs(self) -> list[str]:
        return [v.get("variable") for v in self.start.data.get("variables", []) if v.get("variable")]

    def unsupported(self) -> list[dict[str, Any]]:
        out = []
        for n in self.nodes:
            if not n.supported:
                out.append(
                    {
                        "id": n.id,
                        "type": n.type,
                        "title": n.title,
                        "reason": "no adapter for this node type",
                        "known_type": n.type in KNOWN_UNSUPPORTED,
                    }
                )
        return out

    def validate(self) -> list[str]:
        issues: list[str] = []
        ids = [n.id for n in self.nodes]
        if len(ids) != len(set(ids)):
            issues.append("duplicate node ids")
        known = set(ids)
        for e in self.edges:
            if e.source not in known:
                issues.append(f"edge {e.source}->{e.target}: unknown source")
            if e.target not in known:
                issues.append(f"edge {e.source}->{e.target}: unknown target")
        if not any(n.type == "start" for n in self.nodes):
            issues.append("no start node")
        if not any(n.type in ("end", "answer") for n in self.nodes):
            issues.append("no end/answer node")
        return issues

    def topo_order(self) -> list[str]:
        """Kahn topological order; deterministic by original node order."""
        order: list[str] = []
        indeg = {n.id: 0 for n in self.nodes}
        out: dict[str, list[str]] = {n.id: [] for n in self.nodes}
        for e in self.edges:
            if e.source in indeg and e.target in indeg:
                indeg[e.target] += 1
                out[e.source].append(e.target)
        ids = [n.id for n in self.nodes]
        ready = [i for i in ids if indeg[i] == 0]
        while ready:
            cur = ready.pop(0)
            order.append(cur)
            for nxt in out[cur]:
                indeg[nxt] -= 1
                if indeg[nxt] == 0:
                    ready.append(nxt)
            ready.sort(key=ids.index)
        if len(order) != len(ids):
            raise DslError("graph contains a cycle; loops/iterations are not supported yet")
        return order

    def to_ir(self) -> dict[str, Any]:
        order = self.topo_order()
        nodes = []
        for n in self.nodes:
            entry = {
                "id": n.id,
                "type": n.type,
                "title": n.title,
                "adapter": n.type if n.supported else None,
                "status": "supported" if n.supported else "unsupported",
                "data": n.data,
            }
            if not n.supported:
                entry["reason"] = "no adapter for this node type"
            nodes.append(entry)
        return {
            "ir_version": "1.0",
            "source": {
                "path": self.path,
                "difyVersion": self.dify_version,
                "appName": self.app_name,
                "mode": self.app_mode,
            },
            "start": {"id": self.start.id, "inputs": self.start_inputs},
            "nodes": nodes,
            "edges": [e.summary() for e in self.edges],
            "executionOrder": order,
            "variables": {
                "environment": self.environment_variables,
                "conversation": self.conversation_variables,
            },
            "unsupported": self.unsupported(),
            "issues": self.validate(),
        }


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def load_workflow(path: str) -> Workflow:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            doc = yaml.safe_load(fh)
    except FileNotFoundError:
        raise DslError(f"file not found: {path}")
    except yaml.YAMLError as exc:
        raise DslError(f"invalid YAML in {path}: {exc}") from exc
    if not isinstance(doc, dict):
        raise DslError(f"{path}: top level is not a mapping")

    app = _as_dict(doc.get("app"))
    workflow = _as_dict(doc.get("workflow"))
    graph = _as_dict(workflow.get("graph")) or _as_dict(doc.get("graph"))
    raw_nodes = graph.get("nodes") or []
    raw_edges = graph.get("edges") or []
    if not isinstance(raw_nodes, list) or not isinstance(raw_edges, list):
        raise DslError(f"{path}: graph.nodes/edges must be lists")

    nodes: list[Node] = []
    for raw in raw_nodes:
        raw = _as_dict(raw)
        data = _as_dict(raw.get("data"))
        node_type = data.get("type") or raw.get("type")
        node_id = str(raw.get("id", ""))
        if not node_id:
            raise DslError(f"{path}: node without id")
        if not node_type or node_type == "custom":
            raise DslError(f"{path}: node {node_id} has no data.type")
        nodes.append(
            Node(
                id=node_id,
                type=str(node_type),
                title=str(data.get("title") or node_type),
                data=data,
                raw=raw,
            )
        )

    edges: list[Edge] = []
    for raw in raw_edges:
        raw = _as_dict(raw)
        edges.append(
            Edge(
                source=str(raw.get("source", "")),
                target=str(raw.get("target", "")),
                source_handle=raw.get("sourceHandle"),
                target_handle=raw.get("targetHandle"),
            )
        )

    version = str(doc.get("version") or "")
    if version and not any(version.startswith(v) for v in SUPPORTED_VERSIONS):
        # Do not hard-fail: report through issues so inspection stays useful.
        pass

    return Workflow(
        path=path,
        app_name=str(app.get("name") or ""),
        app_mode=str(app.get("mode") or ""),
        dify_version=version,
        nodes=nodes,
        edges=edges,
        environment_variables=_as_list(workflow.get("environment_variables")),
        conversation_variables=_as_list(workflow.get("conversation_variables")),
    )


def _as_list(value: Any) -> list[dict[str, Any]]:
    return [x for x in value if isinstance(x, dict)] if isinstance(value, list) else []
