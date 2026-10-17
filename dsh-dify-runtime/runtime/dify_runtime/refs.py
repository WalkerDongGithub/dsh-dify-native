"""Variable resolution and Dify/Jinja rendering.

Dify has two distinct template dialects and they must not be mixed:

* prompt / answer text: ``{{#<node-id>.<variable>#}}`` references, replaced
  against the variable pool (no Jinja control flow);
* template-transform: real Jinja2 with named variables declared by the node.

Both are implemented here; the Jinja path uses jinja2 itself rather than a
string substitution lookalike.
"""
from __future__ import annotations

import json
import re
from typing import Any

from jinja2 import Environment, StrictUndefined

REF_RE = re.compile(r"\{\{#([^#{}]+)#\}\}")
SEGMENT_RE = re.compile(r"([^.\[\]]+)|\[(\d+)\]")


class RefError(Exception):
    pass


def _split_selector(selector: str) -> list[Any]:
    out: list[Any] = []
    for name, index in SEGMENT_RE.findall(selector):
        out.append(name if name else int(index))
    return out


class Scope:
    """The Dify variable pool: node outputs plus sys/conversation/env."""

    def __init__(self) -> None:
        self.nodes: dict[str, dict[str, Any]] = {}
        self.sys: dict[str, Any] = {}
        self.conversation: dict[str, Any] = {}
        self.env: dict[str, Any] = {}

    def set_node(self, node_id: str, values: dict[str, Any]) -> None:
        self.nodes.setdefault(node_id, {}).update(values)

    def has_node(self, node_id: str) -> bool:
        return node_id in self.nodes

    def get(self, selector: list[Any] | str | None, default: Any = None) -> Any:
        if selector is None:
            return default
        parts = _split_selector(selector) if isinstance(selector, str) else list(selector)
        if not parts:
            return default
        head = str(parts[0])
        if head == "sys":
            cur: Any = self.sys
        elif head == "conversation":
            cur = self.conversation
        elif head == "env":
            cur = self.env
        else:
            cur = self.nodes.get(head)
        for part in parts[1:]:
            if cur is None:
                return default
            if isinstance(part, int):
                if not isinstance(cur, (list, tuple)) or part >= len(cur):
                    return default
                cur = cur[part]
            else:
                if not isinstance(cur, dict) or part not in cur:
                    return default
                cur = cur[part]
        return default if cur is None else cur

    def resolve_selector(self, selector: Any, default: Any = None) -> Any:
        if isinstance(selector, str):
            return self.get(selector, default)
        if isinstance(selector, (list, tuple)):
            return self.get(list(selector), default)
        return default

    def as_flat(self) -> dict[str, Any]:
        flat: dict[str, Any] = {}
        for node_id, values in self.nodes.items():
            for key, value in values.items():
                flat[f"{node_id}.{key}"] = value
                flat[f"{node_id}_{key}"] = value
        flat.update(self.sys)
        flat.update(self.conversation)
        return flat


def stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, (list, tuple, dict)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def render_refs(text: str, scope: Scope) -> str:
    """Replace every ``{{#selector#}}`` occurrence in a Dify prompt/answer."""

    def repl(match: re.Match[str]) -> str:
        selector = match.group(1).strip()
        return stringify(scope.resolve_selector(selector, ""))

    return REF_RE.sub(repl, text)


def render_ref_value(text: str, scope: Scope) -> Any:
    """If the whole string is one reference, keep the value's native type."""
    match = REF_RE.fullmatch(text.strip())
    if match:
        return scope.resolve_selector(match.group(1).strip())
    return render_refs(text, scope)


_JINJA = Environment(autoescape=False, undefined=StrictUndefined, keep_trailing_newline=True)


def render_jinja(template: str, variables: dict[str, Any]) -> str:
    try:
        return _JINJA.from_string(template).render(**variables)
    except Exception as exc:  # jinja2 errors are the useful diagnostic here
        raise RefError(f"Jinja render failed: {exc}") from exc


def extract_refs(text: str) -> list[str]:
    return [m.group(1).strip() for m in REF_RE.finditer(text)]
