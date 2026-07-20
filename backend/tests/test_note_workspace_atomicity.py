from __future__ import annotations

import json
from contextlib import asynccontextmanager
from dataclasses import dataclass
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker

import app.mutation.types as mutation_types
from app.errors import IdempotencyConflictError, SpaceRecoveryRequiredError
from app.file_system.engine.base import FileSystemProjectionExecutor, StorageBase
from app.models.mutation import MutationBatch, MutationOperation
from app.models.sync_outbox import SyncOutbox
from app.models.sync_state import SyncState
from app.models.task import Task
from app.mutation.journal import MutationJournal
from app.mutation.staging import StageStore
from app.mutation.types import (
    DbMutationPlan,
    MutationCommand,
    MutationRequest,
    MutationState,
    SyncEventPlan,
)
from app.mutation.unit_of_work import (
    AuthorityOverlay,
    BatchCompilation,
    DbMutationInterpreter,
    MutationCompiler,
    MutationUnitOfWork,
)
from app.registry import CATALOG
from app.runtime.contained_io import BoundDirectoryHandle, BoundStageDirectory
from app.runtime.leases import LeaseMode, RuntimeLeaseCoordinator


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
async def test_authority_overlay_reads_locked_rows_and_applies_after_images(uow_fixture) -> None:
    async with uow_fixture.sessions.begin() as session:
        session.add(
            Task(
                id="overlay-task",
                title="before",
                created_at="2026-07-20T00:00:00Z",
                updated_at="2026-07-20T00:00:00Z",
                version=1,
            )
        )

    request = MutationRequest.from_payload(
        name="entity.update",
        entity_type="task",
        entity_id="overlay-task",
        payload={"title": "after"},
        expected_version=1,
    )
    async with uow_fixture.sessions() as session:
        overlay = await AuthorityOverlay.from_locked_authorities(
            uow_fixture.scope, session, CATALOG
        )
    before = overlay.row("task", "overlay-task")
    assert before is not None and before["title"] == "before"

    after = dict(before)
    after.update(title="after", version=2)
    command = MutationCommand.from_effects(
        request=request,
        db_plans=(
            DbMutationPlan(
                table="tasks",
                primary_key={"id": "overlay-task"},
                operation="update",
                expected_version=1,
                before_row=before,
                after_row=after,
            ),
        ),
        projections=(),
        sync_events=(),
        result_value=after,
    )
    overlay.apply(command)

    assert overlay.row("task", "overlay-task") == after


@pytest.mark.asyncio
async def test_catalog_compiler_and_interpreter_execute_unregistered_entity_policy(
    uow_fixture,
) -> None:
    async with uow_fixture.sessions.begin() as session:
        session.add(
            Task(
                id="generic-task",
                title="before",
                created_at="2026-07-20T00:00:00Z",
                updated_at="2026-07-20T00:00:00Z",
                version=1,
            )
        )
    request = MutationRequest.from_payload(
        name="entity.update",
        entity_type="task",
        entity_id="generic-task",
        payload={"title": "after"},
        expected_version=1,
    )
    item = mutation_types.PreparedBatchItem(
        0, "generic-operation", request.request_hash, request, None
    )

    async with uow_fixture.sessions() as session:
        compilation = await MutationCompiler(CATALOG).compile_batch(
            uow_fixture.scope, (item,), session
        )

    assert compilation.rejected == ()
    assert compilation.operation_ids == ("generic-operation",)
    assert compilation.commands[0].db_plans[0].after_row["title"] == "after"

    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=MutationCompiler(CATALOG),
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=FileSystemProjectionExecutor(),
        recovery_gate=_CleanGate(),
        journal_factory=MutationJournal,
    )
    result = await uow.execute(uow_fixture.scope, request, "generic-execution")
    async with uow_fixture.sessions() as session:
        stored = await session.get(Task, "generic-task")

    assert result.state is MutationState.FINALIZED
    assert stored is not None and stored.title == "after" and stored.version == 2


