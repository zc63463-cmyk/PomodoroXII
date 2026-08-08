"""Coordinate a complete snapshot under one global exclusive lease."""

from datetime import datetime, timezone
import asyncio
import os
from pathlib import Path
import shutil
import uuid

from .contracts import MetaSnapshot, PublishedSnapshotReceipt, SnapshotFile, SnapshotManifest, SpaceSnapshot, VerificationResult
from .manifest import canonical_json, parse_manifest, validate_relative_path
from .sqlite_copy import backup_sqlite, fsync_directory, fsync_file, sha256_file


class DomainFailure(RuntimeError):
    def __init__(self, code: str, message: str = "") -> None:
        self.record = type("FailureRecord", (), {"code": code})()
        super().__init__(message or code)


class RecoveryCoordinator:
    def __init__(self, *, lease_coordinator=None, source_root: Path | None = None, active_root: Path | None = None, catalog=None, meta=None, spaces=None, index_schema=None, **_unused) -> None:
        self.lease_coordinator = lease_coordinator
        self.source_root = Path(source_root or getattr(meta, "root", ".")).expanduser().resolve()
        self.active_root = Path(active_root or self.source_root).expanduser().resolve()
        self.catalog = catalog
        self.meta = meta
        self.spaces = spaces
        self.index_schema = index_schema

    async def snapshot(self, target: Path) -> PublishedSnapshotReceipt:
        target = Path(target).expanduser().resolve()
        if self.active_root == target or self.active_root in target.parents:
            raise DomainFailure("snapshot_invalid", "target is inside active root")
        target.mkdir(parents=True, exist_ok=True)
        if self.lease_coordinator is None:
            raise DomainFailure("snapshot_invalid", "global exclusive lease is required")
        from app.runtime.leases import LeaseMode
        lease = await self.lease_coordinator.acquire_global(LeaseMode.EXCLUSIVE, "recovery snapshot", 60.0)
        try:
            return await self._snapshot_under_lease(target, lease)
        finally:
            await lease.release()

    async def _snapshot_under_lease(self, target: Path, lease) -> PublishedSnapshotReceipt:
        if lease is not None:
            from app.runtime.leases import LeaseMode
            lease.assert_active_owner(mode=LeaseMode.EXCLUSIVE, scope="global")
        temporary = target / f".{uuid.uuid4().hex}.tmp"
        temporary.mkdir(parents=True)
        try:
            files: list[SnapshotFile] = []
            for source, relative, kind in self._database_sources():
                destination = temporary / relative
                result = backup_sqlite(source, destination)
                files.append(SnapshotFile(relative, result.size, result.sha256, kind))
            for source, relative, kind in self._asset_sources():
                source = Path(source)
                if source.is_symlink() or not source.is_file():
                    raise DomainFailure("snapshot_invalid", f"invalid asset {source}")
                destination = temporary / validate_relative_path(relative)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, destination)
                fsync_file(destination)
                files.append(SnapshotFile(destination.relative_to(temporary).as_posix(), destination.stat().st_size, sha256_file(destination), kind))
            manifest = self._build_manifest(files, lease)
            payload = canonical_json(manifest)
            (temporary / "manifest.json").write_bytes(payload)
            fsync_file(temporary / "manifest.json")
            digest = sha256_file(temporary / "manifest.json")
            (temporary / "manifest.sha256").write_text(digest + "\n", encoding="ascii")
            fsync_file(temporary / "manifest.sha256")
            fsync_directory(temporary)
            if lease is not None:
                lease.assert_fence("global")
            final = target / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{manifest.catalog_hash[:12]}"
            os.replace(temporary, final)
            fsync_directory(target)
            return PublishedSnapshotReceipt(final.resolve(), manifest, digest)
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            raise

    def _database_sources(self):
        meta_db = getattr(self.meta, "db_path", None) or getattr(self.meta, "path", None) or self.source_root / "meta.db"
        if not Path(meta_db).is_file() or Path(meta_db).is_symlink():
            raise DomainFailure("snapshot_invalid", "meta database is missing or symlinked")
        self._assert_source_path(meta_db)
        yield meta_db, "meta/meta.db", "meta_db"
        spaces = self.spaces.values() if isinstance(self.spaces, dict) else (self.spaces or ())
        for space in spaces:
            sid = str(getattr(space, "space_id", getattr(space, "id", "space")))
            root = Path(getattr(space, "root", getattr(space, "path", self.source_root / "spaces" / sid)))
            db = getattr(space, "db_path", root / "space.db")
            idx = getattr(space, "index_db_path", root / "index.db")
            validate_relative_path(f"spaces/{sid}")
            self._assert_source_path(db)
            self._assert_source_path(idx)
            if not Path(db).is_file() or Path(db).is_symlink(): raise DomainFailure("snapshot_invalid", f"space database missing: {sid}")
            if not Path(idx).is_file() or Path(idx).is_symlink(): raise DomainFailure("snapshot_invalid", f"index database missing: {sid}")
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

    def _asset_sources(self):
        spaces = self.spaces.values() if isinstance(self.spaces, dict) else (self.spaces or ())
        for space in spaces:
            sid = str(getattr(space, "space_id", getattr(space, "id", "space")))
            root = Path(getattr(space, "root", getattr(space, "path", self.source_root / "spaces" / sid))).resolve()
            for base, kind in ((root / "notes", "note"), (root / "index", "index_asset")):
                if not base.exists():
                    continue
                if base.is_symlink() or not base.is_dir():
                    raise DomainFailure("snapshot_invalid", f"invalid asset directory: {base}")
                for source in base.rglob("*"):
                    if source.is_symlink() or not source.is_file():
                        raise DomainFailure("snapshot_invalid", f"invalid asset: {source}")
                    try:
                        relative = source.resolve().relative_to(root)
                    except ValueError as exc:
                        raise DomainFailure("snapshot_invalid", "asset escapes source root") from exc
                    yield source, f"spaces/{sid}/{relative.as_posix()}", kind

    def _build_manifest(self, files, lease) -> SnapshotManifest:
        catalog_hash = str(getattr(self.catalog, "hash", "0" * 64))
        if len(catalog_hash) != 64 or any(c not in "0123456789abcdef" for c in catalog_hash):
            raise DomainFailure("snapshot_invalid", "catalog hash is invalid")
        types = tuple(sorted(getattr(spec, "effective_sync_entity_type", getattr(spec, "name", "")) for spec in (self.catalog.list() if self.catalog and hasattr(self.catalog, "list") else ())))
        if len(types) != 31 or {"task", "session", "taskQuickNote", "sessionQuickNote"} & set(types):
            raise DomainFailure("snapshot_invalid", "catalog is not the S5 catalog")
        entry_count = 31
        coordination = self._inspect(self.meta, "active_session_coordination", {"classification": "empty", "result": "clean_or_recoverable"})
        effort = self._inspect(self.meta, "effort_projection", {"result": "verified"})
        spaces = self.spaces.values() if isinstance(self.spaces, dict) else (self.spaces or ())
        space_records = tuple(sorted((SpaceSnapshot(
            str(getattr(space, "space_id", getattr(space, "id", "space"))),
            str(getattr(space, "space_head", "")),
            int(getattr(space, "index_schema_version", getattr(self.index_schema, "version", 0))),
            str(getattr(space, "sync_waterline", "")),
            dict(getattr(space, "entity_counts", {})),
            dict(getattr(space, "note_hashes", {})),
        ) for space in spaces), key=lambda item: item.space_id))
        meta = MetaSnapshot(str(getattr(self.meta, "schema_head", "meta_002_active_session_locator")), coordination, effort)
        return SnapshotManifest(1, datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), int(getattr(lease, "fence", 0)), catalog_hash, entry_count, types, meta, space_records, tuple(sorted(files, key=lambda item: item.relative_path)))

    @staticmethod
    def _inspect(owner, name: str, default):
        value = getattr(owner, name, default)
        return value() if callable(value) else value

    def verify(self, snapshot: PublishedSnapshotReceipt | Path) -> VerificationResult:
        root = snapshot.root if isinstance(snapshot, PublishedSnapshotReceipt) else Path(snapshot)
        failures: list[str] = []
        manifest = None
        digest = ""
        try:
            payload = (root / "manifest.json").read_bytes()
            digest = sha256_file(root / "manifest.json")
            expected = (root / "manifest.sha256").read_text(encoding="ascii").strip()
            if digest != expected: failures.append("manifest_sha256")
            if (root / "manifest.json").read_bytes() != canonical_json(parse_manifest(payload)):
                failures.append("manifest_noncanonical")
            manifest = parse_manifest(payload)
            if not manifest.files or len({item.relative_path for item in manifest.files}) != len(manifest.files):
                failures.append("manifest_inventory")
            listed = {validate_relative_path(item.relative_path): item for item in manifest.files}
            for relative, item in listed.items():
                path = root / relative
                try:
                    path.resolve().relative_to(root.resolve())
                except ValueError:
                    failures.append(f"containment:{relative}"); continue
                if path.is_symlink() or not path.is_file(): failures.append(f"missing:{relative}"); continue
                if item.kind.endswith("db"):
                    import sqlite3
                    with sqlite3.connect(path) as connection:
                        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                            failures.append(f"integrity:{relative}")
                if path.stat().st_size != item.size or sha256_file(path) != item.sha256: failures.append(f"file:{relative}")
            for path in root.rglob("*"):
                if path.is_file() and path.name not in {"manifest.json", "manifest.sha256"} and path.relative_to(root).as_posix() not in listed:
                    failures.append(f"unlisted:{path.relative_to(root).as_posix()}")
            if isinstance(snapshot, PublishedSnapshotReceipt) and (digest != snapshot.manifest_sha256 or manifest != snapshot.manifest): failures.append("receipt_manifest")
        except Exception as exc:
            failures.append(type(exc).__name__)
        if failures or manifest is None:
            return VerificationResult(False, digest, manifest, 0 if manifest is None else len(manifest.files), 0 if manifest is None else len(manifest.spaces), tuple(failures or ["manifest_invalid"]))
        return VerificationResult(True, digest, manifest, len(manifest.files), len(manifest.spaces), ())
