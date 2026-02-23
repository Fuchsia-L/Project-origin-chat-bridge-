"""add sessions.deleted_at

Revision ID: 0002_add_session_deleted_at
Revises: 0001_initial
Create Date: 2026-02-14 00:00:00
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0002_add_session_deleted_at"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sessions", sa.Column("deleted_at", sa.BigInteger(), nullable=True))
    op.create_index("ix_sessions_deleted_at", "sessions", ["deleted_at"])


def downgrade() -> None:
    op.drop_index("ix_sessions_deleted_at", table_name="sessions")
    op.drop_column("sessions", "deleted_at")