@pytest.mark.asyncio
async def test_production_compiler_persists_aliases_through_invisible_and_visible_ledger(
    uow_fixture, monkeypatch
) -> None:
    internal_names = ("quick_note", "time_block", "schedule_quick_note")

    class AliasPolicy:
        entity_types = frozenset(internal_names)

        async def compile(self, context, request):
            return context.command(
                request=request,
                db_plans=(),
                sync_events=(
                    SyncEventPlan(
                        request.entity_type,
                        request.entity_id,
                        "create",
                        {"id": request.entity_id},
                        1,
                        "2026-07-20T00:00:00Z",
                    ),
                ),
                value={"id": request.entity_id},
            )

    visibility_snapshots: list[tuple[tuple[str, bool], ...]] = []
    original_finalize = MutationJournal.finalize_batch

    async def observed_finalize(journal, batch_id):
        async with uow_fixture.sessions() as session:
            before = tuple(
                (
                    row.entity_type,
                    row.visible,
                )
                for row in tuple(
                    await session.scalars(
                        select(SyncOutbox)
                        .where(SyncOutbox.batch_id == batch_id)
                        .order_by(SyncOutbox.id)
                    )
                )
            )
        visibility_snapshots.append(before)
        result = await original_finalize(journal, batch_id)
        async with uow_fixture.sessions() as session:
            after = tuple(
                (row.entity_type, row.visible)
                for row in tuple(
                    await session.scalars(
                        select(SyncOutbox)
                        .where(SyncOutbox.batch_id == batch_id)
                        .order_by(SyncOutbox.id)
                    )
                )
            )
        visibility_snapshots.append(after)
        return result

    monkeypatch.setattr(MutationJournal, "finalize_batch", observed_finalize)
    requests = tuple(
        MutationRequest.from_payload(
            name="alias.create",
            entity_type=entity_type,
            entity_id=f"alias-{index}",
            payload={},
            expected_version=None,
        )
        for index, entity_type in enumerate(internal_names)
    )
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=MutationCompiler(CATALOG, (AliasPolicy(),)),
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=FileSystemProjectionExecutor(),
        recovery_gate=_CleanGate(),
        journal_factory=MutationJournal,
    )

    result = await uow.execute_batch(
        uow_fixture.scope,
        requests,
        "alias-batch",
        operation_ids=("alias-op-0", "alias-op-1", "alias-op-2"),
    )

    async with uow_fixture.sessions() as session:
        operations = tuple(
            await session.scalars(
                select(MutationOperation)
                .where(MutationOperation.batch_id == "alias-batch")
                .order_by(MutationOperation.sequence)
            )
        )
    persisted_internal = tuple(
        DbMutationInterpreter(CATALOG).decode_command(row.command_json).sync_events[0].entity_type
        for row in operations
    )
    wire_names = tuple(CATALOG.get(name).effective_sync_entity_type for name in internal_names)
    assert result.rejected == ()
    assert persisted_internal == internal_names
    assert visibility_snapshots == [
        tuple((name, False) for name in wire_names),
        tuple((name, True) for name in wire_names),
    ]


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
async def test_execute_orders_every_durable_boundary_before_visibility(
    uow_fixture, monkeypatch
) -> None:
    observed: list[str] = []
    uow_fixture.compiler.projections = _all_projection_plans()

    original_create_intent = MutationJournal.create_batch_intent
    original_mark_staged = MutationJournal.mark_staged
    original_mark_finalizing = MutationJournal.mark_finalizing
    original_transition = MutationJournal.transition
    original_finalize = MutationJournal.finalize_batch
    original_commit_business = MutationUnitOfWork._commit_business
    original_publish = uow_fixture.scope.mutation_stages.publish
    original_apply_forward = uow_fixture.executor.apply_forward

    async def create_intent(journal, *args, **kwargs):
        result = await original_create_intent(journal, *args, **kwargs)
        observed.append("INTENT-committed")
        return result

    async def publish(*args, **kwargs):
        result = await original_publish(*args, **kwargs)
        observed.append("stage-published")
        return result

    async def mark_staged(journal, *args, **kwargs):
        result = await original_mark_staged(journal, *args, **kwargs)
        observed.append("STAGED-committed")
        return result

    async def commit_business(uow, *args, **kwargs):
        result = await original_commit_business(uow, *args, **kwargs)
        observed.append("business-and-DB_COMMITTED-committed")
        return result

    async def mark_finalizing(journal, *args, **kwargs):
        result = await original_mark_finalizing(journal, *args, **kwargs)
        observed.append("FINALIZING-committed")
        return result

    async def apply_forward(scope, operation_id, command, receipt):
        result = await original_apply_forward(scope, operation_id, command, receipt)
        observed.extend(f"projection:{item.tag.value}" for item in command.projections)
        return result

    async def transition(journal, operation_id, target):
        result = await original_transition(journal, operation_id, target)
        if target is MutationState.FORWARD_APPLIED:
            observed.append("FORWARD_APPLIED-committed")
        return result

    async def finalize(journal, *args, **kwargs):
        result = await original_finalize(journal, *args, **kwargs)
        observed.append("FINALIZED-and-ledger-visible-committed")
        return result

    monkeypatch.setattr(MutationJournal, "create_batch_intent", create_intent)
    monkeypatch.setattr(uow_fixture.scope.mutation_stages, "publish", publish)
    monkeypatch.setattr(MutationJournal, "mark_staged", mark_staged)
    monkeypatch.setattr(MutationUnitOfWork, "_commit_business", commit_business)
    monkeypatch.setattr(MutationJournal, "mark_finalizing", mark_finalizing)
    monkeypatch.setattr(uow_fixture.executor, "apply_forward", apply_forward)
    monkeypatch.setattr(MutationJournal, "transition", transition)
    monkeypatch.setattr(MutationJournal, "finalize_batch", finalize)

    result = await uow_fixture.uow.execute(
        uow_fixture.scope, _request("ordered"), "ordered-operation"
    )

    assert result.state is MutationState.FINALIZED
    assert observed == [
        "INTENT-committed",
        "stage-published",
        "STAGED-committed",
        "business-and-DB_COMMITTED-committed",
        "FINALIZING-committed",
        "projection:markdown_write",
        "projection:path_rename",
        "projection:path_remove",
        "projection:index_replace",
        "projection:fts_replace",
        "FORWARD_APPLIED-committed",
        "FINALIZED-and-ledger-visible-committed",
    ]


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


