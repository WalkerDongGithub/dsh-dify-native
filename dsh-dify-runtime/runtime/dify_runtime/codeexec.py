"""Execution of Dify ``code`` nodes.

Dify code nodes are Python source defining ``def main(...) -> dict``.  The code
is untrusted relative to the harness, so it never runs in the host engine
process: a fresh interpreter is spawned in a throwaway working directory with
CPU/address-space/file-size rlimits and a hard timeout.  The result travels
back as JSON on stdout.

Scope of the isolation is stated honestly in the report: this is
resource-limited process isolation, not the harness' landlock sandbox.  A
production adapter should run the same subprocess through ``ctx.sandbox``.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

RUNNER = r'''
import json, sys, traceback
payload = json.load(sys.stdin)
code = payload["code"]
inputs = payload["inputs"]
namespace = {"__name__": "dify_code_node"}
try:
    exec(compile(code, "<dify-code>", "exec"), namespace)
    main = namespace.get("main")
    if not callable(main):
        raise TypeError("code node does not define main(...)")
    result = main(**inputs)
    if result is None:
        result = {}
    if not isinstance(result, dict):
        raise TypeError(f"main() returned {type(result).__name__}, expected dict")
    json.dump({"ok": True, "result": result}, sys.stdout, ensure_ascii=False, default=str)
except Exception as exc:
    json.dump(
        {"ok": False, "error": f"{type(exc).__name__}: {exc}", "traceback": traceback.format_exc(limit=8)},
        sys.stdout,
        ensure_ascii=False,
    )
'''


class CodeError(Exception):
    pass


def _limits() -> None:  # pragma: no cover - exercised through subprocess
    import resource

    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def run_code(code: str, inputs: dict[str, Any], *, timeout: float = 20.0) -> dict[str, Any]:
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    pylib = os.environ.get("DIFY_PYLIB")
    if pylib:
        env["PYTHONPATH"] = os.path.abspath(pylib)
    with tempfile.TemporaryDirectory(prefix="dify-code-") as tmp:
        try:
            proc = subprocess.run(
                [sys.executable, "-s", "-c", RUNNER],
                input=json.dumps({"code": code, "inputs": inputs}, ensure_ascii=False).encode("utf-8"),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=tmp,
                env=env,
                timeout=timeout,
                preexec_fn=_limits,
            )
        except subprocess.TimeoutExpired as exc:
            raise CodeError(f"code node exceeded {timeout}s") from exc
    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", "replace")[-800:]
        raise CodeError(f"code subprocess exited {proc.returncode}: {stderr}")
    try:
        payload = json.loads(proc.stdout.decode("utf-8", "replace"))
    except json.JSONDecodeError as exc:
        raise CodeError(f"code node produced invalid JSON: {proc.stdout[:300]!r}") from exc
    if not payload.get("ok"):
        raise CodeError(f"{payload.get('error')}\n{payload.get('traceback', '')}".strip())
    return payload["result"]


def coerce_outputs(values: dict[str, Any], schema: dict[str, Any] | None) -> dict[str, Any]:
    """Keep declared outputs, and check the declared primitive type."""
    if not schema:
        return values
    out: dict[str, Any] = {}
    for name, spec in schema.items():
        if name not in values:
            raise CodeError(f"code node did not return declared output {name!r}")
        value = values[name]
        declared = (spec or {}).get("type") if isinstance(spec, dict) else None
        if declared == "string" and not isinstance(value, str):
            value = "" if value is None else str(value)
        elif declared == "number" and isinstance(value, str):
            try:
                value = float(value) if "." in value else int(value)
            except ValueError as exc:
                raise CodeError(f"output {name!r} is not a number: {value!r}") from exc
        elif declared == "boolean" and not isinstance(value, bool):
            value = str(value).lower() in ("1", "true", "yes")
        out[name] = value
    return out
