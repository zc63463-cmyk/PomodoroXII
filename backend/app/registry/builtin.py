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
- 22 BUSINESS entities (sync_enabled=True): includes 12 Task Space entities + 10 legacy entities
- 5 SYNC_INFRA entities (tombstone, sync_outbox, sync_audit_log, session_command_envelope, session_command_receipt)
- 3 META entities (space, meta_setting, active_session_locator)
- 1 SETTING entity (setting)
- Total: 31 entities
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

    Business entities backed by ``SyncMixin`` share ``id`` / ``created_at`` /
    ``updated_at`` / ``version``. Centralising them here keeps each entity
    declaration focused on its own columns.
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
# Legacy business entities (10, sync_enabled=True)
# --------------------------------------------------------------------------- #

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
    service_path="app.services.note.NoteService",
    schema_module="app.schemas.note",
    schema_prefix="NoteResponse",
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
    service_path="app.services.folder.FolderService",
    schema_module="app.schemas.folder",
    schema_prefix="FolderResponse",
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
    ),
    sync_entity_type="quickNote",
    pull_key="quickNotes",
    delete_strategy="soft_delete",
    route_enabled=True,
    route_prefix="/quick-notes",
    service_path="app.services.quick_note.QuickNoteService",
    schema_module="app.schemas.quick_note",
    schema_prefix="QuickNoteResponse",
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
        FieldSpec("tags", "json", nullable=False, default="[]"),
        FieldSpec("sections", "json", nullable=False, default="[]"),
        FieldSpec("is_structured", "boolean", nullable=False, default=False),
    ),
    pull_key="reflections",
    route_enabled=True,
    route_prefix="/reflections",
    service_path="app.services.reflection.ReflectionService",
    schema_module="app.schemas.reflection",
    schema_prefix="ReflectionResponse",
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
    service_path="app.services.habit.HabitService",
    schema_module="app.schemas.habit",
    schema_prefix="HabitResponse",
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
    service_path="app.services.schedule.ScheduleService",
    schema_module="app.schemas.schedule",
    schema_prefix="ScheduleResponse",
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
    service_path="app.services.time_block.TimeBlockService",
    schema_module="app.schemas.time_block",
    schema_prefix="TimeBlockResponse",
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

# --- Junction tables (1, sync_enabled=True) --- #

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
    junction_endpoints=(("schedule_id", "schedule"), ("quick_note_id", "quick_note")),
))

# --------------------------------------------------------------------------- #
# Task Space and FocusSession entities (15, strict_cas)
# --------------------------------------------------------------------------- #
# 12 business entities (sync_enabled=True), 2 sync_infra entities
# (sync_enabled=False), and 1 meta entity (sync_enabled=False).
# All use sync_conflict_policy="strict_cas".

REGISTRY.register(EntitySpec(
    name="project",
    model_path="app.models.project.Project",
    table_name="projects",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    sync_conflict_policy="strict_cas",
    fields=_sync_fields() + (
        FieldSpec("key", "string", nullable=False, unique=True),
        FieldSpec("next_work_item_number", "integer", nullable=False, default=1),
        FieldSpec("name", "string", nullable=False),
        FieldSpec("description", "text", nullable=True),
        FieldSpec("rank", "integer", nullable=False, default=0),
        FieldSpec("default_status_definition_id", "string", nullable=False),
        FieldSpec("default_type_definition_id", "string", nullable=False),
        FieldSpec("archived_at", "datetime", nullable=True),
    ),
    sync_entity_type="project",
    pull_key="projects",
    description="Task Space project with human-readable key and work item numbering",
))

REGISTRY.register(EntitySpec(
    name="status_definition",
    model_path="app.models.work_item_definition.StatusDefinition",
    table_name="status_definitions",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    sync_conflict_policy="strict_cas",
    fields=_sync_fields() + (
        FieldSpec("name", "string", nullable=False),
        FieldSpec("category", "string", nullable=False),
        FieldSpec("icon", "string", nullable=True),
        FieldSpec("color", "string", nullable=True),
        FieldSpec("rank", "integer", nullable=False, default=0),
        FieldSpec("system", "boolean", nullable=False, default=False),
        FieldSpec("archived_at", "datetime", nullable=True),
    ),
    sync_entity_type="statusDefinition",
    pull_key="statusDefinitions",
    description="Work item status definition with category and visual properties",
))

