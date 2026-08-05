"""Add Sync v2 client and bounded recovery storage."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "space_011_sync_clients_streaming"
down_revision = "space_010_task_space_focus_session"
branch_labels = None
depends_on = None


def _add_tombstone_delete_sequence() -> None:
    connection = op.get_bind()
    inspector = inspect(connection)
    columns = {column["name"] for column in inspector.get_columns("tombstones")}
    indexes = {index["name"] for index in inspector.get_indexes("tombstones")}
    checks = {
        constraint["name"]
        for constraint in inspector.get_check_constraints("tombstones")
    }
    with op.batch_alter_table("tombstones") as batch_op:
        if "delete_sequence" not in columns:
            batch_op.add_column(sa.Column("delete_sequence", sa.Integer(), nullable=True))
        if "ix_tombstones_delete_sequence" not in indexes:
            batch_op.create_index("ix_tombstones_delete_sequence", ["delete_sequence"])
        if "ck_tombstones_delete_sequence_nonnegative" not in checks:
            batch_op.create_check_constraint(
                op.f("ck_tombstones_delete_sequence_nonnegative"),
                "delete_sequence IS NULL OR delete_sequence >= 0",
            )


def upgrade() -> None:
    op.create_table(
        "sync_clients",
        sa.Column("client_id", sa.String(64), primary_key=True),
        sa.Column("ack_sequence", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("catalog_hash", sa.String(64), nullable=False),
        sa.Column("registered_at", sa.String(32), nullable=False),
        sa.Column("last_seen_at", sa.String(32), nullable=False),
        sa.Column("expires_at", sa.String(32), nullable=False),
        sa.Column("requires_recovery", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("recovery_generation", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("recovery_manifest_token", sa.String(64), nullable=True),
        sa.Column("recovery_waterline", sa.Integer(), nullable=True),
        sa.Column("recovery_completed_at", sa.String(32), nullable=True),
        sa.CheckConstraint(
            "ack_sequence >= 0",
            name=op.f("ck_sync_clients_ack_nonnegative"),
        ),
        sa.CheckConstraint(
            "recovery_generation >= 0",
            name=op.f("ck_sync_clients_generation_nonnegative"),
        ),
        sa.CheckConstraint(
            "recovery_waterline IS NULL OR recovery_waterline >= 0",
            name=op.f("ck_sync_clients_recovery_waterline_nonnegative"),
        ),
    )
    op.create_index("ix_sync_clients_expires_at", "sync_clients", ["expires_at"])
    op.create_table(
        "sync_recovery_manifests",
        sa.Column("token", sa.String(64), primary_key=True),
        sa.Column("space_id", sa.String(64), nullable=False),
        sa.Column("client_id", sa.String(64), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("catalog_hash", sa.String(64), nullable=False),
        sa.Column("waterline", sa.Integer(), nullable=False),
        sa.Column("total_entities", sa.Integer(), nullable=False),
        sa.Column("total_chunks", sa.Integer(), nullable=False),
        sa.Column("total_uncompressed_bytes", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("expires_at", sa.String(32), nullable=False),
        sa.Column("manifest_sha256", sa.String(64), nullable=False),
        sa.CheckConstraint(
            "generation >= 0",
            name=op.f("ck_sync_recovery_manifests_generation_nonnegative"),
        ),
        sa.CheckConstraint(
            "waterline >= 0",
            name=op.f("ck_sync_recovery_manifests_waterline_nonnegative"),
        ),
        sa.CheckConstraint(
            "total_entities >= 0",
            name=op.f("ck_sync_recovery_manifests_entities_nonnegative"),
        ),
        sa.CheckConstraint(
            "total_chunks >= 0",
            name=op.f("ck_sync_recovery_manifests_chunks_nonnegative"),
        ),
        sa.CheckConstraint(
            "total_uncompressed_bytes >= 0",
            name=op.f("ck_sync_recovery_manifests_bytes_nonnegative"),
        ),
    )
    op.create_table(
        "sync_recovery_chunks",
        sa.Column("manifest_token", sa.String(64), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("entity_count", sa.Integer(), nullable=False),
        sa.Column("uncompressed_bytes", sa.Integer(), nullable=False),
        sa.Column("payload_gzip", sa.LargeBinary(), nullable=False),
        sa.Column("payload_sha256", sa.String(64), nullable=False),
        sa.ForeignKeyConstraint(
            ["manifest_token"],
            ["sync_recovery_manifests.token"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("manifest_token", "chunk_index"),
        sa.CheckConstraint(
            "chunk_index >= 0",
            name=op.f("ck_sync_recovery_chunks_index_nonnegative"),
        ),
        sa.CheckConstraint(
            "entity_count BETWEEN 1 AND 500",
            name=op.f("ck_sync_recovery_chunks_entities"),
        ),
        sa.CheckConstraint(
            "uncompressed_bytes BETWEEN 1 AND 8388608",
            name=op.f("ck_sync_recovery_chunks_bytes"),
        ),
    )
    _add_tombstone_delete_sequence()
    op.execute(
        sa.text(
            "UPDATE tombstones SET delete_sequence = ("
            "SELECT MAX(sync_outbox.id) FROM sync_outbox "
            "WHERE sync_outbox.visible = 1 AND sync_outbox.action = 'delete' "
            "AND sync_outbox.entity_type = tombstones.entity_type "
            "AND sync_outbox.entity_id = tombstones.entity_id)"
        )
    )


def downgrade() -> None:
    op.drop_table("sync_recovery_chunks")
    op.drop_table("sync_recovery_manifests")
    op.drop_index("ix_sync_clients_expires_at", table_name="sync_clients")
    op.drop_table("sync_clients")
    connection = op.get_bind()
    inspector = inspect(connection)
    columns = {column["name"] for column in inspector.get_columns("tombstones")}
    indexes = {index["name"] for index in inspector.get_indexes("tombstones")}
    checks = {
        constraint["name"]
        for constraint in inspector.get_check_constraints("tombstones")
    }
    with op.batch_alter_table("tombstones") as batch_op:
        if "ck_tombstones_delete_sequence_nonnegative" in checks:
            batch_op.drop_constraint(
                op.f("ck_tombstones_delete_sequence_nonnegative"), type_="check"
            )
        if "ix_tombstones_delete_sequence" in indexes:
            batch_op.drop_index("ix_tombstones_delete_sequence")
        if "delete_sequence" in columns:
            batch_op.drop_column("delete_sequence")
