from __future__ import annotations

import ctypes
import os
import secrets
import stat
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Awaitable, BinaryIO, Callable

from app.errors import PathOutsideSpaceError

if TYPE_CHECKING:
    from app.runtime.sqlite_vfs import BoundSQLiteTarget


@dataclass(frozen=True, slots=True)
class StorageIdentity:
    device: int
    file_id: int


class BoundDirectoryHandle:
    __slots__ = ("_identity", "_authority", "_descriptor")

    def __init__(self, *_args, **_kwargs) -> None:
        raise TypeError("BoundDirectoryHandle is authority-created")

    @property
    def identity(self) -> StorageIdentity:
        return self._identity

    def open_child_no_follow(self, relative_name: str, flags: int) -> BinaryIO:
        if (
            not relative_name
            or relative_name in {".", ".."}
            or "/" in relative_name
            or "\\" in relative_name
            or ":" in relative_name
        ):
            raise PathOutsideSpaceError("Contained child name is not exact")
        return self._open_relative_no_follow(relative_name, flags)

    def _open_relative_no_follow(self, relative_name: str, flags: int) -> BinaryIO:
        parts = _relative_parts(relative_name)
        parent = _open_directory_chain(self._descriptor, parts[:-1], create=False)
        try:
            if os.name == "nt":
                descriptor = _open_windows_relative_file(parent, parts[-1], flags)
            else:
                descriptor = os.open(
                    parts[-1],
                    flags | getattr(os, "O_NOFOLLOW", 0),
                    0o600,
                    dir_fd=parent,
                )
        finally:
            _close_directory_descriptor(parent)
        access_mode = flags & getattr(os, "O_ACCMODE", 3)
        mode = "rb" if access_mode == os.O_RDONLY else "wb"
        if access_mode == os.O_RDWR:
            mode = "r+b"
        return os.fdopen(descriptor, mode, closefd=True)

    def _mkdir_relative(self, relative_name: str) -> None:
        descriptor = _open_directory_chain(
            self._descriptor, _relative_parts(relative_name), create=True
        )
        _close_directory_descriptor(descriptor)

    def _relative_file_exists(self, relative_name: str) -> bool:
        try:
            child = self._open_relative_no_follow(relative_name, os.O_RDONLY)
        except FileNotFoundError:
            return False
        else:
            child.close()
            return True

    def _atomic_write_relative(self, relative_name: str, content: bytes) -> None:
        parts = _relative_parts(relative_name)
        if len(parts) > 1:
            self._mkdir_relative("/".join(parts[:-1]))
        temporary = "/".join(
            [*parts[:-1], f".{parts[-1]}.{secrets.token_hex(8)}.tmp"]
        )
        try:
            with self._open_relative_no_follow(
                temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY
            ) as child:
                child.write(content)
                child.flush()
                os.fsync(child.fileno())
            self._rename_relative(temporary, relative_name, replace=True)
        except BaseException:
            try:
                self._unlink_relative(temporary)
            except FileNotFoundError:
                pass
            raise

    def _rename_relative(
        self, source: str, destination: str, *, replace: bool = False
    ) -> None:
        source_parts = _relative_parts(source)
        destination_parts = _relative_parts(destination)
        if len(destination_parts) > 1:
            self._mkdir_relative("/".join(destination_parts[:-1]))
        source_parent = _open_directory_chain(
            self._descriptor, source_parts[:-1], create=False
        )
        try:
            destination_parent = _open_directory_chain(
                self._descriptor, destination_parts[:-1], create=False
            )
            try:
                if os.name == "nt":
                    _rename_windows_relative(
                        source_parent,
                        source_parts[-1],
                        destination_parent,
                        destination_parts[-1],
                        replace=replace,
                    )
                elif replace:
                    os.replace(
                        source_parts[-1],
                        destination_parts[-1],
                        src_dir_fd=source_parent,
                        dst_dir_fd=destination_parent,
                    )
                else:
                    if _relative_exists_posix(
                        destination_parent, destination_parts[-1]
                    ):
                        raise FileExistsError(destination)
                    os.rename(
                        source_parts[-1],
                        destination_parts[-1],
                        src_dir_fd=source_parent,
                        dst_dir_fd=destination_parent,
                    )
            finally:
                _close_directory_descriptor(destination_parent)
        finally:
            _close_directory_descriptor(source_parent)

    def _unlink_relative(self, relative_name: str) -> None:
        parts = _relative_parts(relative_name)
        parent = _open_directory_chain(self._descriptor, parts[:-1], create=False)
        try:
            if os.name == "nt":
                _unlink_windows_relative(parent, parts[-1])
            else:
                os.unlink(parts[-1], dir_fd=parent)
        finally:
            _close_directory_descriptor(parent)

    def _iter_relative_files(self, relative_name: str, *, suffix: str) -> list[str]:
        parts = _relative_parts(relative_name, allow_empty=True)
        directory = _open_directory_chain(self._descriptor, parts, create=False)
        try:
            return _iter_descriptor_files(directory, "", suffix)
        finally:
            _close_directory_descriptor(directory)

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
        return cls._from_descriptor(descriptor, identity)

    @classmethod
    def _from_descriptor(
        cls, descriptor: int, identity: StorageIdentity
    ) -> "BoundDirectoryHandle":
        instance = object.__new__(cls)
        instance._identity = identity
        instance._authority = object()
        instance._descriptor = descriptor
        return instance

    def _close(self) -> None:
        descriptor = self._descriptor
        if descriptor >= 0:
            if os.name == "nt":
                ctypes.windll.kernel32.CloseHandle(wintypes.HANDLE(descriptor))
            else:
                os.close(descriptor)
            self._descriptor = -1


