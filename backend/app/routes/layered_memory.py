from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.core.config import settings
from app.db import get_db
from app.models import LayeredMemory, Persona, Project, User
from app.schemas.layered_memory import (
    ExtractedMemoryItem,
    LayeredMemoryCreate,
    LayeredMemoryResponse,
    LayeredMemoryUpdate,
    MemoryExtractRequest,
    MemoryExtractResponse,
)
from app.services.layered_memory_service import (
    ALLOWED_SCOPES,
    create_layered_memory_row,
    extract_layered_memories,
    resolve_supersedes_memory_id,
)

router = APIRouter(prefix="/layered-memory", tags=["layered-memory"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _to_response(row: LayeredMemory) -> LayeredMemoryResponse:
    return LayeredMemoryResponse(
        id=row.id,
        user_id=row.user_id,
        scope=row.scope,
        category=row.category,
        content=row.content,
        importance=row.importance,
        character_id=row.character_id,
        project_id=row.project_id,
        source_session_id=row.source_session_id,
        supersedes_memory_id=row.supersedes_memory_id,
        is_active=row.is_active,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def _assert_character_exists(db: AsyncSession, user_id: str, character_id: str | None) -> None:
    if not character_id:
        return
    result = await db.execute(select(Persona.id).where(Persona.id == character_id, Persona.user_id == user_id))
    if result.first() is None:
        raise HTTPException(status_code=404, detail="Character not found")


async def _assert_project_exists(db: AsyncSession, user_id: str, project_id: str | None) -> None:
    if not project_id:
        return
    result = await db.execute(select(Project.id).where(Project.id == project_id, Project.user_id == user_id))
    if result.first() is None:
        raise HTTPException(status_code=404, detail="Project not found")


async def _get_memory_or_404(db: AsyncSession, user_id: str, memory_id: str) -> LayeredMemory:
    result = await db.execute(
        select(LayeredMemory).where(LayeredMemory.id == memory_id, LayeredMemory.user_id == user_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Memory not found")
    return row


@router.post("", response_model=LayeredMemoryResponse)
async def create_memory(
    req: LayeredMemoryCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if req.scope not in ALLOWED_SCOPES:
        raise HTTPException(status_code=400, detail="Invalid scope")
    await _assert_character_exists(db, user.id, req.character_id)
    await _assert_project_exists(db, user.id, req.project_id)
    row = await create_layered_memory_row(
        db=db,
        user_id=user.id,
        scope=req.scope,
        category=req.category,
        content=req.content,
        importance=req.importance,
        character_id=req.character_id,
        project_id=req.project_id,
        source_session_id=req.source_session_id,
        supersedes_memory_id=req.supersedes_memory_id,
        is_active=req.is_active,
    )
    await db.commit()
    await db.refresh(row)
    return _to_response(row)


@router.get("", response_model=list[LayeredMemoryResponse])
async def list_memories(
    scope: str | None = Query(default=None),
    character_id: str | None = Query(default=None),
    project_id: str | None = Query(default=None),
    is_active: bool | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(LayeredMemory).where(LayeredMemory.user_id == user.id)
    if scope is not None:
        if scope not in ALLOWED_SCOPES:
            raise HTTPException(status_code=400, detail="Invalid scope")
        stmt = stmt.where(LayeredMemory.scope == scope)
    if character_id is not None:
        stmt = stmt.where(LayeredMemory.character_id == character_id)
    if project_id is not None:
        stmt = stmt.where(LayeredMemory.project_id == project_id)
    if is_active is not None:
        stmt = stmt.where(LayeredMemory.is_active.is_(is_active))

    result = await db.execute(stmt.order_by(LayeredMemory.updated_at.desc()))
    return [_to_response(x) for x in result.scalars().all()]


@router.put("/{memory_id}", response_model=LayeredMemoryResponse)
async def update_memory(
    memory_id: str,
    req: LayeredMemoryUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_memory_or_404(db, user.id, memory_id)
    patch = req.model_dump(exclude_unset=True)
    if "character_id" in patch:
        await _assert_character_exists(db, user.id, patch["character_id"])
    if "project_id" in patch:
        await _assert_project_exists(db, user.id, patch["project_id"])
    if "category" in patch and patch["category"] is not None:
        row.category = patch["category"]
    if "content" in patch and patch["content"] is not None:
        row.content = patch["content"]
    if "importance" in patch and patch["importance"] is not None:
        row.importance = patch["importance"]
    if "character_id" in patch:
        row.character_id = patch["character_id"]
    if "project_id" in patch:
        row.project_id = patch["project_id"]
    if "supersedes_memory_id" in patch:
        row.supersedes_memory_id = patch["supersedes_memory_id"]
    if "is_active" in patch and patch["is_active"] is not None:
        row.is_active = bool(patch["is_active"])
    row.updated_at = _now()
    await db.commit()
    await db.refresh(row)
    return _to_response(row)


@router.delete("/{memory_id}")
async def delete_memory(
    memory_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_memory_or_404(db, user.id, memory_id)
    await db.delete(row)
    await db.commit()
    return {"ok": True}


@router.post("/extract", response_model=MemoryExtractResponse)
async def extract_memories_endpoint(
    req: MemoryExtractRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _assert_character_exists(db, user.id, req.character_id)
    await _assert_project_exists(db, user.id, req.project_id)

    extracted = await extract_layered_memories(
        model=req.model or settings.llm_model,
        request_id=request.state.request_id,
        conversation_summary=req.conversation_summary,
        user_global_profile=req.user_global_profile,
        character_profile=req.character_profile,
        project_context=req.project_context,
    )

    out: list[ExtractedMemoryItem] = []
    for item in extracted:
        scope = item["scope"]
        if scope not in ALLOWED_SCOPES:
            continue
        category = item["category"]
        content = item["content"]
        importance = item["importance"]
        supersedes = item.get("supersedes")

        resolved_character_id = req.character_id if scope in {"character", "cross_session"} else None
        resolved_project_id = req.project_id if scope in {"project", "cross_session"} else None

        supersedes_id = None
        stored_id = None
        if req.persist:
            supersedes_id = await resolve_supersedes_memory_id(
                db=db,
                user_id=user.id,
                scope=scope,
                character_id=resolved_character_id,
                project_id=resolved_project_id,
                supersedes_hint=supersedes,
            )
            row = await create_layered_memory_row(
                db=db,
                user_id=user.id,
                scope=scope,
                category=category,
                content=content,
                importance=importance,
                character_id=resolved_character_id,
                project_id=resolved_project_id,
                source_session_id=req.session_id,
                supersedes_memory_id=supersedes_id,
                is_active=True,
            )
            stored_id = row.id

        out.append(
            ExtractedMemoryItem(
                content=content,
                scope=scope,
                category=category,
                importance=importance,
                supersedes=supersedes,
                stored_id=stored_id,
                supersedes_memory_id=supersedes_id,
            )
        )

    if req.persist:
        await db.commit()
    return MemoryExtractResponse(memories=out)
