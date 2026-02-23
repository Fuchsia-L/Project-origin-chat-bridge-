import json
import time

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.core.config import settings
from app.db import get_db
from app.models import ChatSession, User
from app.schemas.sessions import (
    PullRequest,
    PullResponse,
    PushRequest,
    PushResponse,
    SessionListItem,
    SessionListResponse,
    SessionPayload,
)

router = APIRouter(prefix="/sessions", tags=["sessions"])


def _payload_size(sessions: list[SessionPayload]) -> int:
    try:
        return len(json.dumps([s.model_dump() for s in sessions]).encode("utf-8"))
    except Exception:
        return 0


def _tombstone_cutoff_ms() -> int | None:
    ttl_days = settings.session_tombstone_ttl_days
    if ttl_days is None or ttl_days <= 0:
        return None
    return int(time.time() * 1000) - ttl_days * 24 * 60 * 60 * 1000


async def _cleanup_tombstones(db: AsyncSession, user_id: str) -> None:
    cutoff = _tombstone_cutoff_ms()
    if cutoff is None:
        return
    await db.execute(
        delete(ChatSession).where(
            ChatSession.user_id == user_id,
            ChatSession.deleted_at.is_not(None),
            ChatSession.deleted_at <= cutoff,
        )
    )


@router.get("/list", response_model=SessionListResponse)
async def list_sessions(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatSession)
        .where(
            ChatSession.user_id == user.id,
            ChatSession.deleted_at.is_(None),
        )
        .order_by(ChatSession.updated_at.desc())
    )
    sessions = [
        SessionListItem(
            id=s.id,
            title=s.title,
            createdAt=s.created_at,
            updatedAt=s.updated_at,
        )
        for s in result.scalars().all()
    ]
    return SessionListResponse(sessions=sessions)


@router.post("/pull", response_model=PullResponse)
async def pull_sessions(
    req: PullRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(ChatSession).where(ChatSession.user_id == user.id)
    if req.since is not None:
        stmt = stmt.where(
            or_(
                ChatSession.updated_at > req.since,
                ChatSession.deleted_at > req.since,
            )
        )
    else:
        stmt = stmt.where(ChatSession.deleted_at.is_(None))
    result = await db.execute(stmt.order_by(ChatSession.updated_at.desc()))
    sessions = []
    for s in result.scalars().all():
        payload = s.payload or {}
        payload.setdefault("id", s.id)
        payload.setdefault("title", s.title)
        payload.setdefault("createdAt", s.created_at)
        payload.setdefault("updatedAt", s.updated_at)
        payload.setdefault("persona_id", s.persona_id)
        payload.setdefault("project_id", s.project_id)
        if s.deleted_at is not None:
            payload["deletedAt"] = s.deleted_at
            payload.setdefault("messages", [])
            payload.setdefault("settings", {})
        sessions.append(SessionPayload.model_validate(payload))
    await _cleanup_tombstones(db, user.id)
    await db.commit()
    return PullResponse(sessions=sessions)


@router.post("/push", response_model=PushResponse)
async def push_sessions(
    req: PushRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if settings.sync_max_sessions is not None and len(req.sessions) > settings.sync_max_sessions:
        raise HTTPException(status_code=413, detail="Too many sessions in one push")

    if settings.sync_max_bytes is not None:
        size = _payload_size(req.sessions)
        if size > settings.sync_max_bytes:
            raise HTTPException(status_code=413, detail="Payload too large")

    accepted: list[str] = []
    conflicts: list[str] = []

    for payload in req.sessions:
        result = await db.execute(
            select(ChatSession).where(
                ChatSession.user_id == user.id,
                ChatSession.id == payload.id,
            )
        )
        existing = result.scalar_one_or_none()
        if existing is None:
            row = ChatSession(
                id=payload.id,
                user_id=user.id,
                title=payload.title,
                created_at=payload.createdAt,
                updated_at=payload.updatedAt,
                deleted_at=payload.deletedAt,
                persona_id=payload.persona_id,
                project_id=payload.project_id,
                payload=payload.model_dump(),
            )
            db.add(row)
            accepted.append(payload.id)
            continue

        if existing.deleted_at is not None and payload.deletedAt is None:
            conflicts.append(payload.id)
            continue

        if payload.updatedAt >= existing.updated_at:
            existing.title = payload.title
            existing.created_at = payload.createdAt
            existing.updated_at = payload.updatedAt
            existing.deleted_at = payload.deletedAt
            existing.persona_id = payload.persona_id
            existing.project_id = payload.project_id
            existing.payload = payload.model_dump()
            accepted.append(payload.id)
        else:
            conflicts.append(payload.id)

    await _cleanup_tombstones(db, user.id)
    await db.commit()
    return PushResponse(accepted=accepted, conflicts=conflicts)
