"""Manifest-backed, bounded, resumable full recovery for Sync v2."""

from __future__ import annotations

import base64
import binascii
import gzip
import hashlib
import hmac
import json
import uuid
import zlib
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Literal

import rfc8785
from sqlalchemy import delete, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import AppError, SyncCursorExpiredError, to_wire_json
from app.models.sync_client import SyncClient
from app.models.sync_recovery import SyncRecoveryChunk, SyncRecoveryManifest
from app.models.sync_state import SyncState
from app.runtime.leases import LeaseMode
from app.services.time import utc_now_iso_ms
from app.sync.clients import SyncClientRegistry
from app.sync.contracts import (
    RecoveryPage,
    SnapshotDescriptor,
    require_canonical_utc_rfc3339,
    require_frozen_i_json_object,
    require_safe_nonnegative_int,
    validate_client_id,
    validate_i_json_graph,
    validate_page_token,
)
from app.sync.cursor import CursorPosition, SyncCursorCodec

MAX_CHUNK_ENTITIES = 500
MAX_CHUNK_BYTES = 8 * 1024 * 1024
_PAGE_TOKEN_FIELDS = frozenset(
    {
        "client_id",
        "generation",
        "manifest_token",
        "next_chunk_index",
        "space_id",
        "version",
    }
)
_INVALID_MANIFEST_SHA256 = "0" * 64
_EPOCH_TIMESTAMP = "1970-01-01T00:00:00.000Z"


def _space_id(scope: object) -> str:
    nested = getattr(scope, "scope", None)
    value = getattr(nested, "space_id", None) or getattr(scope, "space_id", None)
    if not isinstance(value, str) or not value:
        raise ValueError("snapshot scope has no Space identity")
    return value


def _expires_at(now: str, ttl_days: int) -> str:
    parsed = datetime.fromisoformat(now.replace("Z", "+00:00")).astimezone(timezone.utc)
    return (parsed + timedelta(days=ttl_days)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:23] + "Z"


def _snake_to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(item[:1].upper() + item[1:] for item in tail)


def _json_field(value: object) -> object:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError("persisted JSON catalog field is invalid") from exc


def _wire_value(value: object, *, field_type: str) -> object:
    if field_type == "json":
        value = _json_field(value)
    if isinstance(value, Enum):
        value = value.value
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() != timedelta(0):
            raise ValueError("persisted datetime must be UTC")
        value = value.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    validate_i_json_graph(value)
    return value


class SnapshotInvalidError(AppError):
    detail = "Sync recovery snapshot is invalid"
    status_code = 409
    legacy_error_type = "sync_snapshot_invalid"
    code = "snapshot_invalid"
    retryable = False

    def __init__(self) -> None:
        super().__init__(details={"recovery_action": "full_recovery"})


class SnapshotEntityTooLargeError(AppError):
    detail = "One Sync recovery entity exceeds the snapshot chunk limit"
    status_code = 422
    legacy_error_type = "sync_snapshot_entity_too_large"
    code = "snapshot_entity_too_large"
    retryable = False

    def __init__(self) -> None:
        super().__init__(details={"recovery_action": "full_recovery"})


@dataclass(frozen=True, slots=True)
class SnapshotEntityRecord:
    kind: Literal["entity"]
    entity_type: str
    entity_id: str
    version: int
    updated_at: str
    payload: Mapping[str, object]

    def __post_init__(self) -> None:
        if self.kind != "entity":
            raise ValueError("snapshot record kind must be entity")
        if not isinstance(self.entity_type, str) or not self.entity_type:
            raise ValueError("snapshot entity_type must not be empty")
        if not isinstance(self.entity_id, str) or not self.entity_id:
            raise ValueError("snapshot entity_id must not be empty")
        require_safe_nonnegative_int(self.version, field="version")
        require_canonical_utc_rfc3339(self.updated_at)
        object.__setattr__(self, "payload", require_frozen_i_json_object(self.payload))


