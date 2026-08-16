"""Deterministic helpers for bounded Sync recovery tests."""

from __future__ import annotations

import base64
import hashlib
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace

from app.models.note import Note
from app.registry.sync_registry import CATALOG
from app.sync.snapshot import (
    SnapshotEntityRecord,
    SyncSnapshotSerializer,
    canonical_snapshot_json_line,
)


class StaticNoteBodies:
    def __init__(self, body: str) -> None:
        self.body = body

    async def read_note(self, _note_id: str) -> str:
        return self.body


class TestLease:
    def assert_active_owner(self, **_expected: object) -> None:
        return None

    def assert_fence(self, _scope: str) -> None:
        return None


class RuntimeScope:
    def __init__(self, session, *, space_id: str = "spc_test", body: str = "") -> None:
        self.scope = SimpleNamespace(space_id=space_id)
        self.file_system = StaticNoteBodies(body)
        self._session = session

    def session_factory(self):
        session = self._session

        class SessionContext:
            async def __aenter__(self):
                return session

            async def __aexit__(self, *_args):
                return False

        return SessionContext()

    @asynccontextmanager
    async def exclusive_space_resources(self, _purpose: str, _timeout: float):
        yield TestLease()


class NoOpRecovery:
    async def recover_under_lease(self, _scope, _lease) -> None:
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


async def recovery_vectors() -> tuple[dict[str, object], ...]:
    """Generate the committed vectors through the production serializer."""
    timestamp = "2026-08-06T00:00:00.000Z"
    serializer = SyncSnapshotSerializer()
    scope = scope_for("spc_test", "# Exact\n\nslash/line\n漢字\n")
    vectors: list[dict[str, object]] = []
    for spec in CATALOG.list_sync_enabled():
        values: dict[str, object] = {}
        for field in spec.fields:
            if field.name == spec.primary_key:
                value: object = f"{spec.effective_sync_entity_type}-1"
            elif field.type == "integer":
                value = 0
            elif field.type == "boolean":
                value = False
            elif field.type == "json":
                value = json.dumps(
                    {
                        "nested": {"unicode": "漢字", "slashNewline": "slash/line\n"},
                        "safeInteger": 2**53 - 1,
                        "decimal": 1.25,
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            elif field.type == "datetime":
                value = None if field.nullable else timestamp
            else:
                value = None if field.nullable else "value"
            values[field.name] = value
        row = SimpleNamespace(**values)
        payload = await serializer.serialize(scope, spec, row)
        entity_id = str(getattr(row, spec.primary_key))
        record = SnapshotEntityRecord(
            kind="entity",
            entity_type=spec.effective_sync_entity_type,
            entity_id=entity_id,
            version=getattr(row, "version", 0),
            updated_at=getattr(row, "updated_at", timestamp),
            payload=payload,
        )
        primary_key = spec.primary_key.split("_")
        primary_key_wire = primary_key[0] + "".join(
            item[:1].upper() + item[1:] for item in primary_key[1:]
        )
        raw = canonical_snapshot_json_line(
            record,
            primary_key=primary_key_wire,
            space_id="spc_test",
        )
        vectors.append(
            {
                "record": json.loads(raw),
                "jsonl_base64": base64.b64encode(raw).decode("ascii"),
                "sha256": hashlib.sha256(raw).hexdigest(),
                "entity_count": 1,
            }
        )
    vectors.append(
        {
            "record": None,
            "jsonl_base64": "",
            "sha256": hashlib.sha256(b"").hexdigest(),
            "entity_count": 0,
        }
    )
    return tuple(vectors)
