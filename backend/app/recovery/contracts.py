"""Immutable recovery snapshot contracts."""

from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Mapping
import re


@dataclass(frozen=True, slots=True)
class MetaSnapshot:
    schema_head: str
    active_session_coordination: object
    effort_projection: object


@dataclass(frozen=True, slots=True)
class SnapshotFile:
    relative_path: str
    size: int
    sha256: str
    kind: Literal["meta_db", "space_db", "index_db", "note", "index_asset"]

    def __post_init__(self) -> None:
        if self.size < 0 or not re.fullmatch(r"[0-9a-f]{64}", self.sha256):
            raise ValueError("snapshot file metadata is invalid")


@dataclass(frozen=True, slots=True)
class SpaceSnapshot:
    space_id: str
    space_head: str
    index_schema_version: int
    sync_waterline: str
    entity_counts: Mapping[str, int]
    note_hashes: Mapping[str, str]


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
        if self.schema_version != 1 or self.catalog_entry_count != 31:
            raise ValueError("unsupported snapshot manifest")
        if self.source_fence < 0 or not re.fullmatch(r"[0-9a-f]{64}", self.catalog_hash):
            raise ValueError("snapshot manifest metadata is invalid")


@dataclass(frozen=True, slots=True)
class PublishedSnapshotReceipt:
    root: Path
    manifest: SnapshotManifest
    manifest_sha256: str

    def __post_init__(self) -> None:
        if not self.root.is_absolute() or not self.root.is_dir():
            raise ValueError("published snapshot root must be an existing absolute directory")
        if not re.fullmatch(r"[0-9a-f]{64}", self.manifest_sha256):
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