def _relative_parts(relative_name: str, *, allow_empty: bool = False) -> tuple[str, ...]:
    if not relative_name:
        if allow_empty:
            return ()
        raise PathOutsideSpaceError("Contained relative name is empty")
    if relative_name.startswith("/") or "\\" in relative_name or ":" in relative_name:
        raise PathOutsideSpaceError("Contained relative name is not normalized")
    parts = tuple(relative_name.split("/"))
    if any(not part or part in {".", ".."} for part in parts):
        raise PathOutsideSpaceError("Contained relative name is not normalized")
    return parts


def _duplicate_directory_descriptor(descriptor: int) -> int:
    if os.name != "nt":
        return os.dup(descriptor)
    kernel32 = ctypes.windll.kernel32
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.DuplicateHandle.argtypes = [
        wintypes.HANDLE,
        wintypes.HANDLE,
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.HANDLE),
        wintypes.DWORD,
        wintypes.BOOL,
        wintypes.DWORD,
    ]
    kernel32.DuplicateHandle.restype = wintypes.BOOL
    source_process = kernel32.GetCurrentProcess()
    duplicate = wintypes.HANDLE()
    if not kernel32.DuplicateHandle(
        source_process,
        wintypes.HANDLE(descriptor),
        source_process,
        ctypes.byref(duplicate),
        0,
        False,
        0x00000002,
    ):
        raise ctypes.WinError()
    return int(duplicate.value)


def _close_directory_descriptor(descriptor: int) -> None:
    if os.name == "nt":
        ctypes.windll.kernel32.CloseHandle(wintypes.HANDLE(descriptor))
    else:
        os.close(descriptor)


def _open_directory_chain(
    root: int, parts: tuple[str, ...], *, create: bool
) -> int:
    current = _duplicate_directory_descriptor(root)
    try:
        for part in parts:
            if os.name == "nt":
                child = _open_windows_relative_directory(current, part, create=create)
            else:
                if create:
                    try:
                        os.mkdir(part, 0o700, dir_fd=current)
                    except FileExistsError:
                        pass
                child = os.open(
                    part,
                    os.O_RDONLY
                    | getattr(os, "O_DIRECTORY", 0)
                    | getattr(os, "O_NOFOLLOW", 0)
                    | getattr(os, "O_CLOEXEC", 0),
                    dir_fd=current,
                )
                if not stat.S_ISDIR(os.fstat(child).st_mode):
                    os.close(child)
                    raise PathOutsideSpaceError("Contained component is not a directory")
            _close_directory_descriptor(current)
            current = child
        return current
    except BaseException:
        _close_directory_descriptor(current)
        raise


