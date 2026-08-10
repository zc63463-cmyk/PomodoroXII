"""Immutable recovery snapshot contracts."""

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Mapping

_SHA256_RE = re.compile(r"[0-9a-f]{64}")
_SNAPSHOT_KINDS = frozenset({"meta_db", "space_db", "index_db", "note", "index_asset"})
_FORBIDDEN_IDENTIFIER_CHARS = frozenset("/\\:\x00")


class _FrozenDict(dict):
    """Immutable dict subclass that stays JSON-serializable.

    ``MappingProxyType`` is not JSON-serializable by the standard library and
    the manifest serializer only shallow-copies it, so nested frozen mappings
    break canonical serialization.  A dict subclass keeps ``json.dumps`` and
    ``isinstance(value, dict)`` working while blocking mutation at the Python
    level (the same guard-the-well-meaning-developer level as mappingproxy).
    """

    def __setitem__(self, key, value):  # type: ignore[override]
        raise TypeError("frozen mapping is immutable")

    def __delitem__(self, key) -> None:  # type: ignore[override]
        raise TypeError("frozen mapping is immutable")

    def clear(self) -> None:
        raise TypeError("frozen mapping is immutable")

    def pop(self, *args, **kwargs):
        raise TypeError("frozen mapping is immutable")

    def popitem(self):
        raise TypeError("frozen mapping is immutable")

    def setdefault(self, *args, **kwargs):
        raise TypeError("frozen mapping is immutable")

    def update(self, *args, **kwargs):  # type: ignore[override]
        raise TypeError("frozen mapping is immutable")

    def __ior__(self, other):
        raise TypeError("frozen mapping is immutable")


def _expected_kind_for_path(relative_path: str) -> str | None:
    """Map a canonical manifest path to the only kind that may claim it.

    ``None`` means the path is not owned by any registered location (it is
    rejected by inventory reconstruction instead).
    """
    if relative_path == "meta/meta.db":
        return "meta_db"
    if re.fullmatch(r"spaces/[^/]+/space\.db", relative_path):
        return "space_db"
    if re.fullmatch(r"spaces/[^/]+/index\.db", relative_path):
        return "index_db"
    if re.fullmatch(r"spaces/[^/]+/notes/.+", relative_path):
        return "note"
    if re.fullmatch(r"spaces/[^/]+/index/.+", relative_path):
        return "index_asset"
    return None


def _deep_freeze(value: object) -> object:
    """Recursively freeze mappings and sequences.

    Every level of a published contract is frozen so no part can be changed
    after construction.  Mappings become ``_FrozenDict`` (an immutable dict
    subclass) so the canonical serializer can still encode them.  Mappings are
    sorted by stringified key so equal receipts always compare equal
    regardless of insertion order.
    """
    if isinstance(value, Mapping):
        frozen = {
            str(key): _deep_freeze(item)
            for key, item in sorted(value.items(), key=lambda entry: str(entry[0]))
        }
        return _FrozenDict(frozen)
    if isinstance(value, (tuple, list)):
        return tuple(_deep_freeze(item) for item in value)
    if isinstance(value, (set, frozenset)):
        return frozenset(_deep_freeze(item) for item in value)
    return value


def _validated_int(value: object, name: str, *, minimum: int = 0) -> int:
    if type(value) is not int:  # ``bool`` is an ``int`` subclass and must be rejected.
        raise ValueError(f"{name} must be an integer")
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return value


@dataclass(frozen=True, slots=True)
class MetaSnapshot:
    schema_head: str
    active_session_coordination: object
    effort_projection: object

    def __post_init__(self) -> None:
        if not isinstance(self.schema_head, str) or not self.schema_head:
            raise ValueError("Meta schema head is invalid")
        for name in ("active_session_coordination", "effort_projection"):
            value = getattr(self, name)
            if not isinstance(value, Mapping):
                raise ValueError(f"{name} must be a mapping")
            object.__setattr__(self, name, _deep_freeze(value))


@dataclass(frozen=True, slots=True)
class SnapshotFile:
    relative_path: str
    size: int
    sha256: str
    kind: Literal["meta_db", "space_db", "index_db", "note", "index_asset"]

    def __post_init__(self) -> None:
        if (
            not isinstance(self.relative_path, str)
            or not self.relative_path
            or type(self.size) is not int
            or self.size < 0
            or not isinstance(self.sha256, str)
            or _SHA256_RE.fullmatch(self.sha256) is None
            or self.kind not in _SNAPSHOT_KINDS
        ):
            raise ValueError("snapshot file metadata is invalid")


@dataclass(frozen=True, slots=True)
class SpaceSnapshot:
    space_id: str
    space_head: str
    index_schema_version: int
    sync_waterline: str
    entity_counts: Mapping[str, int]
    note_hashes: Mapping[str, str]

    def __post_init__(self) -> None:
        if (
            not isinstance(self.space_id, str)
            or not self.space_id
            or _FORBIDDEN_IDENTIFIER_CHARS.intersection(self.space_id)
            or self.space_id in {".", ".."}
        ):
            raise ValueError("Space id is invalid")
        if not isinstance(self.space_head, str) or not self.space_head:
            raise ValueError("Space head is invalid")
        object.__setattr__(
            self, "index_schema_version", _validated_int(self.index_schema_version, "index schema version")
        )
        if not isinstance(self.sync_waterline, str):
            raise ValueError("sync waterline must be a string")
        object.__setattr__(
            self,
            "entity_counts",
            _deep_freeze(_validated_count_mapping(self.entity_counts, int, "entity count")),
        )
        object.__setattr__(
            self,
            "note_hashes",
            _deep_freeze(_validated_count_mapping(self.note_hashes, str, "note hash")),
        )


