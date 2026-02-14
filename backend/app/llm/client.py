from __future__ import annotations

from typing import Any, Optional
import httpx

from app.core.config import settings
from app.core.errors import AppError


class OpenAICompatClient:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout_s: float = 60.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout_s = timeout_s

    async def chat_completions(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        temperature: float,
        request_id: Optional[str] = None,
    ) -> dict[str, Any]:
        url = f"{self.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        if request_id:
            headers["X-Request-Id"] = request_id

        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
        }
        if settings.llm_safety_block:
            payload["safety_settings"] = [
                {"category": "HARM_CATEGORY_HARASSMENT", "threshold": settings.llm_safety_block},
                {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": settings.llm_safety_block},
                {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": settings.llm_safety_block},
                {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": settings.llm_safety_block},
            ]

        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                resp = await client.post(url, headers=headers, json=payload)
        except httpx.RequestError as e:
            raise AppError(f"LLM request failed: {e}", status_code=502, code="llm_request_error")

        # 不是 2xx：尽量把对方错误带回来
        if resp.status_code // 100 != 2:
            try:
                data = resp.json()
            except Exception:
                data = {"error": {"message": resp.text}}
            msg = data.get("error", {}).get("message") or resp.text
            raise AppError(f"LLM error ({resp.status_code}): {msg}", status_code=502, code="llm_bad_response")

        try:
            return resp.json()
        except Exception:
            raise AppError("LLM returned non-JSON response", status_code=502, code="llm_non_json")

    async def chat_completions_stream(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        temperature: float,
        request_id: Optional[str] = None,
    ):
        url = f"{self.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        if request_id:
            headers["X-Request-Id"] = request_id

        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if settings.llm_safety_block:
            payload["safety_settings"] = [
                {"category": "HARM_CATEGORY_HARASSMENT", "threshold": settings.llm_safety_block},
                {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": settings.llm_safety_block},
                {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": settings.llm_safety_block},
                {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": settings.llm_safety_block},
            ]

        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                async with client.stream("POST", url, headers=headers, json=payload) as resp:
                    if resp.status_code // 100 != 2:
                        try:
                            data = await resp.json()
                        except Exception:
                            data = {"error": {"message": await resp.aread()}}
                        msg = data.get("error", {}).get("message") or str(data)
                        raise AppError(
                            f"LLM error ({resp.status_code}): {msg}",
                            status_code=502,
                            code="llm_bad_response",
                        )
                    async for line in resp.aiter_lines():
                        yield line
        except httpx.RequestError as e:
            raise AppError(f"LLM request failed: {e}", status_code=502, code="llm_request_error")


llm_client = OpenAICompatClient(
    base_url=settings.llm_base_url,
    api_key=settings.llm_api_key,
    timeout_s=settings.llm_timeout_s,
)
