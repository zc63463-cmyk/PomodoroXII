from __future__ import annotations

import base64
import gzip
import hashlib
import json
import tracemalloc
import zlib
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.errors import AppError
from app.models.note import Note
from app.models.sync_client import SyncClient
from app.models.sync_recovery import SyncRecoveryChunk, SyncRecoveryManifest
from app.models.sync_state import SyncState
from app.registry.sync_registry import CATALOG
from app.sync.clients import SyncClientRegistry
from app.sync.cursor import SyncCursorCodec
from tests.fixtures.sync_streaming import TestLease, notes, scope_for


@pytest.mark.asyncio
async def test_snapshot_chunks_are_bounded_and_resume_without_duplicates(space_session):
    from app.sync.snapshot import (
        MAX_CHUNK_BYTES,
        MAX_CHUNK_ENTITIES,
        SyncPageTokenCodec,
        SyncSnapshotSerializer,
        SyncSnapshotStore,
    )

    space_session.add_all(notes(10_000, body_bytes=4096))
    await space_session.flush()
    registry = SyncClientRegistry(space_session, CATALOG.hash, 30, space_id="spc_test")
    await registry.register_or_touch("client-a")
    note_catalog = SimpleNamespace(
        hash=CATALOG.hash,
        list_sync_enabled=lambda: (CATALOG.get("note"),),
        model_for=lambda _name: Note,
    )
    store = SyncSnapshotStore(
        space_session,
        note_catalog,
        SyncPageTokenCodec(b"page-token-secret-0123456789abcdef"),
        SyncSnapshotSerializer(),
        cursor=SyncCursorCodec(b"cursor-secret-0123456789abcdefghij"),
        ttl_days=30,
    )
    tracemalloc.start()
    created = await store.create(scope_for("spc_test", "x" * 4096), TestLease(), "client-a")
    peak = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()
    assert created.error is None
    assert created.descriptor is not None
    chunks = tuple(
        await space_session.scalars(
            select(SyncRecoveryChunk)
            .where(SyncRecoveryChunk.manifest_token == created.descriptor.manifest_token)
            .order_by(SyncRecoveryChunk.chunk_index)
        )
    )
    assert all(chunk.entity_count <= MAX_CHUNK_ENTITIES for chunk in chunks)
    assert all(chunk.uncompressed_bytes <= MAX_CHUNK_BYTES for chunk in chunks)
    assert peak <= 128 * 1024 * 1024

    token = created.descriptor.first_page_token
    recovered: list[str] = []
    while token is not None:
        decision = await store.page(scope_for("spc_test"), TestLease(), "client-a", token)
        assert decision.error is None
        assert decision.page is not None
        payload = base64.b64decode(decision.page.jsonl_base64, validate=True)
        assert hashlib.sha256(payload).hexdigest() == decision.page.sha256
        recovered.extend(json.loads(line)["entity_id"] for line in payload.splitlines())
        token = decision.page.next_page_token
    assert recovered == [f"note-{index:05d}" for index in range(10_000)]
    assert len(recovered) == len(set(recovered))


@pytest.mark.asyncio
async def test_waterline_uses_allocated_cursor_and_empty_snapshot_has_terminal_page(space_session):
    from app.sync.snapshot import SyncPageTokenCodec, SyncSnapshotSerializer, SyncSnapshotStore

    state = await space_session.get(SyncState, 1)
    assert state is not None
    state.current_cursor = 6
    registry = SyncClientRegistry(space_session, CATALOG.hash, 30, space_id="spc_test")
    await registry.register_or_touch("client-a")
    cursor = SyncCursorCodec(b"cursor-secret-0123456789abcdefghij")
    empty_catalog = SimpleNamespace(
        hash=CATALOG.hash,
        list_sync_enabled=lambda: (),
        model_for=lambda _name: None,
    )
    store = SyncSnapshotStore(
        space_session,
        empty_catalog,
        SyncPageTokenCodec(b"page-token-secret-0123456789abcdef"),
        SyncSnapshotSerializer(),
        cursor=cursor,
        ttl_days=30,
    )
    created = await store.create(scope_for("spc_test"), TestLease(), "client-a")
    assert created.descriptor is not None
    page = await store.page(
        scope_for("spc_test"), TestLease(), "client-a", created.descriptor.first_page_token
    )
    assert page.page is not None
    assert page.page.entity_count == 0
    assert page.page.jsonl_base64 == ""
    assert page.page.sha256 == hashlib.sha256(b"").hexdigest()
    assert cursor.decode(page.page.waterline_cursor).sequence == 6


