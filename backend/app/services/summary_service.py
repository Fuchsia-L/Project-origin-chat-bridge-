from __future__ import annotations

from datetime import datetime, timezone
import logging
import uuid

from sqlalchemy import select

from app.db import SessionLocal
from app.llm.client import llm_client
from app.models import ChatSession
from app.models import MemorySummary
from app.services.token_counter import estimate_tokens
from app.services.turn_utils import (
    count_user_rounds,
    last_n_round_messages,
    user_turn_spans,
)

logger = logging.getLogger(__name__)


SUMMARY_SYSTEM_PROMPT = """你是一个对话摘要助手。请将以下对话压缩为摘要。称呼使用：角色名称和用户名称。
要求：
- 保留关键事实、决策、情感状态、重要细节
- 使用陈述句，不使用对话格式
- 用角色本人的视角和语气来写摘要，而不是用第三人称客观描述
- 如果对话中有用户的个人信息（名字、偏好、状态），务必保留"""


async def generate_summary(
    messages: list[dict],
    model: str,
    request_id: str,
    *,
    max_chars: int = 300,
    previous_summary: str | None = None,
) -> str:
    prev = f"\n\n已有摘要：\n{previous_summary}" if previous_summary else ""
    payload = [
        {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"请总结以下对话，与已有摘要合并。摘要最大字数 {max_chars} 字：\n\n"
                + "\n".join(f"{m.get('role', 'unknown')}: {m.get('content', '')}" for m in messages)
                + prev
            ),
        },
    ]
    data = await llm_client.chat_completions(
        model=model,
        messages=payload,
        temperature=0.2,
        request_id=request_id,
    )
    return str(data["choices"][0]["message"]["content"]).strip()


async def get_latest_summary(session_id: str, user_id: str) -> MemorySummary | None:
    async with SessionLocal() as db:
        result = await db.execute(
            select(MemorySummary)
            .where(
                MemorySummary.user_id == user_id,
                MemorySummary.session_id == session_id,
            )
            .order_by(MemorySummary.created_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()


async def maybe_compress_session(
    session_id: str,
    user_id: str,
    messages: list[dict],
    settings,
    request_id: str,
    persona_id: str | None = None,
) -> tuple[str | None, int]:
    rounds = count_user_rounds(messages)
    if rounds < settings.context_summary_trigger:
        return None, 0

    tail_round_index = max(1, int(settings.context_summary_tail_round_index))
    spans = user_turn_spans(messages)
    if len(spans) < tail_round_index:
        return None, 0
    end_idx_by_round = spans[-tail_round_index][1]

    try:
        async with SessionLocal() as db:
            result = await db.execute(
                select(MemorySummary)
                .where(
                    MemorySummary.user_id == user_id,
                    MemorySummary.session_id == session_id,
                )
                .order_by(MemorySummary.created_at.desc())
                .limit(1)
            )
            latest = result.scalar_one_or_none()

            start_idx = latest.message_range_end if latest else 0
            end_idx = end_idx_by_round
            if end_idx < start_idx:
                return None, 0

            slice_messages = messages[start_idx : end_idx + 1]
            if not slice_messages:
                return None, 0

            range_rounds = count_user_rounds(slice_messages)
            if range_rounds <= 3:
                return None, 0

            range_tokens = estimate_tokens(
                "\n".join(f"{m.get('role', 'unknown')}: {m.get('content', '')}" for m in slice_messages)
            )
            if range_tokens <= max(1, int(settings.context_summary_min_tokens)):
                return None, 0

            model = getattr(settings, "summary_model", "") or settings.llm_model
            merged_summary = await generate_summary(
                slice_messages,
                model=model,
                request_id=request_id,
                max_chars=300,
                previous_summary=latest.summary_text if latest else None,
            )
            merged_start = latest.message_range_start if latest else start_idx

            token_count = estimate_tokens(merged_summary)
            row = MemorySummary(
                id=str(uuid.uuid4()),
                user_id=user_id,
                session_id=session_id,
                persona_id=persona_id,
                summary_text=merged_summary,
                message_range_start=merged_start,
                message_range_end=end_idx,
                token_count=token_count,
                created_at=datetime.now(timezone.utc),
            )
            db.add(row)
            await db.commit()
            return merged_summary, token_count
    except Exception:
        logger.exception("maybe_compress_session failed request_id=%s", request_id)
        return None, 0


async def force_compress_session(
    *,
    session_id: str,
    user_id: str,
    request_id: str,
    settings,
) -> tuple[str | None, int]:
    try:
        async with SessionLocal() as db:
            session_result = await db.execute(
                select(ChatSession).where(ChatSession.user_id == user_id, ChatSession.id == session_id)
            )
            session = session_result.scalar_one_or_none()
            if not session:
                return None, 0

            payload = session.payload or {}
            raw_messages = payload.get("messages") or []
            messages = [
                {"role": m.get("role"), "content": m.get("content", "")}
                for m in raw_messages
                if isinstance(m, dict) and m.get("role") in {"user", "assistant"}
            ]
            if not messages:
                return None, 0

            total_rounds = count_user_rounds(messages)
            max_chars = max(100, 50 * max(1, total_rounds))
            tail_round_index = max(1, int(settings.context_summary_tail_round_index))
            spans = user_turn_spans(messages)
            # Keep the same tail policy as normal compression so future incremental
            # compression can continue from a consistent range boundary.
            if len(spans) >= tail_round_index:
                compress_end_idx = spans[-tail_round_index][1]
            else:
                compress_end_idx = max(0, len(messages) - 1)
            compressible_messages = messages[: compress_end_idx + 1]
            if not compressible_messages:
                return None, 0

            latest_summary_result = await db.execute(
                select(MemorySummary)
                .where(MemorySummary.user_id == user_id, MemorySummary.session_id == session_id)
                .order_by(MemorySummary.created_at.desc())
                .limit(1)
            )
            latest = latest_summary_result.scalar_one_or_none()

            input_messages = compressible_messages
            previous_summary = None
            if count_user_rounds(input_messages) > 50:
                input_messages = last_n_round_messages(input_messages, 50)
                previous_summary = latest.summary_text if latest else None

            summary_text = await generate_summary(
                input_messages,
                model=(getattr(settings, "summary_model", "") or settings.llm_model),
                request_id=request_id,
                max_chars=max_chars,
                previous_summary=previous_summary,
            )
            token_count = estimate_tokens(summary_text)
            row = MemorySummary(
                id=str(uuid.uuid4()),
                user_id=user_id,
                session_id=session_id,
                persona_id=session.persona_id,
                summary_text=summary_text,
                message_range_start=0,
                message_range_end=compress_end_idx,
                token_count=token_count,
                created_at=datetime.now(timezone.utc),
            )
            db.add(row)
            await db.commit()
            return summary_text, token_count
    except Exception:
        logger.exception("force_compress_session failed request_id=%s", request_id)
        return None, 0
