"""Add CheckConstraint on notes.status.

Revision ID: 003_note_status_check
Revises: 002_sync_indexes
Create Date: 2026-07-04
"""
from alembic import op


revision = "003_note_status_check"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("notes") as batch_op:
        batch_op.create_check_constraint(
            "check_note_status",
            "status IN ('active', 'archived')",
        )


def downgrade() -> None:
    with op.batch_alter_table("notes") as batch_op:
        batch_op.drop_constraint("check_note_status", type_="check")
