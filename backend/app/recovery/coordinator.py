"""Coordinate a complete snapshot under one global exclusive lease."""

import hashlib
import inspect
import json
import os
import shutil
import sqlite3
import uuid
from contextlib import closing
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from types import MappingProxyType, SimpleNamespace

from app.focus_session.recovery_authority import (
    ActiveSessionCoordinationInspector as TS2ActiveSessionCoordinationInspector,
)

from .contracts import (
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


class DomainFailure(RuntimeError):
    def __init__(self, code: str, message: str = "") -> None:
        self.record = type("FailureRecord", (), {"code": code})()
        super().__init__(message or code)


def _is_link_or_reparse(path: Path) -> bool:
    """Detect symlinks and Windows reparse points (including junctions).

    ``Path.is_symlink()`` misses Windows directory junctions, so a resolved
    path that differs from its absolute form is also treated as a link.
    """
    if path.is_symlink():
        return True
    try:
        return path.resolve() != path.absolute()
    except OSError:
        return True


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
        self.source_root = Path(source_root or getattr(meta, "root", ".")).expanduser().resolve()
        active_root_input = Path(active_root or self.source_root).expanduser().absolute()
        if active_root_input.is_symlink():
            raise DomainFailure("snapshot_invalid", "active root may not be a symlink")
        self.active_root = active_root_input.resolve()
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
                result = backup_sqlite(source, destination)
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
        if not Path(meta_db).is_file() or Path(meta_db).is_symlink():
            raise DomainFailure("snapshot_invalid", "meta database is missing or symlinked")
        self._assert_source_path(meta_db)
        return Path(meta_db)

    def _registered_spaces(self) -> tuple[SimpleNamespace, ...]:
        meta_db = self._meta_db_path()
        with closing(sqlite3.connect(meta_db)) as connection:
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
            if canonical_root.is_symlink() or any(
                parent.is_symlink()
                for parent in canonical_root.parents
                if parent != self.active_root.parent
            ):
                raise DomainFailure("snapshot_invalid", f"symlinked Space root: {space_id}")
            root = canonical_root.resolve()
            expected_db = (root / "space.db").resolve()
            expected_notes = (root / "notes").resolve()
            if Path(db_path).expanduser().resolve() != expected_db:
                raise DomainFailure("snapshot_invalid", f"noncanonical Space DB path: {space_id}")
            if Path(notes_dir).expanduser().resolve() != expected_notes:
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
            if not Path(db).is_file() or Path(db).is_symlink():
                raise DomainFailure("snapshot_invalid", f"space database missing: {sid}")
            if not Path(idx).is_file() or Path(idx).is_symlink():
                raise DomainFailure("snapshot_invalid", f"index database missing: {sid}")
            yield db, f"spaces/{sid}/space.db", "space_db"
            yield idx, f"spaces/{sid}/index.db", "index_db"

    def _assert_source_path(self, source: Path) -> None:
        path = Path(source).expanduser()
        if path.is_symlink() or not path.is_file():
            raise DomainFailure("snapshot_invalid", f"invalid source path: {path}")
        try:
            path.resolve().relative_to(self.active_root)
        except ValueError as exc:
            raise DomainFailure("snapshot_invalid", f"source escapes active root: {path}") from exc
        if any(parent.is_symlink() for parent in path.parents if parent != self.active_root.parent):
            raise DomainFailure("snapshot_invalid", f"symlinked source ancestor: {path}")

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
                if base.is_symlink() or not base.is_dir():
                    raise DomainFailure("snapshot_invalid", f"invalid asset directory: {base}")
                for source in base.rglob("*"):
                    if source.is_symlink() or not source.is_file():
                        raise DomainFailure("snapshot_invalid", f"invalid asset: {source}")
                    try:
                        relative = source.resolve().relative_to(root)
                    except ValueError as exc:
                        raise DomainFailure(
                            "snapshot_invalid", "asset escapes source root"
                        ) from exc
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
        if len(types) != 31 or {"task", "session", "taskQuickNote", "sessionQuickNote"} & set(
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
            if not spaces:
                raise DomainFailure(
                    "snapshot_invalid", "effort verification scopes are unavailable"
                )
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
        with closing(sqlite3.connect(path)) as connection:
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
        with closing(sqlite3.connect(space_db)) as connection:
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
        with closing(sqlite3.connect(index_db)) as connection:
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
        note_hashes = (
            {
                note.relative_to(notes_root).as_posix(): sha256_file(note)
                for note in sorted(notes_root.rglob("*"))
                if note.is_file()
            }
            if notes_root.is_dir()
            else {}
        )
        return SpaceSnapshot(
            space_id,
            self._schema_head(space_db, "space"),
            int(row[0]),
            max(waterlines, default=""),
            entity_counts,
            note_hashes,
        )

    async def verify(self, snapshot: PublishedSnapshotReceipt | Path) -> VerificationResult:
        root = snapshot.root if isinstance(snapshot, PublishedSnapshotReceipt) else Path(snapshot)
        failures: list[str] = []
        manifest = None
        digest = ""
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
        if manifest.catalog_entry_count != 31 or {
            "task",
            "session",
            "taskQuickNote",
            "sessionQuickNote",
        } & set(manifest.catalog_entity_types):
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
            if any(parent.is_symlink() for parent in path.parents if parent != root):
                failures.append(f"symlink_parent:{relative}")
                continue
            if path.is_symlink() or not path.is_file():
                failures.append(f"missing:{relative}")
                continue
            if item.kind.endswith("db"):
                with closing(sqlite3.connect(path)) as connection:
                    if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                        failures.append(f"integrity:{relative}")
            if path.stat().st_size != item.size or sha256_file(path) != item.sha256:
                failures.append(f"file:{relative}")
        for path in root.rglob("*"):
            if path.is_symlink():
                failures.append(f"symlink:{path.relative_to(root).as_posix()}")
                continue
            if (
                path.is_file()
                and path.name not in {"manifest.json", "manifest.sha256"}
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
        with closing(sqlite3.connect(meta_db)) as connection:
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
                if not base.is_dir():
                    continue
                for path in base.rglob("*"):
                    if not path.is_file():
                        continue
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
        root = root.resolve()
        if not root.is_dir():
            raise DomainFailure("restore_source_invalid", f"snapshot does not exist: {root}")
        self._reject_symlink_path(root)
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
            return StagedRestore(
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
            if any(parent.is_symlink() for parent in source.parents if parent != snapshot_root):
                raise DomainFailure(
                    "restore_inventory_mismatch", f"symlinked ancestor: {relative}"
                )
            if source.is_symlink() or not source.is_file():
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
                backup_sqlite(source, destination)
                self._prepare_staged_database(destination)
            else:
                shutil.copyfile(source, destination)
                fsync_file(destination)
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
        directories: list[Path] = []
        for path in sorted(root.rglob("*")):
            if path.is_symlink():
                raise DomainFailure(
                    "restore_invalid", f"staging contains a symlink: {path}"
                )
            if not path.is_file():
                if path.is_dir():
                    directories.append(path)
                continue
            fsync_file(path)
        for directory in sorted(directories, key=lambda item: len(item.parts), reverse=True):
            fsync_directory(directory)
        fsync_directory(root)

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
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            if path.is_symlink():
                raise DomainFailure(
                    "restore_invalid", f"staging contains a symlink: {path}"
                )
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
        uri = f"{(staging / 'meta.db').resolve().as_uri()}?mode=ro"
        try:
            with closing(sqlite3.connect(uri, uri=True)) as connection:
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
        target = target_active_root.resolve()
        for space_id, db_path, notes_dir in rows:
            expected_root = target / "spaces" / str(space_id)
            if (
                Path(str(db_path)).expanduser().resolve()
                != (expected_root / "space.db").resolve()
                or Path(str(notes_dir)).expanduser().resolve()
                != (expected_root / "notes").resolve()
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
