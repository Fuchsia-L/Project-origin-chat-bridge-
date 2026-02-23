"""add project and layered memory foundation

Revision ID: 0006_layered_memory
Revises: 0005_add_memory_review_flag
Create Date: 2026-02-22 00:00:00
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0006_layered_memory"
down_revision = "0005_add_memory_review_flag"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "project_types",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("system_prompt_template", sa.Text(), nullable=False, server_default=""),
        sa.Column("memory_strategy", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("features", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "name", name="uq_project_types_user_name"),
    )
    op.create_index("ix_project_types_user_id", "project_types", ["user_id"])

    op.create_table(
        "projects",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("project_type_id", sa.String(length=36), nullable=True),
        sa.Column("context_doc", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["project_type_id"], ["project_types.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "name", name="uq_projects_user_name"),
    )
    op.create_index("ix_projects_user_id", "projects", ["user_id"])
    op.create_index("ix_projects_project_type_id", "projects", ["project_type_id"])

    op.add_column("sessions", sa.Column("project_id", sa.String(length=36), nullable=True))
    op.create_index("ix_sessions_project_id", "sessions", ["project_id"])
    op.create_foreign_key(
        "fk_sessions_project_id_projects",
        "sessions",
        "projects",
        ["project_id"],
        ["id"],
        ondelete="SET NULL",
    )

    op.create_table(
        "layered_memories",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("scope", sa.String(length=32), nullable=False),
        sa.Column("category", sa.String(length=64), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("importance", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("character_id", sa.String(length=36), nullable=True),
        sa.Column("project_id", sa.String(length=36), nullable=True),
        sa.Column("source_session_id", sa.String(length=128), nullable=True),
        sa.Column("supersedes_memory_id", sa.String(length=36), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["character_id"], ["personas.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["supersedes_memory_id"], ["layered_memories.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_layered_memories_user_id", "layered_memories", ["user_id"])
    op.create_index("ix_layered_memories_scope", "layered_memories", ["scope"])
    op.create_index("ix_layered_memories_category", "layered_memories", ["category"])
    op.create_index("ix_layered_memories_importance", "layered_memories", ["importance"])
    op.create_index("ix_layered_memories_character_id", "layered_memories", ["character_id"])
    op.create_index("ix_layered_memories_project_id", "layered_memories", ["project_id"])
    op.create_index("ix_layered_memories_source_session_id", "layered_memories", ["source_session_id"])
    op.create_index("ix_layered_memories_supersedes_memory_id", "layered_memories", ["supersedes_memory_id"])
    op.create_index("ix_layered_memories_is_active", "layered_memories", ["is_active"])
    op.create_index("ix_layered_memories_created_at", "layered_memories", ["created_at"])
    op.create_index("ix_layered_memories_updated_at", "layered_memories", ["updated_at"])


def downgrade() -> None:
    op.drop_index("ix_layered_memories_updated_at", table_name="layered_memories")
    op.drop_index("ix_layered_memories_created_at", table_name="layered_memories")
    op.drop_index("ix_layered_memories_is_active", table_name="layered_memories")
    op.drop_index("ix_layered_memories_supersedes_memory_id", table_name="layered_memories")
    op.drop_index("ix_layered_memories_source_session_id", table_name="layered_memories")
    op.drop_index("ix_layered_memories_project_id", table_name="layered_memories")
    op.drop_index("ix_layered_memories_character_id", table_name="layered_memories")
    op.drop_index("ix_layered_memories_importance", table_name="layered_memories")
    op.drop_index("ix_layered_memories_category", table_name="layered_memories")
    op.drop_index("ix_layered_memories_scope", table_name="layered_memories")
    op.drop_index("ix_layered_memories_user_id", table_name="layered_memories")
    op.drop_table("layered_memories")

    op.drop_constraint("fk_sessions_project_id_projects", "sessions", type_="foreignkey")
    op.drop_index("ix_sessions_project_id", table_name="sessions")
    op.drop_column("sessions", "project_id")

    op.drop_index("ix_projects_project_type_id", table_name="projects")
    op.drop_index("ix_projects_user_id", table_name="projects")
    op.drop_table("projects")

    op.drop_index("ix_project_types_user_id", table_name="project_types")
    op.drop_table("project_types")
