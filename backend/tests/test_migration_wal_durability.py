from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

from app.runtime.durability import (
    atomic_replace_durable,
    fsync_directory,
    sqlite_online_backup,
)
from app.runtime.sqlite_vfs import MaintenanceOptions


@pytest.fixture
def bound_sqlite_pair(tmp_path: Path):
    from app.runtime.sqlite_vfs import (
        bind_marked_isolated_target,
        discard_closed_isolated_target,
    )

    source_marker = tmp_path / ".source-marker"
    backup_marker = tmp_path / ".backup-marker"
    source_marker.write_text("source", encoding="ascii")
    backup_marker.write_text("backup", encoding="ascii")
    source, source_cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="source.db",
        marker_basename=source_marker.name,
        marker_nonce="source",
    )
    backup, backup_cleanup = bind_marked_isolated_target(
        parent_path=tmp_path,
        exact_absent_basename="backup.db",
        marker_basename=backup_marker.name,
        marker_nonce="backup",
    )
    try:
        yield source, backup
    finally:
        errors: list[BaseException] = []
        for target, cleanup in (
            (source, source_cleanup),
            (backup, backup_cleanup),
        ):
            try:
                asyncio.run(target.aclose())
                discard_closed_isolated_target(cleanup, target.identity)
            except BaseException as error:
                errors.append(error)
        if errors:
            raise BaseExceptionGroup("bound SQLite fixture cleanup failed", errors)


def test_online_backup_captures_committed_wal_row(bound_sqlite_pair) -> None:
    source, backup = bound_sqlite_pair
    with source.open_maintenance(MaintenanceOptions(read_only=False)) as writer:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("CREATE TABLE marker (value TEXT NOT NULL)")
        writer.commit()
        checkpoint = writer.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        assert checkpoint is not None
        busy, log_frames, checkpointed_frames = checkpoint
        assert busy == 0
        assert log_frames == checkpointed_frames
        writer.execute("INSERT INTO marker VALUES ('committed-in-wal')")
        writer.commit()

        sqlite_online_backup(source, backup)

        with backup.open_maintenance(MaintenanceOptions(read_only=True)) as copied:
            assert copied.execute("PRAGMA integrity_check").fetchone() == ("ok",)
            assert copied.execute("SELECT value FROM marker").fetchone() == (
                "committed-in-wal",
            )


def test_atomic_replace_fsyncs_file_and_parent(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "replacement.bin"
    target = tmp_path / "target.bin"
    source.write_bytes(b"new")
    target.write_bytes(b"old")
    calls: list[tuple[str, Path]] = []

    monkeypatch.setattr(
        "app.runtime.durability._replace_with_write_through",
        lambda src, dst: calls.append(("replace", Path(dst))),
    )
    monkeypatch.setattr(
        "app.runtime.durability.fsync_file",
        lambda path: calls.append(("file", Path(path))),
    )
    monkeypatch.setattr(
        "app.runtime.durability.fsync_directory",
        lambda path: calls.append(("directory", Path(path))),
    )

    atomic_replace_durable(source, target)

    expected = [("file", source), ("replace", target)]
    if os.name != "nt":
        expected.append(("directory", tmp_path))
    assert calls == expected


def test_fsync_directory_is_exported_for_durability_contract() -> None:
    assert callable(fsync_directory)


def test_posix_directory_fsync_rejects_non_directory_and_symlink_flags(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.runtime.durability as durability

    calls: list[tuple[str, int]] = []
    monkeypatch.setattr(durability.os, "name", "posix")
    monkeypatch.setattr(durability.os, "O_DIRECTORY", 0x10000, raising=False)
    monkeypatch.setattr(durability.os, "O_NOFOLLOW", 0x20000, raising=False)
    monkeypatch.setattr(
        durability.os,
        "open",
        lambda _path, flags: calls.append(("open", flags)) or 17,
    )
    monkeypatch.setattr(
        durability.os, "fsync", lambda descriptor: calls.append(("fsync", descriptor))
    )
    monkeypatch.setattr(
        durability.os, "close", lambda descriptor: calls.append(("close", descriptor))
    )

    durability.fsync_directory(tmp_path)

    flags = calls[0][1]
    assert flags & getattr(os, "O_DIRECTORY", 0)
    assert flags & getattr(os, "O_NOFOLLOW", 0)
    assert calls[1:] == [("fsync", 17), ("close", 17)]


class _FakeWindowsCall:
    def __init__(self, callback):
        self.callback = callback
        self.argtypes = None
        self.restype = None

    def __call__(self, *args):
        return self.callback(*args)


def test_windows_directory_flush_rejects_handle_close_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.runtime.contained_io as contained_io

    handles = iter((101, 102))

    def fill_identity(_handle, pointer) -> int:
        info = contained_io.ctypes.cast(
            pointer, contained_io.ctypes.POINTER(contained_io._BY_HANDLE_FILE_INFORMATION)
        ).contents
        info.dwFileAttributes = 0
        info.dwVolumeSerialNumber = 7
        info.nFileIndexHigh = 0
        info.nFileIndexLow = 9
        return 1

    kernel32 = type("FakeKernel32", (), {})()
    kernel32.CreateFileW = _FakeWindowsCall(lambda *_args: next(handles))
    kernel32.GetFileInformationByHandle = _FakeWindowsCall(fill_identity)
    kernel32.FlushFileBuffers = _FakeWindowsCall(lambda _handle: 1)
    close_results = iter((1, 0))
    kernel32.CloseHandle = _FakeWindowsCall(lambda _handle: next(close_results))
    monkeypatch.setattr(contained_io.ctypes.windll, "kernel32", kernel32)

    with pytest.raises(OSError):
        contained_io.flush_owned_directory(tmp_path)


def test_windows_write_through_replace_rejects_api_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.runtime.contained_io as contained_io

    kernel32 = type("FakeKernel32", (), {})()
    kernel32.MoveFileExW = _FakeWindowsCall(lambda *_args: 0)
    monkeypatch.setattr(contained_io.ctypes.windll, "kernel32", kernel32)

    with pytest.raises(OSError):
        contained_io.replace_file_write_through(
            tmp_path / "source.bin", tmp_path / "target.bin"
        )
