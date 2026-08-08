"""Coordinate a complete snapshot under one global exclusive lease."""

import inspect
import os
import shutil
import sqlite3
import uuid
from contextlib import closing
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from types import MappingProxyType, SimpleNamespace

from .contracts import (
    MetaSnapshot,
    PublishedSnapshotReceipt,
    SnapshotFile,
    SnapshotManifest,
    SpaceSnapshot,
    VerificationResult,
)
from .manifest import canonical_json, parse_manifest, validate_relative_path
from .sqlite_copy import backup_sqlite, fsync_directory, fsync_file, sha256_file


class DomainFailure(RuntimeError):
    def __init__(self, code: str, message: str = "") -> None:
        self.record = type("FailureRecord", (), {"code": code})()
        super().__init__(message or code)


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
        self.active_coordination_inspector = active_coordination_inspector
        self.effort_projection_compiler = effort_projection_compiler
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
            (temporary / "manifest.json").write_bytes(payload)
            fsync_file(temporary / "manifest.json")
            digest = sha256_file(temporary / "manifest.json")
            (temporary / "manifest.sha256").write_text(digest + "\n", encoding="ascii")
            self.failpoint("manifest_write")
            fsync_file(temporary / "manifest.sha256")
            fsync_directory(temporary)
            self.failpoint("fsync")
            lease.assert_fence("global")
            final = target / (
                f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-"
                f"{manifest.catalog_hash[:12]}-{uuid.uuid4().hex[:12]}"
            )
            os.replace(temporary, final)
            self.failpoint("atomic_publish")
            fsync_directory(target)
            return PublishedSnapshotReceipt(final.resolve(), manifest, digest)
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            if final is not None:
                shutil.rmtree(final, ignore_errors=True)
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
            if item.exists() and item.is_symlink():
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
        coordination = await self._inspect_async(
            self.active_coordination_inspector,
            self.meta,
            "inspect_read_only",
        )
        if coordination is None:
            raise DomainFailure("snapshot_invalid", "active coordination inspector is unavailable")
        coordination = self._normalize_receipt(coordination)
        if coordination.get("result") != "clean_or_recoverable":
            raise DomainFailure("active_session_recovery_required")
        effort = None
        if self.effort_projection_compiler is not None:
            injected = (
                tuple(self.spaces.values())
                if isinstance(self.spaces, dict)
                else tuple(self.spaces or ())
            )
            if not injected:
                raise DomainFailure(
                    "snapshot_invalid", "effort verification scopes are unavailable"
                )
            mismatches: list[object] = []
            for scope in injected:
                result = await self._inspect_async(
                    self.effort_projection_compiler,
                    scope,
                    "verify_all",
                )
                mismatches.extend(result or ())
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
    async def _inspect_async(owner, argument, method_name: str):
        if owner is None:
            return None
        method = getattr(owner, method_name, None)
        if method is None:
            return None
        value = method(argument)
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
            if (root / "manifest.json").read_bytes() != canonical_json(parse_manifest(payload)):
                failures.append("manifest_noncanonical")
            manifest = parse_manifest(payload)
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
                    import sqlite3

                    with closing(sqlite3.connect(path)) as connection:
                        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                            failures.append(f"integrity:{relative}")
                if path.stat().st_size != item.size or sha256_file(path) != item.sha256:
                    failures.append(f"file:{relative}")
            for path in root.rglob("*"):
                if (
                    path.is_file()
                    and path.name not in {"manifest.json", "manifest.sha256"}
                    and path.relative_to(root).as_posix() not in listed
                ):
                    failures.append(f"unlisted:{path.relative_to(root).as_posix()}")
            try:
                if manifest.meta.schema_head != self._schema_head(
                    root / "meta" / "meta.db", "meta"
                ):
                    failures.append("meta_schema_head")
                derived_spaces = tuple(
                    self._inspect_space_snapshot(root, space.space_id) for space in manifest.spaces
                )
                if derived_spaces != manifest.spaces:
                    failures.append("space_manifest")
                registered_ids = self._registered_ids_from_snapshot(root / "meta" / "meta.db")
                if registered_ids != tuple(space.space_id for space in manifest.spaces):
                    failures.append("space_registry")
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
