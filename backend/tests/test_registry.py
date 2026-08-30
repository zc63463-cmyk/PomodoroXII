"""Gate tests for the entity registry.

These tests act as a regression gate: they ensure the registry singleton
is populated with the expected set of entities and that key business
classifications (FS+DB split, soft-delete support, sync eligibility)
remain stable as the project evolves.

Any new ORM model added to ``app/models`` or ``app/db/models/meta.py``
MUST be accompanied by a registration in ``app/registry/builtin.py``;
otherwise ``test_registry_has_31_entities`` will fail and surface the
omission before it reaches Phase C sync or the meta API.
"""
from __future__ import annotations

import pytest

from app.registry import REGISTRY
from app.registry.entities import EntityCategory, StorageType


def test_registry_has_31_entities():
    """Registry must contain exactly 31 entities.

    Breakdown:
    - 22 BUSINESS (first-class + junctions)
    - 5 SYNC_INFRA (tombstone, sync_outbox, sync_audit_log,
      session_command_envelope, session_command_receipt)
    - 3 META (space, meta_setting, active_session_locator)
    - 1 SETTING (setting)
    """
    assert len(REGISTRY) == 31, (
        f"Expected 31 entities, got {len(REGISTRY)}. "
        "Did you add a new model without registering it in builtin.py?"
    )

    # Every expected entity name must be present.
    expected_names = {
        "note", "folder", "quick_note", "reflection",
        "habit", "habit_check_in", "schedule", "time_block", "memo_comment",
        "schedule_quick_note",
        "project", "status_definition", "type_definition", "label",
        "work_item_label", "work_item", "work_item_note",
        "focus_session", "session_task_context", "session_attribution_revision",
        "session_work_item_plan", "session_work_item_outcome",
        "tombstone", "sync_outbox", "sync_audit_log",
        "session_command_envelope", "session_command_receipt",
        "space", "meta_setting", "active_session_locator",
        "setting",
    }
    actual_names = {s.name for s in REGISTRY.list()}
    missing = expected_names - actual_names
    extra = actual_names - expected_names
    assert not missing, f"Missing entities in registry: {missing}"
    assert not extra, f"Unexpected entities in registry: {extra}"


def test_registry_note_is_fs_db_split_and_sync_enabled():
    """Note is the only FS+DB split entity and must be sync-enabled.

    This is the architectural keystone of the three-layer discipline:
    the Note model stores content externally (filesystem) while keeping
    only content_hash + word_count in the DB row.  Phase C sync must
    dispatch Note events to NoteService (Saga), not to the generic ORM
    path.  This test guards that contract.
    """
    spec = REGISTRY.get("note")
    assert spec.storage_type == StorageType.FS_DB_SPLIT
    assert spec.sync_enabled is True
    assert spec.soft_delete is True  # Note has trashed_at

    # Note must be the *only* FS_DB_SPLIT entity.
    fs_split = [
        s.name for s in REGISTRY.list()
        if s.storage_type == StorageType.FS_DB_SPLIT
    ]
    assert fs_split == ["note"], (
        f"Expected only 'note' to be FS_DB_SPLIT, got {fs_split}"
    )


def test_registry_categorization_and_classifications():
    """Verify category counts and key classification flags.

    These counts are consumed by:
    - ``/api/v1/meta/health`` (categories dict)
    - ``SyncService.push`` (list_sync_enabled)
    - ``trash.py._resolve_model`` (list_soft_delete)
    """
    # Category counts.
    assert len(REGISTRY.list_by_category(EntityCategory.BUSINESS)) == 22
    assert len(REGISTRY.list_by_category(EntityCategory.SYNC_INFRA)) == 5
    assert len(REGISTRY.list_by_category(EntityCategory.META)) == 3
    assert len(REGISTRY.list_by_category(EntityCategory.SETTING)) == 1

    # Sync eligibility: 21 of the 22 business entities participate in sync.
    # work_item_label (composite (work_item_id, label_id) primary key) is the
    # deliberate exception — see the builtin.py declaration comment.
    sync_names = {s.name for s in REGISTRY.list_sync_enabled()}
    assert sync_names == {
        "note", "folder", "quick_note", "reflection",
        "habit", "habit_check_in", "schedule", "time_block", "memo_comment",
        "schedule_quick_note",
        "project", "status_definition", "type_definition", "label",
        "work_item", "work_item_note",
        "focus_session", "session_task_context", "session_attribution_revision",
        "session_work_item_plan", "session_work_item_outcome",
    }

    # Soft-delete support: only note / folder / quick_note have trashed_at.
    soft_delete_names = {s.name for s in REGISTRY.list_soft_delete()}
    assert soft_delete_names == {"note", "folder", "quick_note"}

    # SYSTEM storage applies to sync-infra tables (including session command
    # envelopes/receipts which are immutable infra records).
    system_names = {
        s.name for s in REGISTRY.list()
        if s.storage_type == StorageType.SYSTEM
    }
    assert system_names == {
        "tombstone", "sync_outbox", "sync_audit_log",
        "session_command_envelope", "session_command_receipt",
    }


