from __future__ import annotations

from datetime import datetime, timezone
from difflib import SequenceMatcher
import re

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.db import get_db
from app.models import MemoryEmbedding, MemorySummary, PersonaMemory, User
from app.schemas.memory import (
    PersonaMemoryResponse,
    PersonaMemoryUpdate,
    SessionCompressResponse,
    SessionSummaryResponse,
)
from app.core.config import settings
from app.services.summary_service import force_compress_session

router = APIRouter(prefix="/memory", tags=["memory"])


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
        if re.search(p, content or ""):
            return f"k{i}"
    return (content or "")[:24]


def _norm_text(text: str) -> str:
    return re.sub(r"\s+", "", (text or "").strip().lower())


def _merge_texts(texts: list[str]) -> str:
    uniq: list[str] = []
    for t in texts:
        tt = (t or "").strip()
        if not tt:
            continue
        if tt not in uniq:
            uniq.append(tt)
    if not uniq:
        return ""
    if len(uniq) == 1:
        return uniq[0]
    return "；".join(uniq)


def _review_hints_for_row(row: PersonaMemory, active_rows: list[PersonaMemory]) -> list[str]:
    hints: list[str] = []
    same_key = [x for x in active_rows if _memory_key(x.content) == _memory_key(row.content)]
    exact = [x for x in same_key if _norm_text(x.content) == _norm_text(row.content)]
    if exact:
        hints.append(f"请求合并“{exact[0].content}”与“{row.content}”为“{exact[0].content}”")
        return hints

    if len(same_key) >= 2:
        merged = _merge_texts([x.content for x in same_key] + [row.content])
        old = "、".join(f"“{x.content}”" for x in same_key[:2])
        hints.append(f"请求合并{old}为“{merged}”")
        return hints

    if len(same_key) == 1:
        hints.append(f"请求更正“{same_key[0].content}”为“{row.content}”")
        return hints

    similar = [
        x
        for x in active_rows
        if SequenceMatcher(None, _norm_text(x.content), _norm_text(row.content)).ratio() >= 0.82
    ]
    if similar:
        merged = _merge_texts([similar[0].content, row.content])
        hints.append(f"请求合并“{similar[0].content}”与“{row.content}”为“{merged}”")
    return hints


def _to_memory_response(m: PersonaMemory, review_hints: list[str] | None = None) -> PersonaMemoryResponse:
    return PersonaMemoryResponse(
        id=m.id,
        user_id=m.user_id,
        persona_id=m.persona_id,
        memory_type=m.memory_type,
        content=m.content,
        confidence=m.confidence,
        is_active=m.is_active,
        needs_review=m.needs_review,
        source_session_id=m.source_session_id,
        review_hints=review_hints,
        created_at=m.created_at,
        updated_at=m.updated_at,
    )


