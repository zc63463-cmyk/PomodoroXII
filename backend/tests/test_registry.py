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

    # Sync eligibility: all 22 business entities participate in sync.
    sync_names = {s.name for s in REGISTRY.list_sync_enabled()}
    assert sync_names == {
        "note", "folder", "quick_note", "reflection",
        "habit", "habit_check_in", "schedule", "time_block", "memo_comment",
        "schedule_quick_note",
        "project", "status_definition", "type_definition", "label",
        "work_item_label", "work_item", "work_item_note",
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