def canonical_snapshot_json_line(
    record: SnapshotEntityRecord,
    *,
    primary_key: str | None = None,
    space_id: str | None = None,
) -> bytes:
    if not isinstance(record, SnapshotEntityRecord):
        raise TypeError("record must be a SnapshotEntityRecord")
    payload = to_wire_json(record.payload)
    if not isinstance(payload, dict):
        raise TypeError("snapshot payload must serialize to an object")
    if primary_key is not None and payload.get(primary_key) != record.entity_id:
        raise ValueError("snapshot primary key disagrees with entity_id")
    if space_id is not None and payload.get("spaceId") != space_id:
        raise ValueError("snapshot payload disagrees with its Space")
    wire = {
        "entity_id": record.entity_id,
        "entity_type": record.entity_type,
        "kind": record.kind,
        "payload": payload,
        "updated_at": record.updated_at,
        "version": record.version,
    }
    if set(wire) != {"kind", "entity_type", "entity_id", "version", "updated_at", "payload"}:
        raise ValueError("snapshot record shape is not closed")
    return rfc8785.dumps(wire) + b"\n"


@dataclass(frozen=True, slots=True)
class SnapshotCreateDecision:
    descriptor: SnapshotDescriptor | None
    error: AppError | None

    def __post_init__(self) -> None:
        if (self.descriptor is None) == (self.error is None):
            raise ValueError("snapshot create decision requires exactly one outcome")


@dataclass(frozen=True, slots=True)
class SnapshotPageDecision:
    page: RecoveryPage | None
    error: AppError | None

    def __post_init__(self) -> None:
        if (self.page is None) == (self.error is None):
            raise ValueError("snapshot page decision requires exactly one outcome")


@dataclass(frozen=True, slots=True)
class PageTokenPosition:
    space_id: str
    client_id: str
    generation: int
    manifest_token: str
    next_chunk_index: int

    def __post_init__(self) -> None:
        validate_client_id(self.client_id)
        require_safe_nonnegative_int(self.generation, field="generation")
        require_safe_nonnegative_int(self.next_chunk_index, field="next_chunk_index")
        if not isinstance(self.space_id, str) or not self.space_id:
            raise ValueError("space_id is invalid")
        if not isinstance(self.manifest_token, str) or not self.manifest_token:
            raise ValueError("manifest_token is invalid")


@dataclass(frozen=True, slots=True)
class _ChunkDescriptor:
    chunk_index: int
    entity_count: int
    uncompressed_bytes: int
    payload_sha256: str


class SyncPageTokenCodec:
    """HMAC-authenticated opaque recovery continuation tokens."""

    def __init__(self, secret: bytes) -> None:
        if not isinstance(secret, bytes) or len(secret) < 32:
            raise ValueError("page token secret must be at least 32 bytes")
        self._secret = secret

    def encode(self, position: PageTokenPosition) -> str:
        if not isinstance(position, PageTokenPosition):
            raise TypeError("position must be PageTokenPosition")
        payload = rfc8785.dumps(
            {
                "client_id": position.client_id,
                "generation": position.generation,
                "manifest_token": position.manifest_token,
                "next_chunk_index": position.next_chunk_index,
                "space_id": position.space_id,
                "version": 1,
            }
        )
        signature = hmac.digest(self._secret, payload, "sha256")
        token = ".".join(
            base64.urlsafe_b64encode(part).rstrip(b"=").decode("ascii")
            for part in (payload, signature)
        )
        validate_page_token(token)
        return token

    def decode(self, token: str) -> PageTokenPosition:
        try:
            validate_page_token(token)
            parts = token.split(".")
            if len(parts) != 2 or any(not item or "=" in item for item in parts):
                raise ValueError("invalid token segments")
            decoded: list[bytes] = []
            for part in parts:
                raw = part.encode("ascii")
                value = base64.b64decode(
                    raw + b"=" * (-len(raw) % 4), altchars=b"-_", validate=True
                )
                if base64.urlsafe_b64encode(value).rstrip(b"=") != raw:
                    raise ValueError("noncanonical token segment")
                decoded.append(value)
            payload, signature = decoded
            expected = hmac.digest(self._secret, payload, "sha256")
            if len(signature) != 32 or not hmac.compare_digest(signature, expected):
                raise ValueError("invalid token signature")
            value = json.loads(payload.decode("utf-8"))
            if not isinstance(value, dict) or set(value) != _PAGE_TOKEN_FIELDS:
                raise ValueError("invalid token shape")
            if value["version"] != 1 or type(value["version"]) is not int:
                raise ValueError("invalid token version")
            return PageTokenPosition(
                space_id=value["space_id"],
                client_id=value["client_id"],
                generation=value["generation"],
                manifest_token=value["manifest_token"],
                next_chunk_index=value["next_chunk_index"],
            )
        except (
            binascii.Error,
            KeyError,
            TypeError,
            UnicodeError,
            ValueError,
            json.JSONDecodeError,
        ) as exc:
            raise SyncCursorExpiredError(recovery_action="full_recovery") from exc


