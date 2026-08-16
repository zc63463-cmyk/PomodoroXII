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
from tests.fixtures.sync_streaming import (
    NoOpRecovery,
    RuntimeScope,
    TestLease,
    notes,
    recovery_vectors,
    scope_for,
)


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
    assert created.descriptor.total_entities == 10_000
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
async def test_snapshot_creation_does_not_retain_one_descriptor_per_chunk(
    space_session, monkeypatch
):
    import app.sync.snapshot as snapshot

    class TrackingDescriptor:
        live = 0
        peak = 0

        def __init__(
            self,
            chunk_index: int,
            entity_count: int,
            uncompressed_bytes: int,
            payload_sha256: str,
        ) -> None:
            self.chunk_index = chunk_index
            self.entity_count = entity_count
            self.uncompressed_bytes = uncompressed_bytes
            self.payload_sha256 = payload_sha256
            type(self).live += 1
            type(self).peak = max(type(self).peak, type(self).live)

        def __del__(self) -> None:
            type(self).live -= 1

    monkeypatch.setattr(snapshot, "MAX_CHUNK_ENTITIES", 1)
    monkeypatch.setattr(snapshot, "_ChunkDescriptor", TrackingDescriptor)
    space_session.add_all(notes(10))
    await space_session.flush()
    registry = SyncClientRegistry(space_session, CATALOG.hash, 30, space_id="spc_test")
    await registry.register_or_touch("client-a")
    note_catalog = SimpleNamespace(
        hash=CATALOG.hash,
        list_sync_enabled=lambda: (CATALOG.get("note"),),
        model_for=lambda _name: Note,
    )
    store = snapshot.SyncSnapshotStore(
        space_session,
        note_catalog,
        snapshot.SyncPageTokenCodec(b"page-token-secret-0123456789abcdef"),
        snapshot.SyncSnapshotSerializer(),
        cursor=SyncCursorCodec(b"cursor-secret-0123456789abcdefghij"),
    )

    created = await store.create(scope_for("spc_test", "body"), TestLease(), "client-a")

    assert created.error is None
    assert TrackingDescriptor.peak <= 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("payload", "error_type"),
    [([], TypeError), ({"spaceId": "spc_test"}, ValueError)],
)
async def test_invalid_serializer_output_fails_before_any_chunk_write(
    space_session, payload, error_type
):
    from app.sync.snapshot import SyncPageTokenCodec, SyncSnapshotStore

    class InvalidSerializer:
        async def serialize(self, _scope, _spec, _row):
            return payload

    space_session.add_all(notes(1))
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
        InvalidSerializer(),
        cursor=SyncCursorCodec(b"cursor-secret-0123456789abcdefghij"),
    )

    with pytest.raises(error_type):
        await store.create(scope_for("spc_test", "body"), TestLease(), "client-a")

    assert await space_session.scalar(select(SyncRecoveryChunk).limit(1)) is None


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


@pytest.mark.asyncio
async def test_terminal_recovery_page_replays_after_response_loss(space_session):
    from app.sync.snapshot import SyncPageTokenCodec, SyncSnapshotSerializer, SyncSnapshotStore

    registry = SyncClientRegistry(space_session, CATALOG.hash, 30, space_id="spc_test")
    await registry.register_or_touch("client-a")
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
        cursor=SyncCursorCodec(b"cursor-secret-0123456789abcdefghij"),
        ttl_days=30,
    )
    created = await store.create(scope_for("spc_test"), TestLease(), "client-a")
    assert created.descriptor is not None

    first = await store.page(
        scope_for("spc_test"), TestLease(), "client-a", created.descriptor.first_page_token
    )
    replay = await store.page(
        scope_for("spc_test"), TestLease(), "client-a", created.descriptor.first_page_token
    )

    assert first.error is None and first.page is not None
    assert replay.error is None
    assert replay.page == first.page


