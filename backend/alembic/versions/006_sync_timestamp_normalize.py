"""sync_timestamp_normalize: migrate seconds-precision timestamps to ms.

Revision ID: 006_sync_timestamp_normalize
Revises: 005_sync_updated_at_indexes
Create Date: 2026-07-04

P0-2: The sync cursor uses lexicographic comparison on ``updated_at`` /
``deleted_at`` strings. When rows mix seconds-precision (``...Z``) and
millisecond-precision (``...123Z``) formats, the comparison breaks because
``"Z" > "."`` (ASCII 90 > 46), causing seconds-precision rows to be
re-emitted on every incremental pull.

This migration rewrites historical seconds-precision values to the
canonical 3-digit millisecond form:
    ``2026-07-04T10:00:00Z`` → ``2026-07-04T10:00:00.000Z``

Only rows whose timestamp ends with ``Z`` and contains no ``.`` are
touched (i.e. seconds-precision Z-suffix values). Microsecond-precision
values (``...123456Z``) are left untouched — they will be normalized on
the next update by the new ``utc_now_iso_ms`` default.

Tables covered:
  - 14 sync entities (created_at + updated_at)
  - tombstones (deleted_at)
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "006_sync_timestamp_normalize"
down_revision: Union[str, None] = "005_sync_updated_at_indexes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# 14 sync entities — migrate both created_at and updated_at.
SYNC_ENTITIES: list[tuple[str, list[str]]] = [
    ("tasks", ["created_at", "updated_at"]),
    ("sessions", ["created_at", "updated_at"]),
    ("notes", ["created_at", "updated_at"]),
    ("folders", ["created_at", "updated_at"]),
    ("quick_notes", ["created_at", "updated_at"]),
    ("reflections", ["created_at", "updated_at"]),
    ("habits", ["created_at", "updated_at"]),
    ("habit_check_ins", ["created_at", "updated_at"]),
    ("schedules", ["created_at", "updated_at"]),
    ("time_blocks", ["created_at", "updated_at"]),
    ("memo_comments", ["created_at", "updated_at"]),
    ("session_quick_notes", ["created_at", "updated_at"]),
    ("schedule_quick_notes", ["created_at", "updated_at"]),
    ("task_quick_notes", ["created_at", "updated_at"]),
]


def upgrade() -> None:
    """Pad seconds-precision Z-suffix timestamps to ``.000Z`` form.

    SQL logic:
      - Filter: ``timestamp LIKE '%Z' AND timestamp NOT LIKE '%.%'``
        (only seconds-precision Z-suffix values).
      - Transform: ``substr(ts, 1, length(ts)-1) || '.000Z'``
        (insert ``.000`` before the trailing ``Z``).
    """
    for table_name, columns in SYNC_ENTITIES:
        for col in columns:
            op.execute(
                f"UPDATE {table_name} "
                f"SET {col} = substr({col}, 1, length({col}) - 1) || '.000Z' "
                f"WHERE {col} LIKE '%Z' AND {col} NOT LIKE '%.%'"
            )
    # Tombstones: deleted_at only (no created_at/updated_at — uses its own schema).
    op.execute(
        "UPDATE tombstones "
        "SET deleted_at = substr(deleted_at, 1, length(deleted_at) - 1) || '.000Z' "
        "WHERE deleted_at LIKE '%Z' AND deleted_at NOT LIKE '%.%'"
    )


def downgrade() -> None:
    """Reverse the migration: strip ``.000`` from timestamps ending in ``.000Z``.

    Note: this only reverses the exact ``.000Z`` → ``Z`` transformation.
    Values with non-zero milliseconds (``.123Z``) are left untouched —
    they were not produced by ``upgrade()`` and represent real ms-precision
    data.
    """
    for table_name, columns in SYNC_ENTITIES:
        for col in columns:
            op.execute(
                f"UPDATE {table_name} "
                f"SET {col} = substr({col}, 1, length({col}) - 5) || 'Z' "
                f"WHERE {col} LIKE '%.000Z'"
            )
    op.execute(
        "UPDATE tombstones "
        "SET deleted_at = substr(deleted_at, 1, length(deleted_at) - 5) || 'Z' "
        "WHERE deleted_at LIKE '%.000Z'"
    )
