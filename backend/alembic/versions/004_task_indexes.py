"""Add indexes on tasks.status, tasks.priority, tasks.due_date.

Revision ID: 004_task_indexes
Revises: 003_note_status_check
Create Date: 2026-07-04
"""
from alembic import op


revision = "004_task_indexes"
down_revision = "003_note_status_check"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("ix_tasks_status", "tasks", ["status"])
    op.create_index("ix_tasks_priority", "tasks", ["priority"])
    op.create_index("ix_tasks_due_date", "tasks", ["due_date"])


def downgrade() -> None:
    op.drop_index("ix_tasks_due_date", "tasks")
    op.drop_index("ix_tasks_priority", "tasks")
    op.drop_index("ix_tasks_status", "tasks")
