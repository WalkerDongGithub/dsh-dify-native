"""Offline regression tests for the Dify runtime (no network, no LLM calls).

Run:  PYTHONPATH=<repo>/runtime python3 -m unittest discover -s tests -v
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "runtime"))
os.environ.setdefault("DIFY_PYLIB", str(ROOT / "runtime" / "vendor"))

from dify_runtime.dsl import load_workflow  # noqa: E402
from dify_runtime.engine import Engine, PreflightError, RunOptions, preflight  # noqa: E402
from dify_runtime.refs import Scope, render_jinja, render_refs  # noqa: E402

DSL = ROOT.parent / "dsl"


class MockLLM:
    """Deterministic stand-in for the model adapter."""

    def __init__(self) -> None:
        self.calls = []

    def chat(self, **kwargs):
        self.calls.append(kwargs)
        # Echo the last user/system content length so different nodes can be
        # distinguished in assertions without calling a real model.
        text = f"MOCK-{len(self.calls)}"
        return {
            "text": text,
            "reasoning": "",
            "finishReason": "stop",
            "usage": {"total_tokens": 1},
            "modelRequested": f"{kwargs.get('provider')}/{kwargs.get('model')}",
            "modelUsed": "mock",
        }


class RuntimeTests(unittest.TestCase):
    def test_parse_and_ir(self):
        wf = load_workflow(str(DSL / "json-repair.yml"))
        self.assertEqual(wf.app_name, "json-repair")
        self.assertEqual([n.type for n in wf.nodes], ["start", "code", "end"])
        self.assertEqual(wf.start_inputs, ["llm_string"])
        ir = wf.to_ir()
        self.assertEqual(ir["unsupported"], [])
        self.assertEqual(len(ir["executionOrder"]), 3)

    def test_unsupported_is_rejected_before_execution(self):
        wf = load_workflow(str(DSL / "lang-consistency.yml"))
        types = {n.type for n in wf.nodes}
        self.assertIn("tool", types)
        with self.assertRaises(PreflightError) as ctx:
            preflight(wf, {}, RunOptions())
        self.assertIn("unsupported-node", str(ctx.exception))
        result = Engine().run(wf, {}, RunOptions())
        self.assertEqual(result.status, "rejected")
        self.assertEqual(result.nodes, {})

    def test_refs_and_real_jinja(self):
        scope = Scope()
        scope.set_node("n1", {"text": "world"})
        self.assertEqual(render_refs("hello {{#n1.text#}}", scope), "hello world")
        # A loop proves this is Jinja, not string replacement.
        out = render_jinja("{% for x in items %}{{ x }}-{% endfor %}", {"items": [1, 2, 3]})
        self.assertEqual(out, "1-2-3-")
        with self.assertRaises(Exception):
            render_jinja("{{ missing }}", {})

    def test_json_repair_end_to_end(self):
        wf = load_workflow(str(DSL / "json-repair.yml"))
        result = Engine().run(
            wf,
            {"llm_string": '{"a": 1, "b": [1,2,], }'},
            RunOptions(use_llm=False),
        )
        self.assertEqual(result.status, "succeeded", result.error)
        self.assertEqual(result.outputs["output"], '{"a": 1, "b": [1, 2]}')
        self.assertEqual([n["status"] for n in result.nodes.values()], ["success"] * 3)

    def test_if_else_both_branches_deterministically(self):
        wf = load_workflow(str(DSL / "translation.yml"))
        for country, expected_branch in (("", "true"), ("Brazil", "false")):
            mock = MockLLM()
            result = Engine().run(
                wf,
                {
                    "target_lang": "Chinese",
                    "source_text": "hello",
                    "source_lang": "English",
                    "country": country,
                },
                RunOptions(llm=mock),
            )
            self.assertEqual(result.status, "succeeded", result.error)
            if_node = next(v for v in result.nodes.values() if v["type"] == "if-else")
            self.assertEqual(if_node["branch"], expected_branch)
            # Both conditional LLM nodes exist, but exactly one is on the
            # active path; the other must be skipped, not executed.
            llm_nodes = {k: v for k, v in result.nodes.items() if v["type"] == "llm"}
            self.assertEqual(len(llm_nodes), 4)
            statuses = sorted(v["status"] for v in llm_nodes.values())
            self.assertEqual(statuses, ["skipped", "success", "success", "success"])
            self.assertEqual(len(mock.calls), 3)

    def test_template_transform_and_answer(self):
        wf = load_workflow(str(DSL / "form-demo.yml"))
        result = Engine().run(
            wf,
            {"sys.query": '{"username":"guest","password":"x"}'},
            RunOptions(use_llm=False),
        )
        self.assertEqual(result.status, "succeeded", result.error)
        self.assertTrue(any("<form" in a for a in result.answers))
        self.assertTrue(any(v["type"] == "template-transform" and v["status"] == "success" for v in result.nodes.values()))


if __name__ == "__main__":
    unittest.main()
