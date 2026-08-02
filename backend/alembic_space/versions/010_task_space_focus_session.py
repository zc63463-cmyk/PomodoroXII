"""Create the final Task Space and FocusSession Space schema."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

from app.task_space.migration_preflight import require_empty_legacy_authority

revision = "space_010_task_space_focus_session"
down_revision = "space_009_mutation_journal"
branch_labels = None
depends_on = None

SEED_TIME = "2026-07-15T00:00:00.000Z"
LEGACY_TABLES = ("task_quick_notes", "session_quick_notes", "tasks", "sessions")
REMOVED_REFERENCE_COLUMNS = {
    "quick_notes": (("session_id", "ix_quick_notes_session_id"),),
    "time_blocks": (("task_id", "ix_time_blocks_task_id"),),
    "reflections": (
        ("related_task_ids", None),
        ("auto_linked_session_ids", None),
    ),
}


def _sync_columns() -> tuple[sa.Column, ...]:
    return (
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("updated_at", sa.String(32), nullable=False),
        sa.Column("version", sa.Integer, nullable=False),
    )


def _drop_removed_reference_columns() -> None:
    """Remove dangling Task/Session references from surviving legacy tables."""
    for table_name, columns in REMOVED_REFERENCE_COLUMNS.items():
        with op.batch_alter_table(table_name) as batch_op:
            for column_name, index_name in columns:
                if index_name is not None:
                    batch_op.drop_index(index_name)
                batch_op.drop_column(column_name)


def _restore_removed_reference_columns() -> None:
    """Restore the pre-TS0 shape for an exact downgrade to space_009."""
    with op.batch_alter_table("quick_notes") as batch_op:
        batch_op.add_column(sa.Column("session_id", sa.String(36), nullable=True))
        batch_op.create_index("ix_quick_notes_session_id", ["session_id"], unique=False)
    with op.batch_alter_table("time_blocks") as batch_op:
        batch_op.add_column(sa.Column("task_id", sa.String(36), nullable=True))
        batch_op.create_index("ix_time_blocks_task_id", ["task_id"], unique=False)
    with op.batch_alter_table("reflections") as batch_op:
        batch_op.add_column(
            sa.Column("related_task_ids", sa.String(4000), nullable=False, server_default="[]")
        )
        batch_op.add_column(
            sa.Column(
                "auto_linked_session_ids",
                sa.String(4000),
                nullable=False,
                server_default="[]",
            )
        )
        batch_op.alter_column("related_task_ids", server_default=None)
        batch_op.alter_column("auto_linked_session_ids", server_default=None)


def upgrade() -> None:
    require_empty_legacy_authority(op.get_bind())
    op.create_table(
        "status_definitions",
        *_sync_columns(),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("category", sa.String(32), nullable=False),
        sa.Column("icon", sa.String(32)),
        sa.Column("color", sa.String(32)),
        sa.Column("rank", sa.Integer, nullable=False, server_default="0"),
        sa.Column("system", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("archived_at", sa.String(32)),
        sa.CheckConstraint(
            "category IN ('not_started','in_progress','paused','waiting','completed','cancelled')",
            name="category_values",
        ),
        sa.UniqueConstraint("category", "system", name="uq_status_definitions_category_system"),
    )
    op.create_table(
        "type_definitions",
        *_sync_columns(),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("icon", sa.String(32)),
        sa.Column("color", sa.String(32)),
        sa.Column("rank", sa.Integer, nullable=False, server_default="0"),
        sa.Column("system", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("archived_at", sa.String(32)),
        sa.CheckConstraint("length(trim(name)) > 0", name="name_nonblank"),
    )
    op.create_table(
        "labels",
        *_sync_columns(),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("color", sa.String(32)),
        sa.Column("archived_at", sa.String(32)),
        sa.UniqueConstraint("name", name="uq_labels_name"),
    )
    op.create_table(
        "projects",
        *_sync_columns(),
        sa.Column("key", sa.String(10), nullable=False),
        sa.Column("next_work_item_number", sa.Integer, nullable=False, server_default="1"),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("rank", sa.Integer, nullable=False, server_default="0"),
        sa.Column("default_status_definition_id", sa.String(36), nullable=False),
        sa.Column("default_type_definition_id", sa.String(36), nullable=False),
        sa.Column("archived_at", sa.String(32)),
        sa.ForeignKeyConstraint(
            ["default_status_definition_id"], ["status_definitions.id"]
        ),
        sa.ForeignKeyConstraint(["default_type_definition_id"], ["type_definitions.id"]),
        sa.UniqueConstraint("key", name="uq_projects_key"),
        sa.CheckConstraint(
            "length(key) BETWEEN 2 AND 10 AND substr(key, 1, 1) GLOB '[A-Z]' "
            "AND key NOT GLOB '*[^A-Z0-9]*'",
            name="key_format",
        ),
        sa.CheckConstraint("next_work_item_number >= 1", name="next_work_item_number_positive"),
    )
    op.create_table(
        "work_items",
        *_sync_columns(),
        sa.Column("project_id", sa.String(36), nullable=False),
        sa.Column("display_key", sa.String(64), nullable=False),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("type_definition_id", sa.String(36), nullable=False),
        sa.Column("status_definition_id", sa.String(36), nullable=False),
        sa.Column("priority", sa.String(20)),
        sa.Column("parent_id", sa.String(36)),
        sa.Column("child_rank", sa.Integer, nullable=False, server_default="0"),
        sa.Column("completion_window_start", sa.String(32)),
        sa.Column("completion_window_end", sa.String(32)),
        sa.Column("review_point", sa.String(32)),
        sa.Column("hard_deadline", sa.String(32)),
        sa.Column("effort_estimate_lower_seconds", sa.Integer),
        sa.Column("effort_estimate_upper_seconds", sa.Integer),
        sa.Column("effort_actual_seconds", sa.Integer, nullable=False, server_default="0"),
        sa.Column("confidence", sa.String(20)),
        sa.Column("completed_at", sa.String(32)),
        sa.Column("cancelled_at", sa.String(32)),
        sa.Column("archived_at", sa.String(32)),
        sa.Column("marked_as_attention", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.ForeignKeyConstraint(["type_definition_id"], ["type_definitions.id"]),
        sa.ForeignKeyConstraint(["status_definition_id"], ["status_definitions.id"]),
        sa.ForeignKeyConstraint(["parent_id"], ["work_items.id"]),
        sa.UniqueConstraint("project_id", "display_key", name="uq_work_items_project_display_key"),
        sa.CheckConstraint(
            "priority IS NULL OR priority IN ('low','medium','high','urgent')",
            name="priority_values",
        ),
        sa.CheckConstraint(
            "confidence IS NULL OR confidence IN ('low','medium','high')",
            name="confidence_values",
        ),
        sa.CheckConstraint("effort_actual_seconds >= 0", name="effort_actual_nonnegative"),
        sa.CheckConstraint(
            "(effort_estimate_lower_seconds IS NULL AND effort_estimate_upper_seconds IS NULL) "
            "OR (effort_estimate_lower_seconds >= 0 AND effort_estimate_upper_seconds > 0 "
            "AND effort_estimate_lower_seconds <= effort_estimate_upper_seconds)",
            name="effort_range",
        ),
    )
    op.create_table(
        "work_item_labels",
        sa.Column("work_item_id", sa.String(36), nullable=False),
        sa.Column("label_id", sa.String(36), nullable=False),
        sa.ForeignKeyConstraint(["work_item_id"], ["work_items.id"]),
        sa.ForeignKeyConstraint(["label_id"], ["labels.id"]),
        sa.PrimaryKeyConstraint("work_item_id", "label_id"),
    )
    op.create_table(
        "work_item_notes",
        *_sync_columns(),
        sa.Column("work_item_id", sa.String(36), nullable=False),
        sa.Column("document_json", sa.Text, nullable=False),
        sa.ForeignKeyConstraint(["work_item_id"], ["work_items.id"]),
        sa.UniqueConstraint("work_item_id", name="uq_work_item_notes_work_item_id"),
    )
    op.create_table(
        "focus_sessions",
        *_sync_columns(),
        sa.Column("session_revision", sa.Integer, nullable=False, server_default="1"),
        sa.Column("started_at", sa.String(32), nullable=False),
        sa.Column("ended_at", sa.String(32)),
        sa.Column("pause_started_at", sa.String(32)),
        sa.Column("planned_seconds", sa.Integer, nullable=False, server_default="0"),
        sa.Column("gross_seconds", sa.Integer, nullable=False, server_default="0"),
        sa.Column("paused_seconds", sa.Integer, nullable=False, server_default="0"),
        sa.Column("break_seconds", sa.Integer, nullable=False, server_default="0"),
        sa.Column("focused_seconds", sa.Integer, nullable=False, server_default="0"),
        sa.Column("timer_completion", sa.String(32)),
        sa.Column("validity", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("validity_reason", sa.String(500)),
        sa.Column("overall_progress", sa.String(32)),
        sa.Column("mood", sa.String(32)),
        sa.Column("session_note", sa.Text, nullable=False, server_default=""),
        sa.Column("review_state", sa.String(32), nullable=False, server_default="not_required"),
        sa.Column("ownership_state", sa.String(32), nullable=False, server_default="authoritative"),
        sa.CheckConstraint(
            "planned_seconds >= 0 AND gross_seconds >= 0 AND paused_seconds >= 0 "
            "AND break_seconds >= 0 AND focused_seconds >= 0",
            name="duration_nonnegative",
        ),
        sa.CheckConstraint(
            "validity IN ('pending','valid','invalid')",
            name="validity_values",
        ),
        sa.CheckConstraint(
            "review_state IN ('not_required','pending','completed','skipped')",
            name="review_state_values",
        ),
        sa.CheckConstraint(
            "ownership_state IN ('authoritative','local_provisional','activation_conflict')",
            name="ownership_state_values",
        ),
    )
    op.create_table(
        "session_task_contexts",
        *_sync_columns(),
        sa.Column("session_id", sa.String(36), nullable=False),
        sa.Column("project_id", sa.String(36), nullable=False),
        sa.Column("level2_work_item_id", sa.String(36), nullable=False),
        sa.Column("title_snapshot", sa.String(500), nullable=False),
        sa.Column("parent_snapshot", sa.String(500)),
        sa.Column("estimate_snapshot", sa.String(200)),
        sa.Column("status_snapshot", sa.String(100)),
        sa.Column("structure_snapshot", sa.Text, nullable=False, server_default="{}"),
        sa.Column("linked_at", sa.String(32), nullable=False),
        sa.Column("link_method", sa.String(32), nullable=False),
        sa.ForeignKeyConstraint(["session_id"], ["focus_sessions.id"]),
        sa.UniqueConstraint("session_id", name="uq_session_task_contexts_session_id"),
    )
    op.create_table(
        "session_attribution_revisions",
        *_sync_columns(),
        sa.Column("session_id", sa.String(36), nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("project_id", sa.String(36), nullable=False),
        sa.Column("level2_work_item_id", sa.String(36), nullable=False),
        sa.Column("reason", sa.String(500)),
        sa.Column("corrected_from_revision", sa.Integer),
        sa.Column("effective", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.ForeignKeyConstraint(["session_id"], ["focus_sessions.id"]),
        sa.UniqueConstraint("session_id", "revision", name="uq_session_attribution_revision"),
    )
    op.create_table(
        "session_work_item_plans",
        *_sync_columns(),
        sa.Column("session_id", sa.String(36), nullable=False),
        sa.Column("work_item_id", sa.String(36), nullable=False),
        sa.Column("title_snapshot", sa.String(500), nullable=False),
        sa.Column("level2_snapshot", sa.String(500)),
        sa.Column("plan_rank", sa.Integer, nullable=False, server_default="0"),
        sa.Column("source", sa.String(32), nullable=False),
        sa.Column("added_at", sa.String(32), nullable=False),
        sa.Column("removed_at", sa.String(32)),
        sa.Column("removal_reason", sa.String(500)),
        sa.Column("current_during_session", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("completion_draft", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.ForeignKeyConstraint(["session_id"], ["focus_sessions.id"]),
        sa.UniqueConstraint("session_id", "work_item_id", name="uq_session_work_item_plan"),
        sa.CheckConstraint("plan_rank >= 0", name="plan_rank_nonnegative"),
        sa.CheckConstraint(
            "source IN ('before_start','during_session','review_materialized')",
            name="plan_source_values",
        ),
    )
    op.create_table(
        "session_work_item_outcomes",
        *_sync_columns(),
        sa.Column("session_id", sa.String(36), nullable=False),
        sa.Column("session_revision", sa.Integer, nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("corrected_from_revision", sa.Integer),
        sa.Column("effective", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("work_item_id", sa.String(36), nullable=False),
        sa.Column("touched", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("result", sa.String(32), nullable=False),
        sa.Column("persona", sa.String(32)),
        sa.Column("state_command", sa.String(32), nullable=False, server_default="none"),
        sa.Column("command_id", sa.String(128)),
        sa.Column("reviewed_at", sa.String(32)),
        sa.ForeignKeyConstraint(["session_id"], ["focus_sessions.id"]),
        sa.UniqueConstraint(
            "session_id", "work_item_id", "revision", name="uq_session_work_item_outcome"
        ),
        sa.CheckConstraint(
            "result IN ('completed','progressed','stuck','untouched','cancelled')",
            name="outcome_result_values",
        ),
        sa.CheckConstraint(
            "state_command IN ('complete','cancel','none')",
            name="state_command_values",
        ),
    )
    op.create_table(
        "session_command_envelopes",
        sa.Column("command_id", sa.String(128), primary_key=True),
        sa.Column("space_id", sa.String(36), nullable=False),
        sa.Column("session_id", sa.String(36), nullable=False),
        sa.Column("session_revision", sa.Integer, nullable=False),
        sa.Column("work_item_id", sa.String(36), nullable=False),
        sa.Column("expected_version", sa.Integer, nullable=False),
        sa.Column("target_transition", sa.String(32), nullable=False),
        sa.Column("replay_safe", sa.Boolean, nullable=False),
        sa.Column("payload_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.ForeignKeyConstraint(["session_id"], ["focus_sessions.id"]),
        sa.CheckConstraint("expected_version >= 0", name="expected_version_nonnegative"),
        sa.CheckConstraint("target_transition IN ('complete','cancel')", name="target_transition_values"),
        sa.CheckConstraint("length(payload_hash) = 64", name="payload_hash_length"),
    )
    op.create_table(
        "session_command_receipts",
        sa.Column("command_id", sa.String(128), primary_key=True),
        sa.Column("state", sa.String(32), nullable=False),
        sa.Column("error_code", sa.String(64)),
        sa.Column("retryable", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("details_json", sa.Text),
        sa.Column("result_json", sa.Text),
        sa.Column("updated_at", sa.String(32), nullable=False),
        sa.ForeignKeyConstraint(["command_id"], ["session_command_envelopes.command_id"]),
        sa.CheckConstraint(
            "state IN ('not_needed','pending','succeeded','failed','conflict','unknown','abandoned')",
            name="receipt_state_values",
        ),
    )

    for table_name in LEGACY_TABLES:
        op.drop_table(table_name)
    _drop_removed_reference_columns()

    statuses = (
        ("sys-status-not-started", "Not started", "not_started", 0),
        ("sys-status-in-progress", "In progress", "in_progress", 1),
        ("sys-status-paused", "Paused", "paused", 2),
        ("sys-status-waiting", "Waiting", "waiting", 3),
        ("sys-status-completed", "Completed", "completed", 4),
        ("sys-status-cancelled", "Cancelled", "cancelled", 5),
    )
    for status_id, name, category, rank in statuses:
        op.bulk_insert(
            sa.table(
                "status_definitions",
                sa.column("id", sa.String),
                sa.column("name", sa.String),
                sa.column("category", sa.String),
                sa.column("rank", sa.Integer),
                sa.column("system", sa.Boolean),
                sa.column("created_at", sa.String),
                sa.column("updated_at", sa.String),
                sa.column("version", sa.Integer),
            ),
            [{
                "id": status_id,
                "name": name,
                "category": category,
                "rank": rank,
                "system": True,
                "created_at": SEED_TIME,
                "updated_at": SEED_TIME,
                "version": 1,
            }],
        )
    op.bulk_insert(
        sa.table(
            "type_definitions",
            sa.column("id", sa.String),
            sa.column("name", sa.String),
            sa.column("rank", sa.Integer),
            sa.column("system", sa.Boolean),
            sa.column("created_at", sa.String),
            sa.column("updated_at", sa.String),
            sa.column("version", sa.Integer),
        ),
        [{
            "id": "sys-type-work-item",
            "name": "Work item",
            "rank": 0,
            "system": True,
            "created_at": SEED_TIME,
            "updated_at": SEED_TIME,
            "version": 1,
        }],
    )
    for table_name in (
        "status_definitions",
        "type_definitions",
        "labels",
        "projects",
        "work_items",
        "work_item_notes",
        "focus_sessions",
        "session_task_contexts",
        "session_attribution_revisions",
        "session_work_item_plans",
        "session_work_item_outcomes",
    ):
        op.create_index(
            f"ix_{table_name}_updated_at",
            table_name,
            ["updated_at"],
        )
    op.create_index("ix_work_items_project_id", "work_items", ["project_id"])
    op.create_index("ix_work_items_parent_id", "work_items", ["parent_id"])
    op.create_index(
        "uq_session_attribution_effective",
        "session_attribution_revisions",
        ["session_id"],
        unique=True,
        sqlite_where=sa.text("effective = 1"),
    )
    op.create_index(
        "uq_session_work_item_outcome_effective",
        "session_work_item_outcomes",
        ["session_id", "work_item_id"],
        unique=True,
        sqlite_where=sa.text("effective = 1"),
    )


def downgrade() -> None:
    connection = op.get_bind()
    seed_statuses = (
        "sys-status-not-started",
        "sys-status-in-progress",
        "sys-status-paused",
        "sys-status-waiting",
        "sys-status-completed",
        "sys-status-cancelled",
    )
    marks = ",".join("?" for _ in seed_statuses)
    if connection.exec_driver_sql(
        f"SELECT 1 FROM status_definitions WHERE id NOT IN ({marks}) LIMIT 1",
        seed_statuses,
    ).first() is not None:
        raise RuntimeError("space_010_downgrade_requires_empty_final_schema")
    if connection.exec_driver_sql(
        "SELECT 1 FROM type_definitions WHERE id != ? LIMIT 1",
        ("sys-type-work-item",),
    ).first() is not None:
        raise RuntimeError("space_010_downgrade_requires_empty_final_schema")
    for table_name in (
        "labels",
        "projects",
        "work_item_labels",
        "work_items",
        "work_item_notes",
        "focus_sessions",
        "session_task_contexts",
        "session_attribution_revisions",
        "session_work_item_plans",
        "session_work_item_outcomes",
        "session_command_envelopes",
        "session_command_receipts",
    ):
        if connection.exec_driver_sql(
            f'SELECT 1 FROM "{table_name}" LIMIT 1'
        ).first() is not None:
            raise RuntimeError("space_010_downgrade_requires_empty_final_schema")

    op.drop_index(
        "uq_session_work_item_outcome_effective",
        table_name="session_work_item_outcomes",
    )
    op.drop_index(
        "uq_session_attribution_effective",
        table_name="session_attribution_revisions",
    )
    for table_name in (
        "session_command_receipts",
        "session_command_envelopes",
        "session_work_item_outcomes",
        "session_work_item_plans",
        "session_attribution_revisions",
        "session_task_contexts",
        "focus_sessions",
        "work_item_notes",
        "work_item_labels",
        "work_items",
        "projects",
        "labels",
        "type_definitions",
        "status_definitions",
    ):
        op.drop_table(table_name)

    _restore_removed_reference_columns()

    # Restore the empty pre-TS0 authority so older revisions can be downgraded
    # and inspected without depending on data-bearing rollback.
    op.create_table(
        "sessions",
        sa.Column("task_id", sa.String(36), nullable=True),
        sa.Column("type", sa.String(20), nullable=False),
        sa.Column("duration", sa.Integer, nullable=False),
        sa.Column("completed", sa.Boolean, nullable=False),
        sa.Column("plan", sa.String(10000), nullable=False),
        sa.Column("completion", sa.String(10000), nullable=False),
        sa.Column("started_at", sa.String(32), nullable=False),
        sa.Column("ended_at", sa.String(32), nullable=True),
        sa.Column("mood", sa.String(20), nullable=True),
        sa.Column("note", sa.String(10000), nullable=False),
        sa.Column("attention_score", sa.Integer, nullable=True),
        sa.Column("flow_state_detected", sa.Boolean, nullable=True),
        sa.Column("flow_state_confidence", sa.Float, nullable=True),
        sa.Column("interruption_count", sa.Integer, server_default=sa.text("0"), nullable=True),
        sa.Column("total_interruption_duration", sa.Integer, server_default=sa.text("0"), nullable=True),
        sa.Column("avg_recovery_time", sa.Integer, nullable=True),
        sa.Column("pause_count", sa.Integer, server_default=sa.text("0"), nullable=True),
        sa.Column("total_pause_duration", sa.Integer, server_default=sa.text("0"), nullable=True),
        sa.Column("cognitive_mark_summary", sa.String(4000), nullable=True),
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("updated_at", sa.String(32), nullable=False),
        sa.Column("version", sa.Integer, nullable=False),
        sa.CheckConstraint(
            "type IN ('work','short_break','long_break','free','countdown')",
            name="ck_sessions_check_session_type",
        ),
        sa.CheckConstraint(
            "mood IN ('great','good','normal','bad','terrible') OR mood IS NULL",
            name="check_session_mood",
        ),
    )
    op.create_table(
        "tasks",
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("description", sa.String(10000), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("priority", sa.String(20), nullable=False),
        sa.Column("tags", sa.String(4000), nullable=False),
        sa.Column("plan", sa.String(10000), nullable=False),
        sa.Column("completion", sa.String(10000), nullable=False),
        sa.Column("due_date", sa.String(32), nullable=True),
        sa.Column("estimated_pomodoros", sa.Integer, nullable=False),
        sa.Column("actual_pomodoros", sa.Integer, nullable=False),
        sa.Column("archived_at", sa.String(32), nullable=True),
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("updated_at", sa.String(32), nullable=False),
        sa.Column("version", sa.Integer, nullable=False),
        sa.CheckConstraint(
            "status IN ('todo','in_progress','done','archived')",
            name="ck_tasks_check_task_status",
        ),
        sa.CheckConstraint(
            "priority IN ('low','medium','high','urgent')",
            name="ck_tasks_check_task_priority",
        ),
    )
    for index_name, columns in (
        ("ix_tasks_status", ["status"]),
        ("ix_tasks_priority", ["priority"]),
        ("ix_tasks_due_date", ["due_date"]),
        ("ix_tasks_updated_at", ["updated_at"]),
    ):
        op.create_index(index_name, "tasks", columns)
    op.create_index("ix_sessions_updated_at", "sessions", ["updated_at"])
    for table_name, parent_column in (
        ("task_quick_notes", "task_id"),
        ("session_quick_notes", "session_id"),
    ):
        op.create_table(
            table_name,
            sa.Column(parent_column, sa.String(36), nullable=False),
            sa.Column("quick_note_id", sa.String(36), nullable=False),
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("created_at", sa.String(32), nullable=False),
            sa.Column("updated_at", sa.String(32), nullable=False),
            sa.Column("version", sa.Integer, nullable=False),
        )
        op.create_index(
            f"ix_{table_name}_{parent_column}", table_name, [parent_column]
        )
        op.create_index(
            f"ix_{table_name}_quick_note_id", table_name, ["quick_note_id"]
        )
        op.create_index(
            f"ix_{table_name}_updated_at", table_name, ["updated_at"]
        )