@pytest.mark.parametrize(
    "case",
    ["corrupt", "size", "members", "trailing", "bomb"],
)
def test_bounded_decoder_rejects_corruption_bombs_size_mismatch_and_extra_members(case):
    from app.sync.snapshot import SnapshotInvalidError, decode_persisted_chunk_bounded

    if case == "corrupt":
        payload, recorded_size = gzip.compress(b"x" * 32, mtime=0)[:-1] + b"!", 32
    elif case == "size":
        payload, recorded_size = gzip.compress(b"x" * 32, mtime=0), 31
    elif case == "members":
        payload, recorded_size = gzip.compress(b"x", mtime=0) + gzip.compress(b"y", mtime=0), 2
    elif case == "trailing":
        payload, recorded_size = gzip.compress(b"x", mtime=0) + b"trailing", 1
    else:
        payload, recorded_size = (
            gzip.compress(b"x" * (8 * 1024 * 1024 + 1), mtime=0),
            8 * 1024 * 1024 + 1,
        )

    with pytest.raises(SnapshotInvalidError) as raised:
        decode_persisted_chunk_bounded(
            payload,
            uncompressed_bytes=recorded_size,
            payload_sha256=hashlib.sha256(b"x" * recorded_size).hexdigest(),
            entity_count=1,
        )
    assert raised.value.code == "snapshot_invalid"
    assert dict(raised.value.details) == {"recovery_action": "full_recovery"}


def test_snapshot_record_is_rfc8785_jsonl_and_enforces_space_primary_key_and_safe_values():
    from app.sync.snapshot import SnapshotEntityRecord, canonical_snapshot_json_line

    record = SnapshotEntityRecord(
        kind="entity",
        entity_type="workItemLabel",
        entity_id="work-1",
        version=0,
        updated_at="2026-08-06T00:00:00.000Z",
        payload={"workItemId": "work-1", "labelId": "label-1", "spaceId": "spc_test"},
    )
    line = canonical_snapshot_json_line(record, primary_key="workItemId", space_id="spc_test")
    assert line.endswith(b"\n")
    assert line[:-1] == __import__("rfc8785").dumps(json.loads(line))
    with pytest.raises(ValueError):
        canonical_snapshot_json_line(record, primary_key="workItemId", space_id="other")
    with pytest.raises(ValueError):
        SnapshotEntityRecord(
            kind="entity",
            entity_type="x",
            entity_id="x",
            version=2**53,
            updated_at="2026-02-30T00:00:00Z",
            payload={"id": "x", "spaceId": "spc_test"},
        )


def test_committed_recovery_vectors_reparse_and_hash_exact_bytes():
    vectors = json.loads(
        (Path(__file__).parent / "fixtures" / "sync_recovery_jsonl_vectors.json").read_text(
            encoding="utf-8"
        )
    )
    assert vectors
    for vector in vectors:
        raw = base64.b64decode(vector["jsonl_base64"], validate=True)
        assert hashlib.sha256(raw).hexdigest() == vector["sha256"]
        assert len(raw.splitlines()) == vector["entity_count"]
        if raw:
            assert json.loads(raw) == vector["record"]


def test_decoder_never_uses_unbounded_gzip_decompress(monkeypatch):
    from app.sync.snapshot import decode_persisted_chunk_bounded

    monkeypatch.setattr(gzip, "decompress", lambda _value: (_ for _ in ()).throw(AssertionError()))
    raw = b'{"kind":"entity"}\n'
    assert (
        decode_persisted_chunk_bounded(
            gzip.compress(raw, mtime=0),
            uncompressed_bytes=len(raw),
            payload_sha256=hashlib.sha256(raw).hexdigest(),
            entity_count=1,
        )
        == raw
    )


