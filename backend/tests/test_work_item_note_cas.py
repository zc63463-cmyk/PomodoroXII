"""TS1 Task 4: WorkItemNote Replace, Append, Toggle, CAS, and idempotency."""

from __future__ import annotations

import json

import pytest

import app.mutation.unit_of_work as mutation_uow
from app.errors import MutationRejectedError
from app.task_space.compiler import NOTE_SYNC_FIELDS, _stable_id
from app.task_space.contracts import TaskSpaceRejected
from app.task_space.document import canonical_document_json, parse_document_v1


@pytest.mark.asyncio
async def test_replace_append_and_toggle_emit_full_canonical_post_images(
    task_space_fixture,
) -> None:
    item = await task_space_fixture.seed_level3("note-owner")
    initial = parse_document_v1({
        "contentVersion": 1,
        "blocks": [{"blockId": "p1", "type": "paragraph", "text": "Start"}],
    })
    created = await task_space_fixture.replace_document(
        "note-create", item["id"], None, initial
    )
    appended = await task_space_fixture.append_blocks(
        "note-append",
        item["id"],
        created.value["version"],
        ({
            "blockId": "c1", "type": "checklist",
            "items": [{
                "itemId": "check-1", "text": "Verify",
                "checked": False, "children": [],
            }],
        },),
    )
    toggled = await task_space_fixture.toggle_checklist_item(
        "note-toggle", item["id"], appended.value["version"], "check-1", True
    )

    assert json.loads(toggled.value["document_json"])["blocks"][1]["items"][0]["checked"] is True
    events = await task_space_fixture.visible_events(entity_type="workItemNote")
    assert [event.payload for event in events][-1] == toggled.value
    stored_item = await task_space_fixture.queries.get_work_item(
        task_space_fixture.scope, item["id"]
    )
    assert stored_item.value["status_definition_id"] == item["status_definition_id"]
    assert stored_item.value["version"] == item["version"]


@pytest.mark.asyncio
@pytest.mark.parametrize("block", (
    {"blockId": "sixth", "type": "code", "text": "no"},
    {"blockId": "extra", "type": "paragraph", "text": "x", "rank": 1},
    {"blockId": "missing", "type": "checklist"},
))
async def test_invalid_append_block_is_a_stable_zero_effect_rejection(
    task_space_fixture, block,
) -> None:
    note = await task_space_fixture.seed_note("invalid-append")
    operation_id = f"invalid-append-{block['blockId']}"
    result = await task_space_fixture.append_blocks(
        operation_id, note["work_item_id"], note["version"], (block,),
    )

    assert isinstance(result, TaskSpaceRejected)
    assert result.code == "invalid_note_document"
    assert await task_space_fixture.visible_events(operation_id=operation_id) == ()
    stored = await task_space_fixture.queries.read_note(
        task_space_fixture.scope, note["work_item_id"]
    )
    assert stored is not None
    assert stored.value["document_json"] == note["document_json"]


@pytest.mark.asyncio
async def test_note_cas_preserves_authoritative_document_and_returns_current_version(
    task_space_fixture,
) -> None:
    note = await task_space_fixture.seed_note("cas-note")
    left = task_space_fixture.replace_command(note, "left-write", "Left")
    right = task_space_fixture.replace_command(note, "right-write", "Right")

    winner = await task_space_fixture.module.execute(task_space_fixture.scope, left)
    conflict = await task_space_fixture.module.execute(task_space_fixture.scope, right)

    stored = await task_space_fixture.queries.read_note(task_space_fixture.scope, note["work_item_id"])
    assert stored is not None
    assert stored.value["document_json"] == winner.value["document_json"]
    assert isinstance(conflict, TaskSpaceRejected)
    assert conflict.code == "version_conflict"
    assert conflict.details["current_version"] == winner.value["version"]