REGISTRY.register(EntitySpec(
    name="type_definition",
    model_path="app.models.work_item_definition.TypeDefinition",
    table_name="type_definitions",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    sync_conflict_policy="strict_cas",
    fields=_sync_fields() + (
        FieldSpec("name", "string", nullable=False),
        FieldSpec("icon", "string", nullable=True),
        FieldSpec("color", "string", nullable=True),
        FieldSpec("rank", "integer", nullable=False, default=0),
        FieldSpec("system", "boolean", nullable=False, default=False),
        FieldSpec("archived_at", "datetime", nullable=True),
    ),
    sync_entity_type="typeDefinition",
    pull_key="typeDefinitions",
    description="Work item type definition with visual properties",
))

REGISTRY.register(EntitySpec(
    name="label",
    model_path="app.models.work_item_definition.Label",
    table_name="labels",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    sync_conflict_policy="strict_cas",
    fields=_sync_fields() + (
        FieldSpec("name", "string", nullable=False, unique=True),
        FieldSpec("color", "string", nullable=True),
        FieldSpec("archived_at", "datetime", nullable=True),
    ),
    sync_entity_type="label",
    pull_key="labels",
    description="Work item label with color",
))

REGISTRY.register(EntitySpec(
    name="work_item_label",
    model_path="app.models.work_item_definition.WorkItemLabel",
    table_name="work_item_labels",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    sync_conflict_policy="strict_cas",
    primary_key="work_item_id",
    fields=(
        FieldSpec("work_item_id", "string", nullable=False, indexed=True),
        FieldSpec("label_id", "string", nullable=False, indexed=True),
    ),
    sync_entity_type="workItemLabel",
    pull_key="workItemLabels",
    description="Junction: work item <-> label",
    junction_endpoints=(("work_item_id", "work_item"), ("label_id", "label")),
))

REGISTRY.register(EntitySpec(
    name="work_item",
    model_path="app.models.work_item.WorkItem",
    table_name="work_items",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    sync_conflict_policy="strict_cas",
    fields=_sync_fields() + (
        FieldSpec("project_id", "string", nullable=False, indexed=True),
        FieldSpec("display_key", "string", nullable=False, unique=True),
        FieldSpec("title", "string", nullable=False),
        FieldSpec("description", "text", nullable=True),
        FieldSpec("type_definition_id", "string", nullable=False),
        FieldSpec("status_definition_id", "string", nullable=False),
        FieldSpec("priority", "string", nullable=True),
        FieldSpec("parent_id", "string", nullable=True, indexed=True),
        FieldSpec("child_rank", "integer", nullable=False, default=0),
        FieldSpec("completion_window_start", "datetime", nullable=True),
        FieldSpec("completion_window_end", "datetime", nullable=True),
        FieldSpec("review_point", "datetime", nullable=True),
        FieldSpec("hard_deadline", "datetime", nullable=True),
        FieldSpec("effort_estimate_lower_seconds", "integer", nullable=True),
        FieldSpec("effort_estimate_upper_seconds", "integer", nullable=True),
        FieldSpec("effort_actual_seconds", "integer", nullable=False, default=0),
        FieldSpec("confidence", "string", nullable=True),
        FieldSpec("completed_at", "datetime", nullable=True),
        FieldSpec("cancelled_at", "datetime", nullable=True),
        FieldSpec("archived_at", "datetime", nullable=True),
        FieldSpec("marked_as_attention", "boolean", nullable=False, default=False),
    ),
    sync_entity_type="workItem",
    pull_key="workItems",
    description="Task Space work item with display key and hierarchy support",
))

REGISTRY.register(EntitySpec(
    name="work_item_note",
    model_path="app.models.work_item_note.WorkItemNote",
    table_name="work_item_notes",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    sync_conflict_policy="strict_cas",
    fields=_sync_fields() + (
        FieldSpec("work_item_id", "string", nullable=False, unique=True),
        FieldSpec("document_json", "text", nullable=False),
    ),
    sync_entity_type="workItemNote",
    pull_key="workItemNotes",
    description="Work item note document; sync payload is full document_json post-image",
))

