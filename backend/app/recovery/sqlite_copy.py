"""SQLite online-backup helpers."""

import hashlib
import os
import sqlite3
import stat
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path


class SnapshotIntegrityError(RuntimeError):
    pass


def _is_link_or_reparse(path: Path) -> bool:
    """Detect symlinks and Windows reparse points (including junctions).

    Uses ``lstat`` only; ``resolve`` would traverse a junction before the
    caller gets a chance to reject it.
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


@dataclass(frozen=True, slots=True)
class SqliteBackupResult:
    size: int
    sha256: str


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        # Windows cannot open a directory with ``os.open``. Reuse the runtime
        # durability primitive, which opens a non-reparse-point handle and
        # calls FlushFileBuffers.
        from app.runtime.contained_io import flush_owned_directory

        flush_owned_directory(path)
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_file(path: Path) -> None:
    with path.open("r+b") as stream:
        os.fsync(stream.fileno())


def fsync_directory(path: Path) -> None:
    if os.name == "nt":
        from app.runtime.durability import fsync_directory as runtime_fsync_directory

        runtime_fsync_directory(path)
        return
    _fsync_directory(path)


def backup_sqlite(
    source: Path,
    destination: Path,
    *,
    read_only_source: bool = False,
    immutable_source: bool = False,
) -> SqliteBackupResult:
    source = Path(source)
    destination = Path(destination)
    if _is_link_or_reparse(source) or not source.is_file():
        raise SnapshotIntegrityError(f"invalid sqlite source: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    source_database: str | Path = source
    source_options: dict[str, object] = {}
    if read_only_source:
        suffix = "?mode=ro&immutable=1" if immutable_source else "?mode=ro"
        # ``resolve()`` after the link check: a junction would otherwise be
        # followed before the caller could reject it.
        source_database = f"{source.resolve().as_uri()}{suffix}"
        source_options["uri"] = True
    with closing(sqlite3.connect(source_database, **source_options)) as src, closing(
        sqlite3.connect(destination)
    ) as dst:
        if read_only_source:
            src.execute("PRAGMA query_only=ON")
        with dst:
            src.backup(dst, pages=256, sleep=0.01)
            integrity = dst.execute("PRAGMA integrity_check").fetchone()[0]
            if integrity != "ok":
                raise SnapshotIntegrityError(destination.name)
            dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    fsync_file(destination)
    fsync_directory(destination.parent)
    return SqliteBackupResult(destination.stat().st_size, sha256_file(destination))


def normalize_sqlite_journal_mode(path: Path) -> None:
    """Make a copied database safe for read-only inventory inspection.

    SQLite's backup API preserves the source journal mode. A copied WAL-mode
    database can create ``-wal`` and ``-shm`` sidecars when later inspected,
    which would mutate an already-fingerprinted recovery tree.
    """
    try:
        with closing(sqlite3.connect(path)) as connection:
            mode = connection.execute("PRAGMA journal_mode=DELETE").fetchone()
            if mode is None or str(mode[0]).lower() != "delete":
                raise sqlite3.DatabaseError("journal mode did not become DELETE")
    except sqlite3.DatabaseError as exc:
        raise SnapshotIntegrityError(
            f"database journal mode cannot be normalized: {Path(path).name}"
        ) from exc
    fsync_file(path)
    fsync_directory(Path(path).parent)
