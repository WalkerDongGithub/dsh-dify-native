"""OpenAI-compatible LLM adapter used by the ``llm`` node.

The Dify workflow carries its original provider/model (deepseek, openai,
anthropic, ...).  We cannot run those providers here; a model map rewrites each
request onto the one endpoint the box actually has credentials for.  The
mapping is always recorded in the trace so a run is auditable.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_BASE_URL = "https://api.z.ai/api/paas/v4"
DEFAULT_MODEL = "glm-4.5-air"

# key: "provider/model" as found in the DSL; value: model id on the target route
DEFAULT_MODEL_MAP = {
    "deepseek/deepseek-chat": DEFAULT_MODEL,
    "deepseek/deepseek-coder": DEFAULT_MODEL,
    "deepseek/deepseek-reasoner": DEFAULT_MODEL,
    "openai/gpt-4o-mini": DEFAULT_MODEL,
    "openai/gpt-4o": DEFAULT_MODEL,
    "anthropic/claude-3-5-sonnet-20241022": DEFAULT_MODEL,
    "tongyi/qwen-vl-plus": "glm-4.5v",
    "tongyi/qwen-plus": DEFAULT_MODEL,
    "zhipu/glm-4": DEFAULT_MODEL,
}


class LlmError(Exception):
    pass


def _credentials_ref(name: str) -> str | None:
    path = Path(os.environ.get("DSH_CREDENTIALS", str(Path.home() / ".dsh/.credentials.yaml")))
    if not path.exists():
        return None
    try:
        import yaml

        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return None
    value = (doc.get("refs") or {}).get(name)
    return value if isinstance(value, str) and value.strip() else None


def resolve_api_key() -> str:
    for name in ("DIFY_LLM_API_KEY", "ZAI_API_KEY"):
        value = os.environ.get(name)
        if value and value.strip():
            return value.strip()
    value = _credentials_ref("ZAI_API_KEY")
    if value:
        return value
    raise LlmError(
        "no LLM credentials: set DIFY_LLM_API_KEY (or ZAI_API_KEY), "
        "or put ZAI_API_KEY in ~/.dsh/.credentials.yaml"
    )


def _model_map() -> dict[str, str]:
    raw = os.environ.get("DIFY_MODEL_MAP")
    mapping = dict(DEFAULT_MODEL_MAP)
    if raw:
        try:
            mapping.update({str(k): str(v) for k, v in json.loads(raw).items()})
        except Exception as exc:
            raise LlmError(f"DIFY_MODEL_MAP is not valid JSON: {exc}") from exc
    return mapping


def map_model(provider: str, name: str) -> tuple[str, str]:
    key = f"{provider}/{name}"
    mapping = _model_map()
    target = mapping.get(key) or mapping.get(name) or os.environ.get("DIFY_LLM_MODEL") or DEFAULT_MODEL
    return key, target


class LlmClient:
    def __init__(self) -> None:
        self.base_url = (os.environ.get("DIFY_LLM_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.api_key = resolve_api_key()
        self.timeout = float(os.environ.get("DIFY_LLM_TIMEOUT", "120"))
        self.disable_thinking = (os.environ.get("DIFY_LLM_DISABLE_THINKING", "1") != "0")

    def chat(
        self,
        *,
        provider: str,
        model: str,
        messages: list[dict[str, str]],
        temperature: float | None = None,
        max_tokens: int | None = None,
        response_format: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        original, target = map_model(provider, model)
        body: dict[str, Any] = {
            "model": target,
            "messages": messages,
            "stream": False,
        }
        if temperature is not None:
            body["temperature"] = float(temperature)
        if max_tokens is not None:
            body["max_tokens"] = max(1, min(int(max_tokens), int(os.environ.get("DIFY_LLM_MAX_TOKENS_CAP", "1024"))))
        if response_format is not None:
            body["response_format"] = response_format
        if self.disable_thinking:
            # z.ai's chat completions accept a thinking toggle; harmless on
            # providers that ignore unknown fields.
            body["thinking"] = {"type": "disabled"}

        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        last_error: Exception | None = None
        for attempt in range(3):
            req = urllib.request.Request(
                f"{self.base_url}/chat/completions",
                data=data,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                break
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", "replace")[:400]
                last_error = LlmError(f"HTTP {exc.code} from LLM endpoint: {detail}")
                if exc.code in (400, 401, 403, 404):
                    raise last_error from exc
            except Exception as exc:  # timeout / connection
                last_error = LlmError(f"LLM request failed: {exc}")
            time.sleep(1.5 * (attempt + 1))
        else:
            raise last_error or LlmError("LLM request failed")

        choices = payload.get("choices") or []
        if not choices:
            raise LlmError(f"LLM response has no choices: {str(payload)[:300]}")
        message = choices[0].get("message") or {}
        text = message.get("content")
        if text is None:
            text = ""
        if isinstance(text, list):  # multimodal content blocks
            text = "".join(part.get("text", "") for part in text if isinstance(part, dict))
        return {
            "text": str(text).strip(),
            "reasoning": str(message.get("reasoning_content") or ""),
            "finishReason": choices[0].get("finish_reason"),
            "usage": payload.get("usage") or {},
            "modelRequested": original,
            "modelUsed": target,
        }
