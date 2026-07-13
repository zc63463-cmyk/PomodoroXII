from __future__ import annotations

import gzip
import hashlib
import json

import pytest

import app.services.sync_snapshot_chunks as snapshot_chunks_module
from app.services.sync_snapshot_chunks import (
    MAX_CHUNK_UNCOMPRESSED_BYTES,
    MAX_SINGLE_ITEM_BYTES,
    SnapshotChunkEncoder,
    decode_snapshot_chunk,
    encode_snapshot_chunks,
)


def _json_line(item: dict) -> bytes:
    return (
        json.dumps(item, ensure_ascii=False, sort_keys=True, allow_nan=False).encode("utf-8")
        + b"\n"
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


def test_encoder_seals_previous_chunk_when_encoded_lines_cross_byte_limit() -> None:
    first = {"payload": "a" * (MAX_CHUNK_UNCOMPRESSED_BYTES // 2)}
    first_size = len(_json_line(first))
    second = {
        "payload": "b" * (MAX_CHUNK_UNCOMPRESSED_BYTES - first_size),
    }
    second_size = len(_json_line(second))
    assert first_size <= MAX_CHUNK_UNCOMPRESSED_BYTES
    assert second_size <= MAX_SINGLE_ITEM_BYTES
    assert first_size + second_size > MAX_CHUNK_UNCOMPRESSED_BYTES

    encoder = SnapshotChunkEncoder()
    assert encoder.add(first) is None
    sealed = encoder.add(second)

    assert sealed is not None
    assert sealed.item_count == 1
    assert sealed.uncompressed_bytes == first_size
    final = encoder.finish()
    assert final is not None
    assert final.item_count == 1
    assert final.uncompressed_bytes == second_size


def test_encoder_rejects_single_encoded_line_over_item_limit() -> None:
    item = {"payload": "x" * MAX_SINGLE_ITEM_BYTES}
    encoded_size = len(_json_line(item))
    assert encoded_size > MAX_SINGLE_ITEM_BYTES

    encoder = SnapshotChunkEncoder()
    with pytest.raises(ValueError, match="item exceeds size limit"):
        encoder.add(item)
    assert encoder.finish() is None


def test_encoder_rejects_chunk_when_compressor_output_exceeds_production_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    item = {"payload": "bounded"}
    oversized = b"x" * (snapshot_chunks_module.MAX_COMPRESSED_BYTES + 1)

    monkeypatch.setattr(snapshot_chunks_module.gzip, "compress", lambda *_args, **_kwargs: oversized)
    encoder = SnapshotChunkEncoder()
    assert encoder.add(item) is None
    with pytest.raises(ValueError, match="compressed size limit"):
        encoder.finish()


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
