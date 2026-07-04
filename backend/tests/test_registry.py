"""Gate tests for the entity registry.

These tests act as a regression gate: they ensure the registry singleton
is populated with the expected set of entities and that key business
classifications (FS+DB split, soft-delete support, sync eligibility)
remain stable as the project evolves.

Any new ORM model added to ``app/models`` or ``app/db/models/meta.py``
MUST be accompanied by a registration in ``app/registry/builtin.py``;
otherwise ``test_registry_has_20_entities`` will fail and surface the
omission before it reaches Phase C sync or the meta API.
"""
from __future__ import annotations

import pytest

from app.registry import REGISTRY
from app.registry.entities import EntityCategory, StorageType


def test_registry_has_20_entities():
    """Registry must contain exactly 20 entities.

    Breakdown:
    - 14 BUSINESS (11 first-class + 3 junctions)
    - 3 SYNC_INFRA (tombstone, sync_outbox, sync_audit_log)
    - 2 META (space, meta_setting)
    - 1 SETTING (setting)
    """
    assert len(REGISTRY) == 20, (
        f"Expected 20 entities, got {len(REGISTRY)}. "
        "Did you add a new model without registering it in builtin.py?"
    )

    # Every expected entity name must be present.
    expected_names = {
        # 14 business
        "task", "session", "note", "folder", "quick_note", "reflection",
        "habit", "habit_check_in", "schedule", "time_block", "memo_comment",
        "session_quick_note", "schedule_quick_note", "task_quick_note",
        # 3 sync infra
        "tombstone", "sync_outbox", "sync_audit_log",
        # 2 meta
        "space", "meta_setting",
        # 1 setting
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
    assert len(REGISTRY.list_by_category(EntityCategory.BUSINESS)) == 14
    assert len(REGISTRY.list_by_category(EntityCategory.SYNC_INFRA)) == 3
    assert len(REGISTRY.list_by_category(EntityCategory.META)) == 2
    assert len(REGISTRY.list_by_category(EntityCategory.SETTING)) == 1

    # Sync eligibility: only the 14 business entities participate in sync.
    sync_names = {s.name for s in REGISTRY.list_sync_enabled()}
    assert sync_names == {
        "task", "session", "note", "folder", "quick_note", "reflection",
        "habit", "habit_check_in", "schedule", "time_block", "memo_comment",
        "session_quick_note", "schedule_quick_note", "task_quick_note",
    }

    # Soft-delete support: only note / folder / quick_note have trashed_at.
    soft_delete_names = {s.name for s in REGISTRY.list_soft_delete()}
    assert soft_delete_names == {"note", "folder", "quick_note"}

    # Task must NOT support soft-delete (P1-1 confirmed: no trashed_at column).
    task_spec = REGISTRY.get("task")
    assert task_spec.soft_delete is False

    # SYSTEM storage applies only to the 3 sync-infra tables.
    system_names = {
        s.name for s in REGISTRY.list()
        if s.storage_type == StorageType.SYSTEM
    }
    assert system_names == {"tombstone", "sync_outbox", "sync_audit_log"}


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
