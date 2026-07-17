from __future__ import annotations

import asyncio
import os
import threading
from dataclasses import fields
from pathlib import Path

import pytest

from app.auth.authority import Principal
from app.errors import PathOutsideSpaceError


class _FakeContainedOpens:
    def __init__(self) -> None:
        self.closed = False

    async def close_all(self) -> None:
        self.closed = True

    async def revoke_transferred_resources(self) -> None:
        self.closed = True

    async def close_untransferred_resources(self) -> None:
        self.closed = True


@pytest.fixture
def fake_bound_opener(monkeypatch):
    import app.runtime.scope as scope_module

    opened: list[_FakeContainedOpens] = []

    def open_fake(*_args, **_kwargs):
        result = _FakeContainedOpens()
        opened.append(result)
        return result

    monkeypatch.setattr(scope_module, "open_bound_space", open_fake)
    return opened


@pytest.fixture
async def authorized_scope(client):
    from app.db.meta_session import get_meta_session
    from app.db.models.meta import Space
    from app.runtime.scope import AuthorizedSpaceScope
    from app.settings import settings

    parent = settings.spaces_data_dir / "spc_lock"
    notes = parent / "notes"
    notes.mkdir(parents=True)
    async for session in get_meta_session():
        session.add(
            Space(
                id="spc_lock",
                name="lock",
                db_path=str(parent / "space.db"),
                notes_dir=str(notes),
            )
        )
        await session.commit()
        return await AuthorizedSpaceScope(session, settings.spaces_data_dir).open(
            _principal("spc_lock"), "spc_lock", "read"
        )
    raise AssertionError("Meta session fixture did not yield")


async def _enter_scope_until(scope, entered: asyncio.Event, release: asyncio.Event) -> None:
    async with scope.containment.open_verified():
        entered.set()
        await release.wait()


async def _enter_scope_once(scope) -> None:
    async with scope.containment.open_verified():
        pass


def _principal(space_id: str) -> Principal:
    return Principal(
        subject="admin",
        token_type="space",
        epoch=1,
        expires_at=None,
        space_id=space_id,
    )


def test_contained_paths_are_private_non_authority_metadata() -> None:
    from app.runtime.scope import AuthorizedSpaceScopeResult, ContainedSpacePaths

    assert [item.name for item in fields(ContainedSpacePaths)] == [
        "space_root",
        "db_path",
        "notes_dir",
        "index_db",
    ]
    result_fields = fields(AuthorizedSpaceScopeResult)
    assert [item.name for item in result_fields] == [
        "principal",
        "space_id",
        "mode",
        "containment",
    ]


@pytest.mark.asyncio
async def test_scope_rejects_registered_path_outside_root_before_storage_io(
    client, tmp_path: Path
) -> None:
    from app.db.meta_session import get_meta_session
    from app.db.models.meta import Space
    from app.runtime.scope import AuthorizedSpaceScope
    from app.settings import settings

    settings.spaces_data_dir.mkdir(parents=True, exist_ok=True)
    outside = tmp_path.parent / "outside-scope"
    outside.mkdir(exist_ok=True)
    async for session in get_meta_session():
        session.add(
            Space(
                id="spc_escape",
                name="escape",
                db_path=str(outside / "space.db"),
                notes_dir=str(outside / "notes"),
            )
        )
        await session.commit()
        with pytest.raises(PathOutsideSpaceError):
            await AuthorizedSpaceScope(session, settings.spaces_data_dir).open(
                _principal("spc_escape"), "spc_escape", "read"
            )
        break
    assert not (outside / "space.db").exists()
    assert not (outside / "notes").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "collision", ["notes_equals_db", "notes_equals_index", "db_equals_index"]
)
async def test_storage_path_roles_must_be_pairwise_distinct(
    client, tmp_path: Path, collision: str
) -> None:
    from app.db.meta_session import get_meta_session
    from app.db.models.meta import Space
    from app.runtime.scope import AuthorizedSpaceScope
    from app.settings import settings

    space_root = settings.spaces_data_dir / "spc_collision"
    space_root.mkdir(parents=True, exist_ok=True)
    db_path = space_root / "space.db"
    notes_dir = space_root / "notes"
    if collision == "notes_equals_db":
        notes_dir = db_path
    elif collision == "notes_equals_index":
        notes_dir = space_root / "index.db"
    elif collision == "db_equals_index":
        db_path = space_root / "index.db"

    async for session in get_meta_session():
        session.add(
            Space(
                id="spc_collision",
                name="collision",
                db_path=str(db_path),
                notes_dir=str(notes_dir),
            )
        )
        await session.commit()
        with pytest.raises(PathOutsideSpaceError, match="roles overlap"):
            await AuthorizedSpaceScope(session, settings.spaces_data_dir).open(
                _principal("spc_collision"), "spc_collision", "read"
            )
        break
    assert list(space_root.iterdir()) == []


