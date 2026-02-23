"""add personas and sessions.persona_id

Revision ID: 0003_add_personas
Revises: 0002_add_session_deleted_at
Create Date: 2026-02-17 00:00:00
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "0003_add_personas"
down_revision = "0002_add_session_deleted_at"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "personas",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("avatar_url", sa.String(length=500), nullable=True),
        sa.Column("system_prompt", sa.Text(), nullable=False),
        sa.Column("greeting", sa.Text(), nullable=True),
        sa.Column("example_messages", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("tags", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id", "user_id"),
    )
    op.create_index("ix_personas_user_id", "personas", ["user_id"])
    op.create_index("ix_personas_id", "personas", ["id"], unique=True)

    op.add_column("sessions", sa.Column("persona_id", sa.String(length=36), nullable=True))
    op.create_index("ix_sessions_persona_id", "sessions", ["persona_id"])
    op.create_foreign_key(
        "fk_sessions_persona_id_personas",
        "sessions",
        "personas",
        ["persona_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_sessions_persona_id_personas", "sessions", type_="foreignkey")
    op.drop_index("ix_sessions_persona_id", table_name="sessions")
    op.drop_column("sessions", "persona_id")

    op.drop_index("ix_personas_id", table_name="personas")
    op.drop_index("ix_personas_user_id", table_name="personas")
    op.drop_table("personas")
