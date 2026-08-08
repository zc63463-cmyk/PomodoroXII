"""SQLite online-backup helpers."""

from dataclasses import dataclass
import hashlib
from pathlib import Path
import os
import sqlite3


class SnapshotIntegrityError(RuntimeError):
    pass


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
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_file(path: Path) -> None:
    with path.open("r+b") as stream:
        os.fsync(stream.fileno())


def fsync_directory(path: Path) -> None:
    _fsync_directory(path)


def backup_sqlite(source: Path, destination: Path) -> SqliteBackupResult:
    source = Path(source)
    destination = Path(destination)
    if source.is_symlink() or not source.is_file():
        raise SnapshotIntegrityError(f"invalid sqlite source: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(source) as src, sqlite3.connect(destination) as dst:
        src.backup(dst, pages=256, sleep=0.01)
        integrity = dst.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise SnapshotIntegrityError(destination.name)
        dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    fsync_file(destination)
    fsync_directory(destination.parent)
    return SqliteBackupResult(destination.stat().st_size, sha256_file(destination))