@pytest.mark.parametrize(
    "case",
    ["corrupt", "incomplete", "size", "members", "trailing", "bomb"],
)
def test_bounded_decoder_rejects_corruption_bombs_size_mismatch_and_extra_members(case):
    from app.sync.snapshot import SnapshotInvalidError, decode_persisted_chunk_bounded

    if case == "corrupt":
        payload, recorded_size = gzip.compress(b"x" * 32, mtime=0)[:-1] + b"!", 32
    elif case == "incomplete":
        payload, recorded_size = gzip.compress(b"x" * 32, mtime=0)[:-8], 32
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
    safe = SnapshotEntityRecord(
        kind="entity",
        entity_type="x",
        entity_id="x",
        version=2**53 - 1,
        updated_at="2024-02-29T23:59:59.999999999Z",
        payload={"id": "x", "spaceId": "spc_test", "safe": 2**53 - 1},
    )
    assert safe.version == 2**53 - 1
    for invalid_timestamp in (
        "2023-02-29T00:00:00Z",
        "2026-08-06T00:00:00+00:00",
        "2026-08-06T00:00:00.000z",
        "2026-08-06 00:00:00.000Z",
    ):
        with pytest.raises(ValueError):
            SnapshotEntityRecord(
                kind="entity",
                entity_type="x",
                entity_id="x",
                version=0,
                updated_at=invalid_timestamp,
                payload={"id": "x", "spaceId": "spc_test"},
            )


def test_page_token_tampering_fails_closed_with_full_recovery_action():
    from app.errors import SyncCursorExpiredError
    from app.sync.snapshot import PageTokenPosition, SyncPageTokenCodec

    codec = SyncPageTokenCodec(b"page-token-secret-0123456789abcdef")
    token = codec.encode(PageTokenPosition("spc_test", "client-a", 1, "manifest-a", 0))
    replacement = "A" if token[-1] != "A" else "B"
    with pytest.raises(SyncCursorExpiredError) as raised:
        codec.decode(token[:-1] + replacement)
    assert dict(raised.value.details) == {"recovery_action": "full_recovery"}


@pytest.mark.asyncio
async def test_committed_recovery_vectors_reparse_and_hash_exact_bytes():
    vectors = json.loads(
        (Path(__file__).parent / "fixtures" / "sync_recovery_jsonl_vectors.json").read_text(
            encoding="utf-8"
        )
    )
    assert vectors == list(await recovery_vectors())
    aliases = {
        vector["record"]["entity_type"] for vector in vectors if vector["record"] is not None
    }
    assert aliases == {spec.effective_sync_entity_type for spec in CATALOG.list_sync_enabled()}
    assert len(aliases) == 22
    assert any(
        isinstance(value, dict) and "nested" in value
        for vector in vectors
        if vector["record"] is not None
        for value in vector["record"]["payload"].values()
    )
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


