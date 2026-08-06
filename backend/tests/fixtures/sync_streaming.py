"""Deterministic helpers for bounded Sync recovery tests."""

from __future__ import annotations

import json
from types import SimpleNamespace

from app.models.note import Note


class StaticNoteBodies:
    def __init__(self, body: str) -> None:
        self.body = body

    async def read_note(self, _note_id: str) -> str:
        return self.body


class TestLease:
    def assert_active_owner(self, **_expected: object) -> None:
        return None


def scope_for(space_id: str, body: str = "") -> SimpleNamespace:
    return SimpleNamespace(
        scope=SimpleNamespace(space_id=space_id),
        file_system=StaticNoteBodies(body),
    )


def notes(count: int, *, body_bytes: int = 0) -> tuple[Note, ...]:
    timestamp = "2026-08-06T00:00:00.000Z"
    return tuple(
        Note(
            id=f"note-{index:05d}",
            title=f"Note {index}",
            content_hash="0" * 64,
            word_count=body_bytes,
            summary="",
            tags=json.dumps(["streaming"]),
            category=None,
            folder_id=None,
            status="active",
            trashed_at=None,
            created_at=timestamp,
            updated_at=timestamp,
            version=1,
        )
        for index in range(count)
    )