REGISTRY.register(EntitySpec(
    name="focus_session",
    model_path="app.models.focus_session.FocusSession",
    table_name="focus_sessions",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    sync_conflict_policy="strict_cas",
    fields=_sync_fields() + (
        FieldSpec("session_revision", "integer", nullable=False, default=1),
        FieldSpec("started_at", "datetime", nullable=False),
        FieldSpec("ended_at", "datetime", nullable=True),
        FieldSpec("pause_started_at", "datetime", nullable=True),
        FieldSpec("planned_seconds", "integer", nullable=False, default=0),
        FieldSpec("gross_seconds", "integer", nullable=False, default=0),
        FieldSpec("paused_seconds", "integer", nullable=False, default=0),
        FieldSpec("break_seconds", "integer", nullable=False, default=0),
        FieldSpec("focused_seconds", "integer", nullable=False, default=0),
        FieldSpec("timer_completion", "datetime", nullable=True),
        FieldSpec("validity", "string", nullable=False, default="pending"),
        FieldSpec("validity_reason", "string", nullable=True),
        FieldSpec("overall_progress", "string", nullable=True),
        FieldSpec("mood", "string", nullable=True),
        FieldSpec("session_note", "text", nullable=False, default=""),
        FieldSpec("review_state", "string", nullable=False, default="not_required"),
        FieldSpec("ownership_state", "string", nullable=False, default="authoritative"),
    ),
    sync_entity_type="focusSession",
    pull_key="focusSessions",
    description="Focus session with timer metrics, validity, and ownership state",
))

REGISTRY.register(EntitySpec(
    name="session_task_context",
    model_path="app.models.focus_session.SessionTaskContext",
    table_name="session_task_contexts",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    sync_conflict_policy="strict_cas",
    fields=_sync_fields() + (
        FieldSpec("session_id", "string", nullable=False, unique=True),
        FieldSpec("project_id", "string", nullable=False),
        FieldSpec("level2_work_item_id", "string", nullable=False),
        FieldSpec("title_snapshot", "string", nullable=False),
        FieldSpec("parent_snapshot", "string", nullable=True),
        FieldSpec("estimate_snapshot", "string", nullable=True),
        FieldSpec("status_snapshot", "string", nullable=True),
        FieldSpec("structure_snapshot", "text", nullable=False, default="{}"),
        FieldSpec("linked_at", "datetime", nullable=False),
        FieldSpec("link_method", "string", nullable=False),
    ),
    sync_entity_type="sessionTaskContext",
    pull_key="sessionTaskContexts",
    description="Immutable task context snapshot linked to a focus session",
))

REGISTRY.register(EntitySpec(
    name="session_attribution_revision",
    model_path="app.models.session_revision.SessionAttributionRevision",
    table_name="session_attribution_revisions",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    sync_conflict_policy="strict_cas",
    fields=_sync_fields() + (
        FieldSpec("session_id", "string", nullable=False, indexed=True),
        FieldSpec("revision", "integer", nullable=False),
        FieldSpec("project_id", "string", nullable=False),
        FieldSpec("level2_work_item_id", "string", nullable=False),
        FieldSpec("reason", "string", nullable=True),
        FieldSpec("corrected_from_revision", "integer", nullable=True),
        FieldSpec("effective", "boolean", nullable=False, default=True),
    ),
    sync_entity_type="sessionAttributionRevision",
    pull_key="sessionAttributionRevisions",
    description="Append-only attribution revision for a focus session",
))

REGISTRY.register(EntitySpec(
    name="session_work_item_plan",
    model_path="app.models.session_revision.SessionWorkItemPlan",
    table_name="session_work_item_plans",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    sync_conflict_policy="strict_cas",
    fields=_sync_fields() + (
        FieldSpec("session_id", "string", nullable=False, indexed=True),
        FieldSpec("work_item_id", "string", nullable=False),
        FieldSpec("title_snapshot", "string", nullable=False),
        FieldSpec("level2_snapshot", "string", nullable=True),
        FieldSpec("plan_rank", "integer", nullable=False, default=0),
        FieldSpec("source", "string", nullable=False),
        FieldSpec("added_at", "datetime", nullable=False),
        FieldSpec("removed_at", "datetime", nullable=True),
        FieldSpec("removal_reason", "string", nullable=True),
        FieldSpec("current_during_session", "boolean", nullable=False, default=False),
        FieldSpec("completion_draft", "boolean", nullable=False, default=False),
    ),
    sync_entity_type="sessionWorkItemPlan",
    pull_key="sessionWorkItemPlans",
    description="Planned work item within a focus session with lifecycle tracking",
))

