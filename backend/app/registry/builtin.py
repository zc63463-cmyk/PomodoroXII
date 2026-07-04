"""Built-in entity registrations for PomodoroXII.

This module is imported once by ``app.registry.__init__`` to populate
the global ``REGISTRY`` singleton with metadata for every ORM entity
in the project.

Each ``EntitySpec`` declares:

- ``name``: the entity_type string used in URLs and sync events
- ``model_path``: fully-qualified ORM class path (string, never imported)
- ``table_name``: SQL table name
- ``storage_type``: DB_ONLY / FS_DB_SPLIT / SYSTEM
- ``category``: BUSINESS / SYNC_INFRA / META / SETTING
- ``sync_enabled``: whether Phase C sync touches this entity
- ``soft_delete``: whether the entity has a ``trashed_at`` column
- ``fields``: tuple of ``FieldSpec`` describing each column

Counts (must match the gate test in ``tests/test_registry.py``):
- 14 BUSINESS entities (sync_enabled=True): 11 first-class + 3 junctions
- 3 SYNC_INFRA entities (tombstone, sync_outbox, sync_audit_log)
- 2 META entities (space, meta_setting)
- 1 SETTING entity (setting)
- Total: 20 entities
"""
from __future__ import annotations

from app.registry import REGISTRY
from app.registry.entities import (
    EntityCategory,
    EntitySpec,
    FieldSpec,
    StorageType,
)


def _sync_fields() -> tuple[FieldSpec, ...]:
    """Return the 4 common columns provided by ``SyncMixin``.

    Every business entity inherits ``SyncMixin``, so they all share
    ``id`` / ``created_at`` / ``updated_at`` / ``version``.  Centralising
    them here keeps each entity declaration focused on its own columns.
    """
    return (
        FieldSpec(
            "id", "string", nullable=False, indexed=True,
            description="UUID hex primary key",
        ),
        FieldSpec(
            "created_at", "datetime", nullable=False,
            description="UTC ISO-8601 creation timestamp",
        ),
        FieldSpec(
            "updated_at", "datetime", nullable=False,
            description="UTC ISO-8601 last-update timestamp",
        ),
        FieldSpec(
            "version", "integer", nullable=False, default=1,
            description="Optimistic concurrency counter",
        ),
    )


# --------------------------------------------------------------------------- #
# Business entities (14, sync_enabled=True)
# --------------------------------------------------------------------------- #

REGISTRY.register(EntitySpec(
    name="task",
    model_path="app.models.task.Task",
    table_name="tasks",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,  # Task has no trashed_at column (P1-1 confirmed)
    fields=_sync_fields() + (
        FieldSpec("title", "string", nullable=False),
        FieldSpec("description", "string", nullable=False, default=""),
        FieldSpec(
            "status", "string", nullable=False, default="todo",
            description="todo|in_progress|done|archived",
        ),
        FieldSpec(
            "priority", "string", nullable=False, default="medium",
            description="low|medium|high|urgent",
        ),
        FieldSpec("tags", "json", nullable=False, default="[]"),
        FieldSpec("plan", "string", nullable=False, default=""),
        FieldSpec("completion", "string", nullable=False, default=""),
        FieldSpec("due_date", "datetime", nullable=True),
        FieldSpec("estimated_pomodoros", "integer", nullable=False, default=1),
        FieldSpec("actual_pomodoros", "integer", nullable=False, default=0),
        FieldSpec("archived_at", "datetime", nullable=True),
    ),
    pull_key="tasks",
    route_enabled=True,
    route_prefix="/tasks",
    description="Todo/plan item with pomodoro estimates",
))

