"""add persona_memories.needs_review

Revision ID: 0005_add_memory_review_flag
Revises: 0004_add_memory_system
Create Date: 2026-02-19 00:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = "0005_add_memory_review_flag"
down_revision = "0004_add_memory_system"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "persona_memories",
        sa.Column("needs_review", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.create_index("ix_persona_memories_needs_review", "persona_memories", ["needs_review"])


def downgrade() -> None:
    op.drop_index("ix_persona_memories_needs_review", table_name="persona_memories")
    op.drop_column("persona_memories", "needs_review")
