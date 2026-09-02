"""End-to-end: Sync v2 push of Note entities (issue #64).

``SyncCommandMapper`` emits generic ``entity.create`` / ``entity.update`` /
``entity.delete`` requests, but ``MutationCompiler`` dispatches by
``entity_type`` -- so ``note`` lands on ``KnowledgeDomainPolicy``, which
historically accepted only ``knowledge.note.*`` names and rejected everything
else with ``ValueError`` (which escapes as HTTP 500).

These tests drive the *sync-emitted* request names through the real production
compiler, interpreter and projection executor, and assert all three
projections (Markdown / index row / FTS5) land for create and update, and are
removed for delete.

Run:
  backend/.venv/Scripts/python.exe -m pytest tests/test_note_sync_push.py -q
"""
from __future__ import annotations

import pytest

from app.commands.entity import EntityCommand
from app.registry import CATALOG
from app.sync.commands import SyncCommandMapper
from app.sync.contracts import SyncEventInput
from tests.test_note_workspace_atomicity import (  # noqa: F401
    knowledge_fixture,
    uow_fixture,
)

UTC = "2026-09-02T10:00:00.000Z"


def _sync_request(scope, *, action: str, note_id: str, payload, expected_version):
    """Build exactly the request a Sync v2 push would hand to the compiler."""
    return SyncCommandMapper(CATALOG, EntityCommand(CATALOG)).to_request(
        scope,
        SyncEventInput(
            entity_type="note",
            entity_id=note_id,
            action=action,
            payload=payload,
            expected_version=expected_version,
            client_updated_at=UTC,
            operation_id=f"sync-{action}-{note_id}",
        ),
    )


async def _push(fixture, *, action: str, note_id: str, payload, expected_version):
    request = _sync_request(
        fixture.scope,
        action=action,
        note_id=note_id,
        payload=payload,
        expected_version=expected_version,
    )
    return await fixture.store.uow.execute(
        fixture.scope, request, f"op-{action}-{note_id}"
    )


@pytest.mark.asyncio
async def test_sync_push_create_writes_all_three_projections(knowledge_fixture):
    request = _sync_request(
        knowledge_fixture.scope,
        action="create",
        note_id="sync-note-1",
        payload={
            "id": "sync-note-1",
            "title": "Synced Note",
            "content": "sync body alpha",
            "tags": [],
        },
        expected_version=None,
    )
    # Guard the premise: the sync layer really does emit the generic name.
    assert request.name == "entity.create"
    assert request.entity_type == "note"

    await knowledge_fixture.store.uow.execute(
        knowledge_fixture.scope, request, "op-create-sync-note-1"
    )

    # Projection 1: authoritative Markdown.
    assert await knowledge_fixture.file_system.read_note("sync-note-1") == (
        "sync body alpha"
    )
    # Projection 2: index row.
    meta = await knowledge_fixture.file_system.read_note_meta("sync-note-1")
    assert meta.title == "Synced Note"
    # Projection 3: FTS5 body.
    hits = await knowledge_fixture.file_system.search("sync body alpha")
    assert any(hit.note_id == "sync-note-1" for hit in hits)


@pytest.mark.asyncio
async def test_sync_push_update_rewrites_markdown_and_fts(knowledge_fixture):
    await _push(
        knowledge_fixture,
        action="create",
        note_id="sync-note-2",
        payload={
            "id": "sync-note-2",
            "title": "Updatable",
            "content": "before body",
            "tags": [],
        },
        expected_version=None,
    )

    request = _sync_request(
        knowledge_fixture.scope,
        action="update",
        note_id="sync-note-2",
        payload={"content": "after body"},
        expected_version=1,
    )
    assert request.name == "entity.update"

    await knowledge_fixture.store.uow.execute(
        knowledge_fixture.scope, request, "op-update-sync-note-2"
    )

    assert await knowledge_fixture.file_system.read_note("sync-note-2") == (
        "after body"
    )
    hits = await knowledge_fixture.file_system.search("after body")
    assert any(hit.note_id == "sync-note-2" for hit in hits)


@pytest.mark.asyncio
async def test_sync_push_delete_purges_everywhere(knowledge_fixture):
    await _push(
        knowledge_fixture,
        action="create",
        note_id="sync-note-3",
        payload={
            "id": "sync-note-3",
            "title": "Doomed",
            "content": "goodbye body",
            "tags": [],
        },
        expected_version=None,
    )

    request = _sync_request(
        knowledge_fixture.scope,
        action="delete",
        note_id="sync-note-3",
        payload={},
        expected_version=1,
    )
    assert request.name == "entity.delete"

    await knowledge_fixture.store.uow.execute(
        knowledge_fixture.scope, request, "op-delete-sync-note-3"
    )

    await knowledge_fixture.assert_note_absent_everywhere("sync-note-3")
