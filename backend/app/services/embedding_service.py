from __future__ import annotations

from datetime import datetime, timezone
import json
import logging
import math
import uuid

import httpx
from sqlalchemy import select

from app.core.config import settings
from app.db import SessionLocal
from app.llm.client import llm_client
from app.models import MemoryEmbedding
from app.services.turn_utils import user_turn_spans

logger = logging.getLogger(__name__)


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return -1.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return -1.0
    return dot / (norm_a * norm_b)


def _to_chunk_text(messages: list[dict]) -> str:
    lines: list[str] = []
    for m in messages:
        role = m.get("role")
        content = str(m.get("content") or "").strip()
        if not content:
            continue
        if role == "user":
            lines.append(f"用户：{content}")
        elif role == "assistant":
            lines.append(f"角色：{content}")
        else:
            lines.append(f"{role}：{content}")
    return "\n".join(lines)


async def _summarize_chunk(messages: list[dict], model: str, request_id: str) -> str:
    payload = [
        {"role": "system", "content": "你是对话压缩助手，请将以下内容压缩为100字以内的摘要。"},
        {"role": "user", "content": _to_chunk_text(messages)},
    ]
    data = await llm_client.chat_completions(
        model=model,
        messages=payload,
        temperature=0.2,
        request_id=request_id,
    )
    return str(data["choices"][0]["message"]["content"]).strip()


async def compute_embedding(text: str) -> list[float] | None:
    if not settings.embedding_enabled or not settings.embedding_api_url:
        return None
    headers = {"Content-Type": "application/json"}
    if settings.embedding_api_key:
        headers["Authorization"] = f"Bearer {settings.embedding_api_key}"
    payload = {"model": settings.embedding_model, "input": text}
    try:
        async with httpx.AsyncClient(timeout=30.0, trust_env=False) as client:
            resp = await client.post(settings.embedding_api_url.rstrip("/") + "/embeddings", headers=headers, json=payload)
        if resp.status_code // 100 != 2:
            logger.error("compute_embedding bad status=%s body=%s", resp.status_code, resp.text)
            return None
        data = resp.json()
        vector = data.get("data", [{}])[0].get("embedding")
        if isinstance(vector, list):
            return [float(x) for x in vector]
        return None
    except Exception:
        logger.exception("compute_embedding failed")
        return None


async def store_chunk(
    user_id: str,
    persona_id: str | None,
    session_id: str,
    messages: list[dict],
    range_start: int,
    range_end: int,
    model: str,
    request_id: str,
) -> None:
    chunk_text = _to_chunk_text(messages)
    if not chunk_text:
        return
    try:
        chunk_summary = await _summarize_chunk(messages, model=model, request_id=request_id)
        vector = await compute_embedding(chunk_text)
        if not vector:
            return

        async with SessionLocal() as db:
            exists = await db.execute(
                select(MemoryEmbedding.id).where(
                    MemoryEmbedding.session_id == session_id,
                    MemoryEmbedding.message_range_start == range_start,
                    MemoryEmbedding.message_range_end == range_end,
                )
            )
            if exists.first():
                return

            row = MemoryEmbedding(
                id=str(uuid.uuid4()),
                user_id=user_id,
                persona_id=persona_id,
                session_id=session_id,
                chunk_text=chunk_text,
                chunk_summary=chunk_summary,
                embedding=json.dumps(vector, ensure_ascii=False),
                model_name=settings.embedding_model,
                vector_dim=len(vector),
                message_range_start=range_start,
                message_range_end=range_end,
                created_at=datetime.now(timezone.utc),
            )
            db.add(row)
            await db.commit()
    except Exception:
        logger.exception("store_chunk failed request_id=%s", request_id)


async def chunk_and_store_session(
    user_id: str,
    persona_id: str | None,
    session_id: str | None,
    messages: list[dict],
    request_id: str,
    model: str,
) -> None:
    if not settings.embedding_enabled:
        return
    if not session_id:
        return

    spans = user_turn_spans(messages)
    rounds = len(spans)
    if rounds <= 0:
        return

    chunk_size = max(1, settings.embedding_chunk_size)
    overlap = min(chunk_size - 1, max(0, settings.embedding_chunk_overlap))
    step = max(1, chunk_size - overlap)

    for start_round in range(0, rounds, step):
        end_round = min(rounds, start_round + chunk_size)
        if end_round <= start_round:
            continue
        start_idx = spans[start_round][0]
        end_idx = spans[end_round - 1][1]
        await store_chunk(
            user_id=user_id,
            persona_id=persona_id,
            session_id=session_id,
            messages=messages[start_idx : end_idx + 1],
            range_start=start_idx,
            range_end=end_idx,
            model=model,
            request_id=request_id,
        )
        if end_round == rounds:
            break


async def search_relevant_chunks(
    query: str,
    user_id: str,
    persona_id: str | None,
    top_k: int,
    min_similarity: float,
) -> list[dict]:
    qv = await compute_embedding(query)
    if not qv:
        return []

    async with SessionLocal() as db:
        stmt = select(MemoryEmbedding).where(MemoryEmbedding.user_id == user_id)
        if persona_id is None:
            stmt = stmt.where(MemoryEmbedding.persona_id.is_(None))
        else:
            stmt = stmt.where(MemoryEmbedding.persona_id == persona_id)
        result = await db.execute(stmt.order_by(MemoryEmbedding.created_at.desc()))
        rows = result.scalars().all()

    scored: list[dict] = []
    for row in rows:
        try:
            vec = json.loads(row.embedding)
            if not isinstance(vec, list):
                continue
            score = _cosine_similarity(qv, [float(x) for x in vec])
            if score >= min_similarity:
                scored.append(
                    {
                        "summary": row.chunk_summary,
                        "similarity": score,
                        "created_at": row.created_at,
                    }
                )
        except Exception:
            continue

    scored.sort(key=lambda x: x["similarity"], reverse=True)
    return scored[: max(1, top_k)]