def _validated_count_mapping(
    value: object, item_type: type, label: str
) -> dict[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError("Space snapshot requires a mapping")
    result: dict[str, object] = {}
    for key, item in value.items():
        if not isinstance(key, str) or not key:
            raise ValueError(f"{label} key must be a non-empty string")
        if item_type is int:
            _validated_int(item, f"{label} value")
        elif not isinstance(item, str):
            raise ValueError(f"{label} value must be a string")
        result[key] = item
    return result


@dataclass(frozen=True, slots=True)
class SnapshotManifest:
    schema_version: Literal[1]
    created_at: str
    source_fence: int
    catalog_hash: str
    catalog_entry_count: Literal[31]
    catalog_entity_types: tuple[str, ...]
    meta: MetaSnapshot
    spaces: tuple[SpaceSnapshot, ...]
    files: tuple[SnapshotFile, ...]

    def __post_init__(self) -> None:
        if (
            type(self.schema_version) is not int
            or self.schema_version != 1
            or type(self.catalog_entry_count) is not int
            or self.catalog_entry_count != 31
        ):
            raise ValueError("unsupported snapshot manifest")
        object.__setattr__(self, "source_fence", _validated_int(self.source_fence, "source fence"))
        if (
            not isinstance(self.created_at, str)
            or not self.created_at
            or not isinstance(self.catalog_hash, str)
            or _SHA256_RE.fullmatch(self.catalog_hash) is None
        ):
            raise ValueError("snapshot manifest metadata is invalid")
        if not isinstance(self.catalog_entity_types, tuple) or any(
            not isinstance(item, str) or not item for item in self.catalog_entity_types
        ):
            raise ValueError("catalog entity types are invalid")
        if not isinstance(self.spaces, tuple) or any(
            not isinstance(item, SpaceSnapshot) for item in self.spaces
        ):
            raise ValueError("spaces must be a tuple of Space snapshots")
        if not isinstance(self.files, tuple) or any(
            not isinstance(item, SnapshotFile) for item in self.files
        ):
            raise ValueError("files must be a tuple of file snapshots")
        if len({item.space_id for item in self.spaces}) != len(self.spaces):
            raise ValueError("duplicate Space ids")
        if len({item.relative_path for item in self.files}) != len(self.files):
            raise ValueError("duplicate file paths")
        for item in self.files:
            expected_kind = _expected_kind_for_path(item.relative_path)
            if expected_kind is not None and item.kind != expected_kind:
                raise ValueError(
                    f"file kind does not match its path: {item.relative_path}"
                )


@dataclass(frozen=True, slots=True)
class PublishedSnapshotReceipt:
    root: Path
    manifest: SnapshotManifest
    manifest_sha256: str

    def __post_init__(self) -> None:
        if not self.root.is_absolute() or not self.root.is_dir():
            raise ValueError("published snapshot root must be an existing absolute directory")
        if not isinstance(self.manifest_sha256, str) or _SHA256_RE.fullmatch(
            self.manifest_sha256
        ) is None:
            raise ValueError("published manifest SHA-256 is invalid")


@dataclass(frozen=True, slots=True)
class VerificationResult:
    valid: bool
    manifest_sha256: str
    manifest: SnapshotManifest | None
    checked_files: int
    checked_spaces: int
    failures: tuple[str, ...]

    def __post_init__(self) -> None:
        if self.valid and (self.manifest is None or self.failures):
            raise ValueError("valid verification requires a manifest and zero failures")
        if not self.valid and not self.failures:
            raise ValueError("invalid verification requires at least one failure")


@dataclass(frozen=True, slots=True)
class StagedRestore:
    """Immutable receipt of a verified restore into a unique staging root.

    Every value is derived from the verified manifest, the real staged tree,
    and coordinator configuration.  No caller-supplied hash, catalog, or fence
    is ever trusted: ``restore_to_staging`` re-verifies the snapshot from disk
    and recomputes ``staged_tree_sha256`` over the actual staged files before
    this receipt is constructed.  All paths are normalized absolute paths,
    hashes are 64-char lowercase hex, and ``source_fence`` is a non-bool
    positive integer.
    """

    snapshot_root: Path
    root: Path
    target_active_root: Path
    manifest_sha256: str
    staged_tree_sha256: str
    catalog_hash: str
    source_fence: int
    manifest: SnapshotManifest
    verification: VerificationResult

    def __post_init__(self) -> None:
        for name in ("snapshot_root", "root", "target_active_root"):
            path = Path(getattr(self, name)).expanduser().resolve()
            object.__setattr__(self, name, path)
        if not self.root.is_dir():
            raise ValueError("staged root must be an existing directory")
        for name in ("manifest_sha256", "staged_tree_sha256", "catalog_hash"):
            value = getattr(self, name)
            if not isinstance(value, str) or _SHA256_RE.fullmatch(value) is None:
                raise ValueError(f"{name} must be a 64-char lowercase hex digest")
        object.__setattr__(
            self,
            "source_fence",
            _validated_int(self.source_fence, "source fence", minimum=1),
        )
        if not isinstance(self.manifest, SnapshotManifest):
            raise ValueError("staged restore requires a SnapshotManifest")
        if not isinstance(self.verification, VerificationResult):
            raise ValueError("staged restore requires a VerificationResult")
        if self.manifest_sha256 != self.verification.manifest_sha256:
            raise ValueError("staged restore manifest hash disagrees with verification")
        if (
            self.catalog_hash != self.manifest.catalog_hash
            or self.source_fence != self.manifest.source_fence
        ):
            raise ValueError("staged restore catalog/fence disagree with the manifest")
