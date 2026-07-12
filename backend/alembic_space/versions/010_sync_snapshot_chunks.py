"""Add chunked gzip snapshot manifests.

Revision ID: space_010_sync_snapshot_chunks
Revises: space_009_sync_clients
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "space_010_sync_snapshot_chunks"
down_revision = "space_009_sync_clients"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    inspector = inspect(connection)
    existing_tables = set(inspector.get_table_names())
    snapshot_columns = {
        column["name"] for column in inspector.get_columns("sync_snapshots")
    }
    additions = (
        ("format", sa.String(length=32), "'legacy-json-v1'"),
        ("status", sa.String(length=16), "'ready'"),
        ("item_count", sa.Integer(), "0"),
        ("chunk_count", sa.Integer(), "0"),
        ("uncompressed_bytes", sa.Integer(), "0"),
        ("compressed_bytes", sa.Integer(), "0"),
        ("checksum", sa.String(length=64), "''"),
        ("expires_at", sa.String(length=32), "''"),
    )
    for name, column_type, default in additions:
        if name not in snapshot_columns:
            op.add_column(
                "sync_snapshots",
                sa.Column(name, column_type, nullable=False, server_default=sa.text(default)),
            )

    if "sync_snapshot_chunks" not in existing_tables:
        op.create_table(
            "sync_snapshot_chunks",
            sa.Column("snapshot_token", sa.String(length=36), nullable=False),
            sa.Column("chunk_index", sa.Integer(), nullable=False),
            sa.Column("item_start", sa.Integer(), nullable=False),
            sa.Column("item_count", sa.Integer(), nullable=False),
            sa.Column("compressed_payload", sa.LargeBinary(), nullable=False),
            sa.Column("uncompressed_bytes", sa.Integer(), nullable=False),
            sa.Column("compressed_bytes", sa.Integer(), nullable=False),
            sa.Column("checksum", sa.String(length=64), nullable=False),
            sa.ForeignKeyConstraint(
                ["snapshot_token"],
                ["sync_snapshots.token"],
                name=op.f("fk_sync_snapshot_chunks_snapshot_token_sync_snapshots"),
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint(
                "snapshot_token", "chunk_index", name=op.f("pk_sync_snapshot_chunks")
            ),
        )
        op.create_index(
            "ix_sync_snapshot_chunks_offset",
            "sync_snapshot_chunks",
            ["snapshot_token", "item_start"],
            unique=True,
        )
    existing_indexes = {index["name"] for index in inspect(connection).get_indexes("sync_snapshots")}
    if "ix_sync_snapshots_expiry_status" not in existing_indexes:
        op.create_index(
            "ix_sync_snapshots_expiry_status",
            "sync_snapshots",
            ["expires_at", "status"],
            unique=False,
        )


def downgrade() -> None:
    op.drop_index("ix_sync_snapshot_chunks_offset", table_name="sync_snapshot_chunks")
    op.drop_table("sync_snapshot_chunks")
    op.drop_index("ix_sync_snapshots_expiry_status", table_name="sync_snapshots")
    for column in (
        "expires_at",
        "checksum",
        "compressed_bytes",
        "uncompressed_bytes",
        "chunk_count",
        "item_count",
        "status",
        "format",
    ):
        op.drop_column("sync_snapshots", column)