REGISTRY.register(EntitySpec(
    name="session",
    model_path="app.models.session.Session",
    table_name="sessions",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    fields=_sync_fields() + (
        FieldSpec("task_id", "string", nullable=True),
        FieldSpec(
            "type", "string", nullable=False,
            description="work|short_break|long_break|free|countdown",
        ),
        FieldSpec("duration", "integer", nullable=False),
        FieldSpec("completed", "boolean", nullable=False, default=False),
        FieldSpec("plan", "string", nullable=False, default=""),
        FieldSpec("completion", "string", nullable=False, default=""),
        FieldSpec("started_at", "datetime", nullable=False),
        FieldSpec("ended_at", "datetime", nullable=True),
        FieldSpec("mood", "string", nullable=True),
        FieldSpec("note", "string", nullable=False, default=""),
        FieldSpec("attention_score", "integer", nullable=True),
        FieldSpec("flow_state_detected", "boolean", nullable=True),
        FieldSpec("flow_state_confidence", "float", nullable=True),
        FieldSpec("interruption_count", "integer", nullable=True, default=0),
        FieldSpec(
            "total_interruption_duration", "integer", nullable=True, default=0,
        ),
        FieldSpec("avg_recovery_time", "integer", nullable=True),
        FieldSpec("pause_count", "integer", nullable=True, default=0),
        FieldSpec("total_pause_duration", "integer", nullable=True, default=0),
        FieldSpec("cognitive_mark_summary", "string", nullable=True, default=""),
    ),
    pull_key="sessions",
    route_enabled=True,
    route_prefix="/sessions",
    description="Pomodoro work/break interval with enhanced metrics",
))

REGISTRY.register(EntitySpec(
    name="note",
    model_path="app.models.note.Note",
    table_name="notes",
    storage_type=StorageType.FS_DB_SPLIT,  # The only FS+DB split entity
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=True,  # Note has trashed_at
    fields=_sync_fields() + (
        FieldSpec("title", "string", nullable=False, default=""),
        FieldSpec("content_hash", "string", nullable=False, default=""),
        FieldSpec("word_count", "integer", nullable=False, default=0),
        FieldSpec("summary", "string", nullable=False, default=""),
        FieldSpec("tags", "json", nullable=False, default="[]"),
        FieldSpec("category", "string", nullable=True, indexed=True),
        FieldSpec("folder_id", "string", nullable=True, indexed=True),
        FieldSpec(
            "status", "string", nullable=False, default="active", indexed=True,
            description="active|archived",
        ),
        FieldSpec("trashed_at", "datetime", nullable=True, indexed=True),
    ),
    pull_key="notes",
    delete_strategy="fs_saga",
    route_enabled=True,
    route_prefix="/notes",
    description="Lightweight knowledge-base entry; content lives in FS, meta in DB",
))

REGISTRY.register(EntitySpec(
    name="folder",
    model_path="app.models.folder.Folder",
    table_name="folders",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=True,  # Folder has trashed_at
    fields=_sync_fields() + (
        FieldSpec("name", "string", nullable=False),
        FieldSpec("parent_id", "string", nullable=True, indexed=True),
        FieldSpec("icon", "string", nullable=True, default="📁"),
        FieldSpec("color", "string", nullable=True),
        FieldSpec("sort_order", "integer", nullable=False, default=0),
        FieldSpec("is_system", "boolean", nullable=False, default=False),
        FieldSpec("trashed_at", "datetime", nullable=True, indexed=True),
    ),
    pull_key="folders",
    delete_strategy="cascade_soft_delete",
    route_enabled=True,
    route_prefix="/folders",
    description="Self-referencing VFS folder for organising notes/quick_notes",
))

