"""TS1 Task 5: Lock WorkItemNote v1 boundary and dual-version conflict contract."""

from __future__ import annotations

import json

import pytest

import app.mutation.unit_of_work as mutation_uow
from app.errors import MutationRejectedError, thaw_json
from app.task_space.contracts import TaskSpaceRejected
from app.task_space.document import canonical_document_json, parse_document_v1


@pytest.mark.asyncio
async def test_conflict_returns_the_remote_document_without_merging_local(
    task_space_fixture,
) -> None:
    note = await task_space_fixture.seed_note("dual-version")
    local_document = {
        "contentVersion": 1,
        "blocks": [{
            "blockId": "p",
            "type": "paragraph",
            "text": "Local",
        }],
    }

    winner = await task_space_fixture.replace_document(
        "remote-winner",
        note["work_item_id"],
        note["version"],
        {
            "contentVersion": 1,
            "blocks": [{
                "blockId": "p",
                "type": "paragraph",
                "text": "Remote",
            }],
        },
    )

    conflict = await task_space_fixture.replace_document(
        "local-loser",
        note["work_item_id"],
        note["version"],
        local_document,
    )

    assert isinstance(conflict, TaskSpaceRejected)
    assert conflict.code == "version_conflict"
    assert thaw_json(conflict.details) == {
        "current_version": winner.value["version"],
        "current_document": json.loads(winner.value["document_json"]),
    }
    assert local_document["blocks"][0]["text"] == "Local"

    stored = await task_space_fixture.queries.read_note(
        task_space_fixture.scope, str(note["work_item_id"])
    )
    assert stored is not None
    assert stored.value["document_json"] == winner.value["document_json"]
    assert stored.value["version"] == winner.value["version"]
    assert thaw_json(conflict.details["current_document"]) == json.loads(
        stored.value["document_json"]
    )

    assert (
        await task_space_fixture.visible_events(operation_id="local-loser")
        == ()
    )


@pytest.mark.asyncio
async def test_sync_conflict_returns_the_authoritative_document(
    task_space_fixture,
    monkeypatch,
) -> None:
    note = await task_space_fixture.seed_note("sync-dual-version")
    client_updated_at = task_space_fixture.clock.tick()
    payload = {
        **note,
        "document_json": canonical_document_json(parse_document_v1({
            "contentVersion": 1,
            "blocks": [{
                "blockId": "local",
                "type": "paragraph",
                "text": "Local",
            }],
        })),
        "updated_at": client_updated_at,
        "version": int(note["version"]) + 1,
    }
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope,
        task_space_fixture.sync_event(
            entity_type="workItemNote",
            entity_id=str(note["id"]),
            action="update",
            payload=payload,
            expected_version=int(note["version"]) + 1,
            client_updated_at=client_updated_at,
        ),
    )
    before = task_space_fixture.overlay_snapshot()

    async def poison_generic_fallback(*args, **kwargs):
        raise AssertionError("workItemNote reached generic fallback")

    monkeypatch.setattr(
        mutation_uow, "compile_catalog_entity_command", poison_generic_fallback
    )
    with pytest.raises(MutationRejectedError) as caught:
        await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, "sync-local-loser"
        )

    assert caught.value.rejection.code == "version_conflict"
    # QN-S8b: the sync (S4 outbox) path carries the authoritative remote
    # post-image under snapshot/version so clients can adopt it on reload.
    details = thaw_json(caught.value.rejection.details)
    assert details["snapshot"]["document_json"] == note["document_json"]
    assert details["snapshot"]["version"] == note["version"]
    assert details["version"] == note["version"]
    assert task_space_fixture.overlay_snapshot() == before
    assert (
        await task_space_fixture.visible_events(operation_id="sync-local-loser")
        == ()
    )