class SyncSnapshotSerializer:
    """Catalog-allowlisted post-image serializer with authoritative Note bodies."""

    async def serialize(self, scope: object, spec: object, row: object) -> Mapping[str, object]:
        space_id = _space_id(scope)
        payload: dict[str, object] = {}
        fields = getattr(spec, "fields", None)
        if not isinstance(fields, tuple):
            raise TypeError("catalog fields must be an immutable tuple")
        for field in fields:
            name = getattr(field, "name", None)
            if not isinstance(name, str) or not hasattr(row, name):
                raise ValueError("catalog row is missing an allowlisted field")
            payload[_snake_to_camel(name)] = _wire_value(
                getattr(row, name), field_type=getattr(field, "type", "")
            )
        if getattr(spec, "name", None) == "note":
            file_system = getattr(scope, "file_system", None)
            reader = getattr(file_system, "read_note", None)
            if reader is None or not callable(reader):
                raise ValueError("authoritative Note Markdown reader is unavailable")
            body = await reader(str(getattr(row, getattr(spec, "primary_key"))))
            if not isinstance(body, str):
                raise ValueError("authoritative Note Markdown body is unavailable")
            payload["content"] = body
        if "spaceId" in payload and payload["spaceId"] != space_id:
            raise ValueError("serializer supplied a foreign Space")
        payload["spaceId"] = space_id
        return require_frozen_i_json_object(payload)


def _canonical_manifest_bytes(
    manifest: SyncRecoveryManifest, chunks: tuple[_ChunkDescriptor, ...]
) -> bytes:
    return rfc8785.dumps(
        {
            "catalog_hash": manifest.catalog_hash,
            "chunks": [
                {
                    "entity_count": chunk.entity_count,
                    "payload_sha256": chunk.payload_sha256,
                    "uncompressed_bytes": chunk.uncompressed_bytes,
                }
                for chunk in chunks
            ],
            "client_id": manifest.client_id,
            "generation": manifest.generation,
            "space_id": manifest.space_id,
            "total_chunks": manifest.total_chunks,
            "total_entities": manifest.total_entities,
            "total_uncompressed_bytes": manifest.total_uncompressed_bytes,
            "waterline": manifest.waterline,
        }
    )


def decode_persisted_chunk_bounded(
    payload_gzip: bytes,
    *,
    uncompressed_bytes: int,
    payload_sha256: str,
    entity_count: int,
) -> bytes:
    """Decode exactly one gzip member with a hard output ceiling."""
    try:
        if not isinstance(payload_gzip, bytes):
            raise ValueError("gzip payload is not bytes")
        if type(uncompressed_bytes) is not int or not 1 <= uncompressed_bytes <= MAX_CHUNK_BYTES:
            raise ValueError("recorded size is outside the chunk limit")
        if type(entity_count) is not int or not 1 <= entity_count <= MAX_CHUNK_ENTITIES:
            raise ValueError("recorded count is outside the chunk limit")
        if not isinstance(payload_sha256, str) or len(payload_sha256) != 64:
            raise ValueError("recorded hash is invalid")
        decoder = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)
        decoded = decoder.decompress(payload_gzip, MAX_CHUNK_BYTES + 1)
        if len(decoded) > MAX_CHUNK_BYTES:
            raise ValueError("decoded chunk exceeds limit")
        if decoder.unconsumed_tail or decoder.unused_data or not decoder.eof:
            raise ValueError("gzip stream is not one complete member")
        remaining = MAX_CHUNK_BYTES + 1 - len(decoded)
        decoded += decoder.flush(remaining)
        if len(decoded) > MAX_CHUNK_BYTES:
            raise ValueError("decoded chunk exceeds limit")
        if len(decoded) != uncompressed_bytes:
            raise ValueError("decoded chunk size mismatch")
        if hashlib.sha256(decoded).hexdigest() != payload_sha256:
            raise ValueError("decoded chunk hash mismatch")
        if decoded.count(b"\n") != entity_count or not decoded.endswith(b"\n"):
            raise ValueError("decoded chunk entity count mismatch")
        return decoded
    except (TypeError, ValueError, zlib.error) as exc:
        raise SnapshotInvalidError() from exc


