from __future__ import annotations

import asyncio
import ctypes
import errno
import hashlib
import os
import secrets
import sqlite3
import stat
import threading
import weakref
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import aiosqlite
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.pool import AsyncAdaptedQueuePool

from app.errors import SQLiteAuthorityRevokedError
from app.runtime.contained_io import StorageIdentity
from app.runtime.joined_thread import run_joined_awaitable


@dataclass(frozen=True, slots=True)
class AsyncEngineOptions:
    echo: bool = False
    pool_size: int = 5
    max_overflow: int = 10
    busy_timeout_ms: int = 5_000

    def __post_init__(self) -> None:
        if self.pool_size < 0 or self.max_overflow < 0:
            raise ValueError("pool sizes cannot be negative")
        if self.busy_timeout_ms <= 0:
            raise ValueError("busy timeout must be positive")


@dataclass(frozen=True, slots=True)
class MaintenanceOptions:
    read_only: bool
    create_if_missing: bool = False
    busy_timeout_ms: int = 5_000

    def __post_init__(self) -> None:
        if self.read_only and self.create_if_missing:
            raise ValueError("read-only maintenance cannot create a database")
        if self.busy_timeout_ms <= 0:
            raise ValueError("busy timeout must be positive")


@dataclass(frozen=True, slots=True)
class _BootstrapReceipt:
    vfs_name: str
    control_sqlite_source_id: str
    extension_sqlite_source_id: str
    control_sqlite_version: str
    extension_sqlite_version: str
    extension_loading_enabled_after_bootstrap: bool


@dataclass(frozen=True, slots=True)
class _BindingReceipt:
    virtual_filename: str
    live_file_references: int


@dataclass(slots=True)
class _TargetAuthority:
    token: str
    create_authority: bool
    parent_descriptor: int
    basename: str
    revoked: bool = False
    sealed: bool = False


@dataclass(slots=True)
class _IsolatedCleanupAuthority:
    target: _TargetAuthority
    parent_descriptor: int
    target_basename: str
    marker_basename: str
    target_identity: StorageIdentity
    marker_identity: StorageIdentity
    terminal: str | None = None
    completed_deletes: set[str] = field(default_factory=set)
    attempted_deletes: set[str] = field(default_factory=set)


_BOOTSTRAP_LOCK = threading.RLock()
_CONTROL: sqlite3.Connection | None = None
_BOOTSTRAP_RECEIPT: _BootstrapReceipt | None = None


def _terminal_fault_hook(_stage: str) -> None:
    return None


def _mark_physical_completion(error: BaseException, operation: str) -> None:
    setattr(error, "_pxii_physical_completion", operation)


def _has_physical_completion(error: BaseException, operation: str) -> bool:
    return getattr(error, "_pxii_physical_completion", None) == operation


def _backend_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _native_package_roots() -> tuple[Path, ...]:
    try:
        import pomodoroxii_native  # type: ignore[import-not-found]
    except ImportError:
        return ()
    return tuple(Path(location).resolve() for location in pomodoroxii_native.__path__)


def _extension_candidates() -> tuple[Path, ...]:
    configured = os.environ.get("POMODOROXII_PXII_VFS_EXTENSION")
    suffixes = (".pyd", ".dll") if os.name == "nt" else (".so",)
    if configured:
        selected = Path(configured).resolve()
        return (selected,) if selected.is_file() else ()
    candidates: list[Path] = []
    root = _backend_root()
    for build_dir in (root / ".native-build", root / "_skbuild"):
        for suffix in suffixes:
            candidates.extend(build_dir.rglob(f"_pxii_vfs*{suffix}")) if build_dir.exists() else None
    for location in _native_package_roots():
        for suffix in suffixes:
            candidates.extend(location.glob(f"_pxii_vfs*{suffix}"))
    return tuple(dict.fromkeys(path.resolve() for path in candidates if path.is_file()))


def _source_closure_root() -> Path:
    source_root = _backend_root()
    if (source_root / "cmake" / "pxii-vfs-source.sha256").is_file():
        return source_root
    packaged = tuple(
        root
        for root in _native_package_roots()
        if (root / "cmake" / "pxii-vfs-source.sha256").is_file()
    )
    if len(packaged) != 1:
        raise RuntimeError(f"expected exactly one pxii-vfs source closure, found {len(packaged)}")
    return packaged[0]


def _verify_source_manifest() -> None:
    source_root = _source_closure_root()
    manifest = source_root / "cmake" / "pxii-vfs-source.sha256"
    if not manifest.is_file():
        raise RuntimeError("pxii-vfs source manifest is missing")
    for line in manifest.read_text(encoding="ascii").splitlines():
        expected, relative = line.split("  ", 1)
        source = source_root / relative
        actual = hashlib.sha256(source.read_bytes()).hexdigest()
        if actual != expected:
            raise RuntimeError(f"pxii-vfs source hash mismatch: {relative}")


