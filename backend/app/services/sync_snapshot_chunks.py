"""Bounded NDJSON + gzip codec for materialized sync snapshots."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

MAX_CHUNK_ITEMS = 500
MAX_CHUNK_UNCOMPRESSED_BYTES = 2 * 1024 * 1024
MAX_SINGLE_ITEM_BYTES = 2 * 1024 * 1024
MAX_COMPRESSED_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True)
class EncodedSnapshotChunk:
    item_start: int
    item_count: int
    compressed_payload: bytes
    uncompressed_bytes: int
    compressed_bytes: int
    checksum: str


class SnapshotChunkEncoder:
    """Incrementally seal bounded chunks without retaining the full snapshot."""

    def __init__(self) -> None:
        self._lines: list[bytes] = []
        self._size = 0
        self._item_start = 0

    def add(self, item: dict[str, Any]) -> EncodedSnapshotChunk | None:
        line = (
            json.dumps(item, ensure_ascii=False, sort_keys=True, allow_nan=False)
            .encode("utf-8")
            + b"\n"
        )
        if len(line) > MAX_SINGLE_ITEM_BYTES:
            raise ValueError("snapshot item exceeds size limit")
        sealed = None
        if self._lines and (
            len(self._lines) >= MAX_CHUNK_ITEMS
            or self._size + len(line) > MAX_CHUNK_UNCOMPRESSED_BYTES
        ):
            sealed = self._seal()
        self._lines.append(line)
        self._size += len(line)
        return sealed

    def finish(self) -> EncodedSnapshotChunk | None:
        return self._seal() if self._lines else None

    def _seal(self) -> EncodedSnapshotChunk:
        raw = b"".join(self._lines)
        compressed = gzip.compress(raw, compresslevel=6, mtime=0)
        if len(compressed) > MAX_COMPRESSED_BYTES:
            raise ValueError("snapshot chunk exceeds compressed size limit")
        chunk = EncodedSnapshotChunk(
            item_start=self._item_start,
            item_count=len(self._lines),
            compressed_payload=compressed,
            uncompressed_bytes=len(raw),
            compressed_bytes=len(compressed),
            checksum=hashlib.sha256(compressed).hexdigest(),
        )
        self._item_start += len(self._lines)
        self._lines = []
        self._size = 0
        return chunk


def encode_snapshot_chunks(items: Iterable[dict[str, Any]]) -> list[EncodedSnapshotChunk]:
    encoder = SnapshotChunkEncoder()
    chunks: list[EncodedSnapshotChunk] = []
    for item in items:
        sealed = encoder.add(item)
        if sealed is not None:
            chunks.append(sealed)
    final = encoder.finish()
    if final is not None:
        chunks.append(final)
    return chunks


def decode_snapshot_chunk(
    *,
    compressed_payload: bytes,
    checksum: str,
    expected_uncompressed_bytes: int,
    expected_compressed_bytes: int,
    expected_item_count: int,
) -> list[dict[str, Any]]:
    if len(compressed_payload) != expected_compressed_bytes:
        raise ValueError("snapshot chunk compressed size mismatch")
    if len(compressed_payload) > MAX_COMPRESSED_BYTES:
        raise ValueError("snapshot chunk exceeds compressed size limit")
    if hashlib.sha256(compressed_payload).hexdigest() != checksum:
        raise ValueError("snapshot chunk checksum mismatch")
    if not 0 <= expected_uncompressed_bytes <= MAX_CHUNK_UNCOMPRESSED_BYTES:
        raise ValueError("snapshot chunk declares invalid uncompressed size")
    with gzip.GzipFile(fileobj=io.BytesIO(compressed_payload), mode="rb") as stream:
        raw = stream.read(expected_uncompressed_bytes + 1)
        if len(raw) > expected_uncompressed_bytes:
            raise ValueError("snapshot chunk exceeds declared uncompressed size")
        if stream.read(1):
            raise ValueError("snapshot chunk exceeds uncompressed size limit")
    if len(raw) != expected_uncompressed_bytes:
        raise ValueError("snapshot chunk size mismatch")
    lines = raw.splitlines()
    if len(lines) != expected_item_count:
        raise ValueError("snapshot chunk item count mismatch")
    return [json.loads(line) for line in lines]
