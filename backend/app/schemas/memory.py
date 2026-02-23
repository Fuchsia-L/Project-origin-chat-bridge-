from __future__ import annotations

from datetime import datetime
from pydantic import BaseModel


class PersonaMemoryUpdate(BaseModel):
    memory_type: str | None = None
    content: str | None = None
    confidence: float | None = None
    is_active: bool | None = None
    needs_review: bool | None = None


class PersonaMemoryResponse(BaseModel):
    id: str
    user_id: str
    persona_id: str
    memory_type: str
    content: str
    confidence: float
    is_active: bool
    needs_review: bool
    source_session_id: str | None = None
    review_hints: list[str] | None = None
    created_at: datetime
    updated_at: datetime


class SessionSummaryResponse(BaseModel):
    session_id: str
    summary_text: str | None = None
    message_range_start: int | None = None
    message_range_end: int | None = None
    token_count: int | None = None
    created_at: datetime | None = None


class SessionCompressResponse(BaseModel):
    session_id: str
    summary_text: str | None = None
    token_count: int = 0
