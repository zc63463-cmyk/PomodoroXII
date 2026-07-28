"""sync_indexes: add indexes to sync_outbox and sync_audit_log.

Revision ID: 002
Revises: cab2ff7bcf37
Create Date: 2026-07-04 00:00:00

Adds B-tree indexes on the columns most frequently used in sync queries:
  sync_outbox.entity_type, entity_id, synced_at, created_at
  sync_audit_log.event_type, entity_type, entity_id, created_at
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "002"
down_revision: Union[str, None] = "cab2ff7bcf37"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # sync_outbox indexes
    op.create_index(
        "ix_sync_outbox_entity_type", "sync_outbox", ["entity_type"]
    )
    op.create_index(
        "ix_sync_outbox_entity_id", "sync_outbox", ["entity_id"]
    )
    op.create_index(
        "ix_sync_outbox_synced_at", "sync_outbox", ["synced_at"]
    )
    op.create_index(
        "ix_sync_outbox_created_at", "sync_outbox", ["created_at"]
    )

    # sync_audit_log indexes
    op.create_index(
        "ix_sync_audit_log_event_type", "sync_audit_log", ["event_type"]
    )
    op.create_index(
        "ix_sync_audit_log_entity_type", "sync_audit_log", ["entity_type"]
    )
    op.create_index(
        "ix_sync_audit_log_entity_id", "sync_audit_log", ["entity_id"]
    )
    op.create_index(
        "ix_sync_audit_log_created_at", "sync_audit_log", ["created_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_sync_audit_log_created_at", table_name="sync_audit_log")
    op.drop_index("ix_sync_audit_log_entity_id", table_name="sync_audit_log")
    op.drop_index("ix_sync_audit_log_entity_type", table_name="sync_audit_log")
    op.drop_index("ix_sync_audit_log_event_type", table_name="sync_audit_log")

    op.drop_index("ix_sync_outbox_created_at", table_name="sync_outbox")
    op.drop_index("ix_sync_outbox_synced_at", table_name="sync_outbox")
    op.drop_index("ix_sync_outbox_entity_id", table_name="sync_outbox")
    op.drop_index("ix_sync_outbox_entity_type", table_name="sync_outbox")
