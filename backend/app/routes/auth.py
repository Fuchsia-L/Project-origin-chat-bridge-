from datetime import datetime, timedelta, timezone
import uuid

import jwt
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import create_token, decode_token, hash_password, hash_token, verify_password
from app.db import get_db
from app.models import RefreshToken, User
from app.schemas.auth import (
    AuthLoginRequest,
    AuthRefreshRequest,
    AuthRegisterRequest,
    AuthLogoutRequest,
    AuthResponse,
    AuthUser,
)

router = APIRouter(prefix="/auth", tags=["auth"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _issue_tokens(db: AsyncSession, user: User) -> AuthResponse:
    access = create_token(user.id, "access", settings.jwt_access_ttl)
    refresh = create_token(user.id, "refresh", settings.jwt_refresh_ttl)
    refresh_row = RefreshToken(
        id=f"rt_{uuid.uuid4().hex}",
        user_id=user.id,
        token_hash=hash_token(refresh),
        expires_at=_now() + timedelta(seconds=settings.jwt_refresh_ttl),
        revoked_at=None,
        created_at=_now(),
    )
    db.add(refresh_row)
    await db.commit()
    return AuthResponse(
        access_token=access,
        refresh_token=refresh,
        user=AuthUser(id=user.id, email=user.email),
    )


@router.post("/register", response_model=AuthResponse)
async def register(req: AuthRegisterRequest, db: AsyncSession = Depends(get_db)):
    if len(req.password) < settings.password_min_length:
        raise HTTPException(
            status_code=400,
            detail=f"Password too short (min {settings.password_min_length})",
        )
    if len(req.password.encode("utf-8")) > 72:
        raise HTTPException(status_code=400, detail="Password too long (max 72 bytes)")
    result = await db.execute(select(User).where(User.email == req.email))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Email already registered")

    now = _now()
    user = User(
        id=f"u_{uuid.uuid4().hex}",
        email=req.email,
        password_hash=hash_password(req.password),
        created_at=now,
        updated_at=now,
    )
    db.add(user)
    await db.commit()
    return await _issue_tokens(db, user)


@router.post("/login", response_model=AuthResponse)
async def login(req: AuthLoginRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.email == req.email))
    user = result.scalar_one_or_none()
    if not user or not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return await _issue_tokens(db, user)


@router.post("/refresh", response_model=AuthResponse)
async def refresh(req: AuthRefreshRequest, db: AsyncSession = Depends(get_db)):
    try:
        payload = decode_token(req.refresh_token, "refresh")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    token_hash = hash_token(req.refresh_token)
    result = await db.execute(
        select(RefreshToken)
        .where(
            RefreshToken.user_id == user_id,
            RefreshToken.token_hash == token_hash,
        )
        .order_by(RefreshToken.created_at.desc())
    )
    stored = result.scalars().first()
    if not stored or stored.revoked_at is not None or stored.expires_at <= _now():
        raise HTTPException(status_code=401, detail="Refresh token expired or revoked")
    stored.revoked_at = _now()
    await db.commit()
    return await _issue_tokens(db, user)


@router.post("/logout")
async def logout(req: AuthLogoutRequest, db: AsyncSession = Depends(get_db)):
    token_hash = hash_token(req.refresh_token)
    result = await db.execute(
        select(RefreshToken).where(RefreshToken.token_hash == token_hash)
    )
    tokens = result.scalars().all()
    changed = False
    for stored in tokens:
        if stored.revoked_at is None:
            stored.revoked_at = _now()
            changed = True
    if changed:
        await db.commit()
    return {"ok": True}
