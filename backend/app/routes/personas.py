from datetime import datetime, timezone
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.db import get_db
from app.models import Persona, User
from app.schemas.personas import (
    PersonaCreate,
    PersonaListResponse,
    PersonaResponse,
    PersonaUpdate,
)

router = APIRouter(prefix="/personas", tags=["personas"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _to_response(persona: Persona) -> PersonaResponse:
    return PersonaResponse(
        id=persona.id,
        user_id=persona.user_id,
        name=persona.name,
        avatar_url=persona.avatar_url,
        system_prompt=persona.system_prompt,
        greeting=persona.greeting,
        example_messages=persona.example_messages or [],
        description=persona.description,
        tags=persona.tags or [],
        is_default=persona.is_default,
        created_at=persona.created_at,
        updated_at=persona.updated_at,
    )


async def _get_persona_or_404(db: AsyncSession, user_id: str, persona_id: str) -> Persona:
    result = await db.execute(
        select(Persona).where(Persona.user_id == user_id, Persona.id == persona_id)
    )
    persona = result.scalar_one_or_none()
    if not persona:
        raise HTTPException(status_code=404, detail="Persona not found")
    return persona


async def _clear_default_persona(db: AsyncSession, user_id: str, except_id: str | None = None) -> None:
    stmt = update(Persona).where(Persona.user_id == user_id)
    if except_id is not None:
        stmt = stmt.where(Persona.id != except_id)
    await db.execute(stmt.values(is_default=False, updated_at=_now()))


@router.post("", response_model=PersonaResponse)
async def create_persona(
    req: PersonaCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    now = _now()
    persona = Persona(
        id=str(uuid.uuid4()),
        user_id=user.id,
        name=req.name,
        avatar_url=req.avatar_url,
        system_prompt=req.system_prompt,
        greeting=req.greeting,
        example_messages=[m.model_dump() for m in req.example_messages],
        description=req.description,
        tags=req.tags,
        is_default=bool(req.is_default),
        created_at=now,
        updated_at=now,
    )
    db.add(persona)
    if persona.is_default:
        await _clear_default_persona(db, user.id, except_id=persona.id)
    await db.commit()
    await db.refresh(persona)
    return _to_response(persona)


@router.get("", response_model=PersonaListResponse)
async def list_personas(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Persona)
        .where(Persona.user_id == user.id)
        .order_by(Persona.updated_at.desc())
    )
    personas = [_to_response(p) for p in result.scalars().all()]
    return PersonaListResponse(personas=personas)


@router.get("/{persona_id}", response_model=PersonaResponse)
async def get_persona(
    persona_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    persona = await _get_persona_or_404(db, user.id, persona_id)
    return _to_response(persona)


@router.put("/{persona_id}", response_model=PersonaResponse)
async def update_persona(
    persona_id: str,
    req: PersonaUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    persona = await _get_persona_or_404(db, user.id, persona_id)
    patch = req.model_dump(exclude_unset=True)

    if "name" in patch:
        persona.name = patch["name"]
    if "avatar_url" in patch:
        persona.avatar_url = patch["avatar_url"]
    if "system_prompt" in patch:
        persona.system_prompt = patch["system_prompt"]
    if "greeting" in patch:
        persona.greeting = patch["greeting"]
    if "example_messages" in patch:
        persona.example_messages = patch["example_messages"] or []
    if "description" in patch:
        persona.description = patch["description"]
    if "tags" in patch:
        persona.tags = patch["tags"] or []
    if "is_default" in patch:
        persona.is_default = bool(patch["is_default"])

    if persona.is_default:
        await _clear_default_persona(db, user.id, except_id=persona.id)

    persona.updated_at = _now()
    await db.commit()
    await db.refresh(persona)
    return _to_response(persona)


@router.delete("/{persona_id}")
async def delete_persona(
    persona_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    persona = await _get_persona_or_404(db, user.id, persona_id)
    await db.delete(persona)
    await db.commit()
    return {"ok": True}


@router.post("/{persona_id}/duplicate", response_model=PersonaResponse)
async def duplicate_persona(
    persona_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    source = await _get_persona_or_404(db, user.id, persona_id)
    now = _now()
    duplicate = Persona(
        id=str(uuid.uuid4()),
        user_id=user.id,
        name=f"{source.name} (副本)",
        avatar_url=source.avatar_url,
        system_prompt=source.system_prompt,
        greeting=source.greeting,
        example_messages=source.example_messages or [],
        description=source.description,
        tags=source.tags or [],
        is_default=False,
        created_at=now,
        updated_at=now,
    )
    db.add(duplicate)
    await db.commit()
    await db.refresh(duplicate)
    return _to_response(duplicate)
