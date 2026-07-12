from __future__ import annotations

import gzip
import hashlib

import pytest

from app.services.sync_snapshot_chunks import (
    MAX_CHUNK_UNCOMPRESSED_BYTES,
    decode_snapshot_chunk,
    encode_snapshot_chunks,
)


def test_codec_round_trip_and_dual_threshold_items() -> None:
    items = [{"kind": "entity", "pull_key": "tasks", "payload": {"id": str(i)}} for i in range(501)]
    chunks = encode_snapshot_chunks(items)
    assert [chunk.item_count for chunk in chunks] == [500, 1]
    decoded = [
        item
        for chunk in chunks
        for item in decode_snapshot_chunk(
            compressed_payload=chunk.compressed_payload,
            checksum=chunk.checksum,
            expected_uncompressed_bytes=chunk.uncompressed_bytes,
            expected_compressed_bytes=chunk.compressed_bytes,
            expected_item_count=chunk.item_count,
        )
    ]
    assert decoded == items


def test_decode_rejects_gzip_bomb_before_unbounded_allocation() -> None:
    compressed = gzip.compress(b"x" * (MAX_CHUNK_UNCOMPRESSED_BYTES + 1), mtime=0)
    with pytest.raises(ValueError, match="exceeds declared|exceeds uncompressed"):
        decode_snapshot_chunk(
            compressed_payload=compressed,
            checksum=hashlib.sha256(compressed).hexdigest(),
            expected_uncompressed_bytes=MAX_CHUNK_UNCOMPRESSED_BYTES,
            expected_compressed_bytes=len(compressed),
            expected_item_count=1,
        )


def test_decode_rejects_checksum_mismatch() -> None:
    chunk = encode_snapshot_chunks([{"kind": "tombstone", "payload": {"id": "x"}}])[0]
    with pytest.raises(ValueError, match="checksum"):
        decode_snapshot_chunk(
            compressed_payload=chunk.compressed_payload,
            checksum="0" * 64,
            expected_uncompressed_bytes=chunk.uncompressed_bytes,
            expected_compressed_bytes=chunk.compressed_bytes,
            expected_item_count=chunk.item_count,
        )


def test_decode_rejects_declared_compressed_size_mismatch() -> None:
    chunk = encode_snapshot_chunks([{"kind": "tombstone", "payload": {"id": "x"}}])[0]
    with pytest.raises(ValueError, match="compressed size mismatch"):
        decode_snapshot_chunk(
            compressed_payload=chunk.compressed_payload,
            checksum=chunk.checksum,
            expected_uncompressed_bytes=chunk.uncompressed_bytes,
            expected_compressed_bytes=chunk.compressed_bytes + 1,
            expected_item_count=chunk.item_count,
        )
