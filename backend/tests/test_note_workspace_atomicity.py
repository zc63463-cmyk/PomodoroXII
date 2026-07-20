from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import dataclass
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker

import app.mutation.types as mutation_types
from app.errors import IdempotencyConflictError, SpaceRecoveryRequiredError
from app.file_system.engine.base import FileSystemProjectionExecutor
from app.models.mutation import MutationBatch
from app.models.sync_outbox import SyncOutbox
from app.models.sync_state import SyncState
from app.mutation.journal import MutationJournal
from app.mutation.staging import StageStore
from app.mutation.types import MutationCommand, MutationRequest, MutationState, SyncEventPlan
from app.mutation.unit_of_work import BatchCompilation, MutationUnitOfWork
from app.runtime.contained_io import BoundDirectoryHandle, BoundStageDirectory


def _projection_api():
    names = (
        "ContainedProjectionActionField",
        "MaterializedProjectionAction",
        "ProjectionActionTag",
        "ProjectionPlan",
    )
    missing = tuple(name for name in names if not hasattr(mutation_types, name))
    assert missing == (), f"missing closed projection API: {missing}"
    return tuple(getattr(mutation_types, name) for name in names)


def _projection_plan(
    tag: str,
    target: str,
    ordinal: int,
    before: bytes | None,
    after: bytes | None,
    *,
    source: str | None = None,
):
    field_type, _, tag_type, plan_type = _projection_api()
    return plan_type(
        tag_type(tag),
        None if source is None else field_type(source),
        field_type(target),
        ordinal,
        before,
        after,
    )


def _materialized_action(
    tag: str,
    target: str,
    ordinal: int,
    blob: bytes | None,
    *,
    source: str | None = None,
):
    field_type, action_type, tag_type, _ = _projection_api()
    return action_type(
        tag_type(tag),
        None if source is None else field_type(source),
        field_type(target),
        ordinal,
        blob,
    )


def _stage_authority(path) -> BoundStageDirectory:
    path.mkdir()
    parent = BoundDirectoryHandle._create(path.parent)
    try:
        return BoundStageDirectory._from_parent_handle(parent, path.name)
    finally:
        parent._close()


@dataclass
class _FenceReceipt:
    current: bool = True

    def assert_current(self) -> None:
        if not self.current:
            raise RuntimeError("stale fence")


class _Lease:
    def __init__(self, receipt: _FenceReceipt) -> None:
        self._receipt = receipt

    def assert_active_owner(self, *, mode, scope) -> None:
        assert scope == "space-test"

    def fence_receipt(self, _space_id: str) -> _FenceReceipt:
        return self._receipt


class _StageStore:
    def __init__(self) -> None:
        self.published: dict[str, tuple[object, ...]] = {}
        self.materialize_calls: list[tuple[str, str]] = []

    async def publish(self, operation_id, plans, *, lease, space_id):
        from app.mutation.staging import StageManifest

        assert lease.fence_receipt(space_id).current
        self.published[operation_id] = tuple(plans)
        return StageManifest(operation_id, operation_id, (), "0" * 64)

    async def materialize(self, operation_id, descriptors, *, image, receipt):
        self.materialize_calls.append((operation_id, image))
        receipt.assert_current()
        return tuple(descriptors)


class _Scope:
    def __init__(self, sessions, receipt: _FenceReceipt) -> None:
        self.session_factory = sessions
        self.scope = SimpleNamespace(space_id="space-test")
        self.mutation_stages = _StageStore()
        self.file_system = SimpleNamespace()
        self._receipt = receipt

    @asynccontextmanager
    async def exclusive_space_resources(self, purpose: str, timeout_seconds: float):
        assert (purpose, timeout_seconds) == ("mutation", 5)
        yield _Lease(self._receipt)


class _Catalog:
    def get(self, entity_type: str):
        return SimpleNamespace(sync_enabled=True, effective_sync_entity_type=f"wire-{entity_type}")


class _Compiler:
    def __init__(self) -> None:
        self.calls = 0
        self.projections: tuple[object, ...] = ()

    async def compile_batch(self, scope, items, session) -> BatchCompilation:
        self.calls += 1
        commands = []
        operation_ids = []
        for item in items:
            if item.request is None:
                continue
            request = item.request
            commands.append(
                MutationCommand.from_effects(
                    request=request,
                    db_plans=(),
                    projections=tuple(self.projections),
                    sync_events=(
                        SyncEventPlan(
                            entity_type=request.entity_type,
                            entity_id=request.entity_id,
                            action="create",
                            payload={"id": request.entity_id},
                            version=1,
                            created_at="2026-07-20T00:00:00Z",
                        ),
                    ),
                    result_value={"id": request.entity_id},
                )
            )
            operation_ids.append(item.operation_id)
        return BatchCompilation(tuple(operation_ids), tuple(commands), ())


