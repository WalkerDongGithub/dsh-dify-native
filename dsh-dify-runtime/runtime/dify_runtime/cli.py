"""Command line entry point: inspect, translate, run."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from .dsl import DslError, load_workflow
from .engine import Engine, PreflightError, RunOptions
from .llm import LlmClient, LlmError


def _emit(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, default=str))


def _read_inputs(args: argparse.Namespace) -> dict[str, Any]:
    if args.inputs_file:
        return json.loads(Path(args.inputs_file).read_text(encoding="utf-8"))
    if args.input:
        raw = args.input
        if raw.startswith("@"):
            return json.loads(Path(raw[1:]).read_text(encoding="utf-8"))
        return json.loads(raw)
    return {}


def cmd_inspect(args: argparse.Namespace) -> int:
    wf = load_workflow(args.workflow)
    ir = wf.to_ir()
    counts: dict[str, int] = {}
    for node in wf.nodes:
        counts[node.type] = counts.get(node.type, 0) + 1
    summary = {
        "workflow": wf.app_name,
        "mode": wf.app_mode,
        "difyVersion": wf.dify_version,
        "nodeCount": len(wf.nodes),
        "edgeCount": len(wf.edges),
        "nodeTypes": counts,
        "startInputs": wf.start_inputs,
        "executionOrder": ir["executionOrder"],
        "unsupported": ir["unsupported"],
        "issues": ir["issues"],
        "nodes": [
            {
                "id": n.id,
                "type": n.type,
                "title": n.title,
                "status": "supported" if n.supported else "unsupported",
            }
            for n in wf.nodes
        ],
    }
    _emit(summary)
    return 0


def cmd_translate(args: argparse.Namespace) -> int:
    wf = load_workflow(args.workflow)
    ir = wf.to_ir()
    if args.output:
        Path(args.output).write_text(json.dumps(ir, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"wrote IR to {args.output}", file=sys.stderr)
    _emit(
        {
            "ir_version": ir["ir_version"],
            "source": ir["source"],
            "nodes": len(ir["nodes"]),
            "supported": sum(1 for n in ir["nodes"] if n["status"] == "supported"),
            "unsupported": ir["unsupported"],
            "executionOrder": ir["executionOrder"],
            "output": args.output,
        }
    )
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    if args.max_tokens:
        os.environ["DIFY_LLM_MAX_TOKENS_CAP"] = str(args.max_tokens)
    if args.model:
        os.environ["DIFY_LLM_MODEL"] = args.model
    if args.no_llm:
        os.environ["DIFY_LLM_DISABLED"] = "1"

    wf = load_workflow(args.workflow)
    inputs = _read_inputs(args)
    options = RunOptions(
        max_steps=args.max_steps,
        node_timeout_s=args.timeout,
        trace_path=args.trace,
        allow_unsupported=args.allow_unsupported,
        use_llm=not args.no_llm,
    )
    if not args.no_llm:
        try:
            options.llm = LlmClient()
        except LlmError as exc:
            # Only fail here if the graph actually has LLM nodes; preflight in
            # the engine reports the rest.
            if any(n.type in ("llm", "question-classifier") for n in wf.nodes):
                _emit({"runId": None, "status": "rejected", "error": str(exc), "nodes": {}, "trace": []})
                return 2
            options.llm = None
    try:
        result = Engine().run(wf, inputs, options)
    except (DslError, PreflightError) as exc:
        _emit({"runId": None, "status": "rejected", "error": str(exc), "nodes": {}, "trace": []})
        return 2
    payload = result.to_dict(include_trace=args.verbose)
    _emit(payload)
    if result.status == "succeeded":
        return 0
    if result.status == "rejected":
        return 2
    return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="dify_runtime", description="Run Dify workflow DSL on dsh")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("inspect", help="parse a DSL and report nodes/variables/unsupported types")
    p.add_argument("workflow")
    p.set_defaults(func=cmd_inspect)

    p = sub.add_parser("translate", help="normalize a DSL into the runtime IR")
    p.add_argument("workflow")
    p.add_argument("-o", "--output")
    p.set_defaults(func=cmd_translate)

    p = sub.add_parser("run", help="execute a DSL deterministically")
    p.add_argument("workflow")
    p.add_argument("--input", help="JSON object with start inputs")
    p.add_argument("--inputs-file", help="path to a JSON inputs object")
    p.add_argument("--trace", help="write a JSONL execution trace here")
    p.add_argument("--timeout", type=float, default=30.0, help="per-node timeout seconds")
    p.add_argument("--max-steps", type=int, default=200)
    p.add_argument("--max-tokens", type=int, default=1024)
    p.add_argument("--model", help="override the target LLM model id")
    p.add_argument("--no-llm", action="store_true", help="refuse/fail nodes that need an LLM")
    p.add_argument("--allow-unsupported", action="store_true", help="do not reject unsupported nodes upfront")
    p.add_argument("--verbose", action="store_true", help="include the full trace in stdout")
    p.set_defaults(func=cmd_run)
    return parser


def main(argv: list[str] | None = None) -> int:
    runtime_root = Path(__file__).resolve().parents[1]
    vendor = runtime_root / "vendor"
    if "DIFY_PYLIB" not in os.environ and vendor.exists():
        os.environ["DIFY_PYLIB"] = str(vendor)
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except DslError as exc:
        _emit({"status": "rejected", "error": str(exc)})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
