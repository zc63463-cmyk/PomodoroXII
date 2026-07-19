from __future__ import annotations

import asyncio
import os
import stat
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, AsyncContextManager, AsyncIterator, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.authority import Principal
from app.db.models.meta import Space
from app.errors import AuthorizationError, PathOutsideSpaceError, SpaceNotFoundError
from app.runtime.contained_io import ContainedSpaceOpens, open_bound_space
from app.runtime.joined_thread import run_joined_thread
from app.runtime.leases import LeaseMode

if TYPE_CHECKING:
    from app.runtime.space import SpaceRuntime, SpaceRuntimeHandle

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


def _safe_relative(path: Path, root: Path) -> tuple[str, ...]:
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise _path_error("Registered storage path is outside the authorized Space") from exc
    if not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
        raise _path_error("Registered storage path is not a contained child")
    return relative.parts


def _walk_existing_ancestors(paths: ContainedSpacePaths) -> tuple[AncestorReceipt, ...]:
    from app.runtime.contained_io import (
        _close_directory_descriptor,
        _open_root_authority,
    )

    root = -1
    try:
        root, _root_identity = _open_root_authority(paths.space_root)
        return _walk_ancestors_from_root(paths, root)
    finally:
        if root >= 0:
            _close_directory_descriptor(root)


def _walk_ancestors_from_root(
    paths: ContainedSpacePaths, root: int
) -> tuple[AncestorReceipt, ...]:
    from app.runtime.contained_io import (
        _close_directory_descriptor,
        _descriptor_identity,
        _duplicate_directory_descriptor,
        _open_windows_relative_directory,
    )

    parts = _safe_relative(paths.db_path.parent, paths.space_root)
    receipts: list[AncestorReceipt] = []
    current = _duplicate_directory_descriptor(root)
    current_name = paths.space_root.name
    try:
        for component in (None, *parts):
            if component is not None:
                if os.name == "nt":
                    child = _open_windows_relative_directory(
                        current, component, create=False
                    )
                else:
                    child = os.open(
                        component,
                        os.O_RDONLY
                        | getattr(os, "O_DIRECTORY", 0)
                        | getattr(os, "O_NOFOLLOW", 0)
                        | getattr(os, "O_CLOEXEC", 0),
                        dir_fd=current,
                    )
                _close_directory_descriptor(current)
                current = child
                current_name = component
            identity = _descriptor_identity(current)
            mode = stat.S_IFDIR if os.name == "nt" else os.fstat(current).st_mode
            receipts.append(
                (current_name, identity.device, identity.file_id, mode)
            )
    except OSError as exc:
        raise _path_error("Registered Space ancestor is missing or unsafe") from exc
    finally:
        if current >= 0:
            _close_directory_descriptor(current)
    return tuple(receipts)


def _capture_safe_ancestor_identities(
    paths: ContainedSpacePaths,
) -> tuple[AncestorReceipt, ...]:
    return _walk_existing_ancestors(paths)


def _require_same_safe_ancestors(
    paths: ContainedSpacePaths,
    expected: tuple[AncestorReceipt, ...],
    root_authority: int | None = None,
) -> None:
    actual = (
        _walk_existing_ancestors(paths)
        if root_authority is None
        else _walk_ancestors_from_root(paths, root_authority)
    )
    if actual != expected:
        raise _path_error("Registered Space ancestor identity changed")


def _containment_lock_for(
    parent_identity: tuple[int, int],
) -> _ReentrantAsyncLock:
    return _LOCKS.setdefault(parent_identity, _ReentrantAsyncLock())


async def _fault_hook(_name: str) -> None:
    await asyncio.sleep(0)


class SpaceContainmentCapability:
    __slots__ = ("_paths", "_ancestor_identities", "_lock", "_root_authority")

    def __init__(self, *_args, **_kwargs) -> None:
        raise TypeError("SpaceContainmentCapability is factory-only")

    @classmethod
    def _create(cls, paths: ContainedSpacePaths) -> "SpaceContainmentCapability":
        from app.runtime.contained_io import (
            _close_directory_descriptor,
            _open_root_authority,
        )
        from app.runtime.sqlite_vfs import require_windows_native_runtime

        require_windows_native_runtime()

        instance = object.__new__(cls)
        instance._paths = paths
        root = -1
        try:
            root, _root_identity = _open_root_authority(paths.space_root)
            identities = _walk_ancestors_from_root(paths, root)
        except BaseException:
            if root >= 0:
                _close_directory_descriptor(root)
            raise
        instance._root_authority = root
        instance._ancestor_identities = identities
        instance._lock = _containment_lock_for((identities[-1][1], identities[-1][2]))
        return instance

    def __del__(self) -> None:
        root = getattr(self, "_root_authority", -1)
        if root < 0:
            return
        self._root_authority = -1
        from app.runtime.contained_io import _close_directory_descriptor

        _close_directory_descriptor(root)

    def open_verified(self) -> AsyncContextManager[ContainedSpaceOpens]:
        @asynccontextmanager
        async def verified() -> AsyncIterator[ContainedSpaceOpens]:
            async with self._lock:
                _require_same_safe_ancestors(
                    self._paths, self._ancestor_identities, self._root_authority
                )
                await _fault_hook("after_final_check_before_kernel_open")
                opens = await run_joined_thread(
                    lambda: open_bound_space(
                        self._paths,
                        self._ancestor_identities,
                        self._root_authority,
                    ),
                    dispose_cancelled_result=lambda value: value.close_all(),
                )
                primary: BaseException | None = None
                try:
                    yield opens
                except BaseException as error:
                    primary = error
                cleanup_errors: list[BaseException] = []
                try:
                    _require_same_safe_ancestors(
                        self._paths, self._ancestor_identities, self._root_authority
                    )
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
    def __init__(
        self,
        meta_db: AsyncSession,
        spaces_root: Path,
        runtime: SpaceRuntime | None = None,
    ) -> None:
        self.meta_db = meta_db
        self.spaces_root = _absolute_lexical(spaces_root)
        self.runtime = runtime

    async def open(
        self,
        principal: Principal,
        space_id: str,
        mode: AccessMode,
    ) -> AuthorizedSpaceScopeResult | SpaceRuntimeHandle:
        resolved = await self.resolve(principal, space_id, mode)
        if self.runtime is None:
            return resolved
        global_lease = await self.runtime.leases.acquire_global(
            LeaseMode.SHARED, "request", 5
        )
        try:
            return await self.runtime.open_resolved(
                resolved,
                "read" if mode == "read" else "mutation",
                global_lease,
                owns_global_lease=True,
            )
        except BaseException as primary:
            try:
                await global_lease.release()
            except BaseException as cleanup:
                self.runtime.leases.register_pending_lease_cleanup(global_lease)
                raise BaseExceptionGroup(
                    "scope open and global lease cleanup failed", [primary, cleanup]
                ) from None
            raise

    async def resolve(
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
