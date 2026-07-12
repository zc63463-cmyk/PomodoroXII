"""Add persistent sync retention state and materialized snapshots.

Revision ID: space_008_sync_retention_snapshot
Revises: space_007_session_mood_check
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "space_008_sync_retention_snapshot"
down_revision = "space_007_session_mood_check"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    existing_tables = set(inspect(connection).get_table_names())

    if "sync_state" not in existing_tables:
        op.create_table(
            "sync_state",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("retention_floor", sa.Integer(), nullable=False),
            sa.Column("current_cursor", sa.Integer(), nullable=False),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_sync_state")),
        )
    op.execute(
        "INSERT OR IGNORE INTO sync_state (id, retention_floor, current_cursor) "
        "SELECT 1, 0, COALESCE(MAX(id), 0) FROM sync_outbox"
    )

    if "sync_snapshots" not in existing_tables:
        op.create_table(
            "sync_snapshots",
            sa.Column("token", sa.String(length=36), nullable=False),
            sa.Column("cursor", sa.Integer(), nullable=False),
            sa.Column("payload", sa.Text(), nullable=False),
            sa.Column("created_at", sa.String(length=32), nullable=False),
            sa.PrimaryKeyConstraint("token", name=op.f("pk_sync_snapshots")),
        )


def downgrade() -> None:
    op.drop_table("sync_snapshots")
    op.drop_table("sync_state")