def test_storage_base_owns_all_contained_projection_primitives() -> None:
    for name in (
        "_apply_projection_markdown_write",
        "_apply_projection_path_rename",
        "_apply_projection_path_remove",
        "_apply_projection_index_replace",
        "_apply_projection_fts_replace",
    ):
        assert callable(getattr(StorageBase, name, None)), name


@pytest.mark.asyncio
async def test_production_projection_executor_applies_all_tags_through_contained_authorities(
    tmp_path,
) -> None:
    from app.file_system.api import open_contained_file_system
    from app.runtime.contained_io import open_bound_space
    from app.runtime.scope import _walk_existing_ancestors

    root = tmp_path / "contained-space"
    notes = root / "notes"
    notes.mkdir(parents=True)
    (root / "space.db").touch()
    (root / "index.db").touch()
    paths = SimpleNamespace(
        space_root=root.parent,
        db_path=root / "space.db",
        notes_dir=notes,
        index_db=root / "index.db",
    )
    opens = open_bound_space(paths, _walk_existing_ancestors(paths))
    file_system = await open_contained_file_system(opens)
    stages = StageStore(opens.take_mutation_stage_authority())
    coordinator = RuntimeLeaseCoordinator(tmp_path / ".runtime-production-projection")
    global_lease = await coordinator.acquire_global(LeaseMode.SHARED, "test", 2)
    space_lease = await coordinator.acquire_spaces(
        ["space-production"], LeaseMode.EXCLUSIVE, "projection", 2
    )
    try:
        await file_system.create_note(
            title="Original",
            content="old body",
            external_id="n-production",
        )
        def canonical(value):
            return json.dumps(
                value, ensure_ascii=True, sort_keys=True, separators=(",", ":")
            ).encode("ascii")
        folder_row = {
            "color": None,
            "created_at": "2026-07-20T00:00:00Z",
            "icon": "folder",
            "id": "f-production",
            "is_system": False,
            "name": "Projected",
            "parent_id": None,
            "sort_order": 0,
            "trashed_at": None,
            "updated_at": "2026-07-20T00:00:00Z",
        }
        plans = (
            _projection_plan(
                "markdown_write", "notes/projected.md", 0, None, b"projected body"
            ),
            _projection_plan(
                "path_rename",
                "notes/renamed.md",
                1,
                None,
                None,
                source="notes/projected.md",
            ),
            _projection_plan(
                "path_remove", "notes/renamed.md", 2, b"projected body", None
            ),
            _projection_plan(
                "index_replace",
                "index/folders/id/f-production",
                3,
                None,
                canonical({"row": folder_row}),
            ),
            _projection_plan(
                "fts_replace",
                "fts/n-production",
                4,
                None,
                canonical({"content": "fresh searchable term", "title": "Original"}),
            ),
        )
        command = MutationCommand.from_effects(
            request=_request("n-production"),
            db_plans=(),
            projections=plans,
            sync_events=(),
            result_value={"id": "n-production"},
        )
        manifest = await stages.publish(
            "production-projection",
            plans,
            lease=space_lease,
            space_id="space-production",
        )
        assert tuple(step.descriptor for step in manifest.steps) == command.persisted().projections

        scope = SimpleNamespace(mutation_stages=stages, file_system=file_system)
        receipt = space_lease.fence_receipt("space-production")
        await FileSystemProjectionExecutor().apply_forward(
            scope, "production-projection", command.persisted(), receipt
        )

        folder = await file_system.get_folder("f-production")
        search = await file_system.search("fresh searchable term")
        assert folder.name == "Projected"
        assert [item.note_id for item in search] == ["n-production"]
        assert file_system._file_exists("notes/projected.md") is False
        assert file_system._file_exists("notes/renamed.md") is False
    finally:
        stages.close()
        await file_system.close()
        await space_lease.release()
        await global_lease.release()


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
