"""Canonical manifest serialization and validation."""

from dataclasses import asdict
import json
from pathlib import Path, PurePosixPath
import re

from .contracts import MetaSnapshot, SnapshotFile, SnapshotManifest, SpaceSnapshot
from .sqlite_copy import sha256_file


def validate_relative_path(path: str | Path) -> str:
    value = str(path).replace("\\", "/")
    candidate = PurePosixPath(value)
    if not value or "\x00" in value or candidate.is_absolute() or ":" in value.split("/")[0]:
        raise ValueError("manifest path must be a relative POSIX path")
    if any(part in {"", ".", ".."} for part in candidate.parts):
        raise ValueError("manifest path contains an invalid component")
    return candidate.as_posix()


def _obj(value: object) -> object:
    if hasattr(value, "__dataclass_fields__"):
        return {key: _obj(item) for key, item in asdict(value).items()}
    if isinstance(value, MappingProxyType):
        return dict(value)
    if isinstance(value, dict):
        return {str(key): _obj(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_obj(item) for item in value]
    return value


try:
    from types import MappingProxyType
except ImportError:  # pragma: no cover
    MappingProxyType = dict


def manifest_dict(manifest: SnapshotManifest) -> dict[str, object]:
    data = _obj(manifest)
    if not isinstance(data, dict):
        raise TypeError("manifest did not serialize to an object")
    data["spaces"] = sorted(data["spaces"], key=lambda item: item["space_id"])
    data["files"] = sorted(data["files"], key=lambda item: item["relative_path"])
    return data


def canonical_json(manifest: SnapshotManifest) -> bytes:
    return (json.dumps(manifest_dict(manifest), sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def write_manifest(root: Path, manifest: SnapshotManifest) -> str:
    for entry in manifest.files:
        validate_relative_path(entry.relative_path)
    payload = canonical_json(manifest)
    manifest_path = root / "manifest.json"
    manifest_path.write_bytes(payload)
    digest = sha256_file(manifest_path)
    (root / "manifest.sha256").write_text(digest + "\n", encoding="ascii")
    return digest


def parse_manifest(payload: bytes | str) -> SnapshotManifest:
    raw = json.loads(payload)
    meta = raw["meta"]
    return SnapshotManifest(
        schema_version=raw["schema_version"], created_at=raw["created_at"], source_fence=raw["source_fence"],
        catalog_hash=raw["catalog_hash"], catalog_entry_count=raw["catalog_entry_count"],
        catalog_entity_types=tuple(raw["catalog_entity_types"]),
        meta=MetaSnapshot(meta["schema_head"], meta["active_session_coordination"], meta["effort_projection"]),
        spaces=tuple(SpaceSnapshot(item["space_id"], item["space_head"], item["index_schema_version"], item["sync_waterline"], item["entity_counts"], item["note_hashes"]) for item in raw["spaces"]),
        files=tuple(SnapshotFile(item["relative_path"], item["size"], item["sha256"], item["kind"]) for item in raw["files"]),
    )
