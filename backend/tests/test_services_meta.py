"""Tests for ``MetaService`` -- the read-only registry query facade.

These tests verify the service layer's contract that the route layer
will rely on: list filtering, single-entity lookup, schema extraction,
health stats, and error translation (``KeyError`` -> ``NotFoundError``,
invalid category -> ``ValidationError``).
"""
from __future__ import annotations

import pytest

from app.errors import NotFoundError, ValidationError
from app.registry.entities import EntityCategory, StorageType
from app.services.meta import MetaService


def test_meta_service_list_by_category():
    """list_entities(category=...) filters correctly for each category."""
    svc = MetaService()

    business = svc.list_entities(category=EntityCategory.BUSINESS)
    assert len(business) == 22
    assert all(s.category == EntityCategory.BUSINESS for s in business)

    sync_infra = svc.list_entities(category=EntityCategory.SYNC_INFRA)
    assert len(sync_infra) == 5

    meta = svc.list_entities(category=EntityCategory.META)
    assert len(meta) == 3

    setting = svc.list_entities(category=EntityCategory.SETTING)
    assert len(setting) == 1

    # No filter -> all 31 entities.
    all_entities = svc.list_entities()
    assert len(all_entities) == 31


def test_meta_service_list_with_string_category():
    """list_entities accepts a string category and coerces it."""
    svc = MetaService()
    business = svc.list_entities(category="business")
    assert len(business) == 22


def test_meta_service_list_invalid_category_raises_validation_error():
    """An unknown category string must raise ValidationError (HTTP 422)."""
    svc = MetaService()
    with pytest.raises(ValidationError):
        svc.list_entities(category="nonexistent_category")


def test_meta_service_get_unknown_raises_not_found():
    """Querying an unregistered entity must raise NotFoundError (HTTP 404)."""
    svc = MetaService()
    with pytest.raises(NotFoundError):
        svc.get_entity("nonexistent_entity")


def test_meta_service_get_entity_returns_full_spec():
    """get_entity returns the full EntitySpec with all fields populated."""
    svc = MetaService()
    spec = svc.get_entity("note")
    assert spec.name == "note"
    assert spec.storage_type == StorageType.FS_DB_SPLIT
    assert spec.sync_enabled is True
    assert spec.soft_delete is True
    assert len(spec.fields) > 0
    # Must include the SyncMixin fields.
    field_names = spec.field_names
    assert "id" in field_names
    assert "created_at" in field_names
    assert "updated_at" in field_names
    assert "version" in field_names
    # Must include Note-specific fields.
    assert "content_hash" in field_names
    assert "word_count" in field_names
    assert "trashed_at" in field_names


def test_meta_service_get_schema_returns_dict():
    """get_schema returns a code-generator-friendly dict."""
    svc = MetaService()
    schema = svc.get_schema("habit")
    assert schema["entity_type"] == "habit"
    assert schema["table_name"] == "habits"
    assert schema["primary_key"] == "id"
    assert isinstance(schema["fields"], list)
    assert len(schema["fields"]) > 0
    # Each field dict must have the expected keys.
    f = schema["fields"][0]
    assert {"name", "type", "nullable", "default", "indexed", "unique", "description"} <= set(f)


def test_meta_service_get_schema_unknown_raises_not_found():
    """get_schema on an unknown entity must raise NotFoundError."""
    svc = MetaService()
    with pytest.raises(NotFoundError):
        svc.get_schema("nonexistent")


def test_meta_service_health_returns_correct_structure():
    """health() returns registry_loaded / entity_count / categories."""
    svc = MetaService()
    h = svc.health()
    assert h["registry_loaded"] is True
    assert h["entity_count"] == 31
    assert isinstance(h["categories"], dict)
    assert h["categories"]["business"] == 22
    assert h["categories"]["sync_infra"] == 5
    assert h["categories"]["meta"] == 3
    assert h["categories"]["setting"] == 1


def test_meta_service_serialize_roundtrips_spec():
    """serialize() produces a JSON-safe dict with enum values as strings."""
    svc = MetaService()
    spec = svc.get_entity("note")
    d = svc.serialize(spec)
    assert d["name"] == "note"
    assert d["storage_type"] == "fs_db_split"  # str, not Enum
    assert d["category"] == "business"  # str, not Enum
    assert isinstance(d["fields"], list)
    assert d["fields"][0]["name"] == "id"


def test_meta_service_list_sync_enabled_and_soft_delete():
    """list_sync_enabled / list_soft_delete return the expected subsets.

    work_item_label is a registered BUSINESS junction but is deliberately NOT
    sync-enabled (its real primary key is composite), so it must not appear
    in the sync-enabled subset.
    """
    svc = MetaService()
    sync_enabled = svc.list_sync_enabled()
    assert len(sync_enabled) == 21
    assert {s.name for s in sync_enabled} == {
        "note", "folder", "quick_note", "reflection",
        "habit", "habit_check_in", "schedule", "time_block",
        "memo_comment", "schedule_quick_note",
        "project", "status_definition", "type_definition", "label",
        "work_item", "work_item_note",
        "focus_session", "session_task_context",
        "session_attribution_revision", "session_work_item_plan",
        "session_work_item_outcome",
    }

    soft_delete = svc.list_soft_delete()
    assert {s.name for s in soft_delete} == {"note", "folder", "quick_note"}


def test_meta_service_work_item_label_registered_but_not_sync_enabled():
    """work_item_label remains resolvable for introspection but must never be
    delivered over the generic sync protocol.
    """
    svc = MetaService()
    spec = svc.get_entity("work_item_label")
    assert spec.name == "work_item_label"
    assert spec.category == EntityCategory.BUSINESS
    assert spec.sync_enabled is False
    assert "work_item_label" not in {s.name for s in svc.list_sync_enabled()}


# --------------------------------------------------------------------------- #
# TS1 Task 7 — Task Space entity metadata parity
# --------------------------------------------------------------------------- #

TASK_SPACE_ENTITY_NAMES = frozenset({
    "project",
    "status_definition",
    "type_definition",
    "label",
    # work_item_label is intentionally excluded: it remains registered for
    # introspection but is NOT sync-enabled (composite primary key).  Its
    # registration/non-sync contract is asserted by
    # test_meta_service_work_item_label_registered_but_not_sync_enabled.
    "work_item",
    "work_item_note",
    "focus_session",
    "session_task_context",
    "session_attribution_revision",
    "session_work_item_plan",
    "session_work_item_outcome",
})


def test_meta_service_task_space_entities_resolvable():
    """Every Task Space entity must be resolvable via MetaService.get_entity."""
    svc = MetaService()
    for name in TASK_SPACE_ENTITY_NAMES:
        spec = svc.get_entity(name)
        assert spec.name == name
        assert spec.category == EntityCategory.BUSINESS
        assert spec.sync_enabled is True


def test_meta_service_task_space_entities_have_sync_enabled():
    """All Task Space entities must appear in list_sync_enabled()."""
    svc = MetaService()
    sync_names = {s.name for s in svc.list_sync_enabled()}
    assert TASK_SPACE_ENTITY_NAMES <= sync_names


def test_meta_service_legacy_task_entity_not_resolvable():
    """The legacy 'task' entity must not be resolvable via MetaService."""
    svc = MetaService()
    with pytest.raises(NotFoundError):
        svc.get_entity("task")
