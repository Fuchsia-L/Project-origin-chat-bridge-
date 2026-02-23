from datetime import datetime

from typing import Literal

from pydantic import BaseModel, Field


class PersonaExampleMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class PersonaCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    system_prompt: str = Field(min_length=1)
    avatar_url: str | None = Field(default=None, max_length=500)
    greeting: str | None = None
    example_messages: list[PersonaExampleMessage] = Field(default_factory=list)
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    is_default: bool = False


class PersonaUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    system_prompt: str | None = Field(default=None, min_length=1)
    avatar_url: str | None = Field(default=None, max_length=500)
    greeting: str | None = None
    example_messages: list[PersonaExampleMessage] | None = None
    description: str | None = None
    tags: list[str] | None = None
    is_default: bool | None = None


class PersonaResponse(BaseModel):
    id: str
    user_id: str
    name: str
    avatar_url: str | None = None
    system_prompt: str
    greeting: str | None = None
    example_messages: list[PersonaExampleMessage] = Field(default_factory=list)
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    is_default: bool
    created_at: datetime
    updated_at: datetime


class PersonaListResponse(BaseModel):
    personas: list[PersonaResponse]