def _relative_exists_posix(parent: int, basename: str) -> bool:
    try:
        os.stat(basename, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return False
    return True


def _iter_descriptor_files(directory: int, prefix: str, suffix: str) -> list[str]:
    names = _windows_directory_names(directory) if os.name == "nt" else os.listdir(directory)
    files: list[str] = []
    for name in names:
        if name in {".", ".."}:
            continue
        relative = f"{prefix}/{name}" if prefix else name
        if os.name == "nt":
            try:
                child = _open_windows_relative_directory(directory, name, create=False)
            except NotADirectoryError:
                if name.endswith(suffix):
                    files.append(relative)
            else:
                try:
                    files.extend(_iter_descriptor_files(child, relative, suffix))
                finally:
                    _close_directory_descriptor(child)
        else:
            info = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                raise PathOutsideSpaceError("Contained enumeration found a symlink")
            if stat.S_ISDIR(info.st_mode):
                child = os.open(
                    name,
                    os.O_RDONLY
                    | getattr(os, "O_DIRECTORY", 0)
                    | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=directory,
                )
                try:
                    files.extend(_iter_descriptor_files(child, relative, suffix))
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode) and name.endswith(suffix):
                files.append(relative)
    return files


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


def _windows_storage_identity(handle: int) -> StorageIdentity:
    info = _BY_HANDLE_FILE_INFORMATION()
    if not ctypes.windll.kernel32.GetFileInformationByHandle(
        wintypes.HANDLE(handle), ctypes.byref(info)
    ):
        raise ctypes.WinError()
    if info.dwFileAttributes & 0x00000400:
        raise PathOutsideSpaceError("Contained authority is a reparse point")
    file_id = (int(info.nFileIndexHigh) << 32) | int(info.nFileIndexLow)
    return StorageIdentity(int(info.dwVolumeSerialNumber), file_id)


def _descriptor_identity(descriptor: int) -> StorageIdentity:
    if os.name == "nt":
        return _windows_storage_identity(descriptor)
    info = os.fstat(descriptor)
    return StorageIdentity(info.st_dev, info.st_ino)


def _identity_matches_receipt(
    identity: StorageIdentity, receipt: tuple[str, int, int, int]
) -> bool:
    if os.name == "nt":
        return identity.file_id == receipt[2]
    return (identity.device, identity.file_id) == (receipt[1], receipt[2])


class _WindowsUnicodeString(ctypes.Structure):
    _fields_ = [
        ("length", ctypes.c_ushort),
        ("maximum_length", ctypes.c_ushort),
        ("buffer", ctypes.c_wchar_p),
    ]


class _WindowsObjectAttributes(ctypes.Structure):
    _fields_ = [
        ("length", ctypes.c_ulong),
        ("root_directory", ctypes.c_void_p),
        ("object_name", ctypes.POINTER(_WindowsUnicodeString)),
        ("attributes", ctypes.c_ulong),
        ("security_descriptor", ctypes.c_void_p),
        ("security_quality_of_service", ctypes.c_void_p),
    ]


class _WindowsIoStatusBlock(ctypes.Structure):
    _fields_ = [("status", ctypes.c_void_p), ("information", ctypes.c_size_t)]