@pytest.mark.asyncio
async def test_exact_chunk_limit_succeeds_and_oversize_generation_clears_current_pointer(
    space_session,
):
    from app.sync.snapshot import (
        MAX_CHUNK_BYTES,
        SnapshotEntityRecord,
        SyncPageTokenCodec,
        SyncSnapshotSerializer,
        SyncSnapshotStore,
        canonical_snapshot_json_line,
    )

    row = notes(1)[0]
    space_session.add(row)
    await space_session.flush()
    registry = SyncClientRegistry(space_session, CATALOG.hash, 30, space_id="spc_test")
    await registry.register_or_touch("client-exact")
    await registry.register_or_touch("client-oversize")
    catalog = SimpleNamespace(
        hash=CATALOG.hash,
        list_sync_enabled=lambda: (CATALOG.get("note"),),
        model_for=lambda _name: Note,
    )
    codec = SyncPageTokenCodec(b"page-token-secret-0123456789abcdef")
    cursor = SyncCursorCodec(b"cursor-secret-0123456789abcdefghij")
    scope = scope_for("spc_test", "body")
    store = SyncSnapshotStore(
        space_session,
        catalog,
        codec,
        SyncSnapshotSerializer(),
        cursor=cursor,
    )
    previous = await store.create(scope, TestLease(), "client-oversize")
    assert previous.descriptor is not None

    base_record = SnapshotEntityRecord(
        kind="entity",
        entity_type="note",
        entity_id=row.id,
        version=row.version,
        updated_at=row.updated_at,
        payload={"id": row.id, "spaceId": "spc_test", "content": ""},
    )
    base_size = len(
        canonical_snapshot_json_line(base_record, primary_key="id", space_id="spc_test")
    )
    exact_body_bytes = MAX_CHUNK_BYTES - base_size

    class SizedSerializer:
        def __init__(self, body_bytes: int) -> None:
            self.body_bytes = body_bytes

        async def serialize(self, _scope, _spec, entity):
            return {
                "id": entity.id,
                "spaceId": "spc_test",
                "content": "x" * self.body_bytes,
            }

    exact_store = SyncSnapshotStore(
        space_session,
        catalog,
        codec,
        SizedSerializer(exact_body_bytes),
        cursor=cursor,
    )
    exact = await exact_store.create(scope, TestLease(), "client-exact")
    assert exact.error is None and exact.descriptor is not None
    exact_chunk = await space_session.get(
        SyncRecoveryChunk, (exact.descriptor.manifest_token, 0)
    )
    assert exact_chunk is not None
    assert exact_chunk.uncompressed_bytes == MAX_CHUNK_BYTES

    oversize_store = SyncSnapshotStore(
        space_session,
        catalog,
        codec,
        SizedSerializer(exact_body_bytes + 1),
        cursor=cursor,
    )
    oversized = await oversize_store.create(scope, TestLease(), "client-oversize")
    assert oversized.descriptor is None
    assert oversized.error is not None
    assert oversized.error.code == "snapshot_entity_too_large"
    client = await space_session.get(SyncClient, "client-oversize")
    assert client is not None
    assert client.requires_recovery is True
    assert client.recovery_generation == 2
    assert client.recovery_manifest_token is None
    assert client.recovery_waterline is None
    assert client.recovery_completed_at is None
    unusable = await space_session.scalar(
        select(SyncRecoveryManifest)
        .where(SyncRecoveryManifest.client_id == "client-oversize")
        .order_by(SyncRecoveryManifest.generation.desc())
    )
    assert unusable is not None
    assert unusable.generation == 2
    assert unusable.manifest_sha256 == "0" * 64
    assert (
        await space_session.scalar(
            select(SyncRecoveryChunk).where(
                SyncRecoveryChunk.manifest_token == unusable.token
            )
        )
        is None
    )


@pytest.mark.asyncio
async def test_protocol_commits_corrupt_generation_invalidation_before_raising(space_session):
    from app.sync.protocol import SyncProtocol
    from app.sync.snapshot import SnapshotInvalidError, SyncPageTokenCodec

    space_session.add_all(notes(501))
    await space_session.commit()
    catalog = SimpleNamespace(
        hash=CATALOG.hash,
        list_sync_enabled=lambda: (CATALOG.get("note"),),
        model_for=lambda _name: Note,
    )
    protocol = SyncProtocol(
        RuntimeScope(space_session, body="body"),
        NoOpRecovery(),
        catalog=catalog,
        mapper=SimpleNamespace(),
        cursor=SyncCursorCodec(b"cursor-secret-0123456789abcdefghij"),
        page_tokens=SyncPageTokenCodec(b"page-token-secret-0123456789abcdef"),
        ttl_days=30,
    )
    first = await protocol.recover("client-a")
    assert first.has_more is True
    assert first.next_page_token is not None

    client = await space_session.get(SyncClient, "client-a")
    assert client is not None and client.recovery_manifest_token is not None
    second = await space_session.get(
        SyncRecoveryChunk, (client.recovery_manifest_token, 1)
    )
    assert second is not None
    second.payload_gzip = second.payload_gzip[:-1] + bytes([second.payload_gzip[-1] ^ 1])
    await space_session.commit()

    with pytest.raises(SnapshotInvalidError):
        await protocol.recover("client-a", first.next_page_token)

    persisted = await space_session.get(SyncClient, "client-a")
    assert persisted is not None
    assert persisted.requires_recovery is True
    assert persisted.recovery_manifest_token is None
    assert persisted.recovery_waterline is None
    assert persisted.recovery_completed_at is None


