"""sync_updated_at_indexes: add index on updated_at for all 14 sync entities.

Revision ID: 005_sync_updated_at_indexes
Revises: 004_task_indexes
Create Date: 2026-07-04

Adds B-tree indexes on ``updated_at`` for every entity that participates in
sync pull. Without these indexes, ``SyncService.pull`` would full-scan all
14 tables on every incremental sync request (WHERE updated_at > since).

Tables covered (14):
  tasks, sessions, notes, folders, quick_notes, reflections, habits,
  habit_check_ins, schedules, time_blocks, memo_comments,
  session_quick_notes, schedule_quick_notes, task_quick_notes
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "005_sync_updated_at_indexes"
down_revision: Union[str, None] = "004_task_indexes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (table_name, index_name) pairs for all 14 sync entities.
SYNC_ENTITIES = [
    ("tasks", "ix_tasks_updated_at"),
    ("sessions", "ix_sessions_updated_at"),
    ("notes", "ix_notes_updated_at"),
    ("folders", "ix_folders_updated_at"),
    ("quick_notes", "ix_quick_notes_updated_at"),
    ("reflections", "ix_reflections_updated_at"),
    ("habits", "ix_habits_updated_at"),
    ("habit_check_ins", "ix_habit_check_ins_updated_at"),
    ("schedules", "ix_schedules_updated_at"),
    ("time_blocks", "ix_time_blocks_updated_at"),
    ("memo_comments", "ix_memo_comments_updated_at"),
    ("session_quick_notes", "ix_session_quick_notes_updated_at"),
    ("schedule_quick_notes", "ix_schedule_quick_notes_updated_at"),
    ("task_quick_notes", "ix_task_quick_notes_updated_at"),
]


def upgrade() -> None:
    for table_name, index_name in SYNC_ENTITIES:
        op.create_index(index_name, table_name, ["updated_at"])


def downgrade() -> None:
    # Reverse order for clean downgrade.
    for table_name, index_name in reversed(SYNC_ENTITIES):
        op.drop_index(index_name, table_name=table_name)
