from __future__ import annotations

import asyncio
import os
import stat
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncContextManager, AsyncIterator, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.authority import Principal
from app.db.models.meta import Space
from app.errors import AuthorizationError, PathOutsideSpaceError, SpaceNotFoundError
from app.runtime.contained_io import ContainedSpaceOpens, open_bound_space
from app.runtime.joined_thread import run_joined_thread

type AccessMode = Literal["read", "write"]
type AncestorReceipt = tuple[str, int, int, int]

class _ReentrantAsyncLock:
    __slots__ = ("_lock", "_owner", "_depth")

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._owner: asyncio.Task[object] | None = None
        self._depth = 0

    async def __aenter__(self) -> "_ReentrantAsyncLock":
        task = asyncio.current_task()
        assert task is not None
        if self._owner is task:
            self._depth += 1
            return self
        await self._lock.acquire()
        self._owner = task
        self._depth = 1
        return self

    async def __aexit__(self, *_exc_info: object) -> None:
        task = asyncio.current_task()
        if self._owner is not task:
            raise RuntimeError("containment lock released by non-owner")
        self._depth -= 1
        if self._depth == 0:
            self._owner = None
            self._lock.release()


_LOCKS: dict[tuple[int, int], _ReentrantAsyncLock] = {}


@dataclass(frozen=True, slots=True)
class ContainedSpacePaths:
    space_root: Path
    db_path: Path
    notes_dir: Path
    index_db: Path


def _absolute_lexical(path: Path | str) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def _path_error(detail: str) -> PathOutsideSpaceError:
    return PathOutsideSpaceError(detail)


def _is_reparse(info: os.stat_result) -> bool:
    attributes = getattr(info, "st_file_attributes", 0)
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse)


def _directory_identity(path: Path, info: os.stat_result) -> tuple[int, int]:
    if os.name != "nt":
        return info.st_dev, info.st_ino
    from app.runtime.contained_io import _open_windows_directory

    handle, identity = _open_windows_directory(path)
    try:
        return identity.device, identity.file_id
    finally:
        import ctypes

        ctypes.windll.kernel32.CloseHandle(handle)


def _safe_relative(path: Path, root: Path) -> tuple[str, ...]:
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise _path_error("Registered storage path is outside the authorized Space") from exc
    if not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
        raise _path_error("Registered storage path is not a contained child")
    return relative.parts


def _walk_existing_ancestors(paths: ContainedSpacePaths) -> tuple[AncestorReceipt, ...]:
    root = paths.space_root
    parent = paths.db_path.parent
    parts = _safe_relative(parent, root)
    current = root
    receipts: list[AncestorReceipt] = []
    for component in (None, *parts):
        if component is not None:
            current = current / component
        try:
            info = current.lstat()
        except OSError as exc:
            raise _path_error("Registered Space ancestor is missing") from exc
        if stat.S_ISLNK(info.st_mode) or _is_reparse(info) or not stat.S_ISDIR(info.st_mode):
            raise _path_error("Registered Space ancestor is not a safe directory")
        device, file_id = _directory_identity(current, info)
        receipts.append((current.name, device, file_id, info.st_mode))
    return tuple(receipts)


def _capture_safe_ancestor_identities(
    paths: ContainedSpacePaths,
) -> tuple[AncestorReceipt, ...]:
    return _walk_existing_ancestors(paths)


def _require_same_safe_ancestors(
    paths: ContainedSpacePaths, expected: tuple[AncestorReceipt, ...]
) -> None:
    if _walk_existing_ancestors(paths) != expected:
        raise _path_error("Registered Space ancestor identity changed")


def _containment_lock_for(
    parent_identity: tuple[int, int],
) -> _ReentrantAsyncLock:
    return _LOCKS.setdefault(parent_identity, _ReentrantAsyncLock())


async def _fault_hook(_name: str) -> None:
    await asyncio.sleep(0)


