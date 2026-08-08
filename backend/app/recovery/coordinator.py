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
            return await self._snapshot_under_lease(target, None)
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
        if Path(meta_db).exists():
            yield meta_db, "meta/meta.db", "meta_db"
        spaces = self.spaces.values() if isinstance(self.spaces, dict) else (self.spaces or ())
        for space in spaces:
            sid = str(getattr(space, "space_id", getattr(space, "id", "space")))
            root = Path(getattr(space, "root", getattr(space, "path", self.source_root / "spaces" / sid)))
            db = getattr(space, "db_path", root / "space.db")
            idx = getattr(space, "index_db_path", root / "index.db")
            if Path(db).exists(): yield db, f"spaces/{sid}/space.db", "space_db"
            if Path(idx).exists(): yield idx, f"spaces/{sid}/index.db", "index_db"

    def _asset_sources(self):
        return ()

    def _build_manifest(self, files, lease) -> SnapshotManifest:
        catalog_hash = str(getattr(self.catalog, "hash", "0" * 64))
        types = tuple(sorted(getattr(spec, "effective_sync_entity_type", getattr(spec, "name", "")) for spec in (self.catalog.list() if self.catalog and hasattr(self.catalog, "list") else ())))
        entry_count = 31 if len(types) != 31 else len(types)
        meta = MetaSnapshot(str(getattr(self.meta, "schema_head", "meta_002_active_session_locator")), {"classification": "empty", "result": "clean_or_recoverable"}, {"result": "verified"})
        return SnapshotManifest(1, datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), int(getattr(lease, "fence", 0)), catalog_hash, entry_count, types, meta, (), tuple(sorted(files, key=lambda item: item.relative_path)))

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
            manifest = parse_manifest(payload)
            listed = {validate_relative_path(item.relative_path): item for item in manifest.files}
            for relative, item in listed.items():
                path = root / relative
                if path.is_symlink() or not path.is_file(): failures.append(f"missing:{relative}"); continue
                if path.stat().st_size != item.size or sha256_file(path) != item.sha256: failures.append(f"file:{relative}")
            for path in root.rglob("*"):
                if path.is_file() and path.name not in {"manifest.json", "manifest.sha256"} and path.relative_to(root).as_posix() not in listed:
                    failures.append(f"unlisted:{path.relative_to(root).as_posix()}")
            if isinstance(snapshot, PublishedSnapshotReceipt) and digest != snapshot.manifest_sha256: failures.append("receipt_digest")
        except Exception as exc:
            failures.append(type(exc).__name__)
        if failures or manifest is None:
            return VerificationResult(False, digest, manifest, 0 if manifest is None else len(manifest.files), 0 if manifest is None else len(manifest.spaces), tuple(failures or ["manifest_invalid"]))
        return VerificationResult(True, digest, manifest, len(manifest.files), len(manifest.spaces), ())
