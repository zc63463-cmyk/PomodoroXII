from __future__ import annotations

import ctypes
import os
import stat
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, BinaryIO

from app.errors import PathOutsideSpaceError

if TYPE_CHECKING:
    from app.runtime.sqlite_vfs import BoundSQLiteTarget


@dataclass(frozen=True, slots=True)
class StorageIdentity:
    device: int
    file_id: int


class BoundDirectoryHandle:
    __slots__ = ("_identity", "_authority", "_descriptor", "_location")

    def __init__(self, *_args, **_kwargs) -> None:
        raise TypeError("BoundDirectoryHandle is authority-created")

    @property
    def identity(self) -> StorageIdentity:
        return self._identity

    def open_child_no_follow(self, relative_name: str, flags: int) -> BinaryIO:
        if Path(relative_name).name != relative_name:
            raise PathOutsideSpaceError("Contained child name is not exact")
        descriptor = os.open(
            self._location / relative_name,
            flags | getattr(os, "O_NOFOLLOW", 0),
        )
        return os.fdopen(descriptor, "r+b", closefd=True)

    @classmethod
    def _create(cls, location: Path) -> "BoundDirectoryHandle":
        if os.name == "nt":
            descriptor, identity = _open_windows_directory(location)
        else:
            descriptor = os.open(
                location,
                os.O_RDONLY
                | getattr(os, "O_DIRECTORY", 0)
                | getattr(os, "O_NOFOLLOW", 0),
            )
            info = os.fstat(descriptor)
            identity = StorageIdentity(info.st_dev, info.st_ino)
        instance = object.__new__(cls)
        instance._identity = identity
        instance._authority = object()
        instance._descriptor = descriptor
        instance._location = location
        return instance

    def _close(self) -> None:
        descriptor = self._descriptor
        if descriptor >= 0:
            if os.name == "nt":
                ctypes.windll.kernel32.CloseHandle(wintypes.HANDLE(descriptor))
            else:
                os.close(descriptor)
            self._descriptor = -1


class _BY_HANDLE_FILE_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("dwFileAttributes", wintypes.DWORD),
        ("ftCreationTime", wintypes.FILETIME),
        ("ftLastAccessTime", wintypes.FILETIME),
        ("ftLastWriteTime", wintypes.FILETIME),
        ("dwVolumeSerialNumber", wintypes.DWORD),
        ("nFileSizeHigh", wintypes.DWORD),
        ("nFileSizeLow", wintypes.DWORD),
        ("nNumberOfLinks", wintypes.DWORD),
        ("nFileIndexHigh", wintypes.DWORD),
        ("nFileIndexLow", wintypes.DWORD),
    ]


def _open_windows_directory(location: Path) -> tuple[int, StorageIdentity]:
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateFileW.restype = wintypes.HANDLE
    handle = kernel32.CreateFileW(
        os.fspath(location),
        0,
        0x00000001 | 0x00000002,
        None,
        3,
        0x02000000 | 0x00200000,
        None,
    )
    invalid = ctypes.c_void_p(-1).value
    if handle in {None, invalid}:
        raise ctypes.WinError()
    info = _BY_HANDLE_FILE_INFORMATION()
    if not kernel32.GetFileInformationByHandle(handle, ctypes.byref(info)):
        error = ctypes.WinError()
        kernel32.CloseHandle(handle)
        raise error
    file_id = (int(info.nFileIndexHigh) << 32) | int(info.nFileIndexLow)
    return int(handle), StorageIdentity(int(info.dwVolumeSerialNumber), file_id)


class ContainedSpaceOpens:
    __slots__ = (
        "_database_target",
        "_index_target",
        "_notes_handle",
        "_database_taken",
        "_file_system_taken",
    )

    def __init__(self, *_args, **_kwargs) -> None:
        raise TypeError("ContainedSpaceOpens is authority-created")

    @classmethod
    def _create(
        cls,
        database_target: BoundSQLiteTarget,
        index_target: BoundSQLiteTarget,
        notes_handle: BoundDirectoryHandle,
    ) -> "ContainedSpaceOpens":
        instance = object.__new__(cls)
        instance._database_target = database_target
        instance._index_target = index_target
        instance._notes_handle = notes_handle
        instance._database_taken = False
        instance._file_system_taken = False
        return instance

    @property
    def database_target(self) -> BoundSQLiteTarget:
        return self._database_target

    @property
    def index_target(self) -> BoundSQLiteTarget:
        return self._index_target

    def require_all_existing_roles(self) -> None:
        return None

    def take_database_target(self) -> BoundSQLiteTarget:
        if self._database_taken:
            raise RuntimeError("database target already transferred")
        self._database_taken = True
        return self._database_target

    def take_file_system_handles(
        self,
    ) -> tuple[BoundDirectoryHandle, BoundSQLiteTarget]:
        if self._file_system_taken:
            raise RuntimeError("file-system handles already transferred")
        self._file_system_taken = True
        return self._notes_handle, self._index_target

    async def close_all(self) -> None:
        await self._database_target.aclose()
        await self._index_target.aclose()
        self._notes_handle._close()

    async def revoke_transferred_resources(self) -> None:
        await self._database_target.aclose()
        await self._index_target.aclose()
        self._notes_handle._close()

    async def close_untransferred_resources(self) -> None:
        if not self._database_taken:
            await self._database_target.aclose()
        if not self._file_system_taken:
            await self._index_target.aclose()
            self._notes_handle._close()


def _create_exact_file(path: Path) -> bool:
    try:
        descriptor = os.open(
            path,
            os.O_CREAT
            | os.O_EXCL
            | os.O_RDWR
            | getattr(os, "O_BINARY", 0)
            | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
    except FileExistsError:
        return False
    else:
        os.close(descriptor)
        return True


def _require_regular(path: Path) -> None:
    info = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode):
        raise PathOutsideSpaceError("Contained database role is not a regular file")


def open_bound_space(paths, ancestor_identities) -> ContainedSpaceOpens:
    from app.runtime.sqlite_vfs import _bind_existing_target

    del ancestor_identities
    database_created = _create_exact_file(paths.db_path)
    index_created = _create_exact_file(paths.index_db)
    _require_regular(paths.db_path)
    _require_regular(paths.index_db)
    notes_handle = BoundDirectoryHandle._create(paths.notes_dir)
    try:
        database_target = _bind_existing_target(
            paths.db_path, create_authority=database_created
        )
        index_target = _bind_existing_target(
            paths.index_db, create_authority=index_created
        )
    except BaseException:
        notes_handle._close()
        raise
    return ContainedSpaceOpens._create(
        database_target, index_target, notes_handle
    )
