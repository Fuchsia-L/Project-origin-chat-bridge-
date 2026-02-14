from typing import Any, Optional
import json

from app.core.config import settings
from app.core.errors import AppError
from app.llm.client import llm_client
from app.schemas.chat import ChatMessage, Usage


def _extract_usage(data: dict[str, Any]) -> Usage | None:
    u = data.get("usage")
    if not isinstance(u, dict):
        return None

    # 兼容不同网关字段：prompt_tokens / completion_tokens / total_tokens
    prompt = int(u.get("prompt_tokens") or u.get("input_tokens") or 0)
    completion = int(u.get("completion_tokens") or u.get("output_tokens") or 0)
    total = int(u.get("total_tokens") or (prompt + completion) or 0)
    return Usage(input_tokens=prompt, output_tokens=completion, total_tokens=total)


async def run_chat(
    *,
    system_prompt: str,
    messages: list[ChatMessage],
    model: Optional[str],
    temperature: Optional[float],
    request_id: str,
) -> tuple[ChatMessage, Usage | None, dict[str, Any]]:
    use_model = model or settings.llm_model
    use_temp = temperature if temperature is not None else settings.llm_temperature

    # 把 system_prompt 单独注入到 messages 头部
    req_messages: list[dict[str, str]] = []
    if system_prompt.strip():
        req_messages.append({"role": "system", "content": system_prompt})

    req_messages.extend([{"role": m.role, "content": m.content} for m in messages])

    data = await llm_client.chat_completions(
        model=use_model,
        messages=req_messages,
        temperature=use_temp,
        request_id=request_id,
    )

    try:
        content = data["choices"][0]["message"]["content"]
    except Exception:
        raise AppError("LLM response missing choices[0].message.content", status_code=502, code="llm_parse_error")

    reply = ChatMessage(role="assistant", content=content)
    usage = _extract_usage(data)
    return reply, usage, data


async def run_chat_stream(
    *,
    system_prompt: str,
    messages: list[ChatMessage],
    model: Optional[str],
    temperature: Optional[float],
    request_id: str,
):
    use_model = model or settings.llm_model
    use_temp = temperature if temperature is not None else settings.llm_temperature

    req_messages: list[dict[str, str]] = []
    if system_prompt.strip():
        req_messages.append({"role": "system", "content": system_prompt})
    req_messages.extend([{"role": m.role, "content": m.content} for m in messages])

    async for line in llm_client.chat_completions_stream(
        model=use_model,
        messages=req_messages,
        temperature=use_temp,
        request_id=request_id,
    ):
        if not line:
            continue
        if not line.startswith("data:"):
            continue
        data = line[len("data:") :].strip()
        if data == "[DONE]":
            yield {"type": "done"}
            break
        try:
            payload = json.loads(data)
        except Exception:
            continue

        model = payload.get("model")
        if isinstance(model, str) and model:
            yield {"type": "model", "model": model}

        if settings.app_debug_raw:
            yield {"type": "raw", "raw": payload}

        usage = payload.get("usage")
        if isinstance(usage, dict):
            yield {"type": "usage", "usage": usage}

        try:
            delta = payload["choices"][0]["delta"]
        except Exception:
            delta = {}

        content = delta.get("content")
        if isinstance(content, str) and content:
            yield {"type": "delta", "content": content}

        reasoning = delta.get("reasoning_content") or delta.get("thinking")
        if isinstance(reasoning, str) and reasoning:
            yield {"type": "thinking", "content": reasoning}
