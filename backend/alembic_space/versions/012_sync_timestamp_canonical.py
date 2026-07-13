"""Canonicalize persisted synchronization timestamps to millisecond UTC text.

Revision ID: space_012_sync_timestamp_canonical
Revises: space_011_sync_client_credentials

Legacy synchronization queries compare indexed timestamp columns directly as
text. Every participating value must therefore use the same fixed-width
``YYYY-MM-DDTHH:MM:SS.mmmZ`` representation.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from alembic import op
from sqlalchemy import text

revision = "space_012_sync_timestamp_canonical"
down_revision = "space_011_sync_client_credentials"
branch_labels = None
depends_on = None

_TIMESTAMP_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$"
)

# Stable migration contract: (table, primary key, timestamp columns).
TIMESTAMP_TARGETS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("tasks", "id", ("created_at", "updated_at")),
    ("sessions", "id", ("created_at", "updated_at")),
    ("notes", "id", ("created_at", "updated_at")),
    ("folders", "id", ("created_at", "updated_at")),
    ("quick_notes", "id", ("created_at", "updated_at")),
    ("reflections", "id", ("created_at", "updated_at")),
    ("habits", "id", ("created_at", "updated_at")),
    ("habit_check_ins", "id", ("created_at", "updated_at")),
    ("schedules", "id", ("created_at", "updated_at")),
    ("time_blocks", "id", ("created_at", "updated_at")),
    ("memo_comments", "id", ("created_at", "updated_at")),
    ("session_quick_notes", "id", ("created_at", "updated_at")),
    ("schedule_quick_notes", "id", ("created_at", "updated_at")),
    ("task_quick_notes", "id", ("created_at", "updated_at")),
    ("settings", "key", ("updated_at",)),
    ("tombstones", "id", ("deleted_at",)),
    ("sync_outbox", "id", ("created_at", "synced_at")),
    ("sync_audit_log", "id", ("created_at",)),
    (
        "sync_clients",
        "client_id",
        ("last_seen_at", "lease_expires_at", "created_at", "revoked_at"),
    ),
    ("sync_snapshots", "token", ("created_at", "expires_at")),
)

# Empty expires_at is the pre-010 durable sentinel for a legacy snapshot with
# no explicit expiry. It is not an invalid timestamp and must remain unchanged.
_EMPTY_SENTINELS = {("sync_snapshots", "expires_at")}


def _canonical_timestamp(value: str) -> str:
    if not isinstance(value, str) or not _TIMESTAMP_PATTERN.fullmatch(value):
        raise ValueError("not a supported ISO-8601 timestamp")
    source = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(source)
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        parsed = parsed.astimezone(timezone.utc)
    except (OverflowError, ValueError) as exc:
        raise ValueError("not a valid ISO-8601 timestamp") from exc
    milliseconds = parsed.microsecond // 1000
    return (
        f"{parsed.year:04d}-{parsed.month:02d}-{parsed.day:02d}T"
        f"{parsed.hour:02d}:{parsed.minute:02d}:{parsed.second:02d}."
        f"{milliseconds:03d}Z"
    )


def upgrade() -> None:
    connection = op.get_bind()
    pending: list[tuple[str, str, str, list[dict[str, object]]]] = []

    # Validate the complete migration set before issuing the first UPDATE. This
    # makes malformed persisted values fail closed without partial rewrites.
    for table_name, primary_key, columns in TIMESTAMP_TARGETS:
        for column_name in columns:
            rows = connection.execute(
                text(
                    f'SELECT "{primary_key}", "{column_name}" '
                    f'FROM "{table_name}" WHERE "{column_name}" IS NOT NULL'
                )
            ).all()
            updates: list[dict[str, object]] = []
            for row_key, value in rows:
                if value == "" and (table_name, column_name) in _EMPTY_SENTINELS:
                    continue
                try:
                    canonical = _canonical_timestamp(value)
                except ValueError as exc:
                    raise RuntimeError(
                        "space_012_sync_timestamp_canonical rejected invalid timestamp "
                        f"in {table_name}.{column_name} for primary key {row_key!r}: {value!r}"
                    ) from exc
                if canonical != value:
                    updates.append({"primary_key": row_key, "canonical": canonical})
            if updates:
                pending.append((table_name, primary_key, column_name, updates))

    for table_name, primary_key, column_name, updates in pending:
        connection.execute(
            text(
                f'UPDATE "{table_name}" SET "{column_name}" = :canonical '
                f'WHERE "{primary_key}" = :primary_key'
            ),
            updates,
        )

    # Canonicalization can collapse distinct historical sub-millisecond values
    # into one millisecond bucket. Existing incremental cursors were issued
    # against the old ordering, so every registered client must complete a full
    # recovery before incremental Pull/ACK/Push resumes. This prevents a stale
    # pre-migration cursor from silently skipping a row after the ordering
    # changes.
    connection.execute(text("UPDATE sync_clients SET snapshot_required = 1"))


def downgrade() -> None:
    raise RuntimeError(
        "space_012_sync_timestamp_canonical contains synchronization safety and recovery state; "
        "downgrading would lose data. Restore from a backup taken before the downgrade."
    )