def _nt_open_windows_relative(
    parent: int,
    basename: str,
    *,
    desired_access: int,
    disposition: int,
    options: int,
    file_attributes: int,
    expected_directory: bool,
) -> int:
    name_buffer = ctypes.create_unicode_buffer(basename)
    name = _WindowsUnicodeString(
        length=len(basename.encode("utf-16-le")),
        maximum_length=ctypes.sizeof(name_buffer),
        buffer=ctypes.cast(name_buffer, ctypes.c_wchar_p),
    )
    attributes = _WindowsObjectAttributes(
        length=ctypes.sizeof(_WindowsObjectAttributes),
        root_directory=parent,
        object_name=ctypes.pointer(name),
        attributes=0x00000040,
        security_descriptor=None,
        security_quality_of_service=None,
    )
    status_block = _WindowsIoStatusBlock()
    handle = wintypes.HANDLE()
    nt_create_file = ctypes.windll.ntdll.NtCreateFile
    nt_create_file.restype = ctypes.c_long
    status = nt_create_file(
        ctypes.byref(handle),
        desired_access,
        ctypes.byref(attributes),
        ctypes.byref(status_block),
        None,
        file_attributes,
        0x00000001 | 0x00000002,
        disposition,
        options,
        None,
        0,
    )
    if status < 0:
        unsigned = ctypes.c_ulong(status).value
        if unsigned in {0xC0000034, 0xC000003A}:
            raise FileNotFoundError(basename)
        if unsigned in {0xC0000035, 0xC0000056}:
            raise FileExistsError(basename)
        if unsigned == 0xC0000103:
            raise NotADirectoryError(basename)
        if unsigned == 0xC00000BA:
            raise IsADirectoryError(basename)
        raise OSError(f"NtCreateFile failed with NTSTATUS 0x{unsigned:08x}")
    raw_handle = int(handle.value)
    info = _BY_HANDLE_FILE_INFORMATION()
    try:
        if not ctypes.windll.kernel32.GetFileInformationByHandle(
            wintypes.HANDLE(raw_handle), ctypes.byref(info)
        ):
            raise ctypes.WinError()
        if info.dwFileAttributes & 0x00000400:
            raise PathOutsideSpaceError("Contained child is a reparse point")
        is_directory = bool(info.dwFileAttributes & 0x00000010)
        if expected_directory and not is_directory:
            raise NotADirectoryError(basename)
        if not expected_directory and is_directory:
            raise IsADirectoryError(basename)
    except BaseException:
        ctypes.windll.kernel32.CloseHandle(wintypes.HANDLE(raw_handle))
        raise
    return raw_handle


def _open_windows_relative_file(parent: int, basename: str, flags: int) -> int:
    import msvcrt

    access_mode = flags & getattr(os, "O_ACCMODE", 3)
    desired_access = 0x00000080 | 0x00100000
    if access_mode != os.O_WRONLY:
        desired_access |= 0x00000001
    if access_mode != os.O_RDONLY:
        desired_access |= 0x00000002
    if flags & os.O_APPEND:
        desired_access |= 0x00000004
    create = bool(flags & os.O_CREAT)
    exclusive = bool(flags & os.O_EXCL)
    truncate = bool(flags & os.O_TRUNC)
    if create and exclusive:
        disposition = 0x00000002
    elif create and truncate:
        disposition = 0x00000005
    elif create:
        disposition = 0x00000003
    elif truncate:
        disposition = 0x00000004
    else:
        disposition = 0x00000001
    raw_handle = _nt_open_windows_relative(
        parent,
        basename,
        desired_access=desired_access,
        disposition=disposition,
        options=0x00000020 | 0x00000040 | 0x00200000,
        file_attributes=0x00000080,
        expected_directory=False,
    )
    try:
        return msvcrt.open_osfhandle(raw_handle, flags)
    except BaseException:
        ctypes.windll.kernel32.CloseHandle(wintypes.HANDLE(raw_handle))
        raise


def _open_windows_relative_directory(
    parent: int, basename: str, *, create: bool
) -> int:
    return _nt_open_windows_relative(
        parent,
        basename,
        desired_access=0x00000001 | 0x00000080 | 0x00100000,
        disposition=0x00000003 if create else 0x00000001,
        options=0x00000001 | 0x00000020 | 0x00200000,
        file_attributes=0x00000010,
        expected_directory=True,
    )


class _WindowsFileRenameInfo(ctypes.Structure):
    _fields_ = [
        ("replace_if_exists", ctypes.c_ubyte),
        ("root_directory", ctypes.c_void_p),
        ("file_name_length", wintypes.DWORD),
        ("file_name", wintypes.WCHAR * 1),
    ]