@pytest.mark.asyncio
async def test_existing_link_component_is_rejected_without_following(
    client, tmp_path: Path
) -> None:
    from app.db.meta_session import get_meta_session
    from app.db.models.meta import Space
    from app.runtime.scope import AuthorizedSpaceScope
    from app.settings import settings

    settings.spaces_data_dir.mkdir(parents=True, exist_ok=True)
    outside = tmp_path / "link-target"
    outside.mkdir()
    linked = settings.spaces_data_dir / "spc_link"
    try:
        os.symlink(outside, linked, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"host cannot create a directory link: {exc}")

    async for session in get_meta_session():
        session.add(
            Space(
                id="spc_link",
                name="link",
                db_path=str(linked / "space.db"),
                notes_dir=str(linked / "notes"),
            )
        )
        await session.commit()
        with pytest.raises(PathOutsideSpaceError):
            await AuthorizedSpaceScope(session, settings.spaces_data_dir).open(
                _principal("spc_link"), "spc_link", "read"
            )
        break
    assert list(outside.iterdir()) == []


@pytest.mark.asyncio
async def test_joined_accepts_precreated_future_and_custom_awaitable() -> None:
    from app.runtime.joined_thread import run_joined_awaitable

    future = asyncio.get_running_loop().create_future()
    future.set_result("future")

    class CustomAwaitable:
        def __await__(self):
            async def value():
                return "custom"

            return value().__await__()

    assert await run_joined_awaitable(future) == "future"
    assert await run_joined_awaitable(CustomAwaitable()) == "custom"


def test_space_containment_capability_is_factory_only() -> None:
    from app.runtime.scope import SpaceContainmentCapability

    with pytest.raises(TypeError, match="factory-only"):
        SpaceContainmentCapability()


@pytest.mark.asyncio
async def test_containment_lock_is_reentrant_for_the_same_task(
    authorized_scope, fake_bound_opener
) -> None:
    async with asyncio.timeout(2):
        async with authorized_scope.containment.open_verified():
            async with authorized_scope.containment.open_verified():
                pass


@pytest.mark.asyncio
async def test_containment_lock_excludes_a_different_task(
    authorized_scope, fake_bound_opener
) -> None:
    release = asyncio.Event()
    entered = asyncio.Event()
    async with authorized_scope.containment.open_verified():
        contender = asyncio.create_task(
            _enter_scope_until(authorized_scope, entered, release)
        )
        with pytest.raises(TimeoutError):
            async with asyncio.timeout(0.1):
                await entered.wait()
        assert not contender.done()
    await asyncio.wait_for(entered.wait(), timeout=2)
    release.set()
    await asyncio.wait_for(contender, timeout=2)


@pytest.mark.asyncio
async def test_containment_lock_restores_owner_and_depth_after_error_and_cancel(
    authorized_scope, fake_bound_opener
) -> None:
    with pytest.raises(RuntimeError, match="body failure"):
        async with authorized_scope.containment.open_verified():
            async with authorized_scope.containment.open_verified():
                raise RuntimeError("body failure")

    entered = asyncio.Event()
    never_release = asyncio.Event()
    cancelled = asyncio.create_task(
        _enter_scope_until(authorized_scope, entered, never_release)
    )
    await asyncio.wait_for(entered.wait(), timeout=2)
    cancelled.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled
    async with asyncio.timeout(2):
        async with authorized_scope.containment.open_verified():
            pass