REGISTRY.register(EntitySpec(
    name="session_work_item_outcome",
    model_path="app.models.session_revision.SessionWorkItemOutcome",
    table_name="session_work_item_outcomes",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    sync_conflict_policy="strict_cas",
    fields=_sync_fields() + (
        FieldSpec("session_id", "string", nullable=False, indexed=True),
        FieldSpec("session_revision", "integer", nullable=False),
        FieldSpec("revision", "integer", nullable=False),
        FieldSpec("corrected_from_revision", "integer", nullable=True),
        FieldSpec("effective", "boolean", nullable=False, default=True),
        FieldSpec("work_item_id", "string", nullable=False),
        FieldSpec("touched", "boolean", nullable=False, default=False),
        FieldSpec("result", "string", nullable=False),
        FieldSpec("persona", "string", nullable=True),
        FieldSpec("state_command", "string", nullable=False, default="none"),
        FieldSpec("command_id", "string", nullable=True),
        FieldSpec("reviewed_at", "datetime", nullable=True),
    ),
    sync_entity_type="sessionWorkItemOutcome",
    pull_key="sessionWorkItemOutcomes",
    description="Append-only outcome record for a work item in a focus session",
))

REGISTRY.register(EntitySpec(
    name="session_command_envelope",
    model_path="app.models.session_command.SessionCommandEnvelope",
    table_name="session_command_envelopes",
    storage_type=StorageType.SYSTEM,
    category=EntityCategory.SYNC_INFRA,
    sync_enabled=False,
    soft_delete=False,
    sync_conflict_policy="strict_cas",
    primary_key="command_id",
    fields=(
        FieldSpec("command_id", "string", nullable=False),
        FieldSpec("space_id", "string", nullable=False),
        FieldSpec("session_id", "string", nullable=False, indexed=True),
        FieldSpec("session_revision", "integer", nullable=False),
        FieldSpec("work_item_id", "string", nullable=False),
        FieldSpec("expected_version", "integer", nullable=False),
        FieldSpec("target_transition", "string", nullable=False),
        FieldSpec("replay_safe", "boolean", nullable=False),
        FieldSpec("payload_hash", "string", nullable=False),
        FieldSpec("created_at", "datetime", nullable=False),
    ),
    description="Immutable command envelope for session state transitions",
))

REGISTRY.register(EntitySpec(
    name="session_command_receipt",
    model_path="app.models.session_command.SessionCommandReceipt",
    table_name="session_command_receipts",
    storage_type=StorageType.SYSTEM,
    category=EntityCategory.SYNC_INFRA,
    sync_enabled=False,
    soft_delete=False,
    sync_conflict_policy="strict_cas",
    primary_key="command_id",
    fields=(
        FieldSpec("command_id", "string", nullable=False),
        FieldSpec("state", "string", nullable=False),
        FieldSpec("error_code", "string", nullable=True),
        FieldSpec("retryable", "boolean", nullable=False, default=False),
        FieldSpec("details_json", "text", nullable=True),
        FieldSpec("result_json", "text", nullable=True),
        FieldSpec("updated_at", "datetime", nullable=False),
    ),
    description="Command receipt tracking state machine outcome",
))

REGISTRY.register(EntitySpec(
    name="active_session_locator",
    model_path="app.db.models.meta.ActiveSessionLocator",
    table_name="active_session_locator",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.META,
    sync_enabled=False,
    soft_delete=False,
    sync_conflict_policy="strict_cas",
    primary_key="singleton_key",
    fields=(
        FieldSpec("singleton_key", "string", nullable=False),
        FieldSpec("space_id", "string", nullable=False),
        FieldSpec("session_id", "string", nullable=False),
        FieldSpec("operation_id", "string", nullable=False),
        FieldSpec("state", "string", nullable=False),
        FieldSpec("owner_device_id", "string", nullable=False),
        FieldSpec("owner_tab_id", "string", nullable=False),
        FieldSpec("ownership_epoch", "integer", nullable=False),
        FieldSpec("lease_expires_at", "datetime", nullable=False),
        FieldSpec("updated_at", "datetime", nullable=False),
    ),
    description="Application-wide singleton owning the currently active focus session",
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
    service_path="app.routes.v1.spaces.create_space",
    schema_module="app.schemas.space",
    schema_prefix="SpaceResponse",
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
    service_path="app.routes.v1.settings.get_settings",
    schema_module="app.schemas.settings",
    schema_prefix="SettingsResponse",
    primary_key="key",
    fields=(
        FieldSpec("key", "string", nullable=False, unique=True),
        FieldSpec("value", "string", nullable=False),
        FieldSpec("updated_at", "datetime", nullable=False),
    ),
    description="Per-space key/value configuration (natural key PK)",
))
