from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import logging
import re
import uuid

from sqlalchemy import select

from app.db import SessionLocal
from app.core.config import settings
from app.core.errors import AppError
from app.llm.client import llm_client
from app.models import PersonaMemory
from app.services.turn_utils import last_n_round_messages

logger = logging.getLogger(__name__)
_EXTRACT_RETRY_NEXT_ROUND: dict[tuple[str, str, str], int] = {}

MEMORY_TYPES = {
    "identity",
    "preference",
    "fact",
    "correction",
    "relationship",
    "commitment",
    "status",
}

TYPE_PRIORITY = {
    "correction": 7,
    "identity": 6,
    "preference": 5,
    "relationship": 4,
    "commitment": 3,
    "fact": 2,
    "status": 1,
}

HIGH_SIGNAL_PATTERN = re.compile(
    r"(我叫|我是|我住|我喜欢|我讨厌|我在|记住|别忘了|其实我|纠正|不对|搞错了)"
)
LOW_SIGNAL_PATTERN = re.compile(r"^(嗯+|哈哈+|好的|ok|OK|收到|行|好|👍+|😂+|\.+)$")

MEMORY_PROMPT = """你是一个记忆提取助手。从以下对话中提取值得长期记住的用户信息。

要求：
- 每条记忆用一句陈述句表达（如"用户住在深圳"、"用户不喜欢加班"）
- 为每条记忆标注类型，类型只能是：identity / preference / fact / correction / relationship / commitment / status
- 为每条记忆标注置信度（0.0-1.0），只有用户明确说出的信息才标 1.0，推测性的标 0.5-0.8
- 如果用户纠正了之前的信息，类型标为 correction，并说明被纠正的内容
- 不提取无意义的闲聊内容
- 下面会提供“已有长期记忆”列表；如果信息已经存在且无变化，不要重复输出
- 以 JSON 数组返回：[{"content": "...", "type": "...", "confidence": 0.9}, ...]
- 如果没有值得提取的信息，返回空数组 []"""

def _message_text(m: dict) -> str:
    return str(m.get("content") or "").strip()


def _extract_json_array(raw: str):
    text = (raw or "").strip()
    if not text:
        return []

    # common format: ```json [...] ```
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text, flags=re.IGNORECASE)
    if fenced:
        candidate = fenced.group(1).strip()
        try:
            data = json.loads(candidate)
            if isinstance(data, list):
                return data
        except Exception:
            pass

    # direct JSON array
    try:
        data = json.loads(text)
        if isinstance(data, list):
            return data
    except Exception:
        pass

    # fallback: extract first [...] block in mixed text
    first = text.find("[")
    last = text.rfind("]")
    if first != -1 and last != -1 and last > first:
        candidate = text[first : last + 1]
        try:
            data = json.loads(candidate)
            if isinstance(data, list):
                return data
        except Exception:
            pass

    raise json.JSONDecodeError("No JSON array found", text, 0)


def _is_high_signal(messages: list[dict]) -> bool:
    has_nontrivial_user_text = False
    for m in messages:
        if m.get("role") != "user":
            continue
        text = _message_text(m)
        if not text:
            continue
        if LOW_SIGNAL_PATTERN.match(text):
            continue
        if len(text) >= 8:
            has_nontrivial_user_text = True
        if HIGH_SIGNAL_PATTERN.search(text):
            return True
    return has_nontrivial_user_text


def _memory_key(content: str) -> str:
    checks = [
        r"(用户叫|用户名|名字)",
        r"(用户住在|搬到|居住)",
        r"(用户是|职业|工作)",
        r"(用户喜欢|不喜欢|偏好)",
        r"(用户计划|打算|准备|承诺)",
        r"(用户状态|情绪|压力|失眠|健康)",
    ]
    for i, p in enumerate(checks):
        if re.search(p, content):
            return f"k{i}"
    return content[:24]


def _format_existing_memories_for_prompt(rows: list[PersonaMemory]) -> str:
    if not rows:
        return "（无）"
    lines: list[str] = []
    for r in rows:
        lines.append(f"- [{r.memory_type}] {r.content}")
    return "\n".join(lines)