@pytest.mark.asyncio
async def test_cancelled_waiter_does_not_corrupt_containment_lock_owner(
    authorized_scope, fake_bound_opener
) -> None:
    holder_release = asyncio.Event()
    holder_entered = asyncio.Event()
    holder = asyncio.create_task(
        _enter_scope_until(authorized_scope, holder_entered, holder_release)
    )
    await asyncio.wait_for(holder_entered.wait(), timeout=2)
    waiter = asyncio.create_task(_enter_scope_once(authorized_scope))
    await asyncio.sleep(0)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert not holder.done()
    successor = asyncio.create_task(_enter_scope_once(authorized_scope))
    await asyncio.sleep(0)
    assert not successor.done()
    holder_release.set()
    await asyncio.wait_for(holder, timeout=2)
    await asyncio.wait_for(successor, timeout=2)


@pytest.mark.asyncio
async def test_joined_success_commits_before_original_cancel_is_rethrown() -> None:
    from app.runtime.joined_thread import run_joined_awaitable

    started = asyncio.Event()
    release = asyncio.Event()
    committed: list[str] = []

    async def worker() -> str:
        started.set()
        await release.wait()
        return "ready"

    operation = asyncio.create_task(
        run_joined_awaitable(worker(), on_success=committed.append)
    )
    await started.wait()
    operation.cancel("original")
    await asyncio.sleep(0)
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await operation
    assert committed == ["ready"]


@pytest.mark.asyncio
async def test_joined_cancelled_resource_disposes_instead_of_publishing() -> None:
    from app.runtime.joined_thread import run_joined_awaitable

    started = asyncio.Event()
    release = asyncio.Event()
    published: list[object] = []
    disposed: list[object] = []
    resource = object()

    async def worker() -> object:
        started.set()
        await release.wait()
        return resource

    operation = asyncio.create_task(
        run_joined_awaitable(
            worker(),
            on_success=published.append,
            dispose_cancelled_result=disposed.append,
        )
    )
    await started.wait()
    operation.cancel("original")
    await asyncio.sleep(0)
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await operation
    assert published == []
    assert disposed == [resource]


@pytest.mark.asyncio
async def test_double_cancel_worker_error_preserves_primary_first() -> None:
    from app.runtime.joined_thread import run_joined_awaitable

    started = asyncio.Event()
    release = asyncio.Event()

    async def worker() -> None:
        started.set()
        await release.wait()
        raise RuntimeError("worker failed")

    operation = asyncio.create_task(run_joined_awaitable(worker()))
    await started.wait()
    operation.cancel("original")
    await asyncio.sleep(0)
    operation.cancel("later")
    await asyncio.sleep(0)
    release.set()
    with pytest.raises(BaseExceptionGroup) as raised:
        await operation
    errors = raised.value.exceptions
    assert isinstance(errors[0], asyncio.CancelledError)
    assert str(errors[0]) == "original"
    assert isinstance(errors[1], asyncio.CancelledError)
    assert str(errors[1]) == "later"
    assert isinstance(errors[2], RuntimeError)
    assert str(errors[2]) == "worker failed"


@pytest.mark.asyncio
async def test_cancel_during_bound_open_joins_worker_and_closes_result(
    authorized_scope, monkeypatch
) -> None:
    import app.runtime.scope as scope_module

    started = threading.Event()
    release = threading.Event()
    result = _FakeContainedOpens()

    def slow_open(*_args, **_kwargs):
        started.set()
        assert release.wait(timeout=2)
        return result

    monkeypatch.setattr(scope_module, "open_bound_space", slow_open)

    async def enter() -> None:
        async with authorized_scope.containment.open_verified():
            raise AssertionError("cancelled open must not publish its result")

    operation = asyncio.create_task(enter())
    assert await asyncio.to_thread(started.wait, 2)
    operation.cancel("cancel open")
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await operation
    assert result.closed
