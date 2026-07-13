"""Add hashed device credentials to sync clients.

Revision ID: space_011_sync_client_credentials
Revises: space_010_sync_snapshot_chunks
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "space_011_sync_client_credentials"
down_revision = "space_010_sync_snapshot_chunks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    columns = {
        column["name"] for column in inspect(connection).get_columns("sync_clients")
    }
    if "token_hash" not in columns:
        op.add_column(
            "sync_clients",
            sa.Column("token_hash", sa.String(length=64), nullable=True),
        )


def downgrade() -> None:
    columns = {
        column["name"] for column in inspect(op.get_bind()).get_columns("sync_clients")
    }
    if "token_hash" in columns:
        op.drop_column("sync_clients", "token_hash")