def _rename_windows_relative(
    source_parent: int,
    source_name: str,
    destination_parent: int,
    destination_name: str,
    *,
    replace: bool,
) -> None:
    source = _nt_open_windows_relative(
        source_parent,
        source_name,
        desired_access=0x00010000 | 0x00000080 | 0x00100000,
        disposition=0x00000001,
        options=0x00000020 | 0x00000040 | 0x00200000,
        file_attributes=0x00000080,
        expected_directory=False,
    )
    encoded_name = destination_name.encode("utf-16-le")
    size = _WindowsFileRenameInfo.file_name.offset + len(encoded_name)
    buffer = ctypes.create_string_buffer(size + len(encoded_name))
    info = ctypes.cast(buffer, ctypes.POINTER(_WindowsFileRenameInfo)).contents
    info.replace_if_exists = replace
    info.root_directory = destination_parent
    info.file_name_length = len(encoded_name)
    ctypes.memmove(
        ctypes.addressof(buffer) + _WindowsFileRenameInfo.file_name.offset,
        encoded_name,
        len(encoded_name),
    )
    try:
        status_block = _WindowsIoStatusBlock()
        set_information = ctypes.windll.ntdll.NtSetInformationFile
        set_information.restype = ctypes.c_long
        status = set_information(
            wintypes.HANDLE(source),
            ctypes.byref(status_block),
            ctypes.byref(buffer),
            ctypes.sizeof(buffer),
            10,
        )
        if status < 0:
            unsigned = ctypes.c_ulong(status).value
            raise OSError(
                f"NtSetInformationFile rename failed with NTSTATUS 0x{unsigned:08x}"
            )
    finally:
        ctypes.windll.kernel32.CloseHandle(wintypes.HANDLE(source))


def _unlink_windows_relative(parent: int, basename: str) -> None:
    class _FileDispositionInfo(ctypes.Structure):
        _fields_ = [("delete_file", wintypes.BOOL)]

    handle = _nt_open_windows_relative(
        parent,
        basename,
        desired_access=0x00010000 | 0x00000080 | 0x00100000,
        disposition=0x00000001,
        options=0x00000020 | 0x00000040 | 0x00200000,
        file_attributes=0x00000080,
        expected_directory=False,
    )
    try:
        disposition = _FileDispositionInfo(delete_file=True)
        if not ctypes.windll.kernel32.SetFileInformationByHandle(
            wintypes.HANDLE(handle),
            4,
            ctypes.byref(disposition),
            ctypes.sizeof(disposition),
        ):
            raise ctypes.WinError()
    finally:
        ctypes.windll.kernel32.CloseHandle(wintypes.HANDLE(handle))


def _windows_directory_names(directory: int) -> list[str]:
    query = ctypes.windll.ntdll.NtQueryDirectoryFile
    query.restype = ctypes.c_long
    names: list[str] = []
    restart = True
    while True:
        buffer = ctypes.create_string_buffer(65536)
        status_block = _WindowsIoStatusBlock()
        status = query(
            wintypes.HANDLE(directory),
            None,
            None,
            None,
            ctypes.byref(status_block),
            ctypes.byref(buffer),
            ctypes.sizeof(buffer),
            12,
            False,
            None,
            restart,
        )
        restart = False
        unsigned = ctypes.c_ulong(status).value
        if unsigned == 0x80000006:
            break
        if status < 0:
            raise OSError(
                f"NtQueryDirectoryFile failed with NTSTATUS 0x{unsigned:08x}"
            )
        offset = 0
        while offset < status_block.information:
            next_offset = ctypes.c_ulong.from_buffer(buffer, offset).value
            name_length = ctypes.c_ulong.from_buffer(buffer, offset + 8).value
            name_bytes = bytes(buffer[offset + 12 : offset + 12 + name_length])
            names.append(name_bytes.decode("utf-16-le"))
            if next_offset == 0:
                break
            offset += next_offset
    return names