async def extract_memories(
    messages: list[dict],
    user_id: str,
    persona_id: str | None,
    session_id: str | None,
    model: str,
    request_id: str,
    force: bool = False,
) -> tuple[list[dict], bool]:
    if not persona_id:
        return [], False
    if (not force) and (not _is_high_signal(messages)):
        return [], False

    existing_for_prompt: list[PersonaMemory] = []
    try:
        async with SessionLocal() as db:
            existing_result = await db.execute(
                select(PersonaMemory).where(
                    PersonaMemory.user_id == user_id,
                    PersonaMemory.persona_id == persona_id,
                    PersonaMemory.is_active.is_(True),
                    PersonaMemory.needs_review.is_(False),
                )
            )
            existing_for_prompt = list(existing_result.scalars().all())
    except Exception:
        logger.exception("extract_memories preload existing failed request_id=%s", request_id)
        existing_for_prompt = []

    payload = [
        {"role": "system", "content": MEMORY_PROMPT},
        {
            "role": "user",
            "content": (
                "已有长期记忆：\n"
                + _format_existing_memories_for_prompt(existing_for_prompt)
                + "\n\n本次对话：\n"
                + "\n".join(
                    f"{m.get('role', 'unknown')}: {_message_text(m)}"
                    for m in messages
                    if _message_text(m)
                )
            ),
        },
    ]

    async def _try_extract_with_model(model_name: str, attempts: int) -> list | None:
        last_exc: Exception | None = None
        for i in range(attempts):
            try:
                logger.info(
                    "extract_memories attempt model=%s try=%s/%s request_id=%s",
                    model_name,
                    i + 1,
                    attempts,
                    request_id,
                )
                data = await asyncio.wait_for(
                    llm_client.chat_completions(
                        model=model_name,
                        messages=payload,
                        temperature=0.1,
                        request_id=request_id,
                    ),
                    timeout=max(5, int(getattr(settings, "memory_extract_timeout_s", 20))),
                )
                raw = str(data["choices"][0]["message"]["content"]).strip()
                parsed_local = _extract_json_array(raw)
                return parsed_local
            except asyncio.TimeoutError as e:
                last_exc = e
                logger.warning(
                    "extract_memories timeout model=%s try=%s/%s request_id=%s",
                    model_name,
                    i + 1,
                    attempts,
                    request_id,
                )
                if i < attempts - 1:
                    await asyncio.sleep(0.8 * (i + 1))
            except AppError as e:
                last_exc = e
                if i < attempts - 1:
                    await asyncio.sleep(0.8 * (i + 1))
            except Exception as e:
                last_exc = e
                if i < attempts - 1:
                    await asyncio.sleep(0.8 * (i + 1))
        if last_exc:
            raise last_exc
        return None

    primary_model = settings.memory_extract_model or model
    fallback_model = settings.memory_extract_fallback_model

    parsed: list | None = None
    try:
        parsed = await _try_extract_with_model(primary_model, attempts=3)  # 首次 + 2 次重试
    except Exception:
        logger.warning(
            "extract_memories primary model failed, fallback model=%s request_id=%s",
            fallback_model,
            request_id,
        )
        try:
            parsed = await _try_extract_with_model(fallback_model, attempts=2)
        except asyncio.TimeoutError:
            logger.warning("extract_memories timeout after fallback request_id=%s", request_id)
            return [], True
        except AppError as e:
            logger.warning(
                "extract_memories provider failed after fallback request_id=%s detail=%s",
                request_id,
                str(e),
            )
            return [], True
        except json.JSONDecodeError:
            logger.warning("extract_memories parse failed after fallback request_id=%s", request_id)
            return [], True
        except Exception:
            logger.exception("extract_memories unexpected failure request_id=%s", request_id)
            return [], True

    if parsed is None:
        return [], False

    cleaned: list[dict] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or "").strip()
        memory_type = str(item.get("type") or "").strip()
        try:
            confidence = float(item.get("confidence", 1.0))
        except Exception:
            confidence = 1.0
        if not content or memory_type not in MEMORY_TYPES:
            continue
        cleaned.append(
            {
                "content": content,
                "type": memory_type,
                "confidence": max(0.0, min(1.0, confidence)),
            }
        )

    if not cleaned:
        return [], False

    now = datetime.now(timezone.utc)
    try:
        async with SessionLocal() as db:
            existing_result = await db.execute(
                select(PersonaMemory).where(
                    PersonaMemory.user_id == user_id,
                    PersonaMemory.persona_id == persona_id,
                    PersonaMemory.is_active.is_(True),
                )
            )
            existing = existing_result.scalars().all()

            for mem in cleaned:
                incoming_key = _memory_key(mem["content"])
                incoming_type = mem["type"]
                merged_existing = False
                for old in existing:
                    old_key = _memory_key(old.content)
                    if old_key != incoming_key:
                        continue
                    if old.content.strip() == mem["content"]:
                        old.updated_at = now
                        old.confidence = max(old.confidence, mem["confidence"])
                        merged_existing = True
                        break
                    if not settings.memory_extract_require_confirm:
                        old.is_active = False
                    if incoming_type != "correction":
                        incoming_type = "correction"

                if merged_existing:
                    continue

                row = PersonaMemory(
                    id=str(uuid.uuid4()),
                    user_id=user_id,
                    persona_id=persona_id,
                    memory_type=incoming_type,
                    content=mem["content"],
                    source_session_id=session_id,
                    confidence=mem["confidence"],
                    is_active=not settings.memory_extract_require_confirm,
                    needs_review=settings.memory_extract_require_confirm,
                    created_at=now,
                    updated_at=now,
                )
                db.add(row)

            await db.commit()
        return cleaned, False
    except Exception:
        logger.exception("extract_memories db write failed request_id=%s", request_id)
        return [], True


