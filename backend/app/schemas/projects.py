from __future__ import annotations

from datetime import datetime
from pydantic import BaseModel, Field


class ProjectTypeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    system_prompt_template: str = ""
    memory_strategy: dict = Field(default_factory=dict)
    features: dict = Field(default_factory=dict)


class ProjectTypeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    system_prompt_template: str | None = None
    memory_strategy: dict | None = None
    features: dict | None = None


class ProjectTypeResponse(BaseModel):
    id: str
    user_id: str
    name: str
    system_prompt_template: str
    memory_strategy: dict
    features: dict
    created_at: datetime
    updated_at: datetime


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    project_type_id: str | None = None
    context_doc: dict = Field(default_factory=dict)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    project_type_id: str | None = None
    context_doc: dict | None = None


class ProjectResponse(BaseModel):
    id: str
    user_id: str
    name: str
    project_type_id: str | None = None
    context_doc: dict
    created_at: datetime
    updated_at: datetime
