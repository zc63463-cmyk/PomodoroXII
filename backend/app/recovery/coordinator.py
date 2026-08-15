"""Coordinate a complete snapshot under one global exclusive lease."""

import asyncio
import ctypes
import hashlib
import hmac
import inspect
import json
import os
import shutil
import sqlite3
import stat
import sys
import tempfile
import uuid
from contextlib import closing
from dataclasses import asdict, dataclass, is_dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from types import MappingProxyType, SimpleNamespace
from typing import BinaryIO

import portalocker

from app.focus_session.recovery_authority import (
    ActiveSessionCoordinationInspector as TS2ActiveSessionCoordinationInspector,
)

from .contracts import (
    CutoverResult,
    MetaSnapshot,
    PublishedSnapshotReceipt,
    SnapshotFile,
    SnapshotManifest,
    SpaceSnapshot,
    StagedRestore,
    VerificationResult,
)
from .manifest import canonical_json, parse_manifest, validate_relative_path
from .sqlite_copy import backup_sqlite, fsync_directory, fsync_file, sha256_file


@dataclass(frozen=True, slots=True)
class _RollbackProof:
    snapshot: PublishedSnapshotReceipt
    active_tree_sha256: str


@dataclass(frozen=True, slots=True)
class _StagingProof:
    proof_id: str
    snapshot_root: Path
    staging_root: Path
    manifest_sha256: str
    target_active_root: Path
    source_fence: int
    catalog_hash: str
    staged_tree_sha256: str
    manifest: SnapshotManifest | None = None


# Persistent staging-proof authentication.  A staging proof is an admission
# token persisted outside staging so a fresh coordinator can prove a prior
# restore.  An unauthenticated token would let a local attacker rewrite the
# proof fields and the staging content together, making every hash, source
# re-derivation and receipt cross-check pass on forged data.  The proof is
# therefore authenticated with an application-level secret (``secret_key``)
# through a domain-separated HMAC-SHA-256 over the canonical JSON of every
# persistent field.
_STAGING_PROOF_DOMAIN = "pomodoroxii.recovery.staging-proof"
_STAGING_PROOF_VERSION = 1
_STAGING_PROOF_FIELDS = (
    "proof_id",
    "snapshot_root",
    "staging_root",
    "manifest_sha256",
    "target_active_root",
    "source_fence",
    "catalog_hash",
    "staged_tree_sha256",
    "domain",
    "version",
)


def _staging_proof_secret() -> str:
    """Return the stable application-level proof secret, failing closed.

    The secret comes from the application configuration only.  It is never
    derived from the receipt, a path, staging content, the proof id, or any
    caller-supplied argument, and callers cannot inject an arbitrary secret.
    """
    try:
        from app.settings import settings

        secret = getattr(settings, "secret_key", None)
    except Exception:
        secret = None
    if not isinstance(secret, str) or not secret:
        raise DomainFailure("cutover_stale", "staging proof secret is unavailable")
    return secret


def _staging_proof_key(secret: str) -> bytes:
    """Domain-separated key derivation so one secret serves many protocols."""
    return hmac.new(
        secret.encode("utf-8"), _STAGING_PROOF_DOMAIN.encode("utf-8"), hashlib.sha256
    ).digest()


def _proof_mac_payload(fields: dict[str, object]) -> bytes:
    """Canonical JSON over the persistent proof fields (MAC never included).

    Key order is fixed by ``sort_keys``, separators and encoding are fixed, and
    the result is the unique byte representation the MAC covers.  The MAC field
    itself is never part of the payload.
    """
    return (
        json.dumps(fields, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        + "\n"
    ).encode("utf-8")


def _compute_proof_mac(secret: str, fields: dict[str, object]) -> str:
    payload = _proof_mac_payload(fields)
    return hmac.new(_staging_proof_key(secret), payload, hashlib.sha256).hexdigest()


def _reject_duplicate_json_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _parse_canonical_proof(raw_bytes: bytes) -> dict[str, object]:
    """Parse a proof document strictly; any non-canonical form is rejected.

    The document must be exactly the canonical serialization (sorted keys,
    compact separators, no whitespace, no duplicate keys, exact key set) so the
    bytes the MAC covers are the bytes that were verified.
    """
    try:
        raw = json.loads(raw_bytes, object_pairs_hook=_reject_duplicate_json_keys)
    except (ValueError, UnicodeDecodeError) as exc:
        raise DomainFailure("cutover_stale", "staging proof is not valid JSON") from exc
    if not isinstance(raw, dict):
        raise DomainFailure("cutover_stale", "staging proof is not a JSON object")
    canonical = _proof_mac_payload(raw)
    if raw_bytes != canonical:
        raise DomainFailure("cutover_stale", "staging proof is not canonical JSON")
    if set(raw) != set(_STAGING_PROOF_FIELDS) | {"proof_mac"}:
        raise DomainFailure("cutover_stale", "staging proof has an invalid shape")
    if (
        raw["domain"] != _STAGING_PROOF_DOMAIN
        or type(raw["version"]) is not int
        or raw["version"] != _STAGING_PROOF_VERSION
    ):
        raise DomainFailure("cutover_stale", "staging proof domain/version is invalid")
    mac = raw["proof_mac"]
    if not isinstance(mac, str) or len(mac) != 64 or any(
        character not in "0123456789abcdef" for character in mac
    ):
        raise DomainFailure("cutover_stale", "staging proof MAC is invalid")
    secret = _staging_proof_secret()
    fields = {key: raw[key] for key in _STAGING_PROOF_FIELDS}
    expected = _compute_proof_mac(secret, fields)
    if not hmac.compare_digest(expected, mac):
        raise DomainFailure("cutover_stale", "staging proof MAC verification failed")
    return raw


@dataclass(slots=True)
class _CancellationDeferral:
    """Remember task cancellation until destructive cleanup reaches a terminal state."""

    error: BaseException | None = None

    def record(self, error: BaseException) -> None:
        if self.error is None:
            self.error = error


@dataclass(slots=True)
class _PublicationLock:
    path: Path
    _stream: BinaryIO
    released: bool = False

    def release(self) -> None:
        if self.released:
            return
        # Never unlink ``path`` here. A persistent coordination filename means
        # an old holder can only unlock the file descriptor it acquired; it
        # cannot delete a later holder's replacement pathname in an ABA race.
        try:
            portalocker.unlock(self._stream)
        finally:
            self._stream.close()
        self.released = True


class DomainFailure(RuntimeError):
    def __init__(self, code: str, message: str = "") -> None:
        self.record = type("FailureRecord", (), {"code": code})()
        super().__init__(message or code)


# Old Task/Session catalog type names that S5 must keep rejecting.  They are
# negative evidence only: snapshot/verify consume this closed set to prove the
# catalog is not a legacy catalog.  The production-reference gate allows this
# definition and rejections that reference it; any other use of these names
# remains forbidden.
FORBIDDEN_LEGACY_CATALOG_TYPES = frozenset(
    {"task", "session", "taskQuickNote", "sessionQuickNote"}
)


def _is_link_or_reparse(path: Path) -> bool:
    """Detect symlinks and Windows reparse points (including junctions).

    The check intentionally uses ``lstat`` only. Calling ``resolve`` would
    traverse a junction before the caller gets a chance to reject it.
    """
    try:
        status = os.lstat(path)
    except FileNotFoundError:
        return False
    except OSError:
        return True
    if stat.S_ISLNK(status.st_mode):
        return True
    if os.name == "nt":
        attributes = getattr(status, "st_file_attributes", 0)
        return bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)
    return False


class _UnsafeTreeEntryError(RuntimeError):
    pass


def _scan_regular_tree(root: Path) -> tuple[tuple[Path, ...], tuple[Path, ...]]:
    """Return regular files/directories without following any link or reparse point."""
    root = Path(root).absolute()
    if _is_link_or_reparse(root) or not root.is_dir():
        raise _UnsafeTreeEntryError(f"unsafe tree root: {root}")
    files: list[Path] = []
    directories: list[Path] = [root]
    pending = [root]
    while pending:
        directory = pending.pop()
        try:
            with os.scandir(directory) as iterator:
                entries = sorted(iterator, key=lambda entry: os.fsencode(entry.name))
        except OSError as exc:
            raise _UnsafeTreeEntryError(f"cannot enumerate tree: {directory}") from exc
        for entry in entries:
            path = Path(entry.path)
            if _is_link_or_reparse(path):
                raise _UnsafeTreeEntryError(f"tree entry is a link or reparse point: {path}")
            try:
                mode = entry.stat(follow_symlinks=False).st_mode
            except OSError as exc:
                raise _UnsafeTreeEntryError(f"cannot stat tree entry: {path}") from exc
            if stat.S_ISDIR(mode):
                directories.append(path)
                pending.append(path)
            elif stat.S_ISREG(mode):
                files.append(path)
            else:
                raise _UnsafeTreeEntryError(f"tree entry is not regular: {path}")
    return tuple(files), tuple(directories)


def _open_sqlite_read_only(path: Path) -> sqlite3.Connection:
    database = Path(path).expanduser()
    if _is_link_or_reparse(database):
        raise DomainFailure(
            "snapshot_invalid", f"read-only SQLite path is a link or reparse point: {database}"
        )
    database = database.resolve()
    if _is_link_or_reparse(database):
        raise DomainFailure(
            "snapshot_invalid", f"read-only SQLite path resolved to a link: {database}"
        )
    uri = f"{database.as_uri()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    try:
        connection.execute("PRAGMA query_only=ON")
    except BaseException:
        connection.close()
        raise
    return connection


class ActiveSessionCoordinationInspector:
    """Adapt the TS2 decision contract to S5's fail-closed boundary.

    TS2 deliberately returns a frozen recovery decision for damaged evidence.
    S5 snapshot orchestration exposes failures as ``DomainFailure`` and stores
    the complete successful decision in the manifest for later comparison.
    """

    def __init__(self, *, now: datetime | None = None) -> None:
        self._authority = TS2ActiveSessionCoordinationInspector(now=now)

    async def inspect_read_only(self, view, *, space_views=None) -> dict[str, object]:
        decision = await self._authority.inspect_read_only(
            view,
            space_views=space_views,
        )
        if decision.result != "clean_or_recoverable":
            structural = {
                "invalid_meta_view",
                "meta_db_unreadable",
                "missing_coordination_schema",
                "multiple_locators",
                "invalid_locator",
                "operation_missing",
                "invalid_operation",
                "intent_invalid",
                "state_phase_inconsistent",
                "manual_intervention",
                "lease_expired",
                "relation_missing",
                "relation_invalid",
                "relation_cycle",
                "authority_internal_error",
            }
            if decision.failure_code in structural:
                raise DomainFailure(
                    "snapshot_invalid",
                    decision.reason or decision.failure_code or "invalid active session evidence",
                )
            if not space_views:
                raise DomainFailure(
                    "recovery_inspector_unavailable:active_session_authority",
                    decision.reason or "active session Space authority is unavailable",
                )
            raise DomainFailure(
                "active_session_recovery_required",
                decision.reason or decision.failure_code or "active session recovery required",
            )
        return decision.to_wire()