class _Interpreter:
    async def apply(self, session, plans):
        assert plans == ()
        return ()


class _ProjectionExecutor:
    def __init__(self) -> None:
        self.calls = 0

    async def apply_forward(self, scope, operation_id, command, receipt) -> None:
        receipt.assert_current()
        self.calls += 1

    async def restore_before(self, scope, operation_id, command, receipt) -> None:
        receipt.assert_current()


class _CleanGate:
    async def require_clean_under_lease(self, scope, lease, journal) -> None:
        if not await journal.is_clean():
            raise SpaceRecoveryRequiredError()


class _DirtyGate:
    async def require_clean_under_lease(self, scope, lease, journal) -> None:
        raise SpaceRecoveryRequiredError()


@pytest.fixture
def uow_fixture(space_session):
    assert space_session.bind is not None
    sessions = async_sessionmaker(space_session.bind, expire_on_commit=False)
    receipt = _FenceReceipt()
    compiler = _Compiler()
    executor = _ProjectionExecutor()
    uow = MutationUnitOfWork(
        catalog=_Catalog(),
        compiler=compiler,
        interpreter=_Interpreter(),
        projection_executor=executor,
        recovery_gate=_CleanGate(),
        journal_factory=MutationJournal,
    )
    return SimpleNamespace(
        sessions=sessions,
        scope=_Scope(sessions, receipt),
        compiler=compiler,
        executor=executor,
        receipt=receipt,
        uow=uow,
    )


def _request(entity_id: str, body: str = "body") -> MutationRequest:
    return MutationRequest.from_payload(
        name="note.create",
        entity_type="note",
        entity_id=entity_id,
        payload={"body": body, "id": entity_id},
        expected_version=None,
    )


@pytest.mark.asyncio
async def test_execute_finalizes_once_and_makes_ledger_visible_at_final_boundary(uow_fixture) -> None:
    first = await uow_fixture.uow.execute(uow_fixture.scope, _request("n1"), "op-n1")
    writes = uow_fixture.executor.calls
    second = await uow_fixture.uow.execute(uow_fixture.scope, _request("n1"), "op-n1")

    assert first.state is MutationState.FINALIZED
    assert second == first
    assert uow_fixture.executor.calls == writes == 1
    async with uow_fixture.sessions() as session:
        event = await session.scalar(select(SyncOutbox).where(SyncOutbox.operation_id == "op-n1"))
        state = await session.get(SyncState, 1)
    assert event is not None and event.visible is True and event.entity_type == "wire-note"
    assert state is not None and state.current_cursor == event.id


@pytest.mark.asyncio
async def test_operation_binding_conflict_happens_before_compilation(uow_fixture) -> None:
    await uow_fixture.uow.execute_batch(
        uow_fixture.scope, (_request("n1"),), "batch-a", operation_ids=("shared-op",)
    )
    compiler_calls = uow_fixture.compiler.calls
    with pytest.raises(IdempotencyConflictError):
        await uow_fixture.uow.execute_batch(
            uow_fixture.scope, (_request("n1", "different"),), "batch-b", operation_ids=("shared-op",)
        )
    assert uow_fixture.compiler.calls == compiler_calls
    async with uow_fixture.sessions() as session:
        assert await session.get(MutationBatch, "batch-b") is None


@pytest.mark.asyncio
async def test_dirty_recovery_gate_raises_canonical_error_before_batch_read(uow_fixture) -> None:
    uow = MutationUnitOfWork(
        catalog=_Catalog(),
        compiler=uow_fixture.compiler,
        interpreter=_Interpreter(),
        projection_executor=uow_fixture.executor,
        recovery_gate=_DirtyGate(),
        journal_factory=MutationJournal,
    )
    with pytest.raises(SpaceRecoveryRequiredError) as captured:
        await uow.execute(uow_fixture.scope, _request("n1"), "op-dirty")
    assert captured.value.code == "space_recovery_required"
    assert uow_fixture.compiler.calls == 0
    async with uow_fixture.sessions() as session:
        assert await session.scalar(select(func.count()).select_from(MutationBatch)) == 0