@pytest.mark.asyncio
async def test_same_note_command_id_reuses_receipt_and_changed_payload_conflicts(
    task_space_fixture,
) -> None:
    note = await task_space_fixture.seed_note("idempotent-note")
    command = task_space_fixture.replace_command(note, "same-note-command", "Same")

    first = await task_space_fixture.module.execute(task_space_fixture.scope, command)
    second = await task_space_fixture.module.execute(task_space_fixture.scope, command)
    changed = task_space_fixture.replace_command(note, "same-note-command", "Changed")
    conflict = await task_space_fixture.module.execute(task_space_fixture.scope, changed)

    assert first.value == second.value
    assert isinstance(conflict, TaskSpaceRejected)
    assert conflict.code == "idempotency_conflict"


# -- WorkItemNote Sync entity action matrix -----------------------------------


@pytest.mark.parametrize("action", ("create", "update", "delete"))
@pytest.mark.asyncio
async def test_sync_work_item_note_action_matrix_is_policy_owned(
    task_space_fixture,
    monkeypatch,
    action: str,
) -> None:
    document_json = canonical_document_json(parse_document_v1({
        "contentVersion": 1,
        "blocks": [
            {"blockId": "sync", "type": "paragraph", "text": action}
        ],
    }))
    if action == "create":
        owner = await task_space_fixture.seed_level3("sync-note-create")
        note_id = _stable_id("work_item_note", str(owner["id"]))
        client_updated_at = task_space_fixture.clock.tick()
        payload = {
            "id": note_id,
            "work_item_id": owner["id"],
            "document_json": document_json,
            "created_at": client_updated_at,
            "updated_at": client_updated_at,
            "version": 1,
        }
        expected_version = None
    else:
        note = await task_space_fixture.seed_note(f"sync-note-{action}")
        note_id = str(note["id"])
        client_updated_at = task_space_fixture.clock.tick()
        payload = (
            {}
            if action == "delete"
            else {
                **note,
                "document_json": document_json,
                "updated_at": client_updated_at,
                "version": int(note["version"]) + 1,
            }
        )
        expected_version = int(note["version"])

    event = task_space_fixture.sync_event(
        entity_type="workItemNote",
        entity_id=note_id,
        action=action,
        payload=payload,
        expected_version=expected_version,
        client_updated_at=client_updated_at,
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )
    operation_id = f"sync-note-{action}-matrix"
    before = task_space_fixture.overlay_snapshot()

    async def poison_generic_fallback(*args, **kwargs):
        raise AssertionError("workItemNote reached generic fallback")

    monkeypatch.setattr(
        mutation_uow, "compile_catalog_entity_command", poison_generic_fallback
    )
    if action == "delete":
        with pytest.raises(MutationRejectedError) as caught:
            await task_space_fixture.uow.execute(
                task_space_fixture.scope, request, operation_id
            )
        assert caught.value.rejection.code == "offline_formal_creation_forbidden"
        assert task_space_fixture.overlay_snapshot() == before
        assert await task_space_fixture.visible_events(operation_id=operation_id) == ()
    else:
        result = await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, operation_id
        )
        assert result.value["document_json"] == document_json
        assert result.value["version"] == payload["version"]
        events = await task_space_fixture.visible_events(operation_id=operation_id)
        assert len(events) == 1
        assert events[0].entity_type == "workItemNote"
        assert events[0].payload == result.value


# -- Sync rejection vectors ---------------------------------------------------


@pytest.mark.asyncio
async def test_sync_note_partial_post_image_is_zero_effect_rejection(
    task_space_fixture, monkeypatch,
) -> None:
    note = await task_space_fixture.seed_note("sync-partial")
    client_updated_at = task_space_fixture.clock.tick()
    payload = {"document_json": note["document_json"]}
    event = task_space_fixture.sync_event(
        entity_type="workItemNote",
        entity_id=str(note["id"]),
        action="update",
        payload=payload,
        expected_version=int(note["version"]),
        client_updated_at=client_updated_at,
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )
    before = task_space_fixture.overlay_snapshot()

    async def poison_generic_fallback(*args, **kwargs):
        raise AssertionError("workItemNote reached generic fallback")

    monkeypatch.setattr(
        mutation_uow, "compile_catalog_entity_command", poison_generic_fallback
    )
    with pytest.raises(MutationRejectedError) as caught:
        await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, "sync-partial"
        )
    assert caught.value.rejection.code == "invalid_note_document"
    assert task_space_fixture.overlay_snapshot() == before
    assert await task_space_fixture.visible_events(operation_id="sync-partial") == ()