REGISTRY.register(EntitySpec(
    name="quick_note",
    model_path="app.models.quick_note.QuickNote",
    table_name="quick_notes",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=True,  # QuickNote has trashed_at
    fields=_sync_fields() + (
        FieldSpec("content", "text", nullable=False, default=""),
        FieldSpec("mood", "string", nullable=True),
        FieldSpec("tags", "json", nullable=False, default="[]"),
        FieldSpec("pinned", "boolean", nullable=False, default=False),
        FieldSpec("archived_at", "datetime", nullable=True, indexed=True),
        FieldSpec("archive_file_path", "string", nullable=True),
        FieldSpec("folder_id", "string", nullable=True, indexed=True),
        FieldSpec("trashed_at", "datetime", nullable=True, indexed=True),
        FieldSpec("migrated_to_note_id", "string", nullable=True, indexed=True),
        FieldSpec("session_id", "string", nullable=True, indexed=True),
    ),
    sync_entity_type="quickNote",
    pull_key="quickNotes",
    delete_strategy="soft_delete",
    route_enabled=True,
    route_prefix="/quick-notes",
    description="Rapid-capture note with optional session link",
))

REGISTRY.register(EntitySpec(
    name="reflection",
    model_path="app.models.reflection.Reflection",
    table_name="reflections",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    fields=_sync_fields() + (
        FieldSpec("date", "string", nullable=False, indexed=True),
        FieldSpec("content", "text", nullable=False, default=""),
        FieldSpec("mood", "string", nullable=True, indexed=True),
        FieldSpec("related_task_ids", "json", nullable=False, default="[]"),
        FieldSpec("tags", "json", nullable=False, default="[]"),
        FieldSpec("sections", "json", nullable=False, default="[]"),
        FieldSpec("is_structured", "boolean", nullable=False, default=False),
        FieldSpec("auto_linked_session_ids", "json", nullable=False, default="[]"),
    ),
    pull_key="reflections",
    route_enabled=True,
    route_prefix="/reflections",
    description="Daily retrospective with structured sections",
))

REGISTRY.register(EntitySpec(
    name="habit",
    model_path="app.models.habit.Habit",
    table_name="habits",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    fields=_sync_fields() + (
        FieldSpec("title", "string", nullable=False),
        FieldSpec("description", "string", nullable=False, default=""),
        FieldSpec("color", "string", nullable=False, default="#7F77DD"),
        FieldSpec("icon", "string", nullable=False, default="✅"),
        FieldSpec("target_count", "integer", nullable=False, default=1),
        FieldSpec("rest_day_protection", "boolean", nullable=False, default=False),
        FieldSpec("rest_days", "json", nullable=False, default="[]"),
        FieldSpec("sort_order", "integer", nullable=False, default=0),
        FieldSpec("archived", "boolean", nullable=False, default=False),
    ),
    pull_key="habits",
    route_enabled=True,
    route_prefix="/habits",
    description="Habit streak chain with rest-day protection",
))

REGISTRY.register(EntitySpec(
    name="habit_check_in",
    model_path="app.models.habit_check_in.HabitCheckIn",
    table_name="habit_check_ins",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    fields=_sync_fields() + (
        FieldSpec("habit_id", "string", nullable=False, indexed=True),
        FieldSpec("date", "string", nullable=False, indexed=True),
        FieldSpec("count", "integer", nullable=False, default=1),
        FieldSpec("note", "string", nullable=False, default=""),
    ),
    sync_entity_type="habitCheckIn",
    pull_key="habitCheckIns",
    description="Daily check-in record for a habit",
))

REGISTRY.register(EntitySpec(
    name="schedule",
    model_path="app.models.schedule.Schedule",
    table_name="schedules",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    fields=_sync_fields() + (
        FieldSpec("title", "string", nullable=False),
        FieldSpec("due_at", "datetime", nullable=False),
        FieldSpec("completed_at", "datetime", nullable=True),
        FieldSpec(
            "priority", "string", nullable=False, default="medium",
            description="high|medium|low",
        ),
        FieldSpec("color", "string", nullable=False, default="#3b82f6"),
        FieldSpec("all_day", "boolean", nullable=False, default=False),
        FieldSpec("start_time", "string", nullable=True),
        FieldSpec("end_time", "string", nullable=True),
    ),
    pull_key="schedules",
    route_enabled=True,
    route_prefix="/schedules",
    description="Calendar event with completion status",
))

