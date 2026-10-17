"""Adapters for individual Dify node types.

Every adapter is a pure function of (node config, variable pool) plus, for the
LLM/HTTP adapters, an explicit client.  Branch decisions are computed here from
the DSL, never by the language model: the LLM may classify, but the edge taken
is chosen by code.
"""
from __future__ import annotations

import ipaddress
import json
import socket
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any

from .codeexec import CodeError, coerce_outputs, run_code
from .llm import LlmClient, LlmError
from .refs import RefError, Scope, render_jinja, render_ref_value, render_refs, stringify


class NodeError(Exception):
    pass


class UnsupportedNode(NodeError):
    pass


@dataclass
class NodeResult:
    outputs: dict[str, Any] = field(default_factory=dict)
    branch: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class ExecContext:
    scope: Scope
    llm: LlmClient | None
    trace: Any = None
    timeout_s: float = 30.0


def _d(node: Any) -> dict[str, Any]:
    return node.data if hasattr(node, "data") else node


def _selectors(values: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for item in values or []:
        if not isinstance(item, dict):
            continue
        name = item.get("variable")
        if name:
            out[name] = item.get("value_selector")
    return out


def exec_start(node: Any, ctx: ExecContext, inputs: dict[str, Any]) -> NodeResult:
    data = _d(node)
    out: dict[str, Any] = {}
    for spec in data.get("variables") or []:
        name = spec.get("variable")
        if not name:
            continue
        value = inputs.get(name)
        if value is None and spec.get("required") and spec.get("default") is not None:
            value = spec.get("default")
        kind = spec.get("type")
        if value is not None:
            if kind == "number" and isinstance(value, str):
                try:
                    value = float(value) if "." in value else int(value)
                except ValueError:
                    value = value
            elif kind in ("text-input", "paragraph", "select") and not isinstance(value, str):
                value = stringify(value)
            elif kind == "checkbox" and not isinstance(value, list):
                value = [value]
        out[str(name)] = value
    # Dify chat apps expose the user message as sys.query.  For workflow apps
    # there is no such thing, so fall back to the first declared string input.
    query = inputs.get("sys.query", inputs.get("query"))
    if query is None:
        for name in out:
            if isinstance(out[name], str) and out[name].strip():
                query = out[name]
                break
    ctx.scope.sys["query"] = query
    ctx.scope.sys.setdefault("files", [])
    ctx.scope.set_node(node.id, out)
    return NodeResult(outputs=out)


def exec_end(node: Any, ctx: ExecContext, inputs: dict[str, Any]) -> NodeResult:
    data = _d(node)
    out: dict[str, Any] = {}
    for spec in data.get("outputs") or []:
        name = spec.get("variable")
        if not name:
            continue
        out[name] = ctx.scope.resolve_selector(spec.get("value_selector"))
    return NodeResult(outputs=out, meta={"terminal": "end"})


def exec_answer(node: Any, ctx: ExecContext, inputs: dict[str, Any]) -> NodeResult:
    text = render_refs(str(_d(node).get("answer") or ""), ctx.scope)
    return NodeResult(outputs={"answer": text, "text": text})


def exec_llm(node: Any, ctx: ExecContext, inputs: dict[str, Any]) -> NodeResult:
    data = _d(node)
    if ctx.llm is None:
        raise LlmError("no LLM client configured")
    messages: list[dict[str, str]] = []
    for item in data.get("prompt_template") or []:
        if not isinstance(item, dict):
            continue
        role = item.get("role") or "user"
        text = render_refs(str(item.get("text") or ""), ctx.scope)
        messages.append({"role": role, "content": text})
    if not messages:
        raise LlmError(f"llm node {node.id} has an empty prompt_template")
    adapter_note = None
    if all(m["role"] == "system" for m in messages):
        # Some OpenAI-compatible gateways (z.ai among them) reject a request
        # whose only message is a system turn.  Dify permits system-only
        # prompts, so add a neutral user turn without touching the content.
        messages.append({"role": "user", "content": "Follow the system instruction and produce the requested output."})
        adapter_note = "added neutral user turn for system-only prompt"

    model_cfg = data.get("model") or {}
    params = model_cfg.get("completion_params") or {}
    structured = bool(data.get("structured_output_enabled"))
    if structured:
        schema = data.get("structured_output") or {}
        messages.append(
            {
                "role": "user",
                "content": "Return only a JSON object conforming to this schema, no prose:\n"
                + json.dumps(schema, ensure_ascii=False),
            }
        )
    result = ctx.llm.chat(
        provider=str(model_cfg.get("provider") or "deepseek"),
        model=str(model_cfg.get("name") or "deepseek-chat"),
        messages=messages,
        temperature=params.get("temperature"),
        max_tokens=params.get("max_tokens"),
    )
    text = result["text"]
    outputs: dict[str, Any] = {
        "text": text,
        "usage": result.get("usage") or {},
        "reasoning_content": result.get("reasoning"),
    }
    if structured:
        try:
            outputs["structured_output"] = json.loads(text)
        except json.JSONDecodeError as exc:
            raise LlmError(f"llm node {node.id} promised structured output but returned non-JSON: {text[:200]!r}") from exc
    meta = {"model": result.get("modelUsed"), "requested": result.get("modelRequested")}
    if adapter_note:
        meta["adapterNote"] = adapter_note
    return NodeResult(outputs=outputs, meta=meta)


def exec_code(node: Any, ctx: ExecContext, inputs: dict[str, Any]) -> NodeResult:
    data = _d(node)
    language = (data.get("code_language") or "python3").lower()
    if language not in ("python3", "python"):
        raise UnsupportedNode(f"code language {language!r} is not supported (python3 only)")
    bindings = _selectors(data.get("variables"))
    kwargs = {name: ctx.scope.resolve_selector(selector) for name, selector in bindings.items()}
    raw = run_code(str(data.get("code") or ""), kwargs, timeout=ctx.timeout_s)
    outputs = coerce_outputs(raw, data.get("outputs"))
    return NodeResult(outputs=outputs)


def _condition_value(raw: Any, ctx: ExecContext) -> Any:
    if isinstance(raw, str) and "{{#" in raw:
        return render_ref_value(raw, ctx.scope)
    return raw


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def evaluate_condition(cond: dict[str, Any], ctx: ExecContext) -> bool:
    left = ctx.scope.resolve_selector(cond.get("variable_selector"))
    op = str(cond.get("comparison_operator") or "=").strip()
    right = _condition_value(cond.get("value"), ctx)
    var_type = cond.get("varType")

    if op == "empty":
        return left is None or left == "" or left == [] or left == {}
    if op == "not empty":
        return not (left is None or left == "" or left == [] or left == {})
    if op == "null":
        return left is None
    if op == "not null":
        return left is not None

    if op in ("=", "is", "==", "≠", "is not", "!=", ">", "<", "≥", "≤", ">=", "<=", "in", "not in", "contains", "not contains", "start with", "end with"):
        if op in (">", "<", "≥", "≤", ">=", "<=") or var_type == "number":
            a, b = _as_number(left), _as_number(right)
            if a is not None and b is not None:
                if op in ("=", "is", "=="):
                    return a == b
                if op in ("≠", "is not", "!="):
                    return a != b
                if op == ">":
                    return a > b
                if op == "<":
                    return a < b
                if op in ("≥", ">="):
                    return a >= b
                if op in ("≤", "<="):
                    return a <= b
        ls, rs = stringify(left), stringify(right)
        if op in ("=", "is", "=="):
            return ls == rs
        if op in ("≠", "is not", "!="):
            return ls != rs
        if op == "contains":
            return rs in ls
        if op == "not contains":
            return rs not in ls
        if op == "start with":
            return ls.startswith(rs)
        if op == "end with":
            return ls.endswith(rs)
        if op == "in":
            return ls in [stringify(x) for x in (right if isinstance(right, list) else [right])]
        if op == "not in":
            return ls not in [stringify(x) for x in (right if isinstance(right, list) else [right])]
    raise UnsupportedNode(f"comparison operator {op!r} is not supported")


def exec_if_else(node: Any, ctx: ExecContext, inputs: dict[str, Any]) -> NodeResult:
    data = _d(node)
    for case in data.get("cases") or []:
        conditions = case.get("conditions") or []
        logical = str(case.get("logical_operator") or data.get("logical_operator") or "and").lower()
        results = [evaluate_condition(c, ctx) for c in conditions]
        matched = all(results) if logical == "and" else any(results)
        if matched:
            return NodeResult(outputs={"result": True}, branch=str(case.get("case_id") or "true"))
    return NodeResult(outputs={"result": False}, branch=str(data.get("else_case_id") or "false"))


def exec_template(node: Any, ctx: ExecContext, inputs: dict[str, Any]) -> NodeResult:
    data = _d(node)
    bindings = _selectors(data.get("variables"))
    values = {name: ctx.scope.resolve_selector(selector) for name, selector in bindings.items()}
    # A template may also reference node outputs directly with Dify syntax;
    # resolve those first, then run the result through real Jinja2.
    template = render_refs(str(data.get("template") or ""), ctx.scope)
    text = render_jinja(template, values)
    return NodeResult(outputs={"output": text})


def exec_aggregator(node: Any, ctx: ExecContext, inputs: dict[str, Any]) -> NodeResult:
    data = _d(node)
    chosen = None
    for selector in data.get("variables") or []:
        value = ctx.scope.resolve_selector(selector)
        if value is not None:
            chosen = value
            break
    output_type = str(data.get("output_type") or "string")
    if chosen is None:
        chosen = "" if output_type != "array" else []
    return NodeResult(outputs={"output": chosen})


def _assign_target(scope: Scope, selector: Any, value: Any, operation: str) -> None:
    parts = list(selector) if isinstance(selector, (list, tuple)) else [selector]
    if len(parts) < 2:
        raise NodeError(f"assigner target selector is invalid: {selector!r}")
    head, key = str(parts[0]), str(parts[1])
    if head == "conversation":
        target = scope.conversation
    elif head == "sys":
        target = scope.sys
    else:
        target = scope.nodes.setdefault(head, {})
    if operation == "clear":
        target.pop(key, None)
        return
    if operation == "append":
        current = target.get(key)
        if not isinstance(current, list):
            current = [] if current is None else [current]
        current.append(value)
        target[key] = current
        return
    if operation in ("over-write", "overwrite", "set", ""):
        target[key] = value
        return
    raise UnsupportedNode(f"assigner operation {operation!r} is not supported")


def exec_assigner(node: Any, ctx: ExecContext, inputs: dict[str, Any]) -> NodeResult:
    data = _d(node)
    for item in data.get("items") or []:
        if not isinstance(item, dict):
            continue
        selector = item.get("variable_selector")
        if item.get("input_type") == "constant":
            value = item.get("value")
        else:
            value = ctx.scope.resolve_selector(item.get("value"))
        _assign_target(ctx.scope, selector, value, str(item.get("operation") or "over-write"))
    return NodeResult(outputs={})


def _check_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise NodeError(f"http node only allows http(s), got {parsed.scheme!r}")
    host = parsed.hostname or ""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise NodeError(f"http node cannot resolve {host!r}: {exc}") from exc
    for info in infos:
        addr = ipaddress.ip_address(info[4][0])
        if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved:
            raise NodeError(f"http node refuses private/loopback address {addr} ({host})")
    return url


def exec_http(node: Any, ctx: ExecContext, inputs: dict[str, Any]) -> NodeResult:
    data = _d(node)
    method = str(data.get("method") or "get").upper()
    url = render_refs(str(data.get("url") or ""), ctx.scope)
    params = data.get("params") or []
    query = []
    for item in params:
        if isinstance(item, dict) and item.get("key"):
            query.append((str(item["key"]), stringify(render_ref_value(str(item.get("value", "")), ctx.scope))))
    if query:
        url = url + ("&" if urllib.parse.urlparse(url).query else "?") + urllib.parse.urlencode(query)
    _check_url(url)

    headers = {"User-Agent": "dsh-dify-runtime/0.1"}
    for item in data.get("headers") or []:
        if isinstance(item, dict) and item.get("key"):
            headers[str(item["key"])] = stringify(render_ref_value(str(item.get("value", "")), ctx.scope))

    auth = data.get("authorization") or {}
    auth_type = str(auth.get("type") or "no-auth")
    auth_cfg = auth.get("config") or {}
    if auth_type == "api-key":
        key = stringify(auth_cfg.get("api_key") or "")
        header = stringify(auth_cfg.get("header") or "Authorization")
        headers[header] = key if header.lower() != "authorization" or key.lower().startswith("bearer ") else f"Bearer {key}"
    elif auth_type == "bearer":
        headers["Authorization"] = f"Bearer {stringify(auth_cfg.get('token') or '')}"

    body_cfg = data.get("body") or {}
    body_type = str(body_cfg.get("type") or "none")
    payload: bytes | None = None
    if body_type == "json":
        raw = body_cfg.get("data")
        if isinstance(raw, list):
            obj = {}
            for item in raw:
                if isinstance(item, dict) and item.get("key"):
                    obj[str(item["key"])] = render_ref_value(stringify(item.get("value", "")), ctx.scope)
            body_obj = obj
        elif isinstance(raw, str):
            rendered = render_refs(raw, ctx.scope)
            body_obj = json.loads(rendered)
        else:
            body_obj = raw or {}
        payload = json.dumps(body_obj, ensure_ascii=False).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")
    elif body_type == "raw-text":
        payload = render_refs(str(body_cfg.get("data") or ""), ctx.scope).encode("utf-8")
    elif body_type == "x-www-form-urlencoded":
        fields = []
        for item in body_cfg.get("data") or []:
            if isinstance(item, dict) and item.get("key"):
                fields.append((str(item["key"]), stringify(render_ref_value(str(item.get("value", "")), ctx.scope))))
        payload = urllib.parse.urlencode(fields).encode("utf-8")
        headers.setdefault("Content-Type", "application/x-www-form-urlencoded")

    req = urllib.request.Request(url, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=ctx.timeout_s) as resp:
            text = resp.read().decode("utf-8", "replace")
            status = resp.status
            resp_headers = dict(resp.headers)
    except Exception as exc:
        raise NodeError(f"http node request failed: {exc}") from exc
    if status >= 400 and str(data.get("error_strategy") or "") not in ("continue-on-error", "default-value"):
        raise NodeError(f"http node got HTTP {status}: {text[:300]}")
    return NodeResult(outputs={"body": text, "status_code": status, "headers": resp_headers})


def exec_classifier(node: Any, ctx: ExecContext, inputs: dict[str, Any]) -> NodeResult:
    data = _d(node)
    if ctx.llm is None:
        raise LlmError("no LLM client configured")
    query = stringify(ctx.scope.resolve_selector(data.get("query_variable_selector")))
    classes = [c for c in (data.get("classes") or []) if isinstance(c, dict)]
    if not classes:
        raise NodeError(f"question-classifier {node.id} has no classes")
    names = [str(c.get("name") or "") for c in classes]
    instruction = str(data.get("instruction") or "Classify the input into exactly one class.")
    prompt = (
        f"{instruction}\n\nClasses:\n"
        + "\n".join(f"- {name}" for name in names)
        + f"\n\nInput:\n{query}\n\n"
        + "Answer with the class name only, exactly as written above."
    )
    model_cfg = data.get("model") or {}
    result = ctx.llm.chat(
        provider=str(model_cfg.get("provider") or "deepseek"),
        model=str(model_cfg.get("name") or "deepseek-chat"),
        messages=[{"role": "user", "content": prompt}],
        temperature=0,
        max_tokens=64,
    )
    answer = result["text"].strip()
    match = next((c for c in classes if str(c.get("name")) == answer), None)
    if match is None:
        match = next((c for c in classes if str(c.get("name")) in answer), None)
    if match is None:
        idx = next((i for i, c in enumerate(classes) if str(i + 1) in answer), None)
        if idx is not None:
            match = classes[idx]
    if match is None:
        raise NodeError(f"question-classifier {node.id} returned an unknown class: {answer!r}")
    return NodeResult(
        outputs={"class_name": match.get("name"), "class_id": match.get("id")},
        branch=str(match.get("id")),
        meta={"answer": answer},
    )


EXECUTORS = {
    "start": exec_start,
    "end": exec_end,
    "answer": exec_answer,
    "llm": exec_llm,
    "code": exec_code,
    "if-else": exec_if_else,
    "template-transform": exec_template,
    "variable-aggregator": exec_aggregator,
    "assigner": exec_assigner,
    "http-request": exec_http,
    "question-classifier": exec_classifier,
}


def execute(node: Any, ctx: ExecContext, inputs: dict[str, Any]) -> NodeResult:
    fn = EXECUTORS.get(node.type)
    if fn is None:
        raise UnsupportedNode(f"node {node.id} type {node.type!r} has no adapter")
    try:
        return fn(node, ctx, inputs)
    except (CodeError, RefError, LlmError, UnsupportedNode) as exc:
        raise NodeError(f"{node.type} node {node.id}: {exc}") from exc
