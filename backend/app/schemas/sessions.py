from typing import Any

from pydantic import BaseModel


class SessionSettings(BaseModel):
    system_prompt: str | None = None
    model: str | None = None
    temperature: float | None = None
    stream: bool | None = None


class SessionMessage(BaseModel):
    role: str
    content: str | None = None
    meta: dict[str, Any] | None = None


class SessionPayload(BaseModel):
    id: str
    title: str
    createdAt: int
    updatedAt: int
    deletedAt: int | None = None
    persona_id: str | None = None
    project_id: str | None = None
    messages: list[SessionMessage]
    settings: SessionSettings


class SessionListItem(BaseModel):
    id: str
    title: str
    createdAt: int
    updatedAt: int


class SessionListResponse(BaseModel):
    sessions: list[SessionListItem]


class PullRequest(BaseModel):
    since: int | None = None


class PullResponse(BaseModel):
    sessions: list[SessionPayload]


class PushRequest(BaseModel):
    sessions: list[SessionPayload]


class PushResponse(BaseModel):
    accepted: list[str]
    conflicts: list[str]
