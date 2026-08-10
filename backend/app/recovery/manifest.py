"""Canonical manifest serialization and validation."""

import json
from dataclasses import fields, is_dataclass
from pathlib import Path, PurePosixPath

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
    if is_dataclass(value) and not isinstance(value, type):
        return {field.name: _obj(getattr(value, field.name)) for field in fields(value)}
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
    return (
        json.dumps(
            manifest_dict(manifest), sort_keys=True, separators=(",", ":"), ensure_ascii=False
        )
        + "\n"
    ).encode("utf-8")


def write_manifest(root: Path, manifest: SnapshotManifest) -> str:
    for entry in manifest.files:
        validate_relative_path(entry.relative_path)
    payload = canonical_json(manifest)
    manifest_path = root / "manifest.json"
    manifest_path.write_bytes(payload)
    digest = sha256_file(manifest_path)
    (root / "manifest.sha256").write_text(digest + "\n", encoding="ascii")
    return digest


def _require_str(value: object, label: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value):
        raise ValueError(f"{label} must be a non-empty string")
    return value


def _require_int(value: object, label: str) -> int:
    if type(value) is not int:  # ``bool`` is an ``int`` subclass and must be rejected.
        raise ValueError(f"{label} must be an integer")
    return value


def _require_mapping(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def parse_manifest(payload: bytes) -> SnapshotManifest:
    if not isinstance(payload, bytes):
        raise ValueError("manifest payload must be bytes")
    raw = json.loads(payload)
    if not isinstance(raw, dict):
        raise ValueError("manifest must be an object")
    if set(raw) != {
        "schema_version",
        "created_at",
        "source_fence",
        "catalog_hash",
        "catalog_entry_count",
        "catalog_entity_types",
        "meta",
        "spaces",
        "files",
    }:
        raise ValueError("manifest keys are invalid")
    if canonical_json_from_raw(raw) != payload:
        raise ValueError("manifest is not canonical")
    schema_version = _require_int(raw["schema_version"], "schema_version")
    catalog_entry_count = _require_int(raw["catalog_entry_count"], "catalog_entry_count")
    source_fence = _require_int(raw["source_fence"], "source_fence")
    created_at = _require_str(raw["created_at"], "created_at")
    catalog_hash = _require_str(raw["catalog_hash"], "catalog_hash")
    if not isinstance(raw["catalog_entity_types"], list) or any(
        not isinstance(item, str) or not item for item in raw["catalog_entity_types"]
    ):
        raise ValueError("catalog entity types are invalid")
    meta = _require_mapping(raw["meta"], "meta")
    if set(meta) != {
        "schema_head",
        "active_session_coordination",
        "effort_projection",
    }:
        raise ValueError("Meta manifest keys are invalid")
    meta_head = _require_str(meta["schema_head"], "Meta schema head")
    coordination = _require_mapping(meta["active_session_coordination"], "active session coordination")
    effort = _require_mapping(meta["effort_projection"], "effort projection")
    if not isinstance(raw["spaces"], list) or not isinstance(raw["files"], list):
        raise ValueError("manifest collections are invalid")
    spaces: list[SpaceSnapshot] = []
    for item in raw["spaces"]:
        if not isinstance(item, dict) or set(item) != {
            "space_id",
            "space_head",
            "index_schema_version",
            "sync_waterline",
            "entity_counts",
            "note_hashes",
        }:
            raise ValueError("Space manifest keys are invalid")
        space_id = _require_str(item["space_id"], "space id")
        space_head = _require_str(item["space_head"], "space head")
        index_schema_version = _require_int(
            item["index_schema_version"], "index schema version"
        )
        sync_waterline = _require_str(item["sync_waterline"], "sync waterline", allow_empty=True)
        entity_counts = _require_mapping(item["entity_counts"], "entity counts")
        note_hashes = _require_mapping(item["note_hashes"], "note hashes")
        if any(type(value) is not int or value < 0 for value in entity_counts.values()):
            raise ValueError("entity counts are invalid")
        if any(not isinstance(value, str) for value in note_hashes.values()):
            raise ValueError("note hashes are invalid")
        spaces.append(
            SpaceSnapshot(
                space_id,
                space_head,
                index_schema_version,
                sync_waterline,
                entity_counts,
                note_hashes,
            )
        )
    files: list[SnapshotFile] = []
    for item in raw["files"]:
        if not isinstance(item, dict) or set(item) != {
            "relative_path",
            "size",
            "sha256",
            "kind",
        }:
            raise ValueError("file manifest keys are invalid")
        relative_path = validate_relative_path(item["relative_path"])
        size = _require_int(item["size"], "file size")
        sha256 = _require_str(item["sha256"], "file sha256")
        kind = _require_str(item["kind"], "file kind")
        files.append(SnapshotFile(relative_path, size, sha256, kind))
    return SnapshotManifest(
        schema_version=schema_version,
        created_at=created_at,
        source_fence=source_fence,
        catalog_hash=catalog_hash,
        catalog_entry_count=catalog_entry_count,
        catalog_entity_types=tuple(raw["catalog_entity_types"]),
        meta=MetaSnapshot(meta_head, coordination, effort),
        spaces=tuple(spaces),
        files=tuple(files),
    )


def canonical_json_from_raw(raw: dict[str, object]) -> bytes:
    return (
        json.dumps(raw, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"
    ).encode("utf-8")
