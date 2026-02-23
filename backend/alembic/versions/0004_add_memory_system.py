"""add memory system tables

Revision ID: 0004_add_memory_system
Revises: 0003_add_personas
Create Date: 2026-02-18 00:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = "0004_add_memory_system"
down_revision = "0003_add_personas"
branch_labels = None
depends_on = None


def _has_table(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _has_index(table_name: str, index_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    try:
        indexes = inspector.get_indexes(table_name)
    except Exception:
        return False
    return any(idx.get("name") == index_name for idx in indexes)


def upgrade() -> None:
    if not _has_table("memory_summaries"):
        op.create_table(
            "memory_summaries",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("user_id", sa.String(length=64), nullable=False),
            sa.Column("session_id", sa.String(length=128), nullable=False),
            sa.Column("persona_id", sa.String(length=36), nullable=True),
            sa.Column("summary_text", sa.Text(), nullable=False),
            sa.Column("message_range_start", sa.Integer(), nullable=False),
            sa.Column("message_range_end", sa.Integer(), nullable=False),
            sa.Column("token_count", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
            sa.ForeignKeyConstraint(
                ["session_id", "user_id"],
                ["sessions.id", "sessions.user_id"],
                name="fk_memory_summaries_session_user",
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["persona_id", "user_id"],
                ["personas.id", "personas.user_id"],
                name="fk_memory_summaries_persona_user",
                ondelete="SET NULL",
            ),
            sa.PrimaryKeyConstraint("id"),
        )
    if not _has_index("memory_summaries", "ix_memory_summaries_user_id"):
        op.create_index("ix_memory_summaries_user_id", "memory_summaries", ["user_id"])
    if not _has_index("memory_summaries", "ix_memory_summaries_session_id"):
        op.create_index("ix_memory_summaries_session_id", "memory_summaries", ["session_id"])
    if not _has_index("memory_summaries", "ix_memory_summaries_persona_id"):
        op.create_index("ix_memory_summaries_persona_id", "memory_summaries", ["persona_id"])
    if not _has_index("memory_summaries", "ix_memory_summaries_created_at"):
        op.create_index("ix_memory_summaries_created_at", "memory_summaries", ["created_at"])

    if not _has_table("persona_memories"):
        op.create_table(
            "persona_memories",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("user_id", sa.String(length=64), nullable=False),
            sa.Column("persona_id", sa.String(length=36), nullable=False),
            sa.Column("memory_type", sa.String(length=50), nullable=False),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("source_session_id", sa.String(length=128), nullable=True),
            sa.Column("confidence", sa.Float(), nullable=False, server_default=sa.text("1.0")),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
            sa.ForeignKeyConstraint(
                ["persona_id", "user_id"],
                ["personas.id", "personas.user_id"],
                name="fk_persona_memories_persona_user",
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id"),
        )
    if not _has_index("persona_memories", "ix_persona_memories_user_id"):
        op.create_index("ix_persona_memories_user_id", "persona_memories", ["user_id"])
    if not _has_index("persona_memories", "ix_persona_memories_persona_id"):
        op.create_index("ix_persona_memories_persona_id", "persona_memories", ["persona_id"])
    if not _has_index("persona_memories", "ix_persona_memories_memory_type"):
        op.create_index("ix_persona_memories_memory_type", "persona_memories", ["memory_type"])
    if not _has_index("persona_memories", "ix_persona_memories_source_session_id"):
        op.create_index("ix_persona_memories_source_session_id", "persona_memories", ["source_session_id"])
    if not _has_index("persona_memories", "ix_persona_memories_is_active"):
        op.create_index("ix_persona_memories_is_active", "persona_memories", ["is_active"])
    if not _has_index("persona_memories", "ix_persona_memories_created_at"):
        op.create_index("ix_persona_memories_created_at", "persona_memories", ["created_at"])
    if not _has_index("persona_memories", "ix_persona_memories_updated_at"):
        op.create_index("ix_persona_memories_updated_at", "persona_memories", ["updated_at"])

    if not _has_table("memory_embeddings"):
        op.create_table(
            "memory_embeddings",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("user_id", sa.String(length=64), nullable=False),
            sa.Column("persona_id", sa.String(length=36), nullable=True),
            sa.Column("session_id", sa.String(length=128), nullable=False),
            sa.Column("chunk_text", sa.Text(), nullable=False),
            sa.Column("chunk_summary", sa.Text(), nullable=False),
            sa.Column("embedding", sa.Text(), nullable=False),
            sa.Column("model_name", sa.String(length=100), nullable=False),
            sa.Column("vector_dim", sa.Integer(), nullable=False),
            sa.Column("message_range_start", sa.Integer(), nullable=False),
            sa.Column("message_range_end", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
            sa.ForeignKeyConstraint(
                ["session_id", "user_id"],
                ["sessions.id", "sessions.user_id"],
                name="fk_memory_embeddings_session_user",
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["persona_id", "user_id"],
                ["personas.id", "personas.user_id"],
                name="fk_memory_embeddings_persona_user",
                ondelete="SET NULL",
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint(
                "session_id",
                "message_range_start",
                "message_range_end",
                name="uq_memory_embeddings_session_range",
            ),
        )
    if not _has_index("memory_embeddings", "ix_memory_embeddings_user_id"):
        op.create_index("ix_memory_embeddings_user_id", "memory_embeddings", ["user_id"])
    if not _has_index("memory_embeddings", "ix_memory_embeddings_persona_id"):
        op.create_index("ix_memory_embeddings_persona_id", "memory_embeddings", ["persona_id"])
    if not _has_index("memory_embeddings", "ix_memory_embeddings_session_id"):
        op.create_index("ix_memory_embeddings_session_id", "memory_embeddings", ["session_id"])
    if not _has_index("memory_embeddings", "ix_memory_embeddings_created_at"):
        op.create_index("ix_memory_embeddings_created_at", "memory_embeddings", ["created_at"])


def downgrade() -> None:
    if _has_table("memory_embeddings"):
        if _has_index("memory_embeddings", "ix_memory_embeddings_created_at"):
            op.drop_index("ix_memory_embeddings_created_at", table_name="memory_embeddings")
        if _has_index("memory_embeddings", "ix_memory_embeddings_session_id"):
            op.drop_index("ix_memory_embeddings_session_id", table_name="memory_embeddings")
        if _has_index("memory_embeddings", "ix_memory_embeddings_persona_id"):
            op.drop_index("ix_memory_embeddings_persona_id", table_name="memory_embeddings")
        if _has_index("memory_embeddings", "ix_memory_embeddings_user_id"):
            op.drop_index("ix_memory_embeddings_user_id", table_name="memory_embeddings")
        op.drop_table("memory_embeddings")

    if _has_table("persona_memories"):
        if _has_index("persona_memories", "ix_persona_memories_updated_at"):
            op.drop_index("ix_persona_memories_updated_at", table_name="persona_memories")
        if _has_index("persona_memories", "ix_persona_memories_created_at"):
            op.drop_index("ix_persona_memories_created_at", table_name="persona_memories")
        if _has_index("persona_memories", "ix_persona_memories_is_active"):
            op.drop_index("ix_persona_memories_is_active", table_name="persona_memories")
        if _has_index("persona_memories", "ix_persona_memories_source_session_id"):
            op.drop_index("ix_persona_memories_source_session_id", table_name="persona_memories")
        if _has_index("persona_memories", "ix_persona_memories_memory_type"):
            op.drop_index("ix_persona_memories_memory_type", table_name="persona_memories")
        if _has_index("persona_memories", "ix_persona_memories_persona_id"):
            op.drop_index("ix_persona_memories_persona_id", table_name="persona_memories")
        if _has_index("persona_memories", "ix_persona_memories_user_id"):
            op.drop_index("ix_persona_memories_user_id", table_name="persona_memories")
        op.drop_table("persona_memories")

    if _has_table("memory_summaries"):
        if _has_index("memory_summaries", "ix_memory_summaries_created_at"):
            op.drop_index("ix_memory_summaries_created_at", table_name="memory_summaries")
        if _has_index("memory_summaries", "ix_memory_summaries_persona_id"):
            op.drop_index("ix_memory_summaries_persona_id", table_name="memory_summaries")
        if _has_index("memory_summaries", "ix_memory_summaries_session_id"):
            op.drop_index("ix_memory_summaries_session_id", table_name="memory_summaries")
        if _has_index("memory_summaries", "ix_memory_summaries_user_id"):
            op.drop_index("ix_memory_summaries_user_id", table_name="memory_summaries")
        op.drop_table("memory_summaries")
