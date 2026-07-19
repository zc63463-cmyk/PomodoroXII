from __future__ import annotations

import os
from pathlib import Path

from app.runtime.contained_io import flush_owned_directory, replace_file_write_through
from app.runtime.sqlite_vfs import BoundSQLiteTarget, MaintenanceOptions


def fsync_file(path: Path) -> None:
    with Path(path).open("rb") as handle:
        os.fsync(handle.fileno())


def fsync_directory(path: Path) -> None:
    directory = Path(path)
    if os.name == "nt":
        flush_owned_directory(directory)
        return
    descriptor = os.open(
        directory,
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def sqlite_online_backup(
    source: BoundSQLiteTarget, destination: BoundSQLiteTarget
) -> None:
    with source.open_maintenance(
        MaintenanceOptions(read_only=True)
    ) as source_db, destination.open_maintenance(
        MaintenanceOptions(read_only=False, create_if_missing=True)
    ) as target_db:
        source_db.backup(target_db)
        target_db.commit()
        if target_db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise RuntimeError("SQLite backup integrity check failed")


def _replace_with_write_through(source: Path, target: Path) -> None:
    if os.name == "nt":
        replace_file_write_through(source, target)
    else:
        os.replace(source, target)


def atomic_replace_durable(source: Path, target: Path) -> None:
    source_path = Path(source)
    target_path = Path(target)
    fsync_file(source_path)
    _replace_with_write_through(source_path, target_path)
    if os.name != "nt":
        fsync_directory(target_path.parent)


def next_fence(path: Path) -> int:
    fence_path = Path(path)
    fence_path.parent.mkdir(parents=True, exist_ok=True)
    current = int(fence_path.read_text(encoding="ascii")) if fence_path.exists() else 0
    temporary = fence_path.with_suffix(fence_path.suffix + ".tmp")
    value = current + 1
    temporary.write_text(str(value), encoding="ascii")
    atomic_replace_durable(temporary, fence_path)
    return value