@router.get("/personas/{persona_id}/memories", response_model=list[PersonaMemoryResponse])
async def list_persona_memories(
    persona_id: str,
    is_active: bool | None = Query(default=None),
    needs_review: bool | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(PersonaMemory).where(
        PersonaMemory.user_id == user.id,
        PersonaMemory.persona_id == persona_id,
    )
    if is_active is not None:
        stmt = stmt.where(PersonaMemory.is_active.is_(is_active))
    if needs_review is not None:
        stmt = stmt.where(PersonaMemory.needs_review.is_(needs_review))
    result = await db.execute(stmt.order_by(PersonaMemory.updated_at.desc()))
    rows = result.scalars().all()

    active_map: list[PersonaMemory] = []
    if needs_review is True:
        active_result = await db.execute(
            select(PersonaMemory).where(
                PersonaMemory.user_id == user.id,
                PersonaMemory.persona_id == persona_id,
                PersonaMemory.is_active.is_(True),
                PersonaMemory.needs_review.is_(False),
            )
        )
        active_map = list(active_result.scalars().all())

    out: list[PersonaMemoryResponse] = []
    for m in rows:
        hints = _review_hints_for_row(m, active_map) if m.needs_review else None
        out.append(_to_memory_response(m, review_hints=hints))
    return out


@router.put("/personas/{persona_id}/memories/{memory_id}", response_model=PersonaMemoryResponse)
async def update_persona_memory(
    persona_id: str,
    memory_id: str,
    req: PersonaMemoryUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(PersonaMemory).where(
            PersonaMemory.user_id == user.id,
            PersonaMemory.persona_id == persona_id,
            PersonaMemory.id == memory_id,
        )
    )
    row = result.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Memory not found")

    patch = req.model_dump(exclude_unset=True)
    if "memory_type" in patch and patch["memory_type"] is not None:
        row.memory_type = patch["memory_type"]
    if "content" in patch and patch["content"] is not None:
        row.content = patch["content"]
    if "confidence" in patch and patch["confidence"] is not None:
        row.confidence = max(0.0, min(1.0, float(patch["confidence"])))
    if "is_active" in patch and patch["is_active"] is not None:
        row.is_active = bool(patch["is_active"])
    if "needs_review" in patch and patch["needs_review"] is not None:
        row.needs_review = bool(patch["needs_review"])
    if row.is_active:
        row.needs_review = False
    row.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(row)
    return _to_memory_response(row)


@router.delete("/personas/{persona_id}/memories/{memory_id}")
async def delete_persona_memory(
    persona_id: str,
    memory_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(PersonaMemory).where(
            PersonaMemory.user_id == user.id,
            PersonaMemory.persona_id == persona_id,
            PersonaMemory.id == memory_id,
        )
    )
    row = result.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Memory not found")

    await db.delete(row)
    await db.commit()
    return {"ok": True}


@router.post("/personas/{persona_id}/memories/{memory_id}/approve", response_model=PersonaMemoryResponse)
async def approve_persona_memory(
    persona_id: str,
    memory_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(PersonaMemory).where(
            PersonaMemory.user_id == user.id,
            PersonaMemory.persona_id == persona_id,
            PersonaMemory.id == memory_id,
        )
    )
    row = result.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Memory not found")

    active_result = await db.execute(
        select(PersonaMemory).where(
            PersonaMemory.user_id == user.id,
            PersonaMemory.persona_id == persona_id,
            PersonaMemory.is_active.is_(True),
            PersonaMemory.needs_review.is_(False),
            PersonaMemory.id != row.id,
        )
    )
    active_rows = list(active_result.scalars().all())
    same_key = [x for x in active_rows if _memory_key(x.content) == _memory_key(row.content)]

    exact_dup = [x for x in same_key if _norm_text(x.content) == _norm_text(row.content)]
    if exact_dup:
        keeper = exact_dup[0]
        keeper.updated_at = datetime.now(timezone.utc)
        keeper.confidence = max(float(keeper.confidence), float(row.confidence))
        row.is_active = False
        row.needs_review = False
    else:
        if len(same_key) >= 2:
            merged = _merge_texts([x.content for x in same_key] + [row.content])
            row.content = merged or row.content
        for old in same_key:
            old.is_active = False
            old.updated_at = datetime.now(timezone.utc)
        if same_key and row.memory_type != "correction":
            row.memory_type = "correction"
        row.is_active = True
        row.needs_review = False

    row.needs_review = False
    row.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(row)
    return _to_memory_response(row)


@router.post("/personas/{persona_id}/memories/{memory_id}/reject", response_model=PersonaMemoryResponse)
async def reject_persona_memory(
    persona_id: str,
    memory_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(PersonaMemory).where(
            PersonaMemory.user_id == user.id,
            PersonaMemory.persona_id == persona_id,
            PersonaMemory.id == memory_id,
        )
    )
    row = result.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Memory not found")
    row.is_active = False
    row.needs_review = False
    row.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(row)
    return _to_memory_response(row)


@router.get("/sessions/{session_id}/summary", response_model=SessionSummaryResponse)
async def get_session_summary(
    session_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(MemorySummary)
        .where(
            MemorySummary.user_id == user.id,
            MemorySummary.session_id == session_id,
        )
        .order_by(MemorySummary.created_at.desc())
        .limit(1)
    )
    row = result.scalar_one_or_none()
    if not row:
        return SessionSummaryResponse(session_id=session_id)
    return SessionSummaryResponse(
        session_id=session_id,
        summary_text=row.summary_text,
        message_range_start=row.message_range_start,
        message_range_end=row.message_range_end,
        token_count=row.token_count,
        created_at=row.created_at,
    )


@router.post("/sessions/{session_id}/compress", response_model=SessionCompressResponse)
async def compress_session_now(
    session_id: str,
    request: Request,
    user: User = Depends(get_current_user),
):
    summary_text, token_count = await force_compress_session(
        session_id=session_id,
        user_id=user.id,
        request_id=request.state.request_id,
        settings=settings,
    )
    if not summary_text:
        raise HTTPException(status_code=400, detail="No messages to compress")
    return SessionCompressResponse(
        session_id=session_id,
        summary_text=summary_text,
        token_count=token_count,
    )


@router.get("/stats")
async def memory_stats(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    mem_count = await db.execute(
        select(PersonaMemory.persona_id, func.count(PersonaMemory.id))
        .where(PersonaMemory.user_id == user.id)
        .group_by(PersonaMemory.persona_id)
    )
    emb_count = await db.execute(
        select(MemoryEmbedding.persona_id, func.count(MemoryEmbedding.id))
        .where(MemoryEmbedding.user_id == user.id)
        .group_by(MemoryEmbedding.persona_id)
    )
    emb_size = await db.execute(
        select(func.coalesce(func.sum(func.length(MemoryEmbedding.chunk_text) + func.length(MemoryEmbedding.embedding)), 0))
        .where(MemoryEmbedding.user_id == user.id)
    )

    memory_by_persona = {k: int(v) for k, v in mem_count.all()}
    embedding_by_persona = {k: int(v) for k, v in emb_count.all()}
    return {
        "memory_by_persona": memory_by_persona,
        "embedding_by_persona": embedding_by_persona,
        "embedding_storage_bytes_estimate": int(emb_size.scalar() or 0),
    }