@pytest.mark.asyncio
async def test_projection_executor_asserts_fence_immediately_before_each_destructive_action() -> None:
    class _Executor(FileSystemProjectionExecutor):
        def __init__(self) -> None:
            self.observed: list[str] = []

        def _apply_markdown_write(self, scope, action) -> None:
            self.observed.append("markdown_write")

        def _apply_path_rename(self, scope, action) -> None:
            self.observed.append("path_rename")

        def _apply_path_remove(self, scope, action) -> None:
            self.observed.append("path_remove")

        def _apply_index_replace(self, scope, action) -> None:
            self.observed.append("index_replace")

        def _apply_fts_replace(self, scope, action) -> None:
            self.observed.append("fts_replace")

    executor = _Executor()
    receipt = _FenceReceipt(current=False)
    actions = (
        _materialized_action("markdown_write", "notes/n.md", 0, b"body"),
        _materialized_action(
            "path_rename",
            "notes/new.md",
            1,
            None,
            source="notes/old.md",
        ),
        _materialized_action("path_remove", "notes/deleted.md", 2, None),
        _materialized_action("index_replace", "rows/n.json", 3, b"index"),
        _materialized_action("fts_replace", "fts/n.json", 4, b"fts"),
    )
    for action in actions:
        with pytest.raises(RuntimeError, match="stale fence"):
            executor._apply_one_contained_action(object(), action, receipt)
        assert executor.observed == []


class _RecordingProjectionExecutor(FileSystemProjectionExecutor):
    def __init__(self) -> None:
        self.actions: list[tuple[str, str, bytes | None]] = []

    def _record(self, action) -> None:
        self.actions.append((action.tag.value, str(action.target), action.blob))

    def _apply_markdown_write(self, scope, action) -> None:
        self._record(action)

    def _apply_path_rename(self, scope, action) -> None:
        self._record(action)

    def _apply_path_remove(self, scope, action) -> None:
        self._record(action)

    def _apply_index_replace(self, scope, action) -> None:
        self._record(action)

    def _apply_fts_replace(self, scope, action) -> None:
        self._record(action)


def _all_projection_plans() -> tuple[object, ...]:
    return (
        _projection_plan("markdown_write", "notes/n.md", 0, None, b"body"),
        _projection_plan(
            "path_rename",
            "notes/new.md",
            1,
            None,
            None,
            source="notes/old.md",
        ),
        _projection_plan("path_remove", "notes/deleted.md", 2, b"deleted", None),
        _projection_plan("index_replace", "rows/n.json", 3, None, b"index"),
        _projection_plan("fts_replace", "fts/n.json", 4, b"old-fts", b"fts"),
    )


@pytest.mark.asyncio
async def test_uow_nonempty_projection_stages_materialize_all_closed_tags(
    uow_fixture, tmp_path
) -> None:
    stage_store = StageStore(_stage_authority(tmp_path / "stages"))
    uow_fixture.scope.mutation_stages = stage_store
    uow_fixture.compiler.projections = _all_projection_plans()
    executor = _RecordingProjectionExecutor()
    uow = MutationUnitOfWork(
        catalog=_Catalog(),
        compiler=uow_fixture.compiler,
        interpreter=_Interpreter(),
        projection_executor=executor,
        recovery_gate=_CleanGate(),
        journal_factory=MutationJournal,
    )
    try:
        result = await uow.execute(uow_fixture.scope, _request("n-projected"), "op-projected")

        assert result.state is MutationState.FINALIZED
        assert executor.actions == [
            ("markdown_write", "notes/n.md", b"body"),
            ("path_rename", "notes/new.md", None),
            ("path_remove", "notes/deleted.md", None),
            ("index_replace", "rows/n.json", b"index"),
            ("fts_replace", "fts/n.json", b"fts"),
        ]
    finally:
        stage_store.close()


@pytest.mark.asyncio
async def test_stale_projection_fence_performs_zero_actions(
    uow_fixture, tmp_path
) -> None:
    class _StalingStageStore(StageStore):
        async def materialize(self, operation_id, descriptors, *, image, receipt):
            actions = await super().materialize(
                operation_id, descriptors, image=image, receipt=receipt
            )
            receipt.current = False
            return actions

    stage_store = _StalingStageStore(_stage_authority(tmp_path / "stale-stages"))
    uow_fixture.scope.mutation_stages = stage_store
    uow_fixture.compiler.projections = _all_projection_plans()
    executor = _RecordingProjectionExecutor()
    uow = MutationUnitOfWork(
        catalog=_Catalog(),
        compiler=uow_fixture.compiler,
        interpreter=_Interpreter(),
        projection_executor=executor,
        recovery_gate=_CleanGate(),
        journal_factory=MutationJournal,
    )
    try:
        with pytest.raises(RuntimeError, match="stale fence"):
            await uow.execute(uow_fixture.scope, _request("n-stale"), "op-stale")

        assert executor.actions == []
        async with uow_fixture.sessions() as session:
            visible = await session.scalar(
                select(func.count())
                .select_from(SyncOutbox)
                .where(SyncOutbox.operation_id == "op-stale", SyncOutbox.visible.is_(True))
            )
        assert visible == 0
    finally:
        stage_store.close()
