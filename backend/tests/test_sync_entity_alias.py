"""P1-2: sync entity_type alias map (snake_case ↔ camelCase) canonicalization.

The registry exposes snake_case entity names (e.g. 'quick_note'), while
SyncService.ENTITY_REGISTRY uses camelCase keys (e.g. 'quickNote') for
legacy client compatibility. These tests verify the canonicalization
bridge so clients using either convention are accepted by /sync/push.
"""
from __future__ import annotations

import pytest


def test_canonicalize_camelCase_unchanged():
    """camelCase entity_type should pass through unchanged."""
    from app.services.sync_entity_types import canonicalize_entity_type

    assert canonicalize_entity_type("quickNote") == "quickNote"
    assert canonicalize_entity_type("taskQuickNote") == "taskQuickNote"
    assert canonicalize_entity_type("task") == "task"
    assert canonicalize_entity_type("note") == "note"


def test_canonicalize_snakeCase_to_camelCase():
    """snake_case entity_type should map to camelCase canonical form."""
    from app.services.sync_entity_types import canonicalize_entity_type

    assert canonicalize_entity_type("quick_note") == "quickNote"
    assert canonicalize_entity_type("habit_check_in") == "habitCheckIn"
    assert canonicalize_entity_type("time_block") == "timeBlock"
    assert canonicalize_entity_type("memo_comment") == "memoComment"
    assert canonicalize_entity_type("session_quick_note") == "sessionQuickNote"
    assert canonicalize_entity_type("schedule_quick_note") == "scheduleQuickNote"
    assert canonicalize_entity_type("task_quick_note") == "taskQuickNote"


def test_canonicalize_unknown_returns_none():
    """Unknown entity_type should return None so sync.py reports an error."""
    from app.services.sync_entity_types import canonicalize_entity_type

    assert canonicalize_entity_type("nonexistent") is None
    assert canonicalize_entity_type("") is None


@pytest.mark.asyncio
async def test_push_accepts_snake_case_entity_type(space_session, tmp_path):
    """P1-2: /sync/push should accept snake_case entity_type and canonicalize."""
    from app.services.sync import SyncService

    svc = SyncService(space_session)
    eid = "p12-snake-task"
    result = await svc.push([{
        "entity_type": "task",  # snake_case == camelCase for task, control
        "entity_id": eid,
        "action": "create",
        "payload": {
            "id": eid, "title": "Snake", "status": "todo",
            "priority": "medium", "tags": "[]",
        },
        "client_updated_at": "2026-07-04T10:00:00.000Z",
    }])
    assert len(result["applied"]) == 1
    assert len(result["errors"]) == 0


@pytest.mark.asyncio
async def test_push_accepts_snake_case_quick_note(space_session):
    """P1-2: /sync/push should accept 'quick_note' and canonicalize to 'quickNote'."""
    from app.models.quick_note import QuickNote
    from app.services.sync import SyncService

    svc = SyncService(space_session)
    eid = "p12-snake-qn"
    result = await svc.push([{
        "entity_type": "quick_note",  # snake_case
        "entity_id": eid,
        "action": "create",
        "payload": {"id": eid, "content": "hi", "tags": "[]"},
        "client_updated_at": "2026-07-04T10:00:00.000Z",
    }])
    assert len(result["applied"]) == 1
    assert len(result["errors"]) == 0
    row = await space_session.get(QuickNote, eid)
    assert row is not None