@pytest.mark.asyncio
async def test_expired_generation_collection_removes_chunks_and_rejects_old_token(space_session):
    from app.sync.snapshot import SyncPageTokenCodec, SyncSnapshotSerializer, SyncSnapshotStore

    clock = ["2026-08-06T00:00:00.000Z"]
    registry = SyncClientRegistry(
        space_session,
        CATALOG.hash,
        30,
        space_id="spc_test",
        now_factory=lambda: clock[0],
    )
    await registry.register_or_touch("client-a")
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
        cursor=SyncCursorCodec(b"cursor-secret-0123456789abcdefghij"),
        now_factory=lambda: clock[0],
    )
    created = await store.create(scope_for("spc_test"), TestLease(), "client-a")
    assert created.descriptor is not None
    token = created.descriptor.first_page_token
    manifest_token = created.descriptor.manifest_token
    clock[0] = "2026-09-06T00:00:00.000Z"

    assert await registry.collect_expired_recovery() == 1
    client = await space_session.get(SyncClient, "client-a")
    assert client is not None
    assert client.requires_recovery is True
    assert client.recovery_manifest_token is None
    assert await space_session.get(SyncRecoveryManifest, manifest_token) is None
    assert (
        await space_session.scalar(
            select(SyncRecoveryChunk).where(
                SyncRecoveryChunk.manifest_token == manifest_token
            )
        )
        is None
    )
    expired = await store.page(scope_for("spc_test"), TestLease(), "client-a", token)
    assert expired.page is None
    assert expired.error is not None
    assert expired.error.code == "cursor_expired"
    assert dict(expired.error.details) == {"recovery_action": "full_recovery"}


@pytest.mark.asyncio
async def test_one_maintenance_cycle_preserves_the_101st_referenced_recovery_pin(
    space_session,
):
    expired_at = "2026-08-01T00:00:00.000Z"
    clients = []
    manifests = []
    for index in range(101):
        client_id = f"client-{index:03d}"
        manifest_token = f"manifest-{index:03d}"
        clients.append(
            SyncClient(
                client_id=client_id,
                ack_sequence=0,
                catalog_hash=CATALOG.hash,
                registered_at=expired_at,
                last_seen_at=expired_at,
                expires_at=expired_at,
                requires_recovery=True,
                recovery_generation=1,
                recovery_manifest_token=manifest_token,
                recovery_waterline=index + 1,
            )
        )
        manifests.append(
            SyncRecoveryManifest(
                token=manifest_token,
                space_id="spc_test",
                client_id=client_id,
                generation=1,
                catalog_hash=CATALOG.hash,
                waterline=index + 1,
                total_entities=0,
                total_chunks=0,
                total_uncompressed_bytes=0,
                created_at=expired_at,
                expires_at=expired_at,
                manifest_sha256="d" * 64,
            )
        )
    space_session.add_all([*clients, *manifests])
    await space_session.flush()
    registry = SyncClientRegistry(
        space_session,
        CATALOG.hash,
        30,
        space_id="spc_test",
        now_factory=lambda: "2026-08-02T00:00:00.000Z",
    )

    await registry.expire_inactive()
    assert await registry.collect_expired_recovery() == 100

    unprocessed = await space_session.get(SyncClient, "client-100")
    assert unprocessed is not None
    assert unprocessed.recovery_manifest_token == "manifest-100"
    assert await registry.minimum_safe_retention_sequence() == 101