def test_registry_get_unknown_raises_keyerror():
    """Querying an unregistered entity must raise KeyError."""
    with pytest.raises(KeyError):
        REGISTRY.get("nonexistent_entity")


def test_registry_register_duplicate_raises_valueerror():
    """Re-registering an entity name must raise ValueError."""
    from app.registry import EntityRegistry
    from app.registry.entities import (
        EntityCategory,
        EntitySpec,
        FieldSpec,
        StorageType,
    )
    local = EntityRegistry()
    spec = EntitySpec(
        name="dup",
        model_path="app.models.x.X",
        table_name="xs",
        storage_type=StorageType.DB_ONLY,
        category=EntityCategory.BUSINESS,
        sync_enabled=False,
        soft_delete=False,
        fields=(FieldSpec("id", "string", nullable=False),),
    )
    local.register(spec)
    with pytest.raises(ValueError):
        local.register(spec)


# --------------------------------------------------------------------------- #
# TS1 Task 7 — Task Space entity and sync-key parity gates
# --------------------------------------------------------------------------- #

TASK_SPACE_ENTITY_NAMES = frozenset({
    "project",
    "status_definition",
    "type_definition",
    "label",
    "work_item_label",
    "work_item",
    "work_item_note",
    "focus_session",
    "session_task_context",
    "session_attribution_revision",
    "session_work_item_plan",
    "session_work_item_outcome",
})

EXPECTED_CAMEL_CASE_SYNC_KEYS = {
    "project": "project",
    "status_definition": "statusDefinition",
    "type_definition": "typeDefinition",
    "label": "label",
    "work_item_label": "workItemLabel",
    "work_item": "workItem",
    "work_item_note": "workItemNote",
    "focus_session": "focusSession",
    "session_task_context": "sessionTaskContext",
    "session_attribution_revision": "sessionAttributionRevision",
    "session_work_item_plan": "sessionWorkItemPlan",
    "session_work_item_outcome": "sessionWorkItemOutcome",
}


def test_task_space_entities_are_registered():
    """All seven core Task Space entities must be present in the registry."""
    actual_names = {s.name for s in REGISTRY.list()}
    missing = TASK_SPACE_ENTITY_NAMES - actual_names
    assert not missing, f"Task Space entities missing from registry: {missing}"


def test_task_space_entities_have_camel_case_sync_keys():
    """Each Task Space entity must expose the correct camelCase sync_entity_type."""
    for snake_name, expected_camel in EXPECTED_CAMEL_CASE_SYNC_KEYS.items():
        spec = REGISTRY.get(snake_name)
        assert spec.effective_sync_entity_type == expected_camel, (
            f"Entity '{snake_name}' has sync_entity_type="
            f"{spec.effective_sync_entity_type!r}, expected {expected_camel!r}"
        )


def test_legacy_task_entity_is_absent():
    """The legacy 'task' entity must NOT exist in the registry."""
    actual_names = {s.name for s in REGISTRY.list()}
    assert "task" not in actual_names, (
        "Legacy 'task' entity must not be registered; "
        "it has been replaced by 'work_item'."
    )


# --------------------------------------------------------------------------- #
# Wave 1 — work_item_label is NOT handed to the generic sync protocol
# --------------------------------------------------------------------------- #


def test_work_item_label_remains_registered_but_not_sync_enabled():
    """The work_item_label junction stays registered (composite key intact)
    but is never declared sync-enabled: the generic sync directory must not
    own a relation whose real primary key is composite.
    """
    spec = REGISTRY.get("work_item_label")
    assert spec.sync_enabled is False
    assert spec.category == EntityCategory.BUSINESS
    # The fabricated single-column primary key is metadata only; the real
    # composite key is unchanged and no API is added.
    assert spec.primary_key == "work_item_id"
    assert "work_item_label" not in {s.name for s in REGISTRY.list_sync_enabled()}


def test_build_sync_registry_excludes_work_item_label():
    """build_sync_registry (the source of the generic sync protocol) must not
    contain the work_item_label relation.
    """
    from app.registry.sync_registry import build_sync_registry

    registry = build_sync_registry()
    assert "workItemLabel" not in registry
    assert "workItemLabels" not in {entry["pull_key"] for entry in registry.values()}
