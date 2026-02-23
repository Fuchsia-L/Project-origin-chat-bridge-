from __future__ import annotations

from datetime import datetime
from pydantic import BaseModel, Field


class LayeredMemoryCreate(BaseModel):
    scope: str
    category: str = Field(min_length=1, max_length=64)
    content: str = Field(min_length=1)
    importance: int = Field(default=3, ge=1, le=5)
    character_id: str | None = None
    project_id: str | None = None
    source_session_id: str | None = None
    supersedes_memory_id: str | None = None
    is_active: bool = True


class LayeredMemoryUpdate(BaseModel):
    category: str | None = Field(default=None, min_length=1, max_length=64)
    content: str | None = Field(default=None, min_length=1)
    importance: int | None = Field(default=None, ge=1, le=5)
    character_id: str | None = None
    project_id: str | None = None
    supersedes_memory_id: str | None = None
    is_active: bool | None = None


class LayeredMemoryResponse(BaseModel):
    id: str
    user_id: str
    scope: str
    category: str
    content: str
    importance: int
    character_id: str | None = None
    project_id: str | None = None
    source_session_id: str | None = None
    supersedes_memory_id: str | None = None
    is_active: bool
    created_at: datetime
    updated_at: datetime


class MemoryExtractRequest(BaseModel):
    conversation_summary: str = Field(min_length=1)
    character_id: str | None = None
    project_id: str | None = None
    session_id: str | None = None
    user_global_profile: dict | str | None = None
    character_profile: dict | str | None = None
    project_context: dict | str | None = None
    model: str | None = None
    persist: bool = True


class ExtractedMemoryItem(BaseModel):
    content: str
    scope: str
    category: str
    importance: int
    supersedes: str | None = None
    stored_id: str | None = None
    supersedes_memory_id: str | None = None


class MemoryExtractResponse(BaseModel):
    memories: list[ExtractedMemoryItem]