@pytest.mark.asyncio
async def test_in_progress_recovery_manifest_pins_retention_until_final_ack(space_session):
    from app.services.sync_outbox import record_sync_event
    from app.sync.retention import RetentionCoordinator
    from app.sync.snapshot import SyncPageTokenCodec, SyncSnapshotSerializer, SyncSnapshotStore

    for sequence in range(1, 6):
        await record_sync_event(
            space_session,
            entity_type="note",
            entity_id=f"before-{sequence}",
            action="create",
            payload={"id": f"before-{sequence}"},
            visible=True,
        )
    registry = SyncClientRegistry(space_session, CATALOG.hash, 30, space_id="spc_test")
    await registry.register_or_touch("recovering-client")
    empty_catalog = SimpleNamespace(
        hash=CATALOG.hash,
        list_sync_enabled=lambda: (),
        model_for=lambda _name: None,
    )
    cursor = SyncCursorCodec(b"cursor-secret-0123456789abcdefghij")
    store = SyncSnapshotStore(
        space_session,
        empty_catalog,
        SyncPageTokenCodec(b"page-token-secret-0123456789abcdef"),
        SyncSnapshotSerializer(),
        cursor=cursor,
    )
    created = await store.create(
        scope_for("spc_test"), TestLease(), "recovering-client"
    )
    assert created.descriptor is not None
    assert created.descriptor.waterline == 5
    for sequence in range(6, 26):
        await record_sync_event(
            space_session,
            entity_type="note",
            entity_id=f"after-{sequence}",
            action="create",
            payload={"id": f"after-{sequence}"},
            visible=True,
        )
    other = await registry.register_or_touch("other-client")
    other_row = await space_session.get(SyncClient, other.client_id)
    assert other_row is not None
    other_row.requires_recovery = False
    other_row.ack_sequence = 15
    await space_session.commit()

    pruned = await RetentionCoordinator(
        CATALOG.hash, 30, space_id="spc_test"
    ).prune(RuntimeScope(space_session))
    assert pruned.waterline == 5

    final = await store.page(
        scope_for("spc_test"),
        TestLease(),
        "recovering-client",
        created.descriptor.first_page_token,
    )
    assert final.page is not None and final.page.has_more is False
    acknowledged = await SyncClientRegistry(
        space_session, CATALOG.hash, 30, space_id="spc_test"
    ).acknowledge("recovering-client", cursor.decode(final.page.waterline_cursor))
    assert acknowledged.error is None
    assert acknowledged.result is not None
    assert acknowledged.result.requires_recovery is False


@pytest.mark.asyncio
async def test_post_snapshot_mutation_appears_only_in_incremental_pull(space_session):
    from app.services.sync_outbox import record_sync_event
    from app.sync.protocol import SyncProtocol
    from app.sync.snapshot import SyncPageTokenCodec

    original = notes(1)[0]
    space_session.add(original)
    await record_sync_event(
        space_session,
        entity_type="note",
        entity_id=original.id,
        action="create",
        payload={"id": original.id, "title": original.title},
        operation_id="snapshot-original-op",
        batch_id="snapshot-original-batch",
        version=original.version,
        created_at=original.updated_at,
        visible=True,
    )
    await space_session.commit()
    catalog = SimpleNamespace(
        hash=CATALOG.hash,
        list_sync_enabled=lambda: (CATALOG.get("note"),),
        model_for=lambda _name: Note,
    )
    protocol = SyncProtocol(
        RuntimeScope(space_session, body="body"),
        NoOpRecovery(),
        catalog=catalog,
        mapper=SimpleNamespace(),
        cursor=SyncCursorCodec(b"cursor-secret-0123456789abcdefghij"),
        page_tokens=SyncPageTokenCodec(b"page-token-secret-0123456789abcdef"),
        ttl_days=30,
    )
    recovery = await protocol.recover("client-a")
    recovered = [
        json.loads(line)["entity_id"]
        for line in base64.b64decode(recovery.jsonl_base64, validate=True).splitlines()
    ]
    assert recovered == [original.id]

    later = notes(1)[0]
    later.id = "note-later"
    later.title = "Later Note"
    space_session.add(later)
    await record_sync_event(
        space_session,
        entity_type="note",
        entity_id=later.id,
        action="create",
        payload={"id": later.id, "title": later.title},
        operation_id="snapshot-later-op",
        batch_id="snapshot-later-batch",
        version=later.version,
        created_at=later.updated_at,
        visible=True,
    )
    await space_session.commit()

    ack = await protocol.ack("client-a", recovery.waterline_cursor)
    assert ack.requires_recovery is False
    pulled = await protocol.pull("client-a", recovery.waterline_cursor, 500)
    assert [event.entity_id for event in pulled.events] == [later.id]