def _bootstrap() -> tuple[sqlite3.Connection, _BootstrapReceipt]:
    global _CONTROL, _BOOTSTRAP_RECEIPT
    with _BOOTSTRAP_LOCK:
        if _CONTROL is not None and _BOOTSTRAP_RECEIPT is not None:
            return _CONTROL, _BOOTSTRAP_RECEIPT
        _verify_source_manifest()
        candidates = _extension_candidates()
        if len(candidates) != 1:
            raise RuntimeError(f"expected exactly one pxii-vfs extension, found {len(candidates)}")
        control = sqlite3.connect(":memory:", check_same_thread=False)
        try:
            control.enable_load_extension(True)
            control.load_extension(
                os.fspath(candidates[0]), entrypoint="sqlite3_pxiivfs_init"
            )
        finally:
            control.enable_load_extension(False)
        control_source = control.execute("SELECT sqlite_source_id()").fetchone()[0]
        extension_source = control.execute("SELECT pxii_source_id()").fetchone()[0]
        receipt = _BootstrapReceipt(
            vfs_name=control.execute("SELECT pxii_vfs_name()").fetchone()[0],
            control_sqlite_source_id=control_source,
            extension_sqlite_source_id=extension_source,
            control_sqlite_version=sqlite3.sqlite_version,
            extension_sqlite_version=control.execute("SELECT sqlite_version()").fetchone()[0],
            extension_loading_enabled_after_bootstrap=False,
        )
        if receipt.control_sqlite_source_id != receipt.extension_sqlite_source_id:
            control.close()
            raise RuntimeError("pxii-vfs loaded against a different SQLite library")
        _CONTROL = control
        _BOOTSTRAP_RECEIPT = receipt
        return control, receipt


def _bootstrap_receipt() -> _BootstrapReceipt:
    return _bootstrap()[1]


class _ClosedSurfaceMeta(type):
    def __dir__(cls) -> list[str]:
        private = [name for name in super().__dir__() if name.startswith("_")]
        return [*private, "identity", "make_async_engine", "open_maintenance", "aclose"]


class _MaintenanceCursor:
    __slots__ = ("__cursor", "__weakref__")

    def __init__(self, cursor: sqlite3.Cursor) -> None:
        self.__cursor: sqlite3.Cursor | None = cursor

    def _require_cursor(self) -> sqlite3.Cursor:
        if self.__cursor is None:
            raise sqlite3.ProgrammingError("Cannot operate on a closed cursor")
        return self.__cursor

    def fetchone(self) -> Any:
        return self._require_cursor().fetchone()

    def fetchmany(self, size: int | None = None) -> list[Any]:
        if size is None:
            return self._require_cursor().fetchmany()
        return self._require_cursor().fetchmany(size)

    def fetchall(self) -> list[Any]:
        return self._require_cursor().fetchall()

    def __iter__(self) -> _MaintenanceCursor:
        return self

    def __next__(self) -> Any:
        return next(self._require_cursor())

    def _close(self) -> None:
        cursor = self.__cursor
        self.__cursor = None
        if cursor is not None:
            cursor.close()

    def __del__(self) -> None:
        try:
            self._close()
        except BaseException:
            pass

    @property
    def description(self) -> Any:
        return self._require_cursor().description

    @property
    def lastrowid(self) -> int | None:
        return self._require_cursor().lastrowid

    @property
    def rowcount(self) -> int:
        return self._require_cursor().rowcount


class _MaintenanceConnection:
    __slots__ = ("__connection", "__cursors")

    def __init__(self, connection: sqlite3.Connection) -> None:
        self.__connection = connection
        self.__cursors: weakref.WeakSet[_MaintenanceCursor] = weakref.WeakSet()

    def _wrap(self, cursor: sqlite3.Cursor) -> _MaintenanceCursor:
        wrapped = _MaintenanceCursor(cursor)
        self.__cursors.add(wrapped)
        return wrapped

    def execute(self, sql: str, parameters: Any = ()) -> _MaintenanceCursor:
        return self._wrap(self.__connection.execute(sql, parameters))

    def executemany(self, sql: str, parameters: Any) -> _MaintenanceCursor:
        return self._wrap(self.__connection.executemany(sql, parameters))

    def commit(self) -> None:
        self.__connection.commit()

    def rollback(self) -> None:
        self.__connection.rollback()

    @property
    def row_factory(self) -> Any:
        return self.__connection.row_factory

    @row_factory.setter
    def row_factory(self, value: Any) -> None:
        self.__connection.row_factory = value

    @property
    def in_transaction(self) -> bool:
        return self.__connection.in_transaction

    @property
    def total_changes(self) -> int:
        return self.__connection.total_changes

    def _close(self) -> None:
        errors: list[BaseException] = []
        for cursor in tuple(self.__cursors):
            try:
                cursor._close()
            except BaseException as error:
                errors.append(error)
        self.__cursors.clear()
        try:
            self.__connection.close()
        except BaseException as error:
            errors.append(error)
        if errors:
            raise BaseExceptionGroup("maintenance adapter close failed", errors)


class _MaintenanceContext(AbstractContextManager[_MaintenanceConnection]):
    __slots__ = ("__adapter",)

    def __init__(self, connection: sqlite3.Connection) -> None:
        self.__adapter = _MaintenanceConnection(connection)

    def __enter__(self) -> _MaintenanceConnection:
        return self.__adapter

    def __exit__(self, *_exc_info: object) -> None:
        self.__adapter._close()


