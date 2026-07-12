"""Add durable sync client registry and ACK state.

Revision ID: space_009_sync_clients
Revises: space_008_sync_retention_snapshot
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "space_009_sync_clients"
down_revision = "space_008_sync_retention_snapshot"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    existing_tables = set(inspect(connection).get_table_names())
    if "sync_clients" in existing_tables:
        return

    op.create_table(
        "sync_clients",
        sa.Column("client_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("display_name", sa.String(length=80), nullable=True),
        sa.Column("ack_cursor", sa.Integer(), nullable=False),
        sa.Column("last_seen_at", sa.String(length=32), nullable=False),
        sa.Column("lease_expires_at", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.String(length=32), nullable=False),
        sa.Column("revoked_at", sa.String(length=32), nullable=True),
        sa.Column("snapshot_required", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("client_id", name=op.f("pk_sync_clients")),
    )
    op.create_index(
        "ix_sync_clients_watermark",
        "sync_clients",
        ["revoked_at", "lease_expires_at", "ack_cursor"],
        unique=False,
    )
    op.create_index(
        "ix_sync_clients_user_revoked",
        "sync_clients",
        ["user_id", "revoked_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_sync_clients_user_revoked", table_name="sync_clients")
    op.drop_index("ix_sync_clients_watermark", table_name="sync_clients")
    op.drop_table("sync_clients")
