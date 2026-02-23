from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def _json_column():
    return JSONB


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    refresh_tokens: Mapped[list["RefreshToken"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    sessions: Mapped[list["ChatSession"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    personas: Mapped[list["Persona"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    project_types: Mapped[list["ProjectType"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    projects: Mapped[list["Project"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    layered_memories: Mapped[list["LayeredMemory"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    memory_summaries: Mapped[list["MemorySummary"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    persona_memories: Mapped[list["PersonaMemory"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    memory_embeddings: Mapped[list["MemoryEmbedding"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(256), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    user: Mapped["User"] = relationship(back_populates="refresh_tokens")


class ChatSession(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id"), primary_key=True, index=True
    )
    title: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[int] = mapped_column(BigInteger)
    updated_at: Mapped[int] = mapped_column(BigInteger, index=True)
    deleted_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True, index=True)
    persona_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("personas.id", ondelete="SET NULL"), nullable=True, index=True
    )
    project_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True
    )
    payload: Mapped[dict] = mapped_column(_json_column())

    user: Mapped["User"] = relationship(back_populates="sessions")
    persona: Mapped["Persona | None"] = relationship(back_populates="sessions")
    project: Mapped["Project | None"] = relationship(back_populates="sessions")


class Persona(Base):
    __tablename__ = "personas"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, unique=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id"), primary_key=True, index=True
    )
    name: Mapped[str] = mapped_column(String(100))
    avatar_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    system_prompt: Mapped[str] = mapped_column(Text)
    greeting: Mapped[str | None] = mapped_column(Text, nullable=True)
    example_messages: Mapped[list[dict]] = mapped_column(_json_column(), default=list)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    tags: Mapped[list[str]] = mapped_column(_json_column(), default=list)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    user: Mapped["User"] = relationship(back_populates="personas")
    sessions: Mapped[list["ChatSession"]] = relationship(back_populates="persona")
    layered_memories: Mapped[list["LayeredMemory"]] = relationship(
        back_populates="persona", overlaps="user"
    )
    memories: Mapped[list["PersonaMemory"]] = relationship(
        back_populates="persona", overlaps="persona_memories,user"
    )
    summaries: Mapped[list["MemorySummary"]] = relationship(
        back_populates="persona", overlaps="memory_summaries,user"
    )
    embeddings: Mapped[list["MemoryEmbedding"]] = relationship(
        back_populates="persona", overlaps="memory_embeddings,user"
    )


class Embedding(Base):
    __tablename__ = "embeddings"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    session_id: Mapped[str] = mapped_column(String(128), index=True)
    chunk_id: Mapped[str] = mapped_column(String(128))
    content: Mapped[str] = mapped_column(Text)
    embedding_vector: Mapped[list[float]] = mapped_column(_json_column())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ProjectType(Base):
    __tablename__ = "project_types"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    system_prompt_template: Mapped[str] = mapped_column(Text, nullable=False, default="")
    memory_strategy: Mapped[dict] = mapped_column(_json_column(), default=dict)
    features: Mapped[dict] = mapped_column(_json_column(), default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_project_types_user_name"),
    )

    user: Mapped["User"] = relationship(back_populates="project_types")
    projects: Mapped[list["Project"]] = relationship(
        back_populates="project_type", cascade="all, delete-orphan"
    )


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    project_type_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("project_types.id", ondelete="SET NULL"), nullable=True, index=True
    )
    context_doc: Mapped[dict] = mapped_column(_json_column(), default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_projects_user_name"),
    )

    user: Mapped["User"] = relationship(back_populates="projects")
    project_type: Mapped["ProjectType | None"] = relationship(back_populates="projects")
    sessions: Mapped[list["ChatSession"]] = relationship(back_populates="project")
    layered_memories: Mapped[list["LayeredMemory"]] = relationship(
        back_populates="project", overlaps="user,persona"
    )


class LayeredMemory(Base):
    __tablename__ = "layered_memories"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    scope: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    category: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    importance: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    character_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("personas.id", ondelete="SET NULL"), nullable=True, index=True
    )
    project_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True
    )
    source_session_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    supersedes_memory_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("layered_memories.id", ondelete="SET NULL"), nullable=True, index=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)

    user: Mapped["User"] = relationship(back_populates="layered_memories")
    persona: Mapped["Persona | None"] = relationship(
        back_populates="layered_memories", overlaps="layered_memories,user"
    )
    project: Mapped["Project | None"] = relationship(
        back_populates="layered_memories", overlaps="layered_memories,user,persona"
    )


class MemorySummary(Base):
    __tablename__ = "memory_summaries"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    session_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    persona_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    summary_text: Mapped[str] = mapped_column(Text, nullable=False)
    message_range_start: Mapped[int] = mapped_column(Integer, nullable=False)
    message_range_end: Mapped[int] = mapped_column(Integer, nullable=False)
    token_count: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)

    __table_args__ = (
        ForeignKeyConstraint(
            ["session_id", "user_id"],
            ["sessions.id", "sessions.user_id"],
            name="fk_memory_summaries_session_user",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["persona_id", "user_id"],
            ["personas.id", "personas.user_id"],
            name="fk_memory_summaries_persona_user",
            ondelete="SET NULL",
        ),
    )

    user: Mapped["User"] = relationship(
        back_populates="memory_summaries", overlaps="summaries,persona"
    )
    persona: Mapped["Persona | None"] = relationship(
        back_populates="summaries", overlaps="memory_summaries,user"
    )


class PersonaMemory(Base):
    __tablename__ = "persona_memories"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    persona_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    memory_type: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    source_session_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
    needs_review: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)

    __table_args__ = (
        ForeignKeyConstraint(
            ["persona_id", "user_id"],
            ["personas.id", "personas.user_id"],
            name="fk_persona_memories_persona_user",
            ondelete="CASCADE",
        ),
    )

    user: Mapped["User"] = relationship(
        back_populates="persona_memories", overlaps="memories,persona"
    )
    persona: Mapped["Persona"] = relationship(
        back_populates="memories", overlaps="persona_memories,user"
    )


class MemoryEmbedding(Base):
    __tablename__ = "memory_embeddings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    persona_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    session_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    chunk_text: Mapped[str] = mapped_column(Text, nullable=False)
    chunk_summary: Mapped[str] = mapped_column(Text, nullable=False)
    embedding: Mapped[str] = mapped_column(Text, nullable=False)
    model_name: Mapped[str] = mapped_column(String(100), nullable=False)
    vector_dim: Mapped[int] = mapped_column(Integer, nullable=False)
    message_range_start: Mapped[int] = mapped_column(Integer, nullable=False)
    message_range_end: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)

    __table_args__ = (
        UniqueConstraint(
            "session_id",
            "message_range_start",
            "message_range_end",
            name="uq_memory_embeddings_session_range",
        ),
        ForeignKeyConstraint(
            ["session_id", "user_id"],
            ["sessions.id", "sessions.user_id"],
            name="fk_memory_embeddings_session_user",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["persona_id", "user_id"],
            ["personas.id", "personas.user_id"],
            name="fk_memory_embeddings_persona_user",
            ondelete="SET NULL",
        ),
    )

    user: Mapped["User"] = relationship(
        back_populates="memory_embeddings", overlaps="embeddings,persona"
    )
    persona: Mapped["Persona | None"] = relationship(
        back_populates="embeddings", overlaps="memory_embeddings,user"
    )