class RecoveryCoordinator:
    CUTOVER_LEASE_TIMEOUT_SECONDS = 60.0

    def __init__(
        self,
        *,
        lease_coordinator=None,
        source_root: Path | None = None,
        active_root: Path | None = None,
        catalog=None,
        meta=None,
        spaces=None,
        index_schema=None,
        active_coordination_inspector=None,
        effort_projection_compiler=None,
        recovery_view_factory=None,
        migration_coordinator=None,
        knowledge_checker=None,
        mutation_recovery_inspector=None,
        failpoint=None,
        **_unused,
    ) -> None:
        self.lease_coordinator = lease_coordinator
        self.source_root = Path(
            source_root or getattr(meta, "root", ".")
        ).expanduser().absolute()
        active_root_input = Path(active_root or self.source_root).expanduser().absolute()
        if _is_link_or_reparse(active_root_input):
            raise DomainFailure("snapshot_invalid", "active root may not be a symlink or reparse point")
        self.active_root = active_root_input
        self.catalog = catalog
        self.meta = meta
        self.spaces = spaces
        self.index_schema = index_schema
        self.active_coordination_inspector = (
            active_coordination_inspector
            if active_coordination_inspector is not None
            else ActiveSessionCoordinationInspector()
        )
        self.effort_projection_compiler = effort_projection_compiler
        self.recovery_view_factory = recovery_view_factory
        self.migration_coordinator = migration_coordinator
        self.knowledge_checker = knowledge_checker
        self.mutation_recovery_inspector = mutation_recovery_inspector
        self.failpoint = failpoint or (lambda _name: None)
        # Staging proof receipts live under the stable active-root parent, not
        # in process memory or the mutable staging tree. This lets a fresh
        # coordinator prove a prior restore while preserving exact lexical
        # root binding for the eventual no-replace rename.

    def _proof_directory(self, *, create: bool) -> Path:
        parent = self.active_root.parent.absolute()
        if _is_link_or_reparse(parent):
            raise DomainFailure(
                "restore_target_invalid",
                "staging proof parent is a symlink or reparse point",
            )
        directory = parent / f".{self.active_root.name}.recovery-proofs"
        if _is_link_or_reparse(directory):
            raise DomainFailure(
                "restore_target_invalid",
                "staging proof directory is a symlink or reparse point",
            )
        if create:
            directory.mkdir(parents=True, exist_ok=True)
        elif not directory.is_dir():
            raise DomainFailure("cutover_stale", "staging proof directory is unavailable")
        if _is_link_or_reparse(directory) or not directory.is_dir():
            code = "restore_target_invalid" if create else "cutover_stale"
            raise DomainFailure(code, "staging proof directory is invalid")
        return directory

    def _proof_path(self, proof_id: str, *, create_directory: bool = False) -> Path:
        if not isinstance(proof_id, str) or len(proof_id) != 32:
            raise DomainFailure("cutover_stale", "staging proof id is invalid")
        return self._proof_directory(create=create_directory) / f"{proof_id}.json"

    @staticmethod
    def _absolute_path_text(path: Path) -> str:
        return os.path.normcase(os.path.abspath(os.fspath(path)))

    async def snapshot(self, target: Path) -> PublishedSnapshotReceipt:
        target = Path(target).expanduser()
        self._reject_symlink_path(target)
        target = target.resolve()
        if self.active_root == target or self.active_root in target.parents:
            raise DomainFailure("snapshot_invalid", "target is inside active root")
        if self.lease_coordinator is None:
            raise DomainFailure("snapshot_invalid", "global exclusive lease is required")
        from app.runtime.leases import LeaseMode

        lease = await self.lease_coordinator.acquire_global(
            LeaseMode.EXCLUSIVE, "recovery snapshot", 60.0
        )
        try:
            target.mkdir(parents=True, exist_ok=True)
            return await self._snapshot_under_lease(target, lease)
        finally:
            await lease.release()

    async def _snapshot_under_lease(self, target: Path, lease) -> PublishedSnapshotReceipt:
        if lease is None:
            raise DomainFailure("snapshot_invalid", "global exclusive lease is required")
        from app.runtime.leases import LeaseMode

        lease.assert_active_owner(mode=LeaseMode.EXCLUSIVE, scope="global")
        temporary = target / f".{uuid.uuid4().hex}.tmp"
        final: Path | None = None
        temporary.mkdir(parents=True)
        try:
            files: list[SnapshotFile] = []
            spaces = self._registered_spaces()
            for source, relative, kind in self._database_sources(spaces):
                destination = temporary / relative
                result = backup_sqlite(source, destination, read_only_source=True)
                files.append(SnapshotFile(relative, result.size, result.sha256, kind))
                self.failpoint(f"database_copy:{relative}")
            for source, relative, kind in self._asset_sources(spaces):
                source = Path(source)
                if source.is_symlink() or not source.is_file():
                    raise DomainFailure("snapshot_invalid", f"invalid asset {source}")
                destination = temporary / validate_relative_path(relative)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, destination)
                fsync_file(destination)
                files.append(
                    SnapshotFile(
                        destination.relative_to(temporary).as_posix(),
                        destination.stat().st_size,
                        sha256_file(destination),
                        kind,
                    )
                )
                self.failpoint(f"asset_copy:{relative}")
            manifest = await self._build_manifest(files, lease, spaces, temporary)
            required = {"meta/meta.db"}
            for space in spaces:
                sid = space.space_id
                required.update({f"spaces/{sid}/space.db", f"spaces/{sid}/index.db"})
            if not required.issubset({item.relative_path for item in files}):
                raise DomainFailure("snapshot_invalid", "snapshot inventory is incomplete")
            payload = canonical_json(manifest)
            published_manifest = parse_manifest(payload)
            (temporary / "manifest.json").write_bytes(payload)
            fsync_file(temporary / "manifest.json")
            digest = sha256_file(temporary / "manifest.json")
            (temporary / "manifest.sha256").write_text(digest + "\n", encoding="ascii")
            self.failpoint("manifest_write")
            fsync_file(temporary / "manifest.sha256")
            fsync_directory(temporary)
            self.failpoint("fsync")
            lease.assert_fence("global")
            final = (
                target
                / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{manifest.catalog_hash[:12]}"
            )
            if final.exists():
                raise DomainFailure("snapshot_invalid", "snapshot publication already exists")
            os.replace(temporary, final)
            self.failpoint("atomic_publish")
            fsync_directory(target)
            return PublishedSnapshotReceipt(final.resolve(), published_manifest, digest)
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            if final is not None:
                shutil.rmtree(final, ignore_errors=True)
                if target.is_dir():
                    fsync_directory(target)
            raise

    def _meta_db_path(self) -> Path:
        meta_db = (
            getattr(self.meta, "db_path", None)
            or getattr(self.meta, "path", None)
            or self.source_root / "meta.db"
        )
        if _is_link_or_reparse(Path(meta_db)) or not Path(meta_db).is_file():
            raise DomainFailure("snapshot_invalid", "meta database is missing or symlinked")
        self._assert_source_path(meta_db)
        return Path(meta_db)

    def _registered_spaces(self) -> tuple[SimpleNamespace, ...]:
        meta_db = self._meta_db_path()
        with closing(_open_sqlite_read_only(meta_db)) as connection:
            try:
                rows = connection.execute(
                    "SELECT id, db_path, notes_dir FROM spaces ORDER BY id"
                ).fetchall()
            except sqlite3.DatabaseError as exc:
                raise DomainFailure(
                    "snapshot_invalid", "Meta Space registry is unavailable"
                ) from exc
        spaces: list[SimpleNamespace] = []
        for space_id, db_path, notes_dir in rows:
            relative = validate_relative_path(f"spaces/{space_id}")
            canonical_root = self.active_root / relative
            self._assert_regular_source_ancestor(canonical_root, self.active_root)
            root = canonical_root.resolve()
            expected_db = (root / "space.db").resolve()
            expected_notes = (root / "notes").resolve()
            registered_db = Path(db_path).expanduser().absolute()
            registered_notes = Path(notes_dir).expanduser().absolute()
            if _is_link_or_reparse(registered_db) or registered_db != expected_db:
                raise DomainFailure("snapshot_invalid", f"noncanonical Space DB path: {space_id}")
            if _is_link_or_reparse(registered_notes) or registered_notes != expected_notes:
                raise DomainFailure("snapshot_invalid", f"noncanonical Notes path: {space_id}")
            spaces.append(
                SimpleNamespace(
                    space_id=str(space_id),
                    root=root,
                    db_path=expected_db,
                    index_db_path=root / "index.db",
                )
            )
        injected = self.spaces.values() if isinstance(self.spaces, dict) else (self.spaces or ())
        injected_ids = {
            str(getattr(space, "space_id", getattr(space, "id", ""))) for space in injected
        }
        registered_ids = {space.space_id for space in spaces}
        if injected_ids and injected_ids != registered_ids:
            raise DomainFailure("snapshot_invalid", "injected Spaces do not match Meta registry")
        return tuple(spaces)

    def _database_sources(self, spaces):
        meta_db = self._meta_db_path()
        yield meta_db, "meta/meta.db", "meta_db"
        for space in spaces:
            sid = space.space_id
            db = space.db_path
            idx = space.index_db_path
            validate_relative_path(f"spaces/{sid}")
            self._assert_source_path(db)
            self._assert_source_path(idx)
            if not Path(db).is_file() or _is_link_or_reparse(Path(db)):
                raise DomainFailure("snapshot_invalid", f"space database missing: {sid}")
            if not Path(idx).is_file() or _is_link_or_reparse(Path(idx)):
                raise DomainFailure("snapshot_invalid", f"index database missing: {sid}")
            yield db, f"spaces/{sid}/space.db", "space_db"
            yield idx, f"spaces/{sid}/index.db", "index_db"

    def _assert_source_path(self, source: Path) -> None:
        path = Path(source).expanduser()
        if _is_link_or_reparse(path) or not path.is_file():
            raise DomainFailure("snapshot_invalid", f"invalid source path: {path}")
        try:
            path.resolve().relative_to(self.active_root)
        except ValueError as exc:
            raise DomainFailure("snapshot_invalid", f"source escapes active root: {path}") from exc
        self._assert_regular_source_ancestor(path, self.active_root)

    @staticmethod
    def _assert_regular_source_ancestor(path: Path, root: Path) -> None:
        """Reject every symlink or reparse segment without resolving through it."""
        candidate = Path(path).absolute()
        boundary = Path(root).absolute()
        try:
            relative = candidate.relative_to(boundary)
        except ValueError as exc:
            raise DomainFailure(
                "snapshot_invalid", f"source escapes active root: {candidate}"
            ) from exc
        current = boundary
        if _is_link_or_reparse(current):
            raise DomainFailure("snapshot_invalid", f"symlinked source root: {boundary}")
        for segment in relative.parts:
            current = current / segment
            if _is_link_or_reparse(current):
                raise DomainFailure(
                    "snapshot_invalid", f"symlinked source ancestor: {current}"
                )

    @staticmethod
    def _reject_symlink_path(path: Path) -> None:
        candidate = Path(path).absolute()
        for item in (candidate, *candidate.parents):
            if _is_link_or_reparse(item):
                raise DomainFailure("snapshot_invalid", f"symlinked path is forbidden: {item}")

    def _asset_sources(self, spaces):
        for space in spaces:
            sid = space.space_id
            root = space.root
            for base, kind in ((root / "notes", "note"), (root / "index", "index_asset")):
                if kind == "index_asset" and not base.exists():
                    continue
                if _is_link_or_reparse(base) or not base.is_dir():
                    raise DomainFailure("snapshot_invalid", f"invalid asset directory: {base}")
                try:
                    files, _directories = _scan_regular_tree(base)
                except _UnsafeTreeEntryError as exc:
                    raise DomainFailure(
                        "snapshot_invalid", f"invalid asset directory: {base}"
                    ) from exc
                for source in files:
                    self._assert_regular_source_ancestor(source, root)
                    relative = source.relative_to(root)
                    yield source, f"spaces/{sid}/{relative.as_posix()}", kind

    async def _build_manifest(self, files, lease, spaces, snapshot_root: Path) -> SnapshotManifest:
        catalog_hash = str(getattr(self.catalog, "hash", "0" * 64))
        if len(catalog_hash) != 64 or any(c not in "0123456789abcdef" for c in catalog_hash):
            raise DomainFailure("snapshot_invalid", "catalog hash is invalid")
        types = tuple(
            sorted(
                getattr(spec, "effective_sync_entity_type", getattr(spec, "name", ""))
                for spec in (
                    self.catalog.list() if self.catalog and hasattr(self.catalog, "list") else ()
                )
            )
        )
        if len(types) != 31 or FORBIDDEN_LEGACY_CATALOG_TYPES & set(
            types
        ):
            raise DomainFailure("snapshot_invalid", "catalog is not the S5 catalog")
        entry_count = 31
        if self.recovery_view_factory is None:
            raise DomainFailure("snapshot_invalid", "recovery view factory is unavailable")
        try:
            space_views = {
                space.space_id: self.recovery_view_factory("space", space.root)
                for space in spaces
            }
            coordination = await self._inspect_async(
                self.active_coordination_inspector,
                self.recovery_view_factory("meta", self._meta_db_path()),
                "inspect_read_only",
                space_views=space_views,
            )
        except DomainFailure as exc:
            if exc.record.code == "snapshot_invalid" or exc.record.code.startswith(
                "recovery_inspector_unavailable:"
            ):
                raise DomainFailure(
                    "active_session_recovery_required", str(exc)
                ) from exc
            raise
        if coordination is None:
            raise DomainFailure("snapshot_invalid", "active coordination inspector is unavailable")
        coordination = self._normalize_receipt(coordination)
        if coordination.get("result") != "clean_or_recoverable":
            raise DomainFailure("active_session_recovery_required")
        effort = None
        if self.effort_projection_compiler is not None:
            mismatches: list[object] = []
            for space in spaces:
                view = self.recovery_view_factory("space", space.root)
                result = await self._inspect_async(
                    self.effort_projection_compiler,
                    view,
                    "verify_all",
                )
                if result is None:
                    raise DomainFailure(
                        "snapshot_invalid", "effort projection verifier is unavailable"
                    )
                mismatches.extend(result)
            effort = tuple(mismatches)
        if effort is None:
            raise DomainFailure("snapshot_invalid", "effort projection verifier is unavailable")
        if isinstance(effort, tuple):
            if effort:
                raise DomainFailure("snapshot_invalid", "effort projection drift")
            effort = {"result": "verified"}
        effort = self._normalize_receipt(effort)
        if effort.get("result") != "verified":
            raise DomainFailure("snapshot_invalid", "effort projection drift")
        space_records = tuple(
            sorted(
                (self._inspect_space_snapshot(snapshot_root, space.space_id) for space in spaces),
                key=lambda item: item.space_id,
            )
        )
        meta = MetaSnapshot(
            self._schema_head(snapshot_root / "meta" / "meta.db", "meta"),
            coordination,
            effort,
        )
        return SnapshotManifest(
            1,
            datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            int(getattr(lease, "fence", 0)),
            catalog_hash,
            entry_count,
            types,
            meta,
            space_records,
            tuple(sorted(files, key=lambda item: item.relative_path)),
        )

    @staticmethod
    def _inspect(owner, name: str, default):
        if owner is None:
            return default
        value = getattr(owner, name, default)
        return value() if callable(value) else value

    @staticmethod
    async def _inspect_async(owner, argument, method_name: str, **kwargs):
        if owner is None:
            return None
        method = getattr(owner, method_name, None)
        if method is None:
            return None
        value = method(argument, **kwargs)
        if inspect.isawaitable(value):
            value = await value
        return value

    @staticmethod
    def _normalize_receipt(value) -> dict[str, object]:
        if value is None:
            raise DomainFailure("snapshot_invalid", "required recovery inspector is unavailable")
        if is_dataclass(value):
            value = asdict(value)
        elif isinstance(value, MappingProxyType):
            value = dict(value)
        if not isinstance(value, dict):
            raise DomainFailure("snapshot_invalid", "recovery inspector receipt is invalid")
        return dict(value)

    @staticmethod
    def _schema_head(path: Path, kind: str) -> str:
        version_table = {
            "meta": "alembic_version_meta",
            "space": "alembic_version_space",
        }.get(kind)
        if version_table is None:
            raise DomainFailure("snapshot_invalid", "unknown database kind")
        with closing(_open_sqlite_read_only(path)) as connection:
            try:
                row = connection.execute(f'SELECT version_num FROM "{version_table}"').fetchone()
            except sqlite3.DatabaseError as exc:
                raise DomainFailure(
                    "snapshot_invalid", f"schema head is unavailable: {path.name}"
                ) from exc
        if row is None or not isinstance(row[0], str) or not row[0]:
            raise DomainFailure("snapshot_invalid", f"schema head is unavailable: {path.name}")
        return row[0]

    def _inspect_space_snapshot(self, snapshot_root: Path, space_id: str) -> SpaceSnapshot:
        space_root = snapshot_root / "spaces" / space_id
        space_db = space_root / "space.db"
        index_db = space_root / "index.db"
        entity_counts: dict[str, int] = {}
        waterlines: list[str] = []
        with closing(_open_sqlite_read_only(space_db)) as connection:
            tables = [
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )
            ]
            for table in sorted(tables):
                quoted = table.replace('"', '""')
                entity_counts[table] = int(
                    connection.execute(f'SELECT COUNT(*) FROM "{quoted}"').fetchone()[0]
                )
                columns = {row[1] for row in connection.execute(f'PRAGMA table_info("{quoted}")')}
                if "updated_at" in columns:
                    row = connection.execute(f'SELECT MAX(updated_at) FROM "{quoted}"').fetchone()
                    if row and isinstance(row[0], str) and row[0]:
                        waterlines.append(row[0])
        with closing(_open_sqlite_read_only(index_db)) as connection:
            try:
                row = connection.execute(
                    "SELECT value FROM schema_meta WHERE key='version'"
                ).fetchone()
            except sqlite3.DatabaseError as exc:
                raise DomainFailure(
                    "snapshot_invalid", "index schema version is unavailable"
                ) from exc
        if row is None:
            raise DomainFailure("snapshot_invalid", "index schema version is unavailable")
        notes_root = space_root / "notes"
        if _is_link_or_reparse(notes_root):
            raise DomainFailure("snapshot_invalid", f"invalid notes directory: {notes_root}")
        if notes_root.is_dir():
            try:
                notes, _directories = _scan_regular_tree(notes_root)
            except _UnsafeTreeEntryError as exc:
                raise DomainFailure("snapshot_invalid", str(exc)) from exc
            note_hashes = {
                note.relative_to(notes_root).as_posix(): sha256_file(note)
                for note in notes
            }
        else:
            note_hashes = {}
        return SpaceSnapshot(
            space_id,
            self._schema_head(space_db, "space"),
            int(row[0]),
            max(waterlines, default=""),
            entity_counts,
            note_hashes,
        )

    async def verify(self, snapshot: PublishedSnapshotReceipt | Path) -> VerificationResult:
        root = (
            snapshot.root if isinstance(snapshot, PublishedSnapshotReceipt) else Path(snapshot)
        )
        root = Path(root).absolute()
        failures: list[str] = []
        manifest = None
        digest = ""
        try:
            _scan_regular_tree(root)
        except _UnsafeTreeEntryError as exc:
            return VerificationResult(
                False, "", None, 0, 0, (f"symlink:{exc}",)
            )
        try:
            payload = (root / "manifest.json").read_bytes()
            digest = sha256_file(root / "manifest.json")
            expected = (root / "manifest.sha256").read_text(encoding="ascii").strip()
            if digest != expected:
                failures.append("manifest_sha256")
            try:
                manifest = parse_manifest(payload)
            except ValueError:
                failures.append("manifest_invalid")
            if manifest is not None:
                self._verify_manifest_facts(root, manifest, failures)
                self._verify_file_facts(root, manifest, failures)
                try:
                    self._verify_snapshot_derived_facts(root, manifest, failures)
                    await self._verify_read_only_authority(root, manifest, failures)
                except DomainFailure as exc:
                    failures.append(exc.record.code)
            if isinstance(snapshot, PublishedSnapshotReceipt) and (
                digest != snapshot.manifest_sha256 or manifest != snapshot.manifest
            ):
                failures.append("receipt_manifest")
        except Exception as exc:
            failures.append(type(exc).__name__)
        if failures or manifest is None:
            return VerificationResult(
                False,
                digest,
                manifest,
                0 if manifest is None else len(manifest.files),
                0 if manifest is None else len(manifest.spaces),
                tuple(failures or ["manifest_invalid"]),
            )
        return VerificationResult(
            True, digest, manifest, len(manifest.files), len(manifest.spaces), ()
        )

    def _verify_manifest_facts(
        self, root: Path, manifest: SnapshotManifest, failures: list[str]
    ) -> None:
        if (root / "manifest.json").read_bytes() != canonical_json(manifest):
            failures.append("manifest_noncanonical")
        if not manifest.files or len({item.relative_path for item in manifest.files}) != len(
            manifest.files
        ):
            failures.append("manifest_inventory")
        if "meta/meta.db" not in {item.relative_path for item in manifest.files}:
            failures.append("meta_missing")
        if manifest.catalog_entry_count != 31 or FORBIDDEN_LEGACY_CATALOG_TYPES & set(
            manifest.catalog_entity_types
        ):
            failures.append("catalog_invalid")
        expected_inventory = self._expected_inventory(root, manifest)
        listed_paths = {item.relative_path for item in manifest.files}
        if expected_inventory != listed_paths:
            failures.append("manifest_inventory")
            for missing in sorted(expected_inventory - listed_paths):
                failures.append(f"inventory_missing:{missing}")
            for extra in sorted(listed_paths - expected_inventory):
                failures.append(f"inventory_extra:{extra}")
        coordination = self._normalize_receipt(manifest.meta.active_session_coordination)
        effort = self._normalize_receipt(manifest.meta.effort_projection)
        if coordination.get("result") != "clean_or_recoverable":
            failures.append("active_session_recovery_required")
        if effort.get("result") != "verified":
            failures.append("effort_projection")
        current_types = tuple(
            sorted(
                getattr(spec, "effective_sync_entity_type", getattr(spec, "name", ""))
                for spec in (
                    self.catalog.list()
                    if self.catalog is not None and hasattr(self.catalog, "list")
                    else ()
                )
            )
        )
        if (
            manifest.catalog_hash != getattr(self.catalog, "hash", None)
            or manifest.catalog_entity_types != current_types
        ):
            failures.append("catalog_mismatch")

    def _verify_file_facts(
        self, root: Path, manifest: SnapshotManifest, failures: list[str]
    ) -> None:
        listed = {validate_relative_path(item.relative_path): item for item in manifest.files}
        for relative, item in listed.items():
            path = root / relative
            try:
                path.resolve().relative_to(root.resolve())
            except ValueError:
                failures.append(f"containment:{relative}")
                continue
            if any(
                _is_link_or_reparse(parent)
                for parent in path.parents
                if parent != root and root in parent.parents
            ):
                failures.append(f"symlink_parent:{relative}")
                continue
            if _is_link_or_reparse(path) or not path.is_file():
                failures.append(f"missing:{relative}")
                continue
            if item.kind.endswith("db"):
                with closing(_open_sqlite_read_only(path)) as connection:
                    if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                        failures.append(f"integrity:{relative}")
            if path.stat().st_size != item.size or sha256_file(path) != item.sha256:
                failures.append(f"file:{relative}")
        try:
            files, _directories = _scan_regular_tree(root)
        except _UnsafeTreeEntryError:
            failures.append("symlink")
            return
        for path in files:
            if (
                path.name not in {"manifest.json", "manifest.sha256"}
                and path.relative_to(root).as_posix() not in listed
            ):
                failures.append(f"unlisted:{path.relative_to(root).as_posix()}")

    def _verify_snapshot_derived_facts(
        self, root: Path, manifest: SnapshotManifest, failures: list[str]
    ) -> None:
        if manifest.meta.schema_head != self._schema_head(root / "meta" / "meta.db", "meta"):
            failures.append("meta_schema_head")
        derived_spaces = tuple(
            self._inspect_space_snapshot(root, space.space_id) for space in manifest.spaces
        )
        if derived_spaces != manifest.spaces:
            failures.append("space_manifest")
        registered_ids = self._registered_ids_from_snapshot(root / "meta" / "meta.db")
        if registered_ids != tuple(space.space_id for space in manifest.spaces):
            failures.append("space_registry")

    @staticmethod
    def _registered_ids_from_snapshot(meta_db: Path) -> tuple[str, ...]:
        with closing(_open_sqlite_read_only(meta_db)) as connection:
            try:
                rows = connection.execute("SELECT id FROM spaces ORDER BY id").fetchall()
            except sqlite3.DatabaseError as exc:
                raise DomainFailure(
                    "snapshot_invalid", "Meta Space registry is unavailable"
                ) from exc
        return tuple(str(row[0]) for row in rows)

    def _expected_inventory(self, root: Path, manifest: SnapshotManifest) -> set[str]:
        """Reconstruct the complete canonical inventory from the copied Meta registry.

        The manifest must not be trusted to define its own coverage: an attacker
        could add or drop file entries while leaving the copied databases intact.
        This helper derives the full inventory from the Space registry inside the
        copied ``meta.db`` plus the copied directories themselves, so any
        manifest entry that does not match reality fails verification.
        """
        registered = self._registered_ids_from_snapshot(root / "meta" / "meta.db")
        expected: set[str] = {"meta/meta.db"}
        for space_id in registered:
            space_root = root / "spaces" / space_id
            expected.add(f"spaces/{space_id}/space.db")
            expected.add(f"spaces/{space_id}/index.db")
            for base in (space_root / "notes", space_root / "index"):
                if _is_link_or_reparse(base):
                    raise DomainFailure("snapshot_invalid", f"unsafe inventory path: {base}")
                if not base.is_dir():
                    continue
                try:
                    files, _directories = _scan_regular_tree(base)
                except _UnsafeTreeEntryError as exc:
                    raise DomainFailure("snapshot_invalid", str(exc)) from exc
                for path in files:
                    relative = path.relative_to(root).as_posix()
                    validate_relative_path(relative)
                    expected.add(relative)
        return expected

    async def _verify_read_only_authority(
        self,
        root: Path,
        manifest: SnapshotManifest,
        failures: list[str],
    ) -> None:
        """Re-run every read-only recovery inspector against the copied snapshot.

        Verification must fail closed: a missing authority or a failed check
        becomes an explicit failure instead of silently trusting ``snapshot()``
        values or the manifest receipts.
        """
        if self.recovery_view_factory is None:
            failures.append("recovery_inspector_unavailable")
            return
        missing = tuple(
            name
            for name, owner in (
                ("active_coordination_inspector", self.active_coordination_inspector),
                ("effort_projection_compiler", self.effort_projection_compiler),
                ("migration_coordinator", self.migration_coordinator),
                ("index_schema", self.index_schema),
                ("knowledge_checker", self.knowledge_checker),
                ("mutation_recovery_inspector", self.mutation_recovery_inspector),
            )
            if owner is None
        )
        if missing:
            failures.append("recovery_inspector_unavailable:" + ",".join(missing))
            return
        try:
            await self._verify_active_coordination(root, manifest, failures)
            await self._verify_effort_projection(root, manifest, failures)
            await self._verify_migration(root, manifest, failures)
            await self._verify_index_schema(root, manifest, failures)
            await self._verify_knowledge(root, manifest, failures)
            await self._verify_mutation_recovery(root, manifest, failures)
        except DomainFailure as exc:
            failures.append(exc.record.code)

    async def _verify_active_coordination(
        self, root: Path, manifest: SnapshotManifest, failures: list[str]
    ) -> None:
        meta_view = self.recovery_view_factory("meta", root / "meta" / "meta.db")
        space_views = {
            space.space_id: self.recovery_view_factory(
                "space", root / "spaces" / space.space_id
            )
            for space in manifest.spaces
        }
        coordination = await self._inspect_async(
            self.active_coordination_inspector,
            meta_view,
            "inspect_read_only",
            space_views=space_views,
        )
        try:
            receipt = self._normalize_receipt(coordination)
        except DomainFailure as exc:
            if exc.record.code == "snapshot_invalid":
                # None or structurally invalid receipts mean the authority
                # is not usable, not that the evidence is bad.
                failures.append("recovery_inspector_unavailable:active_session_authority")
            else:
                failures.append(exc.record.code)
            return
        except Exception:
            failures.append("recovery_inspector_unavailable:active_session_authority")
            return
        if receipt.get("result") != "clean_or_recoverable":
            failures.append("active_session_recovery_required")
        if self._freeze_for_comparison(receipt) != manifest.meta.active_session_coordination:
            failures.append("active_session_coordination")

    async def _verify_effort_projection(
        self, root: Path, manifest: SnapshotManifest, failures: list[str]
    ) -> None:
        mismatches: list[object] = []
        for space in manifest.spaces:
            view = self.recovery_view_factory("space", root / "spaces" / space.space_id)
            result = await self._inspect_async(
                self.effort_projection_compiler,
                view,
                "verify_all",
            )
            if result is None:
                failures.append("effort_projection")
                return
            mismatches.extend(result)
        if mismatches:
            failures.append("effort_projection")

    @staticmethod
    def _freeze_for_comparison(value):
        if isinstance(value, dict):
            return MappingProxyType(
                {
                    key: RecoveryCoordinator._freeze_for_comparison(item)
                    for key, item in value.items()
                }
            )
        if isinstance(value, list | tuple):
            return tuple(
                RecoveryCoordinator._freeze_for_comparison(item) for item in value
            )
        return value

    async def _verify_migration(
        self, root: Path, manifest: SnapshotManifest, failures: list[str]
    ) -> None:
        meta_status = await self.migration_coordinator.verify(
            "meta", root / "meta" / "meta.db"
        )
        if not meta_status.at_head or not meta_status.integrity_ok:
            failures.append("migration_meta")
        if meta_status.head != manifest.meta.schema_head:
            failures.append("meta_schema_head")
        for space in manifest.spaces:
            status = await self.migration_coordinator.verify(
                "space", root / "spaces" / space.space_id / "space.db"
            )
            if not status.at_head or not status.integrity_ok:
                failures.append(f"migration_space:{space.space_id}")
            if status.head != space.space_head:
                failures.append(f"space_schema_head:{space.space_id}")

    async def _verify_index_schema(
        self, root: Path, manifest: SnapshotManifest, failures: list[str]
    ) -> None:
        for space in manifest.spaces:
            path = root / "spaces" / space.space_id / "index.db"
            status = await self._verify_index_database(path)
            if status is None:
                failures.append(f"index_inspector_unavailable:{space.space_id}")
            elif not status.valid or status.version != space.index_schema_version:
                failures.append(f"index_schema:{space.space_id}")

    async def _verify_index_database(self, path: Path):
        """Consume only the public ``verify(path)`` IndexSchema Interface.

        RecoveryCoordinator must not reach into runtime VFS or migration
        internals to build a ``BoundSQLiteTarget``; an injected public adapter
        (the S5-locked ``IndexStoreSchema.verify(path) -> IndexSchemaStatus``
        shape) owns any binding concerns.
        """
        verify = getattr(self.index_schema, "verify", None)
        if verify is None:
            return None
        result = verify(path)
        if inspect.isawaitable(result):
            result = await result
        return result

    async def _verify_knowledge(
        self, root: Path, manifest: SnapshotManifest, failures: list[str]
    ) -> None:
        from app.knowledge.consistency import SpaceDataView

        for space in manifest.spaces:
            view = SpaceDataView(
                space_id=space.space_id,
                db_path=root / "spaces" / space.space_id / "space.db",
                notes_dir=root / "spaces" / space.space_id,
                index_db=root / "spaces" / space.space_id / "index.db",
                catalog_hash=manifest.catalog_hash,
            )
            report = await self.knowledge_checker.verify(view)
            if not report.valid:
                failures.append(f"knowledge_consistency:{space.space_id}")

    async def _verify_mutation_recovery(
        self, root: Path, manifest: SnapshotManifest, failures: list[str]
    ) -> None:
        for space in manifest.spaces:
            view = self.recovery_view_factory("space", root / "spaces" / space.space_id)
            inspection = await self._inspect_recovery(view)
            if not inspection.clean:
                failures.append(f"mutation_recovery:{space.space_id}")

    async def _inspect_recovery(self, view) -> object:
        inspect_recovery = getattr(self.mutation_recovery_inspector, "inspect_recovery", None)
        if inspect_recovery is None:
            inspect_recovery = getattr(self.mutation_recovery_inspector, "inspect", None)
        if inspect_recovery is None:
            raise DomainFailure("snapshot_invalid", "mutation recovery inspector is unavailable")
        value = inspect_recovery(view)
        if inspect.isawaitable(value):
            value = await value
        if value is None or not isinstance(getattr(value, "clean", None), bool):
            raise DomainFailure("snapshot_invalid", "mutation recovery inspection is invalid")
        return value

    # ------------------------------------------------------------------ #
    # S5 Task 2 Step 1: restore a verified snapshot into a unique staging
    # root, then re-run every read-only authority against the staged copy.
    # ------------------------------------------------------------------ #

    async def restore_to_staging(
        self, snapshot: Path | PublishedSnapshotReceipt
    ) -> StagedRestore:
        """Restore a published, verified snapshot into a unique staging root.

        The source snapshot is re-verified from disk (a caller-supplied
        ``PublishedSnapshotReceipt`` is never trusted in memory).  Files are
        copied only from the manifest inventory; SQLite databases use the
        online backup API and ordinary assets are copied as regular files.
        After the copy every read-only authority is re-run against the staged
        tree, and the staged-tree digest must be identical before and after
        verification (any write during verification is rejected).
        """
        if not isinstance(snapshot, PublishedSnapshotReceipt):
            if not isinstance(snapshot, Path):
                raise DomainFailure(
                    "restore_invalid",
                    "restore_to_staging requires a Path or PublishedSnapshotReceipt",
                )
        root = (
            snapshot.root
            if isinstance(snapshot, PublishedSnapshotReceipt)
            else Path(snapshot).expanduser()
        )
        root = Path(root).expanduser().absolute()
        try:
            self._reject_symlink_path(root)
        except DomainFailure as exc:
            raise DomainFailure(
                "restore_source_invalid", "snapshot path is a symlink or reparse point"
            ) from exc
        if not root.is_dir():
            raise DomainFailure("restore_source_invalid", f"snapshot does not exist: {root}")
        if root == self.active_root or self.active_root in root.parents:
            raise DomainFailure("restore_source_invalid", "snapshot is inside active root")

        verified = await self.verify(snapshot)
        manifest = verified.manifest
        if (
            verified.valid is not True
            or manifest is None
            or verified.failures
            or verified.manifest_sha256 != getattr(snapshot, "manifest_sha256", verified.manifest_sha256)
        ):
            # A missing/None authority surfaces as a verification failure;
            # keep its stable code instead of masking it as source-invalid.
            for failure in verified.failures:
                if failure.startswith("recovery_inspector_unavailable:"):
                    normalized = failure.replace(
                        "active_coordination_inspector", "active_session_authority"
                    )
                    raise DomainFailure(
                        normalized, f"snapshot verification failed: {normalized}"
                    )
            reason = ", ".join(verified.failures) or "verified manifest is missing"
            raise DomainFailure("restore_source_invalid", f"snapshot verification failed: {reason}")
        if type(manifest.source_fence) is not int or manifest.source_fence < 1:
            raise DomainFailure(
                "restore_source_invalid",
                "snapshot source fence is not a positive integer",
            )
        if manifest.catalog_hash != getattr(self.catalog, "hash", manifest.catalog_hash):
            raise DomainFailure(
                "restore_source_invalid",
                "snapshot catalog hash does not match coordinator configuration",
            )
        self.failpoint("restore_input_checked")

        staging = self._allocate_staging_root()
        try:
            self._copy_manifest_inventory(root, staging, manifest)
            self.failpoint("staged_copy_done")
            self._fsync_tree(staging)
            before = self.hash_staged_tree(staging, manifest)
            self.failpoint("staged_verify_start")
            await self._inspect_staged_root_read_only(
                staging,
                manifest,
                target_active_root=self.active_root,
            )
            self.failpoint("staged_verify_done")
            try:
                after = self.hash_staged_tree(staging, manifest)
            except DomainFailure as exc:
                raise DomainFailure(
                    "restore_verification_failed",
                    f"staged verification modified the staged tree: {exc}",
                ) from exc
            if before != after:
                raise DomainFailure(
                    "restore_verification_failed",
                    "staged verification modified the staged tree",
                )
            self.failpoint("staged_hash")
            proof_id = uuid.uuid4().hex
            receipt = StagedRestore(
                proof_id=proof_id,
                snapshot_root=root,
                root=staging,
                target_active_root=self.active_root,
                manifest_sha256=verified.manifest_sha256,
                staged_tree_sha256=after,
                catalog_hash=manifest.catalog_hash,
                source_fence=manifest.source_fence,
                manifest=manifest,
                verification=verified,
            )
            proof = _StagingProof(
                proof_id=proof_id,
                snapshot_root=root,
                staging_root=staging.absolute(),
                manifest_sha256=verified.manifest_sha256,
                target_active_root=self.active_root,
                source_fence=manifest.source_fence,
                catalog_hash=manifest.catalog_hash,
                staged_tree_sha256=after,
            )
            self._write_staging_proof(proof)
            return receipt
        except Exception as primary:
            # Preserve the primary failure while making a cleanup failure
            # observable to operators and tests.
            try:
                shutil.rmtree(staging)
            except OSError as cleanup_error:
                primary.add_note(
                    f"staging cleanup failed for {staging}: {cleanup_error}"
                )
            raise

    def _write_staging_proof(self, proof: _StagingProof) -> None:
        """Persist an authenticated staging proof with a no-replace atomic publish.

        The proof is written through a same-directory temporary file, fsynced,
        then published with a no-replace rename so an existing legitimate proof
        is never overwritten.  On failure the temporary file is removed while a
        pre-existing proof (if any) is preserved.
        """
        path = self._proof_path(proof.proof_id, create_directory=True)
        if _is_link_or_reparse(path):
            raise DomainFailure("restore_invalid", "staging proof path is a link or reparse point")
        if path.exists():
            raise DomainFailure("restore_invalid", "staging proof already exists")
        fields: dict[str, object] = {
            "proof_id": proof.proof_id,
            "snapshot_root": self._absolute_path_text(proof.snapshot_root),
            "staging_root": self._absolute_path_text(proof.staging_root),
            "manifest_sha256": proof.manifest_sha256,
            "target_active_root": self._absolute_path_text(proof.target_active_root),
            "source_fence": proof.source_fence,
            "catalog_hash": proof.catalog_hash,
            "staged_tree_sha256": proof.staged_tree_sha256,
            "domain": _STAGING_PROOF_DOMAIN,
            "version": _STAGING_PROOF_VERSION,
        }
        mac = _compute_proof_mac(_staging_proof_secret(), fields)
        payload = _proof_mac_payload({**fields, "proof_mac": mac})
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("xb") as stream:
                stream.write(payload)
            fsync_file(temporary)
            try:
                self._rename_no_overwrite(temporary, path)
            except DomainFailure as exc:
                # A concurrent writer already created the target: never
                # overwrite it, but surface the conflict as a restore failure.
                raise DomainFailure(
                    "restore_invalid", f"could not publish staging proof: {exc}"
                ) from exc
            fsync_directory(path.parent)
        except OSError as exc:
            raise DomainFailure("restore_invalid", f"could not persist staging proof: {exc}") from exc
        finally:
            if temporary.exists():
                try:
                    temporary.unlink()
                except OSError:
                    pass

    def _read_staging_proof(self, proof_id: str) -> _StagingProof:
        path = self._proof_path(proof_id)
        if _is_link_or_reparse(path) or not path.is_file():
            raise DomainFailure("cutover_stale", "staging proof is unavailable")
        try:
            raw_bytes = path.read_bytes()
        except OSError as exc:
            raise DomainFailure("cutover_stale", "staging proof is unreadable") from exc
        return self._parse_staging_proof_bytes(proof_id, raw_bytes)

    @staticmethod
    def _parse_staging_proof_bytes(proof_id: str, raw_bytes: bytes) -> _StagingProof:
        """Authenticate proof bytes read from either a pathname or held lock."""
        raw = _parse_canonical_proof(raw_bytes)
        text_fields = (
            "proof_id",
            "snapshot_root",
            "staging_root",
            "manifest_sha256",
            "target_active_root",
            "catalog_hash",
            "staged_tree_sha256",
        )
        if any(not isinstance(raw[name], str) for name in text_fields):
            raise DomainFailure("cutover_stale", "staging proof has invalid fields")
        if type(raw["source_fence"]) is not int or raw["source_fence"] < 1:
            raise DomainFailure("cutover_stale", "staging proof has an invalid source fence")
        proof = _StagingProof(
            proof_id=raw["proof_id"],
            snapshot_root=Path(raw["snapshot_root"]),
            staging_root=Path(raw["staging_root"]),
            manifest_sha256=raw["manifest_sha256"],
            target_active_root=Path(raw["target_active_root"]),
            source_fence=raw["source_fence"],
            catalog_hash=raw["catalog_hash"],
            staged_tree_sha256=raw["staged_tree_sha256"],
        )
        if proof.proof_id != proof_id:
            raise DomainFailure("cutover_stale", "staging proof id does not match its pathname")
        return proof

    def _consume_staging_proof(self, proof: _StagingProof) -> None:
        """Durably invalidate a proof only after the new active root verifies.

        A staging proof is an admission token, not rollback evidence.  The old
        active root remains protected by ``_RollbackProof``; retaining the
        staging proof after a successful cutover would permit a caller to
        recreate the former staging path and replay it later.
        """
        path = self._proof_path(proof.proof_id)
        if _is_link_or_reparse(path) or not path.is_file():
            raise DomainFailure("cutover_stale", "staging proof disappeared before consumption")
        try:
            path.unlink()
            fsync_directory(path.parent)
        except OSError as exc:
            raise DomainFailure(
                "cutover_publication_failed", "staging proof could not be consumed"
            ) from exc

    def _allocate_staging_root(self) -> Path:
        """Allocate a unique, previously non-existing staging directory.

        The staging root lives in the same parent directory as the target
        active root so a later cutover can atomically rename on one
        filesystem.  The recommended shape is
        ``.<active-name>.restore-<uuid>.staging``.
        """
        parent = self.active_root.parent
        if _is_link_or_reparse(parent):
            raise DomainFailure(
                "restore_target_invalid",
                "staging parent is a symlink or reparse point",
            )
        for _ in range(8):
            name = f".{self.active_root.name}.restore-{uuid.uuid4().hex}.staging"
            candidate = parent / name
            for item in (candidate, *candidate.parents):
                if _is_link_or_reparse(item):
                    raise DomainFailure(
                        "restore_target_invalid",
                        f"symlinked or reparse staging path is forbidden: {item}",
                    )
            if candidate.exists():
                continue
            try:
                candidate.mkdir(parents=False)
            except FileExistsError as exc:
                raise DomainFailure(
                    "restore_target_invalid", f"staging name conflict: {candidate}"
                ) from exc
            self.failpoint("staging_allocated")
            return candidate
        raise DomainFailure(
            "restore_target_invalid", "could not allocate a unique staging directory"
        )

    def _copy_manifest_inventory(
        self, snapshot_root: Path, staging: Path, manifest: SnapshotManifest
    ) -> None:
        """Copy only manifest-declared files into the staging root.

        The inventory comes exclusively from the manifest; directory
        enumeration never adds undeclared files.  SQLite databases use the
        online backup API, ordinary assets are copied only when they are
        regular files, and every file is fsynced after writing.
        """
        seen: set[str] = set()
        for item in manifest.files:
            relative = validate_relative_path(item.relative_path)
            if relative in seen:
                raise DomainFailure("restore_inventory_mismatch", f"duplicate path: {relative}")
            seen.add(relative)
            source = snapshot_root / relative
            try:
                self._assert_regular_source_ancestor(source, snapshot_root)
            except DomainFailure as exc:
                raise DomainFailure(
                    "restore_inventory_mismatch", f"symlinked ancestor: {relative}"
                ) from exc
            if _is_link_or_reparse(source) or not source.is_file():
                raise DomainFailure(
                    "restore_inventory_mismatch", f"source is not a regular file: {relative}"
                )
            before_size = source.stat().st_size
            before_hash = sha256_file(source)
            if before_size != item.size or before_hash != item.sha256:
                raise DomainFailure(
                    "restore_inventory_mismatch",
                    f"source changed after verification: {relative}",
                )
            destination = staging / self._staged_relative_path(relative)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if item.kind.endswith("db"):
                backup_sqlite(source, destination, read_only_source=True)
                self._prepare_staged_database(destination)
            else:
                shutil.copyfile(source, destination)
                fsync_file(destination)
            try:
                self._assert_regular_source_ancestor(source, snapshot_root)
            except DomainFailure as exc:
                raise DomainFailure(
                    "restore_inventory_mismatch", f"source path changed while copying: {relative}"
                ) from exc
            if source.stat().st_size != before_size or sha256_file(source) != before_hash:
                raise DomainFailure(
                    "restore_inventory_mismatch",
                    f"source changed while copying: {relative}",
                )
            self.failpoint(f"staged_copy:{relative}")

    @staticmethod
    def _prepare_staged_database(path: Path) -> None:
        """Finish staging writes before the read-only verification boundary.

        Snapshot databases may persist WAL mode. A read-only SQLite open can
        then create ``-shm`` beside the database. Staging switches to DELETE
        journal mode before the first tree hash so every subsequent authority
        must leave the inventory byte-for-byte unchanged.
        """
        try:
            with closing(sqlite3.connect(path)) as connection:
                mode = connection.execute("PRAGMA journal_mode=DELETE").fetchone()
                if mode is None or str(mode[0]).lower() != "delete":
                    raise sqlite3.DatabaseError("journal mode did not become DELETE")
        except sqlite3.DatabaseError as exc:
            raise DomainFailure(
                "restore_inventory_mismatch",
                f"staged database journal mode cannot be normalized: {path.name}",
            ) from exc
        fsync_file(path)

    @staticmethod
    def _staged_relative_path(manifest_relative: str) -> str:
        if manifest_relative == "meta/meta.db":
            return "meta.db"
        return manifest_relative

    @staticmethod
    def _fsync_tree(root: Path) -> None:
        """fsync every regular file and every directory in the staged tree."""
        try:
            files, directories = _scan_regular_tree(root)
        except _UnsafeTreeEntryError as exc:
            raise DomainFailure("restore_invalid", str(exc)) from exc
        for path in files:
            fsync_file(path)
        for directory in sorted(
            directories, key=lambda item: len(item.parts), reverse=True
        ):
            fsync_directory(directory)

    @classmethod
    def hash_staged_tree(cls, root: Path, manifest: SnapshotManifest) -> str:
        """Deterministic digest of the staged tree.

        Covers every canonical relative path, kind, size, and SHA-256.  Paths
        sort by UTF-8 bytes; the payload is canonical JSON bytes hashed with
        SHA-256.  Absolute paths, timestamps, machine names, and the random
        staging name never enter the digest, so identical content restores to
        different staging paths produce the same digest, and any content or
        path change changes the digest.
        """
        kinds = {
            cls._staged_relative_path(item.relative_path): item.kind
            for item in manifest.files
        }
        entries: list[dict[str, object]] = []
        try:
            files, _directories = _scan_regular_tree(root)
        except _UnsafeTreeEntryError as exc:
            raise DomainFailure("restore_invalid", str(exc)) from exc
        for path in files:
            relative = path.relative_to(root).as_posix()
            kind = kinds.get(relative)
            if kind is None:
                raise DomainFailure(
                    "restore_inventory_mismatch", f"staged file is not manifest-declared: {relative}"
                )
            entries.append(
                {
                    "path": relative,
                    "kind": kind,
                    "size": path.stat().st_size,
                    "sha256": sha256_file(path),
                }
            )
        entries.sort(key=lambda entry: entry["path"].encode("utf-8"))
        payload = (
            json.dumps(
                {"files": entries},
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            )
            + "\n"
        ).encode("utf-8")
        return hashlib.sha256(payload).hexdigest()

    async def _inspect_staged_root_read_only(
        self,
        staging: Path,
        manifest: SnapshotManifest,
        *,
        target_active_root: Path,
    ) -> None:
        """Re-run every read-only recovery authority against the staged copy.

        Strictly read-only: no ``SpaceRuntime.open``, no migration upgrade,
        no index rebuild, no journal repair, no active-session recovery, no
        effort write-back, and no file creation.  Any missing authority,
        ``None`` result, unexpected exception, or structural mismatch fails
        closed.  The active-session authority must consume the copied Space
        views (never the live ones).
        """
        missing = tuple(
            name
            for name, owner in (
                ("active_coordination_inspector", self.active_coordination_inspector),
                ("effort_projection_compiler", self.effort_projection_compiler),
                ("migration_coordinator", self.migration_coordinator),
                ("index_schema", self.index_schema),
                ("knowledge_checker", self.knowledge_checker),
                ("mutation_recovery_inspector", self.mutation_recovery_inspector),
            )
            if owner is None
        )
        if missing:
            raise DomainFailure(
                "recovery_inspector_unavailable:" + ",".join(missing),
                "staged verification is missing authorities",
            )
        self._verify_staged_registry_paths(staging, manifest, target_active_root)
        await self._verify_staged_migration(staging, manifest)
        await self._verify_staged_index(staging, manifest)
        await self._verify_staged_knowledge(staging, manifest)
        await self._verify_staged_mutation(staging, manifest)
        await self._verify_staged_active_session(staging, manifest)
        await self._verify_staged_effort(staging, manifest)

    @staticmethod
    def _verify_staged_registry_paths(
        staging: Path,
        manifest: SnapshotManifest,
        target_active_root: Path,
    ) -> None:
        expected_ids = {space.space_id for space in manifest.spaces}
        try:
            with closing(_open_sqlite_read_only(staging / "meta.db")) as connection:
                rows = connection.execute(
                    "SELECT id, db_path, notes_dir FROM spaces ORDER BY id"
                ).fetchall()
        except sqlite3.DatabaseError as exc:
            raise DomainFailure(
                "restore_verification_failed", "staged Meta Space registry is unreadable"
            ) from exc
        if {str(row[0]) for row in rows} != expected_ids:
            raise DomainFailure(
                "restore_verification_failed", "staged Meta Space registry is incomplete"
            )
        target = target_active_root.absolute()
        if _is_link_or_reparse(target):
            raise DomainFailure(
                "restore_verification_failed", "target active root is a link or reparse point"
            )
        for space_id, db_path, notes_dir in rows:
            expected_root = target / "spaces" / str(space_id)
            registered_db = Path(str(db_path)).expanduser().absolute()
            registered_notes = Path(str(notes_dir)).expanduser().absolute()
            if (
                _is_link_or_reparse(registered_db)
                or _is_link_or_reparse(registered_notes)
                or registered_db != expected_root / "space.db"
                or registered_notes != expected_root / "notes"
            ):
                raise DomainFailure(
                    "restore_relocation_required",
                    f"Space {space_id!r} is registered for a different active root",
                )

    async def _verify_staged_migration(
        self, staging: Path, manifest: SnapshotManifest
    ) -> None:
        meta_status = await self.migration_coordinator.verify(
            "meta", staging / "meta.db"
        )
        if meta_status is None:
            raise DomainFailure(
                "recovery_inspector_unavailable:migration_coordinator",
                "migration verification returned no result",
            )
        if not getattr(meta_status, "at_head", False) or not getattr(
            meta_status, "integrity_ok", False
        ):
            raise DomainFailure("restore_verification_failed", "staged Meta migration drift")
        if getattr(meta_status, "head", None) != manifest.meta.schema_head:
            raise DomainFailure("restore_verification_failed", "staged Meta schema head drift")
        for space in manifest.spaces:
            status = await self.migration_coordinator.verify(
                "space", staging / "spaces" / space.space_id / "space.db"
            )
            if status is None:
                raise DomainFailure(
                    "recovery_inspector_unavailable:migration_coordinator",
                    "migration verification returned no result",
                )
            if not getattr(status, "at_head", False) or not getattr(
                status, "integrity_ok", False
            ):
                raise DomainFailure(
                    "restore_verification_failed",
                    f"staged Space migration drift: {space.space_id}",
                )
            if getattr(status, "head", None) != space.space_head:
                raise DomainFailure(
                    "restore_verification_failed",
                    f"staged Space schema head drift: {space.space_id}",
                )

    async def _verify_staged_index(
        self, staging: Path, manifest: SnapshotManifest
    ) -> None:
        verify = getattr(self.index_schema, "verify", None)
        if verify is None:
            raise DomainFailure(
                "recovery_inspector_unavailable:index_schema",
                "index schema verifier interface is missing",
            )
        for space in manifest.spaces:
            result = verify(staging / "spaces" / space.space_id / "index.db")
            if inspect.isawaitable(result):
                result = await result
            if result is None:
                raise DomainFailure(
                    "recovery_inspector_unavailable:index_schema",
                    "index schema verification returned no result",
                )
            if not getattr(result, "valid", False) or getattr(
                result, "version", None
            ) != space.index_schema_version:
                raise DomainFailure(
                    "restore_verification_failed",
                    f"staged index schema drift: {space.space_id}",
                )

    async def _verify_staged_knowledge(
        self, staging: Path, manifest: SnapshotManifest
    ) -> None:
        from app.knowledge.consistency import SpaceDataView

        for space in manifest.spaces:
            view = SpaceDataView(
                space_id=space.space_id,
                db_path=staging / "spaces" / space.space_id / "space.db",
                notes_dir=staging / "spaces" / space.space_id,
                index_db=staging / "spaces" / space.space_id / "index.db",
                catalog_hash=manifest.catalog_hash,
            )
            report = await self.knowledge_checker.verify(view)
            if report is None or not getattr(report, "valid", False):
                raise DomainFailure(
                    "restore_verification_failed",
                    f"staged knowledge inconsistency: {space.space_id}",
                )

    async def _verify_staged_mutation(
        self, staging: Path, manifest: SnapshotManifest
    ) -> None:
        for space in manifest.spaces:
            view = self.recovery_view_factory(
                "space", staging / "spaces" / space.space_id
            )
            inspection = await self._inspect_recovery(view)
            if inspection is None or not getattr(inspection, "clean", False):
                raise DomainFailure(
                    "restore_verification_failed",
                    f"staged mutation journal is not clean: {space.space_id}",
                )

    async def _verify_staged_active_session(
        self, staging: Path, manifest: SnapshotManifest
    ) -> None:
        from app.knowledge.consistency import SpaceDataView

        meta_view = self.recovery_view_factory("meta", staging / "meta.db")
        space_views = {
            space.space_id: SpaceDataView(
                space_id=space.space_id,
                db_path=staging / "spaces" / space.space_id / "space.db",
                notes_dir=staging / "spaces" / space.space_id,
                index_db=staging / "spaces" / space.space_id / "index.db",
                catalog_hash=manifest.catalog_hash,
            )
            for space in manifest.spaces
        }
        try:
            coordination = await self._inspect_async(
                self.active_coordination_inspector,
                meta_view,
                "inspect_read_only",
                space_views=space_views,
            )
        except DomainFailure as exc:
            if exc.record.code == "active_session_recovery_required":
                raise
            raise DomainFailure(
                "active_session_recovery_required", str(exc)
            ) from exc
        except Exception as exc:
            raise DomainFailure(
                "recovery_inspector_unavailable:active_session_authority",
                f"active session authority failed: {exc}",
            ) from exc
        if coordination is None:
            raise DomainFailure(
                "recovery_inspector_unavailable:active_session_authority",
                "active session authority returned no decision",
            )
        try:
            receipt = self._normalize_receipt(coordination)
        except DomainFailure as exc:
            raise DomainFailure(
                "recovery_inspector_unavailable:active_session_authority",
                f"active session authority receipt is invalid: {exc}",
            ) from exc
        if receipt.get("result") != "clean_or_recoverable":
            raise DomainFailure(
                "active_session_recovery_required",
                receipt.get("reason") or "staged active session requires recovery",
            )

    async def _verify_staged_effort(
        self, staging: Path, manifest: SnapshotManifest
    ) -> None:
        mismatches: list[object] = []
        for space in manifest.spaces:
            view = self.recovery_view_factory("space", staging / "spaces" / space.space_id)
            result = await self._inspect_async(
                self.effort_projection_compiler,
                view,
                "verify_all",
            )
            if result is None:
                raise DomainFailure(
                    "recovery_inspector_unavailable:effort_projection_compiler",
                    "effort projection verification returned no result",
                )
            mismatches.extend(result)
        if mismatches:
            raise DomainFailure(
                "restore_verification_failed",
                "staged effort projection drift",
            )


    # ------------------------------------------------------------------ #
    # S5 Task 2 Step 2: fenced rollback-preserving cutover.
    #
    # Lock order (strict, never reordered):
    #   1. process-owner
    #   2. global-exclusive
    #   3. parent publication lock (canonical active-root parent, outside the
    #      active root so the active root itself may be renamed)
    # Release order is exactly the reverse.  Every authority re-verification,
    # fence assertion, rename, and fsync happens while all three fences are
    # held.  Any failure before the first rename is a zero-side-effect
    # rejection; any failure after a rename reverses both renames under the
    # same fences, fsyncs the parent, read-only verifies the restored old
    # active root, and preserves the rollback evidence.
    # ------------------------------------------------------------------ #

    async def cutover(self, staged_restore: StagedRestore) -> CutoverResult:
        """Publish a verified staged restore through a fenced cutover.

        The caller-supplied receipt is never trusted: every hash, fence,
        catalog fact and authority result is re-derived from disk while the
        process-owner and global-exclusive fences and the parent publication
        lock are held.  The old active root is preserved as a unique rollback
        root that this method never deletes.
        """
        self._check_cutover_input(staged_restore)
        owner = None
        global_lease = None
        publication_lock = None
        primary: BaseException | None = None
        deferred_cancellation = _CancellationDeferral()
        result: CutoverResult | None = None
        try:
            owner = await self._acquire_cutover_owner()
            global_lease = await self._acquire_cutover_global()
            publication_lock = await self._acquire_publication_lock()
            result = await self._cutover_under_fences(
                staged_restore,
                owner,
                global_lease,
                publication_lock,
                deferred_cancellation,
            )
        except BaseException as exc:
            primary = exc
        finally:
            await self._release_publication_fences(
                publication_lock,
                global_lease,
                owner,
                primary=primary,
                cancellation_deferral=deferred_cancellation,
            )
        if primary is not None:
            if deferred_cancellation.error is not None and primary is not deferred_cancellation.error:
                primary.add_note("cutover cancellation deferred until cleanup completed")
            raise primary
        if deferred_cancellation.error is not None:
            raise deferred_cancellation.error
        if result is None:
            raise RuntimeError("cutover completed without a result")
        return result

    def _check_cutover_input(self, staged_restore: object) -> None:
        """Non-destructive shape checks; zero renames are possible here."""
        if not isinstance(staged_restore, StagedRestore):
            raise DomainFailure(
                "cutover_invalid", "cutover requires a StagedRestore"
            )
        root = staged_restore.root
        if not root.is_dir():
            raise DomainFailure("cutover_invalid", "staging root does not exist")
        if _is_link_or_reparse(root):
            raise DomainFailure(
                "cutover_invalid", "staging root is a symlink or reparse point"
            )
        if root == self.active_root:
            raise DomainFailure(
                "cutover_invalid", "staging root equals the active root"
            )
        if (
            staged_restore.target_active_root.expanduser().resolve()
            != self.active_root.expanduser().resolve()
        ):
            raise DomainFailure(
                "cutover_invalid", "staging targets a different active root"
            )
        if not self.active_root.is_dir():
            raise DomainFailure("cutover_invalid", "active root is missing")
        if _is_link_or_reparse(self.active_root):
            raise DomainFailure(
                "cutover_invalid", "active root is a symlink or reparse point"
            )
        parent = self.active_root.parent
        if _is_link_or_reparse(parent):
            raise DomainFailure(
                "cutover_invalid", "active parent is a symlink or reparse point"
            )
        if root.parent.expanduser().resolve() != parent.expanduser().resolve():
            if self._different_volume(root, self.active_root):
                raise DomainFailure(
                    "cutover_cross_volume",
                    "staging and active roots are on different volumes",
                )
            raise DomainFailure(
                "cutover_invalid",
                "staging root is not in the active root parent",
            )
        manifest = staged_restore.manifest
        if (
            type(manifest.source_fence) is not int
            or manifest.source_fence < 1
            or type(staged_restore.source_fence) is not int
            or staged_restore.source_fence < 1
        ):
            raise DomainFailure(
                "cutover_invalid", "staged source fence is not a positive integer"
            )
        if staged_restore.source_fence != manifest.source_fence:
            raise DomainFailure(
                "cutover_stale", "staged source fence disagrees with its manifest"
            )
        if staged_restore.verification.valid is not True:
            raise DomainFailure(
                "cutover_invalid", "staged verification receipt is not valid"
            )

    @staticmethod
    def _different_volume(left: Path, right: Path) -> bool:
        """Windows drive/UNC-aware volume comparison; POSIX is one volume."""
        left_drive = os.path.splitdrive(os.path.abspath(left))[0]
        right_drive = os.path.splitdrive(os.path.abspath(right))[0]
        return left_drive.lower() != right_drive.lower()

    async def _acquire_cutover_owner(self):
        from app.runtime import LeaseTimeoutError

        if self.lease_coordinator is None:
            raise DomainFailure(
                "cutover_invalid", "process-owner lease coordinator is required"
            )
        try:
            return await self.lease_coordinator.acquire_process_owner(
                "cutover", self.CUTOVER_LEASE_TIMEOUT_SECONDS
            )
        except LeaseTimeoutError as exc:
            raise DomainFailure(
                "lease_timeout", f"process owner is busy: {exc}"
            ) from exc

    async def _acquire_cutover_global(self):
        from app.runtime import LeaseMode, LeaseTimeoutError

        if self.lease_coordinator is None:
            raise DomainFailure(
                "cutover_invalid", "global lease coordinator is required"
            )
        try:
            return await self.lease_coordinator.acquire_global(
                LeaseMode.EXCLUSIVE,
                "cutover",
                self.CUTOVER_LEASE_TIMEOUT_SECONDS,
            )
        except LeaseTimeoutError as exc:
            raise DomainFailure(
                "lease_timeout", f"global exclusive lease is busy: {exc}"
            ) from exc

    async def _acquire_publication_lock(self):
        """Serialize publications on the canonical active-root parent.

        The lock file lives outside the active root (the active root is
        renamed), is created under the parent, does not follow symlinks or
        junctions, and has a stable timeout.  The lock is released only after
        rollback reversal (if any) and the final parent fsync have completed,
        matching the strict reverse release order of the other fences.
        """
        parent = self.active_root.parent
        if _is_link_or_reparse(parent):
            raise DomainFailure(
                "cutover_invalid", "active parent is a symlink or reparse point"
            )
        lock_path = parent / f".{self.active_root.name}.publication.lock"
        if _is_link_or_reparse(lock_path):
            raise DomainFailure(
                "cutover_invalid", "publication lock is a symlink or reparse point"
            )
        try:
            stream = lock_path.open("a+b")
        except OSError as exc:
            raise DomainFailure(
                "cutover_invalid", f"publication lock cannot be opened: {exc}"
            ) from exc
        try:
            portalocker.lock(
                stream,
                portalocker.LockFlags.EXCLUSIVE | portalocker.LockFlags.NON_BLOCKING,
            )
        except portalocker.exceptions.LockException as exc:
            stream.close()
            raise DomainFailure(
                "lease_timeout", "parent publication lock is busy"
            ) from exc
        except BaseException:
            stream.close()
            raise
        return _PublicationLock(lock_path, stream)

    @staticmethod
    def _rename_no_overwrite(source: Path, destination: Path) -> None:
        """Rename without overwrite; I/O failures become a stable DomainFailure.

        Uses a platform atomic no-replace primitive: ``MoveFileExW`` without
        ``MOVEFILE_REPLACE_EXISTING`` on Windows and
        ``renameat2(RENAME_NOREPLACE)`` on Linux. Other platforms fail closed.
        Any filesystem failure (an open SQLite handle, a locked directory, a
        cross-volume target) raises
        ``cutover_publication_failed`` and flows through the same reversal path
        as any other publication failure.
        """
        try:
            if os.name == "nt":
                kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
                move_file = kernel32.MoveFileExW
                move_file.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint]
                move_file.restype = ctypes.c_int
                if not move_file(str(source), str(destination), 0):
                    raise ctypes.WinError(ctypes.get_last_error())
            elif sys.platform.startswith("linux"):
                libc = ctypes.CDLL(None, use_errno=True)
                renameat2 = getattr(libc, "renameat2", None)
                if renameat2 is None:
                    raise OSError("renameat2 is unavailable")
                renameat2.argtypes = [
                    ctypes.c_int,
                    ctypes.c_char_p,
                    ctypes.c_int,
                    ctypes.c_char_p,
                    ctypes.c_uint,
                ]
                renameat2.restype = ctypes.c_int
                if renameat2(
                    -100,
                    os.fsencode(source),
                    -100,
                    os.fsencode(destination),
                    1,
                ) != 0:
                    error = ctypes.get_errno()
                    raise OSError(error, os.strerror(error), str(destination))
            else:
                raise OSError("atomic no-replace rename is unsupported on this platform")
        except OSError as exc:
            if destination.exists():
                raise DomainFailure(
                    "cutover_invalid", f"rename target already exists: {destination}"
                ) from exc
            raise DomainFailure(
                "cutover_publication_failed", f"filesystem rename failed: {exc}"
            ) from exc

    async def _cutover_under_fences(
        self,
        staged_restore: StagedRestore,
        owner,
        global_lease,
        publication_lock,
        cancellation_deferral: _CancellationDeferral,
    ) -> CutoverResult:
        self._assert_cutover_fences(owner, global_lease)
        rollback_root = self._allocate_rollback_root()
        proof = await self._verify_staged_for_cutover(staged_restore)
        manifest = proof.manifest
        rollback_proof = await self._create_rollback_proof(global_lease)
        self._assert_cutover_fences(owner, global_lease)
        # Re-authenticate the proof immediately before the first rename.  The
        # proof was verified earlier while both fences were held; between that
        # verification and the active->rollback rename a local attacker could
        # replace or delete it.  The re-check reads and authenticates the proof
        # again and compares every persistent field with the verified proof, so
        # any modification, replacement, deletion or MAC failure blocks the
        # cutover with zero renames and releases every fence.
        proof_lock = self._recheck_staging_proof_before_rename(proof, staged_restore)
        proof_lock_released = False

        state = "PREPARED"
        try:
            self.failpoint("cutover_before_first_rename")
            self._rename_no_overwrite(self.active_root, rollback_root)
            state = "ACTIVE_MOVED_TO_ROLLBACK"
            self._release_staging_proof_lock(proof_lock)
            proof_lock_released = True
            self.failpoint("cutover_after_active_to_rollback")
            if self.active_root.exists():
                raise DomainFailure(
                    "cutover_invalid", "active root reappeared before publication"
                )
            self._rename_no_overwrite(staged_restore.root, self.active_root)
            state = "STAGING_PUBLISHED"
            self.failpoint("cutover_after_staging_to_active")
            try:
                fsync_directory(self.active_root.parent)
            except OSError as exc:
                raise DomainFailure(
                    "cutover_publication_failed", f"parent fsync failed: {exc}"
                ) from exc
            self.failpoint("cutover_after_parent_fsync")
            self._assert_cutover_fences(owner, global_lease)
            self.failpoint("cutover_before_published_verify")
            verification = await self._verify_published_root(
                self.active_root, manifest, proof
            )
            state = "PUBLISHED_VERIFIED"
            self.failpoint("cutover_after_published_verify")
            result = self._build_cutover_result(
                proof,
                rollback_root,
                rollback_proof,
                owner,
                global_lease,
                verification,
            )
            self._consume_staging_proof(proof)
            return result
        except BaseException as primary:
            if not proof_lock_released:
                try:
                    self._release_staging_proof_lock(proof_lock)
                    proof_lock_released = True
                except BaseException as lock_error:
                    primary.add_note(f"cutover proof lock release failed: {lock_error}")
            if state == "PREPARED":
                # The first rename never happened: active untouched, staging
                # intact, rollback absent.  Nothing to reverse.
                raise
            try:
                # Run reversal as same-task deferred cleanup so a cancellation
                # (even a second one) can never interrupt the renames, the old
                # active verification, or the parent fsync mid-flight.
                rejected_root = await self._await_cleanup_while_deferring_cancellation(
                    lambda: self._reverse_publication(
                        state,
                        self.active_root,
                        rollback_root,
                        staged_restore.root,
                        rollback_proof,
                        cancellation_deferral,
                    ),
                    cancellation_deferral,
                )
                if rejected_root is not None:
                    primary.add_note(
                        f"cutover new data moved to rejected root: {rejected_root}"
                    )
            except BaseException as reversal_error:
                primary.add_note(f"cutover reversal failed: {reversal_error}")
            raise

    def _recheck_staging_proof_before_rename(
        self, proof: _StagingProof, staged_restore: StagedRestore
    ) -> _PublicationLock:
        """Re-read and authenticate the proof, then hold its file lock.

        Called under both fences immediately before the active->rollback
        rename.  The re-read verifies the MAC again (so a replaced proof is
        rejected) and compares every persistent field with the proof verified
        earlier.  On any mismatch, ``cutover_stale`` is raised before the first
        rename, leaving the active root untouched.  The returned lock is held
        from re-verification through the first rename and is released by
        ``_release_staging_proof_lock`` on every path (success, exception,
        cancellation, cleanup failure).
        """
        self.failpoint("cutover_before_proof_recheck")
        path = self._proof_path(staged_restore.proof_id)
        try:
            stream = path.open("a+b")
        except OSError as exc:
            raise DomainFailure(
                "cutover_stale", f"staging proof lock cannot be opened: {exc}"
            ) from exc
        try:
            portalocker.lock(
                stream,
                portalocker.LockFlags.EXCLUSIVE | portalocker.LockFlags.NON_BLOCKING,
            )
        except portalocker.exceptions.LockException as exc:
            stream.close()
            raise DomainFailure(
                "cutover_stale", "staging proof lock is busy"
            ) from exc
        except BaseException:
            stream.close()
            raise
        try:
            # POSIX permits replacing a pathname after it has been opened.
            # The exclusive lock is held on the old inode in that case, so
            # prove that the pathname still resolves to the locked file before
            # accepting bytes read from the stream.
            opened = os.fstat(stream.fileno())
            current = os.stat(path, follow_symlinks=False)
            if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
                raise DomainFailure(
                    "cutover_stale", "staging proof path changed before lock acquisition"
                )
            if _is_link_or_reparse(path):
                raise DomainFailure(
                    "cutover_stale", "staging proof path became a link or reparse point"
                )
            stream.seek(0)
            fresh = self._parse_staging_proof_bytes(staged_restore.proof_id, stream.read())
            if (
                fresh.proof_id != proof.proof_id
                or self._absolute_path_text(fresh.snapshot_root)
                != self._absolute_path_text(proof.snapshot_root)
                or self._absolute_path_text(fresh.staging_root)
                != self._absolute_path_text(proof.staging_root)
                or fresh.manifest_sha256 != proof.manifest_sha256
                or self._absolute_path_text(fresh.target_active_root)
                != self._absolute_path_text(proof.target_active_root)
                or fresh.source_fence != proof.source_fence
                or fresh.catalog_hash != proof.catalog_hash
                or fresh.staged_tree_sha256 != proof.staged_tree_sha256
            ):
                raise DomainFailure(
                    "cutover_stale", "staging proof changed after verification"
                )
        except BaseException:
            portalocker.unlock(stream)
            stream.close()
            raise
        return _PublicationLock(path, stream)

    def _release_staging_proof_lock(self, proof_lock: _PublicationLock | None) -> None:
        if proof_lock is None:
            return
        proof_lock.release()

    async def _create_rollback_proof(self, global_lease) -> _RollbackProof:
        target_parent = (
            self.active_root.parent / f".{self.active_root.name}.rollback-snapshots"
        )
        if _is_link_or_reparse(target_parent):
            raise DomainFailure(
                "cutover_invalid", "rollback snapshot target is a symlink or reparse point"
            )
        target_parent.mkdir(exist_ok=True)
        target = target_parent / uuid.uuid4().hex
        target.mkdir()
        try:
            snapshot = await self._snapshot_under_lease(target, global_lease)
            verification = await self.verify(snapshot)
            if verification.valid is not True or verification.manifest != snapshot.manifest:
                raise DomainFailure(
                    "cutover_verification_failed", "rollback snapshot verification failed"
                )
            active_tree_sha256 = self._hash_active_tree(self.active_root)
        except BaseException as primary:
            try:
                shutil.rmtree(target)
            except OSError as cleanup_error:
                primary.add_note(
                    f"cutover rollback snapshot cleanup failed: {cleanup_error}"
                )
            raise
        return _RollbackProof(snapshot=snapshot, active_tree_sha256=active_tree_sha256)

    @staticmethod
    def _hash_active_tree(root: Path) -> str:
        entries: list[str] = []
        try:
            files, _directories = _scan_regular_tree(root)
        except _UnsafeTreeEntryError as exc:
            raise DomainFailure("cutover_verification_failed", str(exc)) from exc
        for path in files:
            relative = path.relative_to(root).as_posix()
            entries.append(
                f"{relative}:{path.stat().st_size}:{sha256_file(path)}"
            )
        return hashlib.sha256("\n".join(entries).encode("utf-8")).hexdigest()

    def _assert_cutover_fences(self, owner, global_lease) -> None:
        from app.runtime import LeaseMode

        owner.assert_active_owner(mode=LeaseMode.EXCLUSIVE, scope="process")
        global_lease.assert_active_owner(mode=LeaseMode.EXCLUSIVE, scope="global")
        owner.assert_fence("process")
        global_lease.assert_fence("global")

    def _allocate_rollback_root(self) -> Path:
        parent = self.active_root.parent
        if _is_link_or_reparse(parent):
            raise DomainFailure(
                "cutover_invalid", "active parent is a symlink or reparse point"
            )
        for _ in range(8):
            candidate = parent / f".{self.active_root.name}.rollback.{uuid.uuid4().hex}"
            if candidate.exists():
                continue
            return candidate
        raise DomainFailure(
            "cutover_invalid", "could not allocate a unique rollback root"
        )

    async def _verify_staged_for_cutover(
        self, staged_restore: StagedRestore
    ) -> _StagingProof:
        """Full read-only re-verification of the staged root under the fences.

        Every caller-supplied fact is re-derived from disk: the staged-tree
        digest, the sidecar/journal boundary, the catalog hash and exact entry
        count, the receipt cross-checks, and every read-only authority
        (migration, index, knowledge, mutation recovery, TS2 active session
        with meta + all space views, effort projection, registry path proof).
        Any drift raises a stable ``cutover_*`` code before the first rename.
        """
        root = staged_restore.root
        proof = self._read_staging_proof(staged_restore.proof_id)
        if self._absolute_path_text(proof.target_active_root) != self._absolute_path_text(
            self.active_root
        ):
            raise DomainFailure("cutover_stale", "staging proof targets another active root")
        if self._absolute_path_text(proof.staging_root) != self._absolute_path_text(root):
            raise DomainFailure("cutover_stale", "staging proof targets another staging root")
        manifest = await self._verify_staging_source(proof)
        proof = replace(proof, manifest=manifest)
        if (
            self._absolute_path_text(staged_restore.snapshot_root)
            != self._absolute_path_text(proof.snapshot_root)
            or self._absolute_path_text(staged_restore.target_active_root)
            != self._absolute_path_text(proof.target_active_root)
            or staged_restore.manifest != manifest
            or staged_restore.manifest_sha256 != proof.manifest_sha256
            or staged_restore.source_fence != proof.source_fence
            or staged_restore.catalog_hash != proof.catalog_hash
            or staged_restore.staged_tree_sha256 != proof.staged_tree_sha256
        ):
            raise DomainFailure("cutover_stale", "staged receipt disagrees with its proof")
        catalog_hash = str(getattr(self.catalog, "hash", None) or "")
        if manifest.catalog_hash != catalog_hash:
            raise DomainFailure(
                "cutover_invalid",
                "staged catalog hash does not match coordinator configuration",
            )
        if manifest.catalog_entry_count != 31:
            raise DomainFailure(
                "cutover_invalid", "staged catalog entry count is invalid"
            )
        if (
            staged_restore.manifest_sha256 != staged_restore.verification.manifest_sha256
        ):
            raise DomainFailure(
                "cutover_stale",
                "staged manifest hash disagrees with its verification receipt",
            )
        if staged_restore.catalog_hash != manifest.catalog_hash or proof.catalog_hash != manifest.catalog_hash:
            raise DomainFailure(
                "cutover_stale", "staged catalog hash disagrees with its manifest"
            )
        if (
            staged_restore.verification.valid is not True
            or staged_restore.verification.failures
            or staged_restore.verification.manifest != manifest
        ):
            raise DomainFailure(
                "cutover_stale", "staged verification receipt is stale or invalid"
            )
        self._assert_no_sidecars(root)
        self._assert_delete_journal(root, manifest)
        try:
            tree_hash = self.hash_staged_tree(root, manifest)
        except DomainFailure as exc:
            raise DomainFailure(
                "cutover_inventory_mismatch", f"staged inventory is invalid: {exc}"
            ) from exc
        if tree_hash != proof.staged_tree_sha256:
            raise DomainFailure(
                "cutover_stale", "staged tree hash drifted from the receipt"
            )
        await self._verify_staged_matches_source(root, proof, manifest)
        try:
            await self._inspect_staged_root_read_only(
                root, manifest, target_active_root=self.active_root
            )
        except DomainFailure as exc:
            raise self._map_staged_authority_failure(exc) from exc
        return proof

    async def _verify_staging_source(self, proof: _StagingProof) -> SnapshotManifest:
        """Re-verify the canonical source snapshot while all cutover fences are held."""
        root = proof.snapshot_root
        if _is_link_or_reparse(root) or not root.is_dir():
            raise DomainFailure("cutover_stale", "source snapshot root is unavailable")
        try:
            payload = (root / "manifest.json").read_bytes()
            manifest = parse_manifest(payload)
        except (OSError, ValueError) as exc:
            raise DomainFailure("cutover_stale", "source snapshot manifest is invalid") from exc
        source = PublishedSnapshotReceipt(root, manifest, proof.manifest_sha256)
        verified = await self.verify(source)
        if (
            verified.valid is not True
            or verified.failures
            or verified.manifest is None
            or verified.manifest != manifest
            or verified.manifest_sha256 != proof.manifest_sha256
        ):
            raise DomainFailure("cutover_stale", "source snapshot proof drifted")
        return verified.manifest

    async def _verify_staged_matches_source(
        self,
        staged_root: Path,
        proof: _StagingProof,
        manifest: SnapshotManifest,
    ) -> None:
        """Independently reproduce normalized source files and compare staging bytes."""
        with tempfile.TemporaryDirectory(
            prefix=f".{self.active_root.name}.source-proof-",
            dir=self.active_root.parent,
        ) as temporary:
            expected_root = Path(temporary)
            for item in manifest.files:
                relative = validate_relative_path(item.relative_path)
                source = proof.snapshot_root / relative
                staged = staged_root / self._staged_relative_path(relative)
                try:
                    self._assert_regular_source_ancestor(source, proof.snapshot_root)
                except DomainFailure as exc:
                    raise DomainFailure(
                        "cutover_stale", f"source proof path is unsafe: {relative}"
                    ) from exc
                # The staged path may have been swapped for a junction after the
                # earlier tree scan; re-check its ancestors before any access.
                try:
                    self._assert_regular_source_ancestor(staged, staged_root)
                except DomainFailure as exc:
                    raise DomainFailure(
                        "cutover_stale", f"staged proof path is unsafe: {relative}"
                    ) from exc
                if _is_link_or_reparse(staged) or not staged.is_file():
                    raise DomainFailure(
                        "cutover_stale", f"staged proof file is missing or a link: {relative}"
                    )
                if item.kind.endswith("db"):
                    expected = expected_root / self._staged_relative_path(relative)
                    backup_sqlite(
                        source,
                        expected,
                        read_only_source=True,
                        immutable_source=True,
                    )
                    self._prepare_staged_database(expected)
                    if (
                        expected.stat().st_size != staged.stat().st_size
                        or sha256_file(expected) != sha256_file(staged)
                    ):
                        raise DomainFailure(
                            "cutover_stale",
                            f"staged database differs from source snapshot: {relative}",
                        )
                elif (
                    source.stat().st_size != staged.stat().st_size
                    or sha256_file(source) != sha256_file(staged)
                ):
                    raise DomainFailure(
                        "cutover_stale",
                        f"staged asset differs from source snapshot: {relative}",
                    )
                try:
                    self._assert_regular_source_ancestor(source, proof.snapshot_root)
                    self._assert_regular_source_ancestor(staged, staged_root)
                except DomainFailure as exc:
                    raise DomainFailure(
                        "cutover_stale", f"source proof path changed: {relative}"
                    ) from exc

    @staticmethod
    def _map_staged_authority_failure(exc: DomainFailure) -> DomainFailure:
        code = exc.record.code
        if code == "restore_relocation_required":
            return DomainFailure(
                "cutover_invalid", f"staged registry path drift: {exc}"
            )
        if code.startswith("recovery_inspector_unavailable:"):
            return DomainFailure(
                "cutover_verification_failed", f"staged authority unavailable: {exc}"
            )
        return DomainFailure("cutover_verification_failed", str(exc))

    @staticmethod
    def _assert_no_sidecars(root: Path) -> None:
        try:
            files, _directories = _scan_regular_tree(root)
        except _UnsafeTreeEntryError as exc:
            raise DomainFailure("cutover_inventory_mismatch", str(exc)) from exc
        for path in files:
            if path.name.endswith(("-wal", "-shm", "-journal")):
                raise DomainFailure(
                    "cutover_inventory_mismatch",
                    f"SQLite sidecar present in staging: {path.relative_to(root)}",
                )

    @staticmethod
    def _assert_delete_journal(root: Path, manifest: SnapshotManifest) -> None:
        for item in manifest.files:
            if not item.kind.endswith("db"):
                continue
            path = root / RecoveryCoordinator._staged_relative_path(item.relative_path)
            try:
                if _is_link_or_reparse(path) or any(
                    _is_link_or_reparse(parent)
                    for parent in path.parents
                    if parent != root and root in parent.parents
                ):
                    raise DomainFailure(
                        "cutover_inventory_mismatch",
                        f"staged database path is a link or reparse point: {path.name}",
                    )
                with closing(_open_sqlite_read_only(path)) as connection:
                    mode = connection.execute("PRAGMA journal_mode").fetchone()
            except DomainFailure:
                raise
            except sqlite3.DatabaseError as exc:
                raise DomainFailure(
                    "cutover_verification_failed",
                    f"staged database is unreadable: {path.name}",
                ) from exc
            if mode is None or str(mode[0]).lower() != "delete":
                raise DomainFailure(
                    "cutover_inventory_mismatch",
                    f"staged database journal mode is not DELETE: {path.name}",
                )

    async def _verify_published_root(
        self,
        root: Path,
        manifest: SnapshotManifest,
        proof: _StagingProof,
    ) -> VerificationResult:
        """Full read-only verification of the published active root.

        Runs while both fences and the parent lock are still held.  The
        staged-tree digest must be byte-identical to the verified receipt and
        every authority must pass against the now-active paths.
        """
        self._assert_no_sidecars(root)
        self._assert_delete_journal(root, manifest)
        try:
            tree_hash = self.hash_staged_tree(root, manifest)
        except DomainFailure as exc:
            raise DomainFailure(
                "cutover_verification_failed",
                f"published tree is invalid: {exc}",
            ) from exc
        if tree_hash != proof.staged_tree_sha256:
            raise DomainFailure(
                "cutover_verification_failed",
                "published tree hash drifted from the staged receipt",
            )
        try:
            await self._inspect_staged_root_read_only(
                root, manifest, target_active_root=self.active_root
            )
        except DomainFailure as exc:
            raise self._map_staged_authority_failure(exc) from exc
        return VerificationResult(
            True,
            proof.manifest_sha256,
            manifest,
            len(manifest.files),
            len(manifest.spaces),
            (),
        )

    async def _reverse_publication(
        self,
        state: str,
        active_root: Path,
        rollback_root: Path,
        staging: Path,
        rollback_proof: _RollbackProof,
        cancellation_deferral: _CancellationDeferral,
    ) -> Path | None:
        """Reverse a partially published cutover under the held fences.

        Returns the unique rejected root that received the unpublished new
        data, or ``None`` when the new data never reached the active path.
        The rejected path is recorded by the caller in the primary error notes
        so operators can find the data; it is never silently dropped.
        """
        rejected_root: Path | None = None
        if state in ("STAGING_PUBLISHED", "PUBLISHED_VERIFIED"):
            self.failpoint("cutover_before_reverse_new_active")
            rejected_root = (
                active_root.parent
                / f".{active_root.name}.rejected.{uuid.uuid4().hex}.staging"
            )
            if rejected_root.exists():
                raise DomainFailure(
                    "cutover_rollback_failed",
                    f"rejected root already exists: {rejected_root}",
                )
            self._rename_no_overwrite(active_root, rejected_root)
            self.failpoint("cutover_after_reverse_new_active")
        self.failpoint("cutover_before_reverse_old_active")
        if not rollback_root.exists():
            raise DomainFailure(
                "cutover_rollback_failed",
                f"rollback root is missing during reversal: {rollback_root}",
            )
        self._rename_no_overwrite(rollback_root, active_root)
        self.failpoint("cutover_after_reverse_old_active")
        fsync_directory(active_root.parent)
        self.failpoint("cutover_after_reverse_fsync")
        self.failpoint("cutover_before_rollback_verify")
        await self._await_cleanup_while_deferring_cancellation(
            lambda: self._verify_reversed_active(active_root, rollback_proof),
            cancellation_deferral,
        )
        return rejected_root

    async def _verify_reversed_active(self, root: Path, proof: _RollbackProof) -> None:
        """Read-only verification of the restored old active root."""
        try:
            manifest = proof.snapshot.manifest
            if self._hash_active_tree(root) != proof.active_tree_sha256:
                raise DomainFailure(
                    "cutover_rollback_failed", "restored active tree differs from rollback proof"
                )
            await self._inspect_staged_root_read_only(
                root, manifest, target_active_root=self.active_root
            )
        except DomainFailure as exc:
            raise DomainFailure(
                "cutover_rollback_failed",
                f"rollback verification failed: {exc}",
            ) from exc
        except Exception as exc:
            raise DomainFailure(
                "cutover_rollback_failed",
                f"rollback verification failed: {exc}",
            ) from exc

    def _build_cutover_result(
        self,
        proof: _StagingProof,
        rollback_root: Path,
        rollback_proof: _RollbackProof,
        owner,
        global_lease,
        verification: VerificationResult,
    ) -> CutoverResult:
        return CutoverResult(
            success=True,
            active_root=self.active_root,
            rollback_root=rollback_root,
            rollback_snapshot_root=rollback_proof.snapshot.root,
            rollback_manifest_sha256=rollback_proof.snapshot.manifest_sha256,
            source_manifest_sha256=proof.manifest_sha256,
            staged_tree_sha256=proof.staged_tree_sha256,
            catalog_hash=proof.manifest.catalog_hash,
            process_fence=int(owner.fence),
            global_fence=int(global_lease.fence),
            published_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            verification=verification,
            verified_spaces=tuple(space.space_id for space in proof.manifest.spaces),
        )

    @staticmethod
    def _split_cancellation(
        error: BaseException,
    ) -> tuple[BaseException | None, BaseException | None]:
        if isinstance(error, BaseExceptionGroup):
            return error.split(asyncio.CancelledError)
        if isinstance(error, asyncio.CancelledError):
            return error, None
        return None, error

    @staticmethod
    def _consume_current_task_cancellation(
        cancellation: BaseException,
        deferral: _CancellationDeferral,
    ) -> bool:
        """Clear real task cancellation so same-task cleanup can finish.

        A manually raised ``CancelledError`` is an ordinary cleanup failure and
        must not be retried forever.  Only cancellation requested on the
        current ``asyncio.Task`` is deferred.
        """
        task = asyncio.current_task()
        if task is None or task.cancelling() == 0:
            return False
        deferral.record(cancellation)
        while task.cancelling():
            task.uncancel()
        return True

    async def _await_cleanup_while_deferring_cancellation(
        self,
        operation,
        deferral: _CancellationDeferral,
    ):
        """Run idempotent same-task cleanup until it is terminal or fails normally."""
        while True:
            try:
                return await operation()
            except BaseException as error:
                cancellation, remainder = self._split_cancellation(error)
                if cancellation is None or not self._consume_current_task_cancellation(
                    cancellation, deferral
                ):
                    raise
                if remainder is not None:
                    raise remainder

    async def _release_publication_fences(
        self,
        publication_lock,
        global_lease,
        owner,
        *,
        primary: BaseException | None,
        cancellation_deferral: _CancellationDeferral,
    ) -> None:
        """Release fences in strict reverse order; failures stay observable."""
        errors: list[BaseException] = []
        if publication_lock is not None:
            try:
                publication_lock.release()
            except BaseException as exc:
                errors.append(exc)
        if global_lease is not None:
            try:
                await self._await_cleanup_while_deferring_cancellation(
                    global_lease.release,
                    cancellation_deferral,
                )
            except BaseException as exc:
                errors.append(exc)
        if owner is not None:
            try:
                await self._await_cleanup_while_deferring_cancellation(
                    owner.release,
                    cancellation_deferral,
                )
            except BaseException as exc:
                errors.append(exc)
        if not errors:
            return
        if primary is not None:
            for exc in errors:
                primary.add_note(f"cutover fence release failed: {exc}")
            return
        raise BaseExceptionGroup("cutover fence release failed", errors) from None