REGISTRY.register(EntitySpec(
    name="time_block",
    model_path="app.models.time_block.TimeBlock",
    table_name="time_blocks",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    fields=_sync_fields() + (
        FieldSpec("task_id", "string", nullable=True, indexed=True),
        FieldSpec("title", "string", nullable=False, default=""),
        FieldSpec("date", "string", nullable=False, indexed=True),
        FieldSpec("start_time", "string", nullable=False),
        FieldSpec("end_time", "string", nullable=False),
        FieldSpec("planned_duration", "integer", nullable=False, default=0),
        FieldSpec("actual_duration", "integer", nullable=False, default=0),
        FieldSpec(
            "block_type", "string", nullable=False, default="work",
            description="work|short_break|long_break",
        ),
        FieldSpec(
            "status", "string", nullable=False, default="planned",
            description="planned|in_progress|completed|skipped",
        ),
        FieldSpec("sort_order", "integer", nullable=False, default=0),
    ),
    sync_entity_type="timeBlock",
    pull_key="timeBlocks",
    route_enabled=True,
    route_prefix="/time-blocks",
    description="Planned time block on a given date",
))

REGISTRY.register(EntitySpec(
    name="memo_comment",
    model_path="app.models.memo_comment.MemoComment",
    table_name="memo_comments",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    fields=_sync_fields() + (
        FieldSpec("note_id", "string", nullable=False, indexed=True),
        FieldSpec("content", "text", nullable=False, default=""),
    ),
    sync_entity_type="memoComment",
    pull_key="memoComments",
    description="Comment on a quick note (小记评论)",
))

# --- Junction tables (3, sync_enabled=True) --- #

REGISTRY.register(EntitySpec(
    name="session_quick_note",
    model_path="app.models.session_quick_note.SessionQuickNote",
    table_name="session_quick_notes",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    fields=_sync_fields() + (
        FieldSpec("session_id", "string", nullable=False, indexed=True),
        FieldSpec("quick_note_id", "string", nullable=False, indexed=True),
    ),
    sync_entity_type="sessionQuickNote",
    pull_key="sessionQuickNotes",
    description="Junction: pomodoro session <-> quick note",
))

REGISTRY.register(EntitySpec(
    name="schedule_quick_note",
    model_path="app.models.schedule_quick_note.ScheduleQuickNote",
    table_name="schedule_quick_notes",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    fields=_sync_fields() + (
        FieldSpec("schedule_id", "string", nullable=False, indexed=True),
        FieldSpec("quick_note_id", "string", nullable=False, indexed=True),
    ),
    sync_entity_type="scheduleQuickNote",
    pull_key="scheduleQuickNotes",
    description="Junction: schedule <-> quick note",
))

REGISTRY.register(EntitySpec(
    name="task_quick_note",
    model_path="app.models.task_quick_note.TaskQuickNote",
    table_name="task_quick_notes",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    fields=_sync_fields() + (
        FieldSpec("task_id", "string", nullable=False, indexed=True),
        FieldSpec("quick_note_id", "string", nullable=False, indexed=True),
    ),
    sync_entity_type="taskQuickNote",
    pull_key="taskQuickNotes",
    description="Junction: task <-> quick note",
))


# --------------------------------------------------------------------------- #
# Sync infrastructure (3, sync_enabled=False, integer PK)
# --------------------------------------------------------------------------- #

REGISTRY.register(EntitySpec(
    name="tombstone",
    model_path="app.models.tombstone.Tombstone",
    table_name="tombstones",
    storage_type=StorageType.SYSTEM,
    category=EntityCategory.SYNC_INFRA,
    sync_enabled=False,
    soft_delete=False,
    primary_key="id",
    fields=(
        FieldSpec("id", "integer", nullable=False),
        FieldSpec("entity_type", "string", nullable=False, indexed=True),
        FieldSpec("entity_id", "string", nullable=False, indexed=True),
        FieldSpec("deleted_at", "datetime", nullable=False, indexed=True),
    ),
    description="Anti-resurrection tombstone for sync deletions",
))