@pytest.mark.asyncio
async def test_sync_note_cas_mismatch_is_version_conflict(
    task_space_fixture, monkeypatch,
) -> None:
    note = await task_space_fixture.seed_note("sync-cas")
    client_updated_at = task_space_fixture.clock.tick()
    document_json = canonical_document_json(parse_document_v1({
        "contentVersion": 1,
        "blocks": [{"blockId": "sync", "type": "paragraph", "text": "CAS"}],
    }))
    payload = {
        **note,
        "document_json": document_json,
        "updated_at": client_updated_at,
        "version": int(note["version"]) + 1,
    }
    event = task_space_fixture.sync_event(
        entity_type="workItemNote",
        entity_id=str(note["id"]),
        action="update",
        payload=payload,
        expected_version=int(note["version"]) + 99,
        client_updated_at=client_updated_at,
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )
    before = task_space_fixture.overlay_snapshot()

    async def poison_generic_fallback(*args, **kwargs):
        raise AssertionError("workItemNote reached generic fallback")

    monkeypatch.setattr(
        mutation_uow, "compile_catalog_entity_command", poison_generic_fallback
    )
    with pytest.raises(MutationRejectedError) as caught:
        await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, "sync-cas"
        )
    assert caught.value.rejection.code == "version_conflict"
    assert task_space_fixture.overlay_snapshot() == before
    assert await task_space_fixture.visible_events(operation_id="sync-cas") == ()


@pytest.mark.asyncio
async def test_sync_note_accepted_post_image_matches_typed_replace(
    task_space_fixture, monkeypatch,
) -> None:
    note = await task_space_fixture.seed_note("sync-match")
    client_updated_at = task_space_fixture.clock.tick()
    document_json = canonical_document_json(parse_document_v1({
        "contentVersion": 1,
        "blocks": [{"blockId": "match", "type": "paragraph", "text": "Match"}],
    }))
    payload = {
        **note,
        "document_json": document_json,
        "updated_at": client_updated_at,
        "version": int(note["version"]) + 1,
    }
    event = task_space_fixture.sync_event(
        entity_type="workItemNote",
        entity_id=str(note["id"]),
        action="update",
        payload=payload,
        expected_version=int(note["version"]),
        client_updated_at=client_updated_at,
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )

    async def poison_generic_fallback(*args, **kwargs):
        raise AssertionError("workItemNote reached generic fallback")

    monkeypatch.setattr(
        mutation_uow, "compile_catalog_entity_command", poison_generic_fallback
    )
    sync_result = await task_space_fixture.uow.execute(
        task_space_fixture.scope, request, "sync-match"
    )

    note2 = await task_space_fixture.seed_note("sync-match-typed")
    typed_result = await task_space_fixture.replace_document(
        "sync-match-typed-cmd", str(note2["work_item_id"]),
        int(note2["version"]),
        {"contentVersion": 1, "blocks": [
            {"blockId": "match", "type": "paragraph", "text": "Match"},
        ]},
    )
    sync_doc = json.loads(sync_result.value["document_json"])
    typed_doc = json.loads(typed_result.value["document_json"])
    assert sync_doc == typed_doc


def test_note_sync_fields_shape() -> None:
    assert NOTE_SYNC_FIELDS == frozenset({
        "id", "work_item_id", "document_json",
        "created_at", "updated_at", "version",
    })


# -- read_note query ----------------------------------------------------------


@pytest.mark.asyncio
async def test_read_note_returns_none_for_missing_note(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level3("no-note")
    result = await task_space_fixture.queries.read_note(
        task_space_fixture.scope, item["id"]
    )
    assert result is None


@pytest.mark.asyncio
async def test_read_note_returns_content_version_and_write_supported(
    task_space_fixture,
) -> None:
    note = await task_space_fixture.seed_note("read-note")
    result = await task_space_fixture.queries.read_note(
        task_space_fixture.scope, str(note["work_item_id"])
    )
    assert result is not None
    assert result.value["content_version"] == 1
    assert result.value["write_supported"] is True