@pytest.mark.asyncio
async def test_serializer_covers_all_aliases_space_and_exact_note_markdown():
    from app.sync.snapshot import SyncSnapshotSerializer

    markdown = "# Exact\n\nslash/ and 漢字\n"
    scope = scope_for("spc_test", markdown)
    serializer = SyncSnapshotSerializer()
    aliases: set[str] = set()
    for spec in CATALOG.list_sync_enabled():
        values = {}
        for field in spec.fields:
            if field.name == spec.primary_key:
                value = "entity-1"
            elif field.type == "integer":
                value = 0
            elif field.type == "boolean":
                value = False
            elif field.type == "json":
                value = "[]"
            elif field.type == "datetime":
                value = None if field.nullable else "2026-08-06T00:00:00.000Z"
            else:
                value = None if field.nullable else "value"
            values[field.name] = value
        payload = await serializer.serialize(scope, spec, SimpleNamespace(**values))
        aliases.add(spec.effective_sync_entity_type)
        assert payload["spaceId"] == "spc_test"
        assert (
            payload[{"work_item_id": "workItemId"}.get(spec.primary_key, spec.primary_key)]
            == "entity-1"
        )
        if spec.name == "note":
            assert payload["content"] == markdown
    assert aliases == {spec.effective_sync_entity_type for spec in CATALOG.list_sync_enabled()}
    assert len(aliases) == 22


@pytest.mark.asyncio
async def test_corrupt_chunk_and_catalog_drift_fail_closed_and_clear_current_pointer(space_session):
    from app.sync.snapshot import (
        SnapshotInvalidError,
        SyncPageTokenCodec,
        SyncSnapshotSerializer,
        SyncSnapshotStore,
    )

    space_session.add_all(notes(1))
    await space_session.flush()
    registry = SyncClientRegistry(space_session, CATALOG.hash, 30, space_id="spc_test")
    await registry.register_or_touch("client-a")
    catalog = SimpleNamespace(
        hash=CATALOG.hash,
        list_sync_enabled=lambda: (CATALOG.get("note"),),
        model_for=lambda _name: Note,
    )
    store = SyncSnapshotStore(
        space_session,
        catalog,
        SyncPageTokenCodec(b"page-token-secret-0123456789abcdef"),
        SyncSnapshotSerializer(),
        cursor=SyncCursorCodec(b"cursor-secret-0123456789abcdefghij"),
    )
    first = await store.create(scope_for("spc_test", "body"), TestLease(), "client-a")
    assert first.descriptor is not None
    chunk = await space_session.scalar(
        select(SyncRecoveryChunk).where(
            SyncRecoveryChunk.manifest_token == first.descriptor.manifest_token
        )
    )
    assert chunk is not None
    chunk.payload_gzip = chunk.payload_gzip[:-1] + bytes([chunk.payload_gzip[-1] ^ 1])
    invalid = await store.page(
        scope_for("spc_test"), TestLease(), "client-a", first.descriptor.first_page_token
    )
    assert isinstance(invalid.error, SnapshotInvalidError)
    client = await space_session.get(SyncClient, "client-a")
    assert client is not None and client.recovery_manifest_token is None

    second = await store.create(scope_for("spc_test", "body"), TestLease(), "client-a")
    assert second.descriptor is not None
    catalog.hash = "f" * 64
    expired = await store.page(
        scope_for("spc_test"), TestLease(), "client-a", second.descriptor.first_page_token
    )
    assert expired.error is not None and expired.error.code == "cursor_expired"
    assert dict(expired.error.details) == {"recovery_action": "full_recovery"}


@pytest.mark.asyncio
async def test_restarting_recovery_cascade_deletes_every_superseded_generation(space_session):
    from app.sync.snapshot import SyncPageTokenCodec, SyncSnapshotSerializer, SyncSnapshotStore

    space_session.add_all(notes(2))
    await space_session.flush()
    registry = SyncClientRegistry(space_session, CATALOG.hash, 30, space_id="spc_test")
    await registry.register_or_touch("client-a")
    catalog = SimpleNamespace(
        hash=CATALOG.hash,
        list_sync_enabled=lambda: (CATALOG.get("note"),),
        model_for=lambda _name: Note,
    )
    store = SyncSnapshotStore(
        space_session,
        catalog,
        SyncPageTokenCodec(b"page-token-secret-0123456789abcdef"),
        SyncSnapshotSerializer(),
        cursor=SyncCursorCodec(b"cursor-secret-0123456789abcdefghij"),
    )
    for _ in range(5):
        created = await store.create(scope_for("spc_test", "body"), TestLease(), "client-a")
        assert created.descriptor is not None
        manifests = tuple(await space_session.scalars(select(SyncRecoveryManifest)))
        chunks = tuple(await space_session.scalars(select(SyncRecoveryChunk)))
        assert [item.token for item in manifests] == [created.descriptor.manifest_token]
        assert {item.manifest_token for item in chunks} == {created.descriptor.manifest_token}