class SyncSnapshotStore:
    """Session-bound snapshot writer and page server; caller owns transaction."""

    def __init__(
        self,
        session: AsyncSession,
        catalog: object,
        page_tokens: SyncPageTokenCodec,
        serializer: SyncSnapshotSerializer,
        *,
        cursor: SyncCursorCodec | None = None,
        ttl_days: int = 30,
        now_factory=utc_now_iso_ms,
    ) -> None:
        if type(ttl_days) is not int or ttl_days <= 0:
            raise ValueError("snapshot ttl_days must be positive")
        self.db = session
        self.catalog = catalog
        self.page_tokens = page_tokens
        self.serializer = serializer
        self.cursor = cursor
        self.ttl_days = ttl_days
        self._now_factory = now_factory

    def _assert_lease(self, scope: object, lease: object) -> None:
        assertion = getattr(lease, "assert_active_owner", None)
        if assertion is None or not callable(assertion):
            raise ValueError("snapshot requires a Space-exclusive lease")
        assertion(mode=LeaseMode.EXCLUSIVE, scope=_space_id(scope))

    async def _iter_records(self, scope: object) -> AsyncIterator[bytes]:
        space_id = _space_id(scope)
        for spec in self.catalog.list_sync_enabled():
            model = self.catalog.model_for(spec.name)
            key_names = tuple(column.name for column in model.__table__.primary_key.columns)
            primary_key_columns = tuple(getattr(model, name) for name in key_names)
            last_primary_key: tuple[object, ...] | None = None
            while True:
                query = (
                    select(model)
                    .order_by(*(column.asc() for column in primary_key_columns))
                    .limit(MAX_CHUNK_ENTITIES)
                )
                if last_primary_key is not None:
                    if len(key_names) == 1:
                        query = query.where(primary_key_columns[0] > last_primary_key[0])
                    else:
                        query = query.where(
                            tuple_(*primary_key_columns) > tuple(last_primary_key)
                        )
                rows = tuple((await self.db.scalars(query)).all())
                if not rows:
                    break
                for row in rows:
                    payload = await self.serializer.serialize(scope, spec, row)
                    if not isinstance(payload, Mapping):
                        raise TypeError("snapshot serializer returned a non-object")
                    entity_id = getattr(row, spec.primary_key)
                    if not isinstance(entity_id, str) or not entity_id:
                        raise ValueError("snapshot entity identity must be nonempty text")
                    primary_key_wire = _snake_to_camel(spec.primary_key)
                    if payload.get(primary_key_wire) != entity_id:
                        raise ValueError("snapshot payload primary key disagrees with row")
                    if payload.get("spaceId") != space_id:
                        raise ValueError("snapshot payload has the wrong Space")
                    version = getattr(row, "version", 0)
                    updated_at = getattr(row, "updated_at", _EPOCH_TIMESTAMP)
                    record = SnapshotEntityRecord(
                        kind="entity",
                        entity_type=spec.effective_sync_entity_type,
                        entity_id=entity_id,
                        version=version,
                        updated_at=updated_at,
                        payload=payload,
                    )
                    yield canonical_snapshot_json_line(
                        record, primary_key=primary_key_wire, space_id=space_id
                    )
                last_primary_key = tuple(getattr(rows[-1], name) for name in key_names)

    async def _mark_unusable(
        self, manifest: SyncRecoveryManifest, client: SyncClient | None
    ) -> None:
        manifest.manifest_sha256 = _INVALID_MANIFEST_SHA256
        if client is not None and client.recovery_manifest_token == manifest.token:
            client.requires_recovery = True
            client.recovery_manifest_token = None
            client.recovery_waterline = None
            client.recovery_completed_at = None
        await self.db.flush()

    async def create(self, scope: object, lease: object, client_id: str) -> SnapshotCreateDecision:
        self._assert_lease(scope, lease)
        client_id = validate_client_id(client_id)
        space_id = _space_id(scope)
        client = await self.db.get(SyncClient, client_id)
        if client is None or client.catalog_hash != self.catalog.hash:
            return SnapshotCreateDecision(
                None, SyncCursorExpiredError(recovery_action="full_recovery")
            )
        state = await self.db.get(SyncState, 1)
        waterline = 0 if state is None else state.current_cursor
        require_safe_nonnegative_int(waterline, field="waterline")
        old_manifest_token = client.recovery_manifest_token
        token = uuid.uuid4().hex
        generation = client.recovery_generation + 1
        now = self._now_factory()
        manifest = SyncRecoveryManifest(
            token=token,
            space_id=space_id,
            client_id=client_id,
            generation=generation,
            catalog_hash=self.catalog.hash,
            waterline=waterline,
            total_entities=0,
            total_chunks=0,
            total_uncompressed_bytes=0,
            created_at=now,
            expires_at=_expires_at(now, self.ttl_days),
            manifest_sha256=_INVALID_MANIFEST_SHA256,
        )
        self.db.add(manifest)
        await self.db.flush()
        registry = SyncClientRegistry(
            self.db,
            self.catalog.hash,
            self.ttl_days,
            space_id=space_id,
            now_factory=self._now_factory,
        )
        registration = await registry.begin_recovery(
            client_id, manifest_token=token, waterline=waterline
        )
        if registration.recovery_generation != generation:
            raise RuntimeError("snapshot recovery generation changed unexpectedly")
        current = bytearray()
        current_count = 0
        descriptors: list[_ChunkDescriptor] = []

        async def flush_chunk() -> None:
            nonlocal current, current_count
            if not current:
                return
            raw = bytes(current)
            chunk = SyncRecoveryChunk(
                manifest_token=token,
                chunk_index=len(descriptors),
                entity_count=current_count,
                uncompressed_bytes=len(raw),
                payload_gzip=gzip.compress(raw, mtime=0),
                payload_sha256=hashlib.sha256(raw).hexdigest(),
            )
            self.db.add(chunk)
            descriptors.append(
                _ChunkDescriptor(
                    chunk.chunk_index,
                    chunk.entity_count,
                    chunk.uncompressed_bytes,
                    chunk.payload_sha256,
                )
            )
            current = bytearray()
            current_count = 0
            await self.db.flush()

        try:
            async for line in self._iter_records(scope):
                if len(line) > MAX_CHUNK_BYTES:
                    raise SnapshotEntityTooLargeError()
                if current and (
                    current_count == MAX_CHUNK_ENTITIES
                    or len(current) + len(line) > MAX_CHUNK_BYTES
                ):
                    await flush_chunk()
                current.extend(line)
                current_count += 1
            await flush_chunk()
        except SnapshotEntityTooLargeError as exc:
            await self._mark_unusable(manifest, client)
            return SnapshotCreateDecision(None, exc)

        manifest.total_chunks = len(descriptors)
        manifest.total_entities = sum(chunk.entity_count for chunk in descriptors)
        manifest.total_uncompressed_bytes = sum(
            chunk.uncompressed_bytes for chunk in descriptors
        )
        manifest.manifest_sha256 = hashlib.sha256(
            _canonical_manifest_bytes(manifest, tuple(descriptors))
        ).hexdigest()
        if old_manifest_token is not None and old_manifest_token != token:
            old = await self.db.get(SyncRecoveryManifest, old_manifest_token)
            if old is not None:
                # Production SQLite enforces the FK cascade.  The explicit
                # child delete also keeps test/alternate engines fail-closed
                # when their connection omitted SQLite's foreign_keys pragma.
                await self.db.execute(
                    delete(SyncRecoveryChunk).where(
                        SyncRecoveryChunk.manifest_token == old_manifest_token
                    )
                )
                await self.db.delete(old)
        await self.db.flush()
        first_page_token = self.page_tokens.encode(
            PageTokenPosition(space_id, client_id, generation, token, 0)
        )
        return SnapshotCreateDecision(
            SnapshotDescriptor(
                token,
                first_page_token,
                self.catalog.hash,
                waterline,
                generation,
                manifest.total_entities,
                manifest.total_chunks,
                manifest.total_uncompressed_bytes,
            ),
            None,
        )

    async def page(
        self,
        scope: object,
        lease: object,
        client_id: str,
        page_token: str,
    ) -> SnapshotPageDecision:
        self._assert_lease(scope, lease)
        client_id = validate_client_id(client_id)
        space_id = _space_id(scope)
        try:
            position = self.page_tokens.decode(page_token)
        except AppError as exc:
            return SnapshotPageDecision(None, exc)
        client = await self.db.get(SyncClient, client_id)
        manifest = await self.db.get(SyncRecoveryManifest, position.manifest_token)

        def expired() -> SnapshotPageDecision:
            return SnapshotPageDecision(
                None, SyncCursorExpiredError(recovery_action="full_recovery")
            )

        if client is None or manifest is None:
            return expired()
        if client.recovery_completed_at is not None:
            return expired()
        if (
            position.space_id != space_id
            or position.client_id != client_id
            or position.generation != client.recovery_generation
            or position.manifest_token != client.recovery_manifest_token
            or manifest.space_id != space_id
            or manifest.client_id != client_id
            or manifest.generation != position.generation
            or manifest.waterline != client.recovery_waterline
            or manifest.expires_at <= self._now_factory()
        ):
            return expired()
        if manifest.catalog_hash != self.catalog.hash or client.catalog_hash != self.catalog.hash:
            await self._mark_unusable(manifest, client)
            return expired()
        descriptors = tuple(
            _ChunkDescriptor(*row)
            for row in await self.db.execute(
                select(
                    SyncRecoveryChunk.chunk_index,
                    SyncRecoveryChunk.entity_count,
                    SyncRecoveryChunk.uncompressed_bytes,
                    SyncRecoveryChunk.payload_sha256,
                )
                .where(SyncRecoveryChunk.manifest_token == manifest.token)
                .order_by(SyncRecoveryChunk.chunk_index.asc())
            )
        )
        valid_descriptors = (
            len(descriptors) == manifest.total_chunks
            and tuple(chunk.chunk_index for chunk in descriptors)
            == tuple(range(len(descriptors)))
            and sum(chunk.entity_count for chunk in descriptors) == manifest.total_entities
            and sum(chunk.uncompressed_bytes for chunk in descriptors)
            == manifest.total_uncompressed_bytes
            and hashlib.sha256(
                _canonical_manifest_bytes(manifest, descriptors)
            ).hexdigest()
            == manifest.manifest_sha256
        )
        if not valid_descriptors:
            await self._mark_unusable(manifest, client)
            return SnapshotPageDecision(None, SnapshotInvalidError())
        if manifest.total_chunks == 0:
            if position.next_chunk_index != 0:
                return expired()
            raw = b""
            entity_count = 0
            sha256 = hashlib.sha256(raw).hexdigest()
        else:
            if position.next_chunk_index >= manifest.total_chunks:
                return expired()
            chunk = await self.db.get(
                SyncRecoveryChunk,
                (manifest.token, position.next_chunk_index),
            )
            if chunk is None:
                await self._mark_unusable(manifest, client)
                return SnapshotPageDecision(None, SnapshotInvalidError())
            try:
                raw = decode_persisted_chunk_bounded(
                    chunk.payload_gzip,
                    uncompressed_bytes=chunk.uncompressed_bytes,
                    payload_sha256=chunk.payload_sha256,
                    entity_count=chunk.entity_count,
                )
            except SnapshotInvalidError as exc:
                await self._mark_unusable(manifest, client)
                return SnapshotPageDecision(None, exc)
            entity_count = chunk.entity_count
            sha256 = chunk.payload_sha256
        next_index = position.next_chunk_index + 1
        has_more = next_index < manifest.total_chunks
        next_token = (
            self.page_tokens.encode(
                PageTokenPosition(
                    space_id, client_id, position.generation, manifest.token, next_index
                )
            )
            if has_more
            else None
        )
        if not has_more:
            client.recovery_completed_at = self._now_factory()
        client.last_seen_at = self._now_factory()
        client.expires_at = _expires_at(client.last_seen_at, self.ttl_days)
        await self.db.flush()
        cursor = self.cursor
        if cursor is None:
            raise RuntimeError("snapshot page serving requires a cursor codec")
        waterline_cursor = cursor.encode(
            CursorPosition(
                manifest.waterline,
                manifest.catalog_hash,
                space_id,
                client_id,
                manifest.generation,
            )
        )
        try:
            page = RecoveryPage(
                next_token,
                has_more,
                manifest.catalog_hash,
                waterline_cursor,
                entity_count,
                base64.b64encode(raw).decode("ascii"),
                sha256,
            )
        except (TypeError, ValueError):
            await self._mark_unusable(manifest, client)
            return SnapshotPageDecision(None, SnapshotInvalidError())
        return SnapshotPageDecision(page, None)


__all__ = [
    "MAX_CHUNK_BYTES",
    "MAX_CHUNK_ENTITIES",
    "PageTokenPosition",
    "SnapshotCreateDecision",
    "SnapshotEntityRecord",
    "SnapshotEntityTooLargeError",
    "SnapshotInvalidError",
    "SnapshotPageDecision",
    "SyncPageTokenCodec",
    "SyncSnapshotSerializer",
    "SyncSnapshotStore",
    "canonical_snapshot_json_line",
    "decode_persisted_chunk_bounded",
]