REGISTRY.register(EntitySpec(
    name="sync_outbox",
    model_path="app.models.sync_outbox.SyncOutbox",
    table_name="sync_outbox",
    storage_type=StorageType.SYSTEM,
    category=EntityCategory.SYNC_INFRA,
    sync_enabled=False,
    soft_delete=False,
    primary_key="id",
    fields=(
        FieldSpec("id", "integer", nullable=False),
        FieldSpec("entity_type", "string", nullable=False),
        FieldSpec("entity_id", "string", nullable=False),
        FieldSpec(
            "action", "string", nullable=False,
            description="create|update|delete",
        ),
        FieldSpec("payload", "text", nullable=False),
        FieldSpec("created_at", "datetime", nullable=False),
        FieldSpec("synced_at", "datetime", nullable=True),
    ),
    description="Pending sync event queue (ephemeral)",
))

REGISTRY.register(EntitySpec(
    name="sync_audit_log",
    model_path="app.models.sync_audit_log.SyncAuditLog",
    table_name="sync_audit_log",
    storage_type=StorageType.SYSTEM,
    category=EntityCategory.SYNC_INFRA,
    sync_enabled=False,
    soft_delete=False,
    primary_key="id",
    fields=(
        FieldSpec("id", "integer", nullable=False),
        FieldSpec("event_type", "string", nullable=False),
        FieldSpec("entity_type", "string", nullable=False),
        FieldSpec("entity_id", "string", nullable=False),
        FieldSpec("details", "text", nullable=False),
        FieldSpec("created_at", "datetime", nullable=False),
    ),
    description="Immutable append-only audit log for sync events",
))


# --------------------------------------------------------------------------- #
# Meta layer (2, sync_enabled=False, live in meta DB)
# --------------------------------------------------------------------------- #

REGISTRY.register(EntitySpec(
    name="space",
    model_path="app.db.models.meta.Space",
    table_name="spaces",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.META,
    sync_enabled=False,
    soft_delete=False,
    route_enabled=True,
    route_prefix="/spaces",
    primary_key="id",
    fields=(
        FieldSpec("id", "string", nullable=False),
        FieldSpec("name", "string", nullable=False),
        FieldSpec("db_path", "string", nullable=False),
        FieldSpec("notes_dir", "string", nullable=False),
        FieldSpec("is_default", "boolean", nullable=False, default=False),
        FieldSpec("created_at", "datetime", nullable=False),
        FieldSpec("updated_at", "datetime", nullable=False),
    ),
    description="Space registry row (meta DB); owns its own SQLite DB + notes dir",
))

REGISTRY.register(EntitySpec(
    name="meta_setting",
    model_path="app.db.models.meta.MetaSetting",
    table_name="meta_settings",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.META,
    sync_enabled=False,
    soft_delete=False,
    primary_key="id",
    fields=(
        FieldSpec("id", "string", nullable=False),
        FieldSpec("key", "string", nullable=False, unique=True),
        FieldSpec("value", "string", nullable=True),
        FieldSpec("created_at", "datetime", nullable=False),
        FieldSpec("updated_at", "datetime", nullable=False),
    ),
    description="Global key/value setting stored in the meta DB",
))


# --------------------------------------------------------------------------- #
# Setting layer (1, sync_enabled=False, natural-key PK)
# --------------------------------------------------------------------------- #

REGISTRY.register(EntitySpec(
    name="setting",
    model_path="app.models.setting.Setting",
    table_name="settings",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.SETTING,
    sync_enabled=False,
    soft_delete=False,
    route_enabled=True,
    route_prefix="/settings",
    primary_key="key",
    fields=(
        FieldSpec("key", "string", nullable=False, unique=True),
        FieldSpec("value", "string", nullable=False),
        FieldSpec("updated_at", "datetime", nullable=False),
    ),
    description="Per-space key/value configuration (natural key PK)",
))