class SpaceContainmentCapability:
    __slots__ = ("_paths", "_ancestor_identities", "_lock")

    def __init__(self, *_args, **_kwargs) -> None:
        raise TypeError("SpaceContainmentCapability is factory-only")

    @classmethod
    def _create(cls, paths: ContainedSpacePaths) -> "SpaceContainmentCapability":
        instance = object.__new__(cls)
        instance._paths = paths
        identities = _capture_safe_ancestor_identities(paths)
        instance._ancestor_identities = identities
        instance._lock = _containment_lock_for((identities[-1][1], identities[-1][2]))
        return instance

    def open_verified(self) -> AsyncContextManager[ContainedSpaceOpens]:
        @asynccontextmanager
        async def verified() -> AsyncIterator[ContainedSpaceOpens]:
            async with self._lock:
                _require_same_safe_ancestors(self._paths, self._ancestor_identities)
                await _fault_hook("after_final_check_before_kernel_open")
                opens = await run_joined_thread(
                    lambda: open_bound_space(self._paths, self._ancestor_identities),
                    dispose_cancelled_result=lambda value: value.close_all(),
                )
                primary: BaseException | None = None
                try:
                    yield opens
                except BaseException as error:
                    primary = error
                cleanup_errors: list[BaseException] = []
                try:
                    _require_same_safe_ancestors(self._paths, self._ancestor_identities)
                except BaseException as error:
                    cleanup_errors.append(error)
                    try:
                        await opens.revoke_transferred_resources()
                    except BaseException as revoke_error:
                        cleanup_errors.append(revoke_error)
                try:
                    await opens.close_untransferred_resources()
                except BaseException as error:
                    cleanup_errors.append(error)
                if primary is not None and cleanup_errors:
                    raise BaseExceptionGroup(
                        "storage body and containment cleanup failed",
                        [primary, *cleanup_errors],
                    ) from None
                if primary is not None:
                    raise primary
                if cleanup_errors:
                    raise BaseExceptionGroup("containment cleanup failed", cleanup_errors)

        return verified()


@dataclass(frozen=True, slots=True)
class AuthorizedSpaceScopeResult:
    principal: Principal
    space_id: str
    mode: AccessMode
    containment: SpaceContainmentCapability


class AuthorizedSpaceScope:
    def __init__(self, meta_db: AsyncSession, spaces_root: Path) -> None:
        self.meta_db = meta_db
        self.spaces_root = _absolute_lexical(spaces_root)

    async def open(
        self,
        principal: Principal,
        space_id: str,
        mode: AccessMode,
    ) -> AuthorizedSpaceScopeResult:
        if principal.token_type not in {"master", "space", "trusted_stdio"}:
            raise AuthorizationError("Token scope is not allowed")
        if principal.token_type == "space" and principal.space_id != space_id:
            raise AuthorizationError("Token is not valid for this Space")

        row = await self.meta_db.scalar(select(Space).where(Space.id == space_id))
        if row is None:
            raise SpaceNotFoundError()

        db_path = _absolute_lexical(row.db_path)
        notes_dir = _absolute_lexical(row.notes_dir)
        _safe_relative(db_path, self.spaces_root)
        _safe_relative(notes_dir, self.spaces_root)
        if db_path.parent != notes_dir.parent:
            raise _path_error("Registered Space storage roles must share one parent")
        index_db = db_path.parent / "index.db"
        role_keys = {os.path.normcase(str(path)) for path in (db_path, notes_dir, index_db)}
        if len(role_keys) != 3:
            raise _path_error("Registered Space storage roles overlap")

        paths = ContainedSpacePaths(
            space_root=self.spaces_root,
            db_path=db_path,
            notes_dir=notes_dir,
            index_db=index_db,
        )
        containment = SpaceContainmentCapability._create(paths)
        return AuthorizedSpaceScopeResult(
            principal=principal,
            space_id=space_id,
            mode=mode,
            containment=containment,
        )