def _open_windows_directory(location: Path) -> tuple[int, StorageIdentity]:
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateFileW.restype = wintypes.HANDLE
    handle = kernel32.CreateFileW(
        os.fspath(location),
        0x00000001 | 0x00000080 | 0x00100000,
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
    if info.dwFileAttributes & 0x00000400:
        kernel32.CloseHandle(handle)
        raise PathOutsideSpaceError("Contained root is a reparse point")
    file_id = (int(info.nFileIndexHigh) << 32) | int(info.nFileIndexLow)
    return int(handle), StorageIdentity(int(info.dwVolumeSerialNumber), file_id)


class ContainedSpaceOpens:
    __slots__ = (
        "_database_target",
        "_index_target",
        "_notes_handle",
        "_database_taken",
        "_file_system_taken",
        "_revocation_callbacks",
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
        instance._revocation_callbacks: list[Callable[[], Awaitable[None]]] = []
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

    def _register_revocation_callback(
        self, callback: Callable[[], Awaitable[None]]
    ) -> None:
        self._revocation_callbacks.append(callback)

    async def close_all(self) -> None:
        await self._database_target.aclose()
        await self._index_target.aclose()
        self._notes_handle._close()

    async def revoke_transferred_resources(self) -> None:
        callbacks = self._revocation_callbacks
        self._revocation_callbacks = []
        errors: list[BaseException] = []
        for callback in callbacks:
            try:
                await callback()
            except BaseException as error:
                errors.append(error)
        for close in (self._database_target.aclose, self._index_target.aclose):
            try:
                await close()
            except BaseException as error:
                errors.append(error)
        try:
            self._notes_handle._close()
        except BaseException as error:
            errors.append(error)
        if errors:
            raise BaseExceptionGroup("transferred resource revocation failed", errors)

    async def close_untransferred_resources(self) -> None:
        self._revocation_callbacks = []
        if not self._database_taken:
            await self._database_target.aclose()
        if not self._file_system_taken:
            await self._index_target.aclose()
            self._notes_handle._close()


def _open_root_authority(root: Path) -> tuple[int, StorageIdentity]:
    if os.name == "nt":
        return _open_windows_directory(root)
    descriptor = os.open(
        root,
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0),
    )
    identity = _descriptor_identity(descriptor)
    return descriptor, identity


def _open_verified_parent(
    root: int,
    parts: tuple[str, ...],
    receipts: tuple[tuple[str, int, int, int], ...],
) -> int:
    if len(receipts) != len(parts) + 1:
        raise PathOutsideSpaceError("Contained ancestor receipt is incomplete")
    current = _duplicate_directory_descriptor(root)
    try:
        for index, part in enumerate(parts, start=1):
            if os.name == "nt":
                child = _open_windows_relative_directory(current, part, create=False)
            else:
                child = os.open(
                    part,
                    os.O_RDONLY
                    | getattr(os, "O_DIRECTORY", 0)
                    | getattr(os, "O_NOFOLLOW", 0)
                    | getattr(os, "O_CLOEXEC", 0),
                    dir_fd=current,
                )
            identity = _descriptor_identity(child)
            if not _identity_matches_receipt(identity, receipts[index]):
                _close_directory_descriptor(child)
                raise PathOutsideSpaceError("Contained ancestor identity changed")
            _close_directory_descriptor(current)
            current = child
        return current
    except BaseException:
        _close_directory_descriptor(current)
        raise


def _open_relative_regular(
    parent: int, basename: str
) -> tuple[int, StorageIdentity, bool]:
    if not basename or "/" in basename or "\\" in basename or ":" in basename:
        raise PathOutsideSpaceError("Contained database name is not exact")
    if os.name == "nt":
        desired_access = 0x80000000 | 0x40000000 | 0x00000080 | 0x00100000
        try:
            descriptor = _nt_open_windows_relative(
                parent,
                basename,
                desired_access=desired_access,
                disposition=0x00000002,
                options=0x00000020 | 0x00000040 | 0x00200000,
                file_attributes=0x00000080,
                expected_directory=False,
            )
        except FileExistsError:
            created = False
            descriptor = _nt_open_windows_relative(
                parent,
                basename,
                desired_access=desired_access,
                disposition=0x00000001,
                options=0x00000020 | 0x00000040 | 0x00200000,
                file_attributes=0x00000080,
                expected_directory=False,
            )
        else:
            created = True
        return descriptor, _descriptor_identity(descriptor), created

    flags = (
        os.O_RDWR
        | getattr(os, "O_BINARY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0)
    )
    try:
        descriptor = os.open(
            basename, flags | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=parent
        )
    except FileExistsError:
        created = False
        descriptor = os.open(basename, flags, dir_fd=parent)
    else:
        created = True
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode):
        os.close(descriptor)
        raise PathOutsideSpaceError("Contained database role is not a regular file")
    return descriptor, StorageIdentity(info.st_dev, info.st_ino), created


def _open_relative_directory(parent: int, basename: str) -> tuple[int, StorageIdentity]:
    if not basename or "/" in basename or "\\" in basename or ":" in basename:
        raise PathOutsideSpaceError("Contained directory name is not exact")
    if os.name == "nt":
        descriptor = _open_windows_relative_directory(parent, basename, create=False)
    else:
        descriptor = os.open(
            basename,
            os.O_RDONLY
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0),
            dir_fd=parent,
        )
    return descriptor, _descriptor_identity(descriptor)


