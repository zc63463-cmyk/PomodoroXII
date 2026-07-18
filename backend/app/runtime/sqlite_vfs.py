from __future__ import annotations

import asyncio
import ctypes
import hashlib
import os
import secrets
import sqlite3
import stat
import threading
import weakref
from contextlib import AbstractContextManager
from dataclasses import dataclass
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
    revoked: bool = False


@dataclass(slots=True)
class _IsolatedCleanupAuthority:
    target: _TargetAuthority
    parent_descriptor: int
    target_basename: str
    marker_basename: str
    target_identity: StorageIdentity
    marker_identity: StorageIdentity
    terminal: str | None = None


_BOOTSTRAP_LOCK = threading.RLock()
_CONTROL: sqlite3.Connection | None = None
_BOOTSTRAP_RECEIPT: _BootstrapReceipt | None = None


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
        if self._authority.revoked:
            raise SQLiteAuthorityRevokedError()
        return self._authority

    def make_async_engine(self, options: AsyncEngineOptions) -> AsyncEngine:
        authority = self._require_live()

        async def connect() -> aiosqlite.Connection:
            if authority.revoked:
                raise SQLiteAuthorityRevokedError()
            connection = await run_joined_awaitable(
                aiosqlite.connect(
                    _virtual_uri(authority),
                    uri=True,
                    timeout=options.busy_timeout_ms / 1000,
                ),
                dispose_cancelled_result=lambda value: value.close(),
            )
            await connection._execute(connection._conn.enable_load_extension, False)
            await connection._execute(connection._conn.set_authorizer, _sqlite_authorizer)
            await connection.execute(f"PRAGMA busy_timeout={options.busy_timeout_ms}")
            await connection.execute("PRAGMA foreign_keys=ON")
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
                return
            if references == 0:
                raise RuntimeError("native SQLite authority did not unlink after drain")
            await asyncio.sleep(0.01)


def _virtual_uri(authority: _TargetAuthority) -> str:
    if authority.revoked:
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
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
        return
    descriptor = os.open(
        basename,
        os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
        dir_fd=parent,
    )
    try:
        info = os.fstat(descriptor)
        if (
            expected_identity is not None
            and StorageIdentity(info.st_dev, info.st_ino) != expected_identity
        ):
            raise ValueError("isolated cleanup identity mismatch")
        os.unlink(basename, dir_fd=parent)
    finally:
        os.close(descriptor)


def _close_parent_authority(parent: int) -> None:
    if os.name == "nt":
        ctypes.windll.kernel32.CloseHandle(parent)
    else:
        os.close(parent)


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
    control, _receipt = _bootstrap()
    with _BOOTSTRAP_LOCK:
        accepted = control.execute(
            "SELECT pxii_bind(?, ?, ?, ?)",
            (token, parent, main, basename),
        ).fetchone()[0]
    if accepted != 1:
        raise RuntimeError("pxii-vfs rejected authority binding")
    return BoundSQLiteTarget._create(
        identity,
        _TargetAuthority(token=token, create_authority=create_authority),
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
    parent_info = parent.stat(follow_symlinks=False)
    if not stat.S_ISDIR(parent_info.st_mode):
        raise ValueError("isolated target parent is not a directory")
    marker = parent / marker_basename
    marker_info = marker.stat(follow_symlinks=False)
    if not stat.S_ISREG(marker_info.st_mode):
        raise ValueError("isolated target marker is not a regular file")
    if marker.read_text(encoding="utf-8") != marker_nonce:
        raise ValueError("isolated target marker nonce mismatch")

    target_path = parent / exact_absent_basename
    descriptor = os.open(
        target_path,
        os.O_CREAT | os.O_EXCL | os.O_RDWR | getattr(os, "O_BINARY", 0),
        0o600,
    )
    os.close(descriptor)
    target = _bind_existing_target(target_path, create_authority=True)
    cleanup_parent = _open_parent_authority(parent)
    try:
        marker_identity = _relative_identity(cleanup_parent, marker_basename)
    except BaseException:
        _close_parent_authority(cleanup_parent)
        raise
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


def commit_closed_isolated_target(
    cleanup_authority: object, identity: StorageIdentity
) -> None:
    cleanup = _require_cleanup(cleanup_authority, identity)
    if cleanup.terminal is None:
        _delete_relative(
            cleanup.parent_descriptor,
            cleanup.marker_basename,
            cleanup.marker_identity,
        )
        cleanup.terminal = "committed"
        _close_parent_authority(cleanup.parent_descriptor)
        cleanup.parent_descriptor = -1


def discard_closed_isolated_target(
    cleanup_authority: object, identity: StorageIdentity
) -> None:
    cleanup = _require_cleanup(cleanup_authority, identity)
    if cleanup.terminal is None:
        for suffix in ("-wal", "-shm", "-journal"):
            try:
                _delete_relative(
                    cleanup.parent_descriptor,
                    f"{cleanup.target_basename}{suffix}",
                    None,
                )
            except FileNotFoundError:
                pass
        _delete_relative(
            cleanup.parent_descriptor,
            cleanup.target_basename,
            cleanup.target_identity,
        )
        _delete_relative(
            cleanup.parent_descriptor,
            cleanup.marker_basename,
            cleanup.marker_identity,
        )
        cleanup.terminal = "discarded"
        _close_parent_authority(cleanup.parent_descriptor)
        cleanup.parent_descriptor = -1