class BoundSQLiteTarget(metaclass=_ClosedSurfaceMeta):
    __slots__ = ("_identity", "_authority")

    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        raise TypeError("BoundSQLiteTarget is authority-created")

    @classmethod
    def _create(
        cls, identity: StorageIdentity, authority: _TargetAuthority
    ) -> BoundSQLiteTarget:
        instance = object.__new__(cls)
        instance._identity = identity
        instance._authority = authority
        return instance

    @property
    def identity(self) -> StorageIdentity:
        return self._identity

    def _require_live(self) -> _TargetAuthority:
        if self._authority.revoked or self._authority.sealed:
            raise SQLiteAuthorityRevokedError()
        return self._authority

    def make_async_engine(self, options: AsyncEngineOptions) -> AsyncEngine:
        authority = self._require_live()

        async def connect() -> aiosqlite.Connection:
            if authority.revoked or authority.sealed:
                raise SQLiteAuthorityRevokedError()
            connection = await run_joined_awaitable(
                aiosqlite.connect(
                    _virtual_uri(authority),
                    uri=True,
                    timeout=options.busy_timeout_ms / 1000,
                ),
                dispose_cancelled_result=lambda value: value.close(),
            )
            try:
                await connection._execute(connection._conn.enable_load_extension, False)
                await connection._execute(
                    connection._conn.set_authorizer, _sqlite_authorizer
                )
                await connection.execute(
                    f"PRAGMA busy_timeout={options.busy_timeout_ms}"
                )
                await connection.execute("PRAGMA foreign_keys=ON")
            except BaseException as primary:
                try:
                    await run_joined_awaitable(connection.close())
                except BaseException as close_error:
                    raise BaseExceptionGroup(
                        "async SQLite configuration and close failed",
                        [primary, close_error],
                    ) from None
                raise
            return connection

        return create_async_engine(
            "sqlite+aiosqlite://",
            async_creator=connect,
            echo=options.echo,
            poolclass=AsyncAdaptedQueuePool,
            pool_size=options.pool_size,
            max_overflow=options.max_overflow,
        )

    def open_maintenance(
        self, options: MaintenanceOptions
    ) -> AbstractContextManager[_MaintenanceConnection]:
        authority = self._require_live()
        if options.create_if_missing and not authority.create_authority:
            raise ValueError("target does not carry isolated create authority")
        connection = sqlite3.connect(
            _virtual_uri(authority),
            uri=True,
            timeout=options.busy_timeout_ms / 1000,
        )
        connection.execute(f"PRAGMA busy_timeout={options.busy_timeout_ms}")
        connection.execute("PRAGMA foreign_keys=ON")
        if options.read_only:
            connection.execute("PRAGMA query_only=ON")
        connection.enable_load_extension(False)
        connection.set_authorizer(_sqlite_authorizer)
        return _MaintenanceContext(connection)

    async def aclose(self) -> None:
        authority = self._authority
        authority.revoked = True
        control, _receipt = _bootstrap()
        while True:
            with _BOOTSTRAP_LOCK:
                control.execute("SELECT pxii_revoke(?)", (authority.token,)).fetchone()
                references = control.execute(
                    "SELECT pxii_live_references(?)", (authority.token,)
                ).fetchone()[0]
            if references < 0:
                _close_target_parent(authority)
                return
            if references == 0:
                raise RuntimeError("native SQLite authority did not unlink after drain")
            await asyncio.sleep(0.01)


def _virtual_uri(authority: _TargetAuthority) -> str:
    if authority.revoked or authority.sealed:
        raise SQLiteAuthorityRevokedError()
    return f"file:pxii-{authority.token}?vfs=pxii"


def _test_binding_receipt(target: BoundSQLiteTarget) -> _BindingReceipt:
    authority = target._require_live()
    control, _receipt = _bootstrap()
    with _BOOTSTRAP_LOCK:
        references = control.execute(
            "SELECT pxii_live_references(?)", (authority.token,)
        ).fetchone()[0]
    return _BindingReceipt(
        virtual_filename=_virtual_uri(authority),
        live_file_references=int(references),
    )


def _test_set_open_delay(target: BoundSQLiteTarget, delay_ms: int) -> None:
    authority = target._require_live()
    control, _receipt = _bootstrap()
    with _BOOTSTRAP_LOCK:
        accepted = control.execute(
            "SELECT pxii_set_open_delay(?, ?)", (authority.token, delay_ms)
        ).fetchone()[0]
    if accepted != 1:
        raise RuntimeError("native binding rejected test delay")


def _test_memory_open_probe() -> dict[str, int | bool]:
    control, _receipt = _bootstrap()
    with _BOOTSTRAP_LOCK:
        raw = control.execute("SELECT pxii_probe_memory()").fetchone()[0]
    operations, namespace_opens, round_trip = (int(value) for value in raw.split("|"))
    return {
        "executed_operations": operations,
        "namespace_open_count": namespace_opens,
        "round_trip": bool(round_trip),
    }


def _sqlite_authorizer(
    action: int,
    argument_one: str | None,
    argument_two: str | None,
    _database: str | None,
    _trigger: str | None,
) -> int:
    if action in {sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH}:
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_FUNCTION and argument_two == "load_extension":
        return sqlite3.SQLITE_DENY
    if (
        action == sqlite3.SQLITE_PRAGMA
        and argument_one is not None
        and argument_one.lower()
        in {
            "writable_schema",
            "trusted_schema",
            "temp_store_directory",
            "data_store_directory",
            "query_only",
        }
    ):
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


def _windows_file_identity(handle: int) -> StorageIdentity:
    from app.runtime.contained_io import _BY_HANDLE_FILE_INFORMATION

    info = _BY_HANDLE_FILE_INFORMATION()
    kernel32 = ctypes.windll.kernel32
    if not kernel32.GetFileInformationByHandle(handle, ctypes.byref(info)):
        raise ctypes.WinError()
    file_id = (int(info.nFileIndexHigh) << 32) | int(info.nFileIndexLow)
    return StorageIdentity(int(info.dwVolumeSerialNumber), file_id)