def _close_file_descriptor(descriptor: int) -> None:
    if descriptor < 0:
        return
    if os.name == "nt":
        ctypes.windll.kernel32.CloseHandle(wintypes.HANDLE(descriptor))
    else:
        os.close(descriptor)


def _remove_created_role(parent: int, basename: str) -> None:
    if os.name == "nt":
        _unlink_windows_relative(parent, basename)
    else:
        os.unlink(basename, dir_fd=parent)


def _fault_hook(_name: str) -> None:
    return None


def open_bound_space(paths, ancestor_identities) -> ContainedSpaceOpens:
    from app.runtime.scope import _walk_existing_ancestors
    from app.runtime.sqlite_vfs import (
        _bind_open_authority,
        _revoke_unopened_target,
    )

    receipts = tuple(ancestor_identities)
    parent_parts = paths.db_path.parent.relative_to(paths.space_root).parts
    if not parent_parts or any(part in {"", ".", ".."} for part in parent_parts):
        raise PathOutsideSpaceError("Contained Space parent is not normalized")
    if paths.notes_dir.parent != paths.db_path.parent:
        raise PathOutsideSpaceError("Contained storage roles have different parents")

    root = -1
    parent = -1
    database_main = -1
    index_main = -1
    notes_descriptor = -1
    database_created = False
    index_created = False
    database_target = None
    index_target = None
    notes_handle = None
    try:
        root, root_identity = _open_root_authority(paths.space_root)
        if not receipts or not _identity_matches_receipt(root_identity, receipts[0]):
            raise PathOutsideSpaceError("Contained root identity changed")
        parent = _open_verified_parent(root, parent_parts, receipts)
        database_main, database_identity, database_created = _open_relative_regular(
            parent, paths.db_path.name
        )
        index_main, index_identity, index_created = _open_relative_regular(
            parent, paths.index_db.name
        )

        _fault_hook("before_sqlite_bound_connect")
        database_target = _bind_open_authority(
            parent,
            database_main,
            database_identity,
            paths.db_path.name,
            create_authority=database_created,
        )
        index_target = _bind_open_authority(
            parent,
            index_main,
            index_identity,
            paths.index_db.name,
            create_authority=index_created,
        )

        _fault_hook("before_filesystem_handle_open")
        notes_descriptor, notes_identity = _open_relative_directory(
            parent, paths.notes_dir.name
        )
        notes_handle = BoundDirectoryHandle._from_descriptor(
            notes_descriptor, notes_identity
        )
        notes_descriptor = -1

        if _walk_existing_ancestors(paths) != receipts:
            raise PathOutsideSpaceError("Contained namespace changed during open")
        return ContainedSpaceOpens._create(
            database_target, index_target, notes_handle
        )
    except BaseException as primary:
        cleanup_errors: list[BaseException] = []
        for target in (database_target, index_target):
            if target is not None:
                try:
                    _revoke_unopened_target(target)
                except BaseException as error:
                    cleanup_errors.append(error)
        if notes_handle is not None:
            try:
                notes_handle._close()
            except BaseException as error:
                cleanup_errors.append(error)
        _close_file_descriptor(database_main)
        database_main = -1
        _close_file_descriptor(index_main)
        index_main = -1
        for created, basename in (
            (database_created, paths.db_path.name),
            (index_created, paths.index_db.name),
        ):
            if created and parent >= 0:
                try:
                    _remove_created_role(parent, basename)
                except BaseException as error:
                    cleanup_errors.append(error)
        if cleanup_errors:
            raise BaseExceptionGroup(
                "contained open and cleanup failed", [primary, *cleanup_errors]
            ) from None
        raise
    finally:
        _close_file_descriptor(database_main)
        _close_file_descriptor(index_main)
        _close_file_descriptor(notes_descriptor)
        if parent >= 0:
            _close_directory_descriptor(parent)
        if root >= 0:
            _close_directory_descriptor(root)