async def maybe_extract_memories(
    message_count: int,
    messages: list[dict],
    user_id: str,
    persona_id: str | None,
    session_id: str | None,
    model: str,
    request_id: str,
    settings,
) -> None:
    if not settings.memory_extract_enabled:
        return
    if not persona_id:
        return
    interval = max(1, settings.memory_extract_interval)
    rounds = message_count
    if rounds == 0:
        return

    retry_key = (user_id, persona_id or "", session_id or "")
    should_run = False
    is_retry_after_failure = False
    if rounds % interval == 0:
        should_run = True
    elif retry_key in _EXTRACT_RETRY_NEXT_ROUND and rounds > _EXTRACT_RETRY_NEXT_ROUND[retry_key]:
        should_run = True
        is_retry_after_failure = True
    else:
        # 补偿策略：本会话若还没有任何提取记录，达到阈值后也尝试一次
        try:
            async with SessionLocal() as db:
                existing = await db.execute(
                    select(PersonaMemory.id)
                    .where(
                        PersonaMemory.user_id == user_id,
                        PersonaMemory.persona_id == persona_id,
                        PersonaMemory.source_session_id == session_id,
                    )
                    .limit(1)
                )
                has_any = existing.first() is not None
            if (not has_any) and rounds >= interval:
                should_run = True
        except Exception:
            logger.exception("maybe_extract_memories precheck failed request_id=%s", request_id)
            should_run = False

    if not should_run:
        return

    recent_messages = last_n_round_messages(messages, interval)
    if (not is_retry_after_failure) and (not _is_high_signal(recent_messages)):
        return

    _, failed = await extract_memories(
        messages=recent_messages,
        user_id=user_id,
        persona_id=persona_id,
        session_id=session_id,
        model=model,
        request_id=request_id,
        force=is_retry_after_failure,
    )
    if failed:
        _EXTRACT_RETRY_NEXT_ROUND[retry_key] = rounds
    else:
        _EXTRACT_RETRY_NEXT_ROUND.pop(retry_key, None)


async def get_active_memories(user_id: str, persona_id: str | None, settings) -> list[dict]:
    if not persona_id:
        return []
    async with SessionLocal() as db:
        result = await db.execute(
            select(PersonaMemory)
            .where(
                PersonaMemory.user_id == user_id,
                PersonaMemory.persona_id == persona_id,
                PersonaMemory.is_active.is_(True),
                PersonaMemory.needs_review.is_(False),
            )
            .order_by(PersonaMemory.updated_at.desc())
        )
        rows = result.scalars().all()

    grouped = sorted(
        rows,
        key=lambda x: (
            -TYPE_PRIORITY.get(x.memory_type, 0),
            -int(x.updated_at.timestamp()),
        ),
    )
    limited = grouped[: settings.memory_max_per_persona]
    return [
        {
            "id": r.id,
            "type": r.memory_type,
            "content": r.content,
            "confidence": r.confidence,
            "created_at": r.created_at,
            "updated_at": r.updated_at,
        }
        for r in limited
    ]