def _open_authority(path: Path) -> tuple[int, int, StorageIdentity]:
    if os.name == "nt":
        from ctypes import wintypes

        from app.runtime.contained_io import _open_windows_directory

        parent, _identity = _open_windows_directory(path.parent)
        kernel32 = ctypes.windll.kernel32
        kernel32.CreateFileW.restype = wintypes.HANDLE
        main = kernel32.CreateFileW(
            os.fspath(path),
            0x80000000 | 0x40000000,
            0x00000001 | 0x00000002,
            None,
            3,
            0x00200000 | 0x10000000 | 0x40000000,
            None,
        )
        invalid = ctypes.c_void_p(-1).value
        if main in {None, invalid}:
            kernel32.CloseHandle(parent)
            raise ctypes.WinError()
        return int(parent), int(main), _windows_file_identity(int(main))

    parent = os.open(
        path.parent,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        main = os.open(
            path.name,
            os.O_RDWR | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=parent,
        )
    except BaseException:
        os.close(parent)
        raise
    info = os.fstat(main)
    return parent, main, StorageIdentity(info.st_dev, info.st_ino)


def _close_authority(parent: int, main: int) -> None:
    if os.name == "nt":
        kernel32 = ctypes.windll.kernel32
        kernel32.CloseHandle(parent)
        kernel32.CloseHandle(main)
    else:
        os.close(parent)
        os.close(main)


def _open_parent_authority(parent: Path) -> int:
    if os.name == "nt":
        from app.runtime.contained_io import _open_windows_directory

        descriptor, _identity = _open_windows_directory(parent)
        return descriptor
    return os.open(
        parent,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
    )


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


def _windows_open_relative(parent: int, basename: str, *, delete: bool) -> int:
    from ctypes import wintypes

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
    desired_access = 0x80000000 | 0x00100000
    if delete:
        desired_access |= 0x00010000
    status = nt_create_file(
        ctypes.byref(handle),
        desired_access,
        ctypes.byref(attributes),
        ctypes.byref(status_block),
        None,
        0x00000080,
        0x00000001 | 0x00000002 | 0x00000004,
        0x00000001,
        0x00000040 | 0x00200000,
        None,
        0,
    )
    if status < 0:
        unsigned = ctypes.c_ulong(status).value
        if unsigned in {0xC0000034, 0xC000003A}:
            raise FileNotFoundError(basename)
        raise OSError(f"NtCreateFile failed with NTSTATUS 0x{unsigned:08x}")
    return int(handle.value)


def _relative_identity(parent: int, basename: str) -> StorageIdentity:
    if os.name == "nt":
        handle = _windows_open_relative(parent, basename, delete=False)
        try:
            return _windows_file_identity(handle)
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    descriptor = os.open(
        basename,
        os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
        dir_fd=parent,
    )
    try:
        info = os.fstat(descriptor)
        return StorageIdentity(info.st_dev, info.st_ino)
    finally:
        os.close(descriptor)


def _delete_relative(
    parent: int,
    basename: str,
    expected_identity: StorageIdentity | None,
) -> None:
    if os.name == "nt":
        class _FileDispositionInfo(ctypes.Structure):
            _fields_ = [("delete_file", ctypes.c_int)]

        handle = _windows_open_relative(parent, basename, delete=True)
        deleted = False
        try:
            if (
                expected_identity is not None
                and _windows_file_identity(handle) != expected_identity
            ):
                raise ValueError("isolated cleanup identity mismatch")
            disposition = _FileDispositionInfo(delete_file=1)
            if not ctypes.windll.kernel32.SetFileInformationByHandle(
                handle, 4, ctypes.byref(disposition), ctypes.sizeof(disposition)
            ):
                raise ctypes.WinError()
            deleted = True
            _terminal_fault_hook("delete_relative_after_unlink_before_receipt")
        except BaseException as error:
            if deleted:
                _mark_physical_completion(error, "delete")
            raise
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
        return
    descriptor = os.open(
        basename,
        os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
        dir_fd=parent,
    )
    deleted = False
    try:
        info = os.fstat(descriptor)
        if (
            expected_identity is not None
            and StorageIdentity(info.st_dev, info.st_ino) != expected_identity
        ):
            raise ValueError("isolated cleanup identity mismatch")
        _terminal_fault_hook("delete_relative_before_unlink")
        if (
            expected_identity is not None
            and _relative_identity(parent, basename) != expected_identity
        ):
            raise ValueError("isolated cleanup identity mismatch")
        os.unlink(basename, dir_fd=parent)
        deleted = True
        _terminal_fault_hook("delete_relative_after_unlink_before_receipt")
    except BaseException as error:
        if deleted:
            _mark_physical_completion(error, "delete")
        raise
    finally:
        os.close(descriptor)


def _close_parent_authority(parent: int) -> None:
    if parent < 0:
        return
    if os.name == "nt":
        ctypes.windll.kernel32.CloseHandle(parent)
    else:
        os.close(parent)


def _duplicate_parent_authority(parent: int) -> int:
    if os.name != "nt":
        return os.dup(parent)
    from ctypes import wintypes

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
    duplicate = wintypes.HANDLE()
    process = kernel32.GetCurrentProcess()
    if not kernel32.DuplicateHandle(
        process,
        wintypes.HANDLE(parent),
        process,
        ctypes.byref(duplicate),
        0,
        False,
        0x00000002,
    ):
        raise ctypes.WinError()
    return int(duplicate.value)


def _close_target_parent(authority: _TargetAuthority) -> None:
    parent = authority.parent_descriptor
    authority.parent_descriptor = -1
    _close_parent_authority(parent)


def _bind_existing_target(path: Path, *, create_authority: bool) -> BoundSQLiteTarget:
    source = Path(path)
    parent, main, identity = _open_authority(source)
    try:
        return _bind_open_authority(
            parent,
            main,
            identity,
            source.name,
            create_authority=create_authority,
        )
    finally:
        _close_authority(parent, main)


def _bind_open_authority(
    parent: int,
    main: int,
    identity: StorageIdentity,
    basename: str,
    *,
    create_authority: bool,
) -> BoundSQLiteTarget:
    if not basename or Path(basename).name != basename:
        raise ValueError("SQLite authority basename must be exact")
    token = secrets.token_hex(32)
    owned_parent = _duplicate_parent_authority(parent)
    try:
        control, _receipt = _bootstrap()
        with _BOOTSTRAP_LOCK:
            accepted = control.execute(
                "SELECT pxii_bind(?, ?, ?, ?, ?)",
                (token, parent, main, basename, int(create_authority)),
            ).fetchone()[0]
    except BaseException as error:
        _close_parent_authority(owned_parent)
        if (
            isinstance(error, sqlite3.DatabaseError)
            and create_authority
            and "companion" in str(error).lower()
        ):
            raise RuntimeError("SQLite create authority companion already exists") from error
        raise
    if accepted != 1:
        _close_parent_authority(owned_parent)
        raise RuntimeError("pxii-vfs rejected authority binding")
    return BoundSQLiteTarget._create(
        identity,
        _TargetAuthority(
            token=token,
            create_authority=create_authority,
            parent_descriptor=owned_parent,
            basename=basename,
        ),
    )


def _revoke_unopened_target(target: BoundSQLiteTarget) -> None:
    authority = target._authority
    if authority.revoked:
        return
    authority.revoked = True
    control, _receipt = _bootstrap()
    with _BOOTSTRAP_LOCK:
        control.execute("SELECT pxii_revoke(?)", (authority.token,)).fetchone()
        references = control.execute(
            "SELECT pxii_live_references(?)", (authority.token,)
        ).fetchone()[0]
    if references not in {0, -1}:
        raise RuntimeError("unopened SQLite target retained native references")
    _close_target_parent(authority)


def _open_relative_file_descriptor(parent: int, basename: str, flags: int) -> int:
    if not basename or Path(basename).name != basename:
        raise ValueError("isolated child basename must be exact")
    if os.name == "nt":
        from app.runtime.contained_io import _open_windows_relative_file

        return _open_windows_relative_file(parent, basename, flags)
    return os.open(
        basename,
        flags | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
        0o600,
        dir_fd=parent,
    )


def _relative_entry_exists(parent: int, basename: str) -> bool:
    if os.name != "nt":
        try:
            os.stat(basename, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return False
        return True
    try:
        descriptor = _open_relative_file_descriptor(parent, basename, os.O_RDONLY)
    except FileNotFoundError:
        return False
    except (IsADirectoryError, PermissionError):
        return True
    else:
        os.close(descriptor)
        return True


def _regular_descriptor_identity(descriptor: int) -> StorageIdentity:
    if os.name == "nt":
        import msvcrt

        return _windows_file_identity(msvcrt.get_osfhandle(descriptor))
    info = os.fstat(descriptor)
    return StorageIdentity(info.st_dev, info.st_ino)


def _native_reference_count(authority: _TargetAuthority) -> int:
    control, _receipt = _bootstrap()
    with _BOOTSTRAP_LOCK:
        return int(
            control.execute(
                "SELECT pxii_live_references(?)", (authority.token,)
            ).fetchone()[0]
        )


def _require_no_companions(parent: int, basename: str) -> None:
    for suffix in ("-wal", "-shm", "-journal"):
        if _relative_entry_exists(parent, f"{basename}{suffix}"):
            raise RuntimeError("closed SQLite target retains a companion")


def _relative_identity_or_none(
    parent: int, basename: str
) -> StorageIdentity | None:
    try:
        return _relative_identity(parent, basename)
    except FileNotFoundError:
        return None


def _rename_relative_no_replace(parent: int, source: str, destination: str) -> None:
    if os.name == "nt":
        from app.runtime.contained_io import _rename_windows_relative

        _rename_windows_relative(parent, source, parent, destination, replace=False)
        return
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise RuntimeError("renameat2 is required for no-replace SQLite publication")
    renameat2.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    renameat2.restype = ctypes.c_int
    if renameat2(parent, os.fsencode(source), parent, os.fsencode(destination), 1) != 0:
        error = ctypes.get_errno()
        if error == errno.EEXIST:
            raise FileExistsError(destination)
        if error == errno.ENOENT:
            raise FileNotFoundError(source)
        raise OSError(error, os.strerror(error), source)
    try:
        os.fsync(parent)
    except BaseException as error:
        _mark_physical_completion(error, "rename")
        raise


class SQLiteReplacementAuthority:
    __slots__ = (
        "_source",
        "_target",
        "_parent_descriptor",
        "_source_basename",
        "_replacement_basename",
        "_replacement_identity",
        "_checkpoint",
        "_terminal",
        "_committed_identity",
        "_physical_stage",
        "_source_backup_basename",
        "_discard_tombstone_basename",
        "_rejected_public_basename",
    )

    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        raise TypeError("SQLiteReplacementAuthority is factory-only")

    @classmethod
    def _create(
        cls,
        *,
        source: BoundSQLiteTarget,
        target: BoundSQLiteTarget,
        parent_descriptor: int,
        source_basename: str,
        replacement_basename: str,
        replacement_identity: StorageIdentity,
    ) -> SQLiteReplacementAuthority:
        instance = object.__new__(cls)
        instance._source = source
        instance._target = target
        instance._parent_descriptor = parent_descriptor
        instance._source_basename = source_basename
        instance._replacement_basename = replacement_basename
        instance._replacement_identity = replacement_identity
        instance._checkpoint: tuple[int, int, int] | None = None
        instance._terminal: str | None = None
        instance._committed_identity: StorageIdentity | None = None
        instance._physical_stage: str | None = None
        instance._source_backup_basename = f".pxii-source-{secrets.token_hex(16)}.db"
        instance._discard_tombstone_basename = (
            f".pxii-discard-{secrets.token_hex(16)}.db"
        )
        instance._rejected_public_basename = (
            f".pxii-rejected-{secrets.token_hex(16)}.db"
        )
        return instance

    @property
    def target(self) -> BoundSQLiteTarget:
        return self._target

    def checkpoint_and_seal_source(self) -> tuple[int, int, int]:
        if self._terminal is not None:
            raise RuntimeError("replacement authority is already terminal")
        if self._checkpoint is not None:
            return self._checkpoint
        if _native_reference_count(self._source._authority) != 0:
            raise RuntimeError("source target has live SQLite references")
        if _native_reference_count(self._target._authority) != 0:
            raise RuntimeError("replacement target has live SQLite references")
        with self._source.open_maintenance(
            MaintenanceOptions(read_only=False)
        ) as connection:
            row = connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        if row is None or len(row) != 3:
            raise RuntimeError("source checkpoint did not return a closed receipt")
        if _native_reference_count(self._source._authority) != 0:
            raise RuntimeError("source checkpoint retained SQLite references")
        if _native_reference_count(self._target._authority) != 0:
            raise RuntimeError("replacement target gained SQLite references")

        authority = self._source._authority
        authority.sealed = True
        authority.revoked = True
        control, _receipt = _bootstrap()
        with _BOOTSTRAP_LOCK:
            control.execute("SELECT pxii_revoke(?)", (authority.token,)).fetchone()
            references = control.execute(
                "SELECT pxii_live_references(?)", (authority.token,)
            ).fetchone()[0]
        if references != -1:
            raise RuntimeError("sealed source binding did not close")
        _close_target_parent(authority)
        self._checkpoint = tuple(int(value) for value in row)
        return self._checkpoint

    def _require_closed_targets(self) -> None:
        if self._checkpoint is None:
            raise RuntimeError("source target is not checkpointed and sealed")
        if not self._source._authority.revoked or not self._target._authority.revoked:
            raise RuntimeError("source and replacement targets must be closed")
        if _native_reference_count(self._source._authority) != -1:
            raise RuntimeError("source native binding is not closed")
        if _native_reference_count(self._target._authority) != -1:
            raise RuntimeError("replacement native binding is not closed")

    def _commit_physical_stage(self) -> str:
        parent = self._parent_descriptor
        source = _relative_identity_or_none(parent, self._source_basename)
        replacement = _relative_identity_or_none(
            parent, self._replacement_basename
        )
        backup = _relative_identity_or_none(parent, self._source_backup_basename)
        if (
            backup == self._source.identity
            and replacement is None
            and source is not None
            and source != self._replacement_identity
        ):
            _rename_relative_no_replace(
                parent, self._source_basename, self._rejected_public_basename
            )
            _rename_relative_no_replace(
                parent, self._source_backup_basename, self._source_basename
            )
            self._physical_stage = None
            raise ValueError("published replacement identity mismatch; source restored")
        if (
            source == self._source.identity
            and replacement == self._replacement_identity
            and backup is None
        ):
            return "initial"
        if (
            source is None
            and replacement == self._replacement_identity
            and backup == self._source.identity
        ):
            return "source_quarantined"
        if (
            source == self._replacement_identity
            and replacement is None
            and backup == self._source.identity
        ):
            return "replacement_published"
        if (
            source == self._replacement_identity
            and replacement is None
            and backup is None
        ):
            return "source_retired"
        raise ValueError("replacement commit namespace state is not reconcilable")

    def _discard_physical_stage(self) -> str:
        parent = self._parent_descriptor
        source = _relative_identity_or_none(parent, self._source_basename)
        replacement = _relative_identity_or_none(
            parent, self._replacement_basename
        )
        tombstone = _relative_identity_or_none(
            parent, self._discard_tombstone_basename
        )
        if source != self._source.identity:
            raise ValueError("source target identity changed before discard")
        if replacement == self._replacement_identity and tombstone is None:
            return "initial"
        if replacement is None and tombstone == self._replacement_identity:
            return "replacement_quarantined"
        if replacement is None and tombstone is None:
            if self._physical_stage in {
                "replacement_quarantine_attempted",
                "replacement_quarantined",
                "replacement_delete_attempted",
                "replacement_deleted",
            }:
                return "replacement_deleted"
            raise ValueError("replacement discard namespace state is not reconcilable")
        if replacement is not None and tombstone is None:
            raise ValueError("replacement target name reappeared after discard")
        raise ValueError("replacement discard namespace state is not reconcilable")

    def _restore_quarantined_source(self) -> None:
        parent = self._parent_descriptor
        if (
            _relative_identity_or_none(parent, self._source_basename) is None
            and _relative_identity_or_none(parent, self._source_backup_basename)
            == self._source.identity
        ):
            _rename_relative_no_replace(
                parent, self._source_backup_basename, self._source_basename
            )
            self._physical_stage = None

    def commit_bound_replace(self) -> StorageIdentity:
        if self._terminal == "committed":
            assert self._committed_identity is not None
            return self._committed_identity
        if self._terminal is not None:
            raise RuntimeError("replacement authority was discarded")
        parent = self._parent_descriptor
        stage = self._commit_physical_stage()
        if stage == "initial":
            self._require_closed_targets()
            _require_no_companions(parent, self._source_basename)
            _require_no_companions(parent, self._replacement_basename)
            self._physical_stage = "source_quarantine_attempted"
            try:
                _rename_relative_no_replace(
                    parent, self._source_basename, self._source_backup_basename
                )
            except BaseException as error:
                if not _has_physical_completion(error, "rename"):
                    self._physical_stage = None
                raise
            _terminal_fault_hook(
                "replacement_commit_after_source_quarantine_before_receipt"
            )
            self._physical_stage = "source_quarantined"
            stage = self._commit_physical_stage()
        if stage == "source_quarantined":
            _terminal_fault_hook("replacement_commit_before_publish")
            if (
                _relative_identity(parent, self._replacement_basename)
                != self._replacement_identity
            ):
                self._restore_quarantined_source()
                raise ValueError("replacement target identity changed before commit")
            self._physical_stage = "replacement_publish_attempted"
            _terminal_fault_hook("replacement_commit_between_check_and_publish")
            _terminal_fault_hook(
                "replacement_commit_after_publish_intent_before_syscall"
            )
            try:
                _rename_relative_no_replace(
                    parent, self._replacement_basename, self._source_basename
                )
            except BaseException as error:
                if not _has_physical_completion(error, "rename"):
                    self._restore_quarantined_source()
                raise
            _terminal_fault_hook("replacement_commit_after_publish")
            self._physical_stage = "replacement_published"
            stage = self._commit_physical_stage()
        if stage == "replacement_published":
            _delete_relative(
                parent, self._source_backup_basename, self._source.identity
            )
            _terminal_fault_hook("replacement_commit_after_source_retire")
            self._physical_stage = "source_retired"
            stage = self._commit_physical_stage()
        if stage != "source_retired":
            raise RuntimeError("replacement commit physical stage is invalid")
        committed = _relative_identity(parent, self._source_basename)
        if committed != self._replacement_identity:
            raise RuntimeError("replacement commit published the wrong identity")
        self._committed_identity = committed
        self._terminal = "committed"
        _close_parent_authority(parent)
        self._parent_descriptor = -1
        return committed

    def discard_closed_replacement(self) -> None:
        if self._terminal == "discarded":
            return
        if self._terminal is not None:
            raise RuntimeError("replacement authority was committed")
        parent = self._parent_descriptor
        stage = self._discard_physical_stage()
        if stage == "initial":
            self._require_closed_targets()
            _require_no_companions(parent, self._source_basename)
            _require_no_companions(parent, self._replacement_basename)
            _terminal_fault_hook("replacement_discard_before_delete")
            if (
                _relative_identity(parent, self._replacement_basename)
                != self._replacement_identity
            ):
                raise ValueError("replacement target identity changed before discard")
            self._physical_stage = "replacement_quarantine_attempted"
            _terminal_fault_hook(
                "replacement_discard_after_quarantine_intent_before_syscall"
            )
            try:
                _rename_relative_no_replace(
                    parent,
                    self._replacement_basename,
                    self._discard_tombstone_basename,
                )
            except BaseException as error:
                if not _has_physical_completion(error, "rename"):
                    self._physical_stage = None
                raise
            _terminal_fault_hook(
                "replacement_discard_after_quarantine_before_receipt"
            )
            self._physical_stage = "replacement_quarantined"
            stage = self._discard_physical_stage()
        if stage == "replacement_quarantined":
            self._physical_stage = "replacement_delete_attempted"
            try:
                _delete_relative(
                    parent,
                    self._discard_tombstone_basename,
                    self._replacement_identity,
                )
            except BaseException as error:
                if _has_physical_completion(error, "delete"):
                    self._physical_stage = "replacement_deleted"
                else:
                    self._physical_stage = "replacement_quarantined"
                raise
            _terminal_fault_hook("replacement_discard_after_delete")
            self._physical_stage = "replacement_deleted"
            stage = self._discard_physical_stage()
        if stage != "replacement_deleted":
            raise RuntimeError("replacement discard physical stage is invalid")
        self._terminal = "discarded"
        _close_parent_authority(parent)
        self._parent_descriptor = -1


def begin_bound_replacement(
    source: BoundSQLiteTarget,
) -> SQLiteReplacementAuthority:
    authority = source._require_live()
    if _native_reference_count(authority) != 0:
        raise RuntimeError("source target has live SQLite references")
    parent = _duplicate_parent_authority(authority.parent_descriptor)
    basename = f".pxii-replacement-{secrets.token_hex(16)}.db"
    main_descriptor = -1
    created = False
    target = None
    try:
        from app.runtime.contained_io import (
            _close_file_descriptor,
            _open_relative_regular,
        )

        main_descriptor, identity, created = _open_relative_regular(parent, basename)
        if not created:
            raise RuntimeError("random replacement target already exists")
        target = _bind_open_authority(
            parent,
            main_descriptor,
            identity,
            basename,
            create_authority=True,
        )
        _close_file_descriptor(main_descriptor)
        main_descriptor = -1
        return SQLiteReplacementAuthority._create(
            source=source,
            target=target,
            parent_descriptor=parent,
            source_basename=authority.basename,
            replacement_basename=basename,
            replacement_identity=identity,
        )
    except BaseException:
        if main_descriptor >= 0:
            from app.runtime.contained_io import _close_file_descriptor

            _close_file_descriptor(main_descriptor)
        if target is not None:
            _revoke_unopened_target(target)
        if created:
            try:
                from app.runtime.contained_io import _remove_created_role

                _remove_created_role(parent, basename)
            except FileNotFoundError:
                pass
        _close_parent_authority(parent)
        raise


def bind_marked_isolated_target(
    *,
    parent_path: Path,
    exact_absent_basename: str,
    marker_basename: str,
    marker_nonce: str,
) -> tuple[BoundSQLiteTarget, object]:
    parent = Path(parent_path).absolute()
    if Path(exact_absent_basename).name != exact_absent_basename:
        raise ValueError("isolated target basename must be exact")
    if Path(marker_basename).name != marker_basename:
        raise ValueError("marker basename must be exact")
    cleanup_parent = _open_parent_authority(parent)
    marker_descriptor = -1
    main_descriptor = -1
    target = None
    created = False
    try:
        marker_descriptor = _open_relative_file_descriptor(
            cleanup_parent, marker_basename, os.O_RDONLY
        )
        marker_info = os.fstat(marker_descriptor)
        if not stat.S_ISREG(marker_info.st_mode):
            raise ValueError("isolated target marker is not a regular file")
        marker_identity = _regular_descriptor_identity(marker_descriptor)
        with os.fdopen(marker_descriptor, "r", encoding="utf-8", closefd=True) as marker:
            marker_descriptor = -1
            if marker.read() != marker_nonce:
                raise ValueError("isolated target marker nonce mismatch")

        reserved = (
            exact_absent_basename,
            f"{exact_absent_basename}-wal",
            f"{exact_absent_basename}-shm",
            f"{exact_absent_basename}-journal",
        )
        if any(_relative_entry_exists(cleanup_parent, name) for name in reserved):
            raise RuntimeError("isolated target or companion already exists")

        from app.runtime.contained_io import (
            _close_file_descriptor,
            _open_relative_regular,
        )

        main_descriptor, identity, created = _open_relative_regular(
            cleanup_parent, exact_absent_basename
        )
        if not created:
            raise RuntimeError("isolated target already exists")
        target = _bind_open_authority(
            cleanup_parent,
            main_descriptor,
            identity,
            exact_absent_basename,
            create_authority=True,
        )
        _close_file_descriptor(main_descriptor)
        main_descriptor = -1
    except BaseException:
        if marker_descriptor >= 0:
            os.close(marker_descriptor)
        if main_descriptor >= 0:
            from app.runtime.contained_io import _close_file_descriptor

            _close_file_descriptor(main_descriptor)
        if created:
            try:
                from app.runtime.contained_io import _remove_created_role

                _remove_created_role(cleanup_parent, exact_absent_basename)
            except FileNotFoundError:
                pass
        _close_parent_authority(cleanup_parent)
        raise
    assert target is not None
    return target, _IsolatedCleanupAuthority(
        target=target._authority,
        parent_descriptor=cleanup_parent,
        target_basename=exact_absent_basename,
        marker_basename=marker_basename,
        target_identity=target.identity,
        marker_identity=marker_identity,
    )


def _require_cleanup(
    cleanup_authority: object, identity: StorageIdentity
) -> _IsolatedCleanupAuthority:
    if not isinstance(cleanup_authority, _IsolatedCleanupAuthority):
        raise TypeError("invalid isolated cleanup authority")
    if cleanup_authority.terminal is not None:
        return cleanup_authority
    if cleanup_authority.target_identity != identity:
        raise ValueError("isolated cleanup target identity mismatch")
    if not cleanup_authority.target.revoked:
        raise RuntimeError("isolated target must be closed before cleanup")
    return cleanup_authority


def _delete_isolated_role(
    cleanup: _IsolatedCleanupAuthority,
    *,
    key: str,
    basename: str,
    expected_identity: StorageIdentity,
) -> None:
    if key in cleanup.completed_deletes:
        return
    if key not in cleanup.attempted_deletes:
        observed = _relative_identity_or_none(cleanup.parent_descriptor, basename)
        if observed is None:
            raise FileNotFoundError(basename)
        if observed != expected_identity:
            raise ValueError("isolated cleanup identity mismatch")
        cleanup.attempted_deletes.add(key)
    _terminal_fault_hook(f"isolated_{key}_after_intent_before_delete")
    try:
        _delete_relative(
            cleanup.parent_descriptor,
            basename,
            expected_identity,
        )
    except BaseException as error:
        if _has_physical_completion(error, "delete"):
            cleanup.completed_deletes.add(key)
        raise
    cleanup.completed_deletes.add(key)


def commit_closed_isolated_target(
    cleanup_authority: object, identity: StorageIdentity
) -> None:
    cleanup = _require_cleanup(cleanup_authority, identity)
    if cleanup.terminal is None:
        if "marker" not in cleanup.completed_deletes:
            _delete_isolated_role(
                cleanup,
                key="marker",
                basename=cleanup.marker_basename,
                expected_identity=cleanup.marker_identity,
            )
            _terminal_fault_hook("isolated_commit_after_marker_delete")
        cleanup.terminal = "committed"
        _close_parent_authority(cleanup.parent_descriptor)
        cleanup.parent_descriptor = -1


def discard_closed_isolated_target(
    cleanup_authority: object, identity: StorageIdentity
) -> None:
    cleanup = _require_cleanup(cleanup_authority, identity)
    if cleanup.terminal is None:
        for suffix in ("-wal", "-shm", "-journal"):
            key = f"companion:{suffix}"
            if key in cleanup.completed_deletes:
                continue
            try:
                _delete_relative(
                    cleanup.parent_descriptor,
                    f"{cleanup.target_basename}{suffix}",
                    None,
                )
            except FileNotFoundError:
                pass
            cleanup.completed_deletes.add(key)
        if "target" not in cleanup.completed_deletes:
            _delete_isolated_role(
                cleanup,
                key="target",
                basename=cleanup.target_basename,
                expected_identity=cleanup.target_identity,
            )
            _terminal_fault_hook("isolated_discard_after_target_delete")
        if "marker" not in cleanup.completed_deletes:
            _delete_isolated_role(
                cleanup,
                key="marker",
                basename=cleanup.marker_basename,
                expected_identity=cleanup.marker_identity,
            )
            _terminal_fault_hook("isolated_discard_after_marker_delete")
        cleanup.terminal = "discarded"
        _close_parent_authority(cleanup.parent_descriptor)
        cleanup.parent_descriptor = -1
