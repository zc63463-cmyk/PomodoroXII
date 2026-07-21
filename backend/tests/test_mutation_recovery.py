from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.file_system.interfaces import ProjectionAuthoritySnapshot
from app.models.folder import Folder
from app.models.mutation import MutationBatch, MutationOperation, MutationStep
from app.models.sync_outbox import SyncOutbox
from app.mutation.journal import MutationJournal
from app.mutation.recovery import (
    FAULT_OUTCOME,
    RECOVERY_ACTION,
    MutationRecovery,
)
from app.mutation.staging import StageStore
from app.mutation.types import (
    ContainedProjectionActionField,
    DbMutationPlan,
    MutationCommand,
    MutationRequest,
    MutationState,
    ProjectionActionTag,
    ProjectionPlan,
    RecoveryInspection,
    RecoveryResult,
    StepState,
    SyncEventPlan,
)
from app.mutation.unit_of_work import DbMutationInterpreter
from app.registry import CATALOG
from app.runtime.contained_io import BoundDirectoryHandle, BoundStageDirectory
from app.runtime.leases import LeaseMode
from app.services.sync_outbox import record_sync_event


class FaultPoint(StrEnum):
    BEFORE_INTENT = "before/at INTENT commit"
    TEMP_STAGE_BLOB = "temporary stage blob write"
    MANIFEST_WRITE = "manifest write/fsync"
    ATOMIC_STAGE_RENAME = "atomic stage rename"
    CHILD_STAGE_PUBLISH = "after each accepted child stage publish"
    BATCH_MARK_STAGED = "before/at batch mark_staged commit"
    STAGED_COMMIT = "STAGED commit"
    ORM_FLUSH_SAVEPOINT = "ORM flush/savepoint"
    LEDGER_INSERT = "invisible index/ledger insert in outer transaction"
    OUTER_COMMIT = "outer business commit"
    FINALIZING_COMMIT = "FINALIZING commit"
    MARKDOWN_FINALIZE = "Markdown finalize"
    PATH_FINALIZE = "path/frontmatter finalize"
    INDEX_COMMIT = "index row commit"
    FTS_COMMIT = "FTS commit"
    VERSION_TRASH = "version/trash finalize"
    TERMINAL_VISIBILITY = "terminal status/visibility commit"
    MISSING_AFTER = "missing/corrupt after-image after DB commit"
    CORRUPT_IMAGES = "corrupt forward and inverse images"
    ORPHAN_STAGE = "orphan temp/published stage"
    RESTART_NONTERMINAL = "restart from every nonterminal state"
    BATCH_CHILD_FAILURE = "accepted batch child finalize failure"


ALL_FAULT_POINTS = tuple(FaultPoint)


def _stage_authority(path: Path) -> BoundStageDirectory:
    path.mkdir(parents=True)
    parent = BoundDirectoryHandle._create(path.parent)
    try:
        return BoundStageDirectory._from_parent_handle(parent, path.name)
    finally:
        parent._close()


class _DiskProjection:
    """Small restartable projection authority used by the recovery matrix."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.state_path = self.root / "state.json"
        if not self.state_path.exists():
            self._save({"markdown": {}, "index": {}, "fts": {}})

    def _load(self) -> dict[str, dict[str, str]]:
        return json.loads(self.state_path.read_text(encoding="utf-8"))

    def _save(self, value: dict[str, dict[str, str]]) -> None:
        self.state_path.write_text(
            json.dumps(value, sort_keys=True, separators=(",", ":")),
            encoding="utf-8",
        )

    def _bucket(self, target: str) -> str:
        return "markdown" if target.startswith("notes/") else (
            "index" if target.startswith("index/") else "fts"
        )

    def _apply(self, action, receipt) -> None:
        receipt.assert_current()
        state = self._load()
        tag = action.tag.value
        target = str(action.target)
        if tag == "path_rename":
            source = str(action.source)
            source_bucket = self._bucket(source)
            target_bucket = self._bucket(target)
            value = state[source_bucket].pop(source, None)
            if value is None:
                value = state[target_bucket].get(target)
            if value is not None:
                state[target_bucket][target] = value
        elif tag == "path_remove":
            state[self._bucket(target)].pop(target, None)
        else:
            bucket = self._bucket(target)
            if action.blob is None:
                state[bucket].pop(target, None)
            else:
                state[bucket][target] = action.blob.hex()
        self._save(state)

    def _apply_projection_markdown_write(self, action, receipt) -> None:
        self._apply(action, receipt)

    def _apply_projection_path_rename(self, action, receipt) -> None:
        self._apply(action, receipt)

    def _apply_projection_path_remove(self, action, receipt) -> None:
        self._apply(action, receipt)

    def _apply_projection_index_replace(self, action, receipt) -> None:
        self._apply(action, receipt)

    def _apply_projection_fts_replace(self, action, receipt) -> None:
        self._apply(action, receipt)

    async def snapshot_projection_authority(self) -> ProjectionAuthoritySnapshot:
        state = self._load()
        return ProjectionAuthoritySnapshot(
            {
                key: bytes.fromhex(value) for key, value in state["markdown"].items()
            },
            {key: bytes.fromhex(value) for key, value in state["index"].items()},
            {key: bytes.fromhex(value) for key, value in state["fts"].items()},
        )


class _ProjectionExecutor:
    def __init__(self, *, fail_forward: bool = False) -> None:
        self.fail_forward = fail_forward
        self.forward_calls = 0
        self.inverse_calls = 0

    async def apply_forward(
        self, scope, operation_id, command, receipt, *, ordinals=None
    ) -> None:
        self.forward_calls += 1
        if self.fail_forward:
            raise RuntimeError("injected forward failure")
        actions = await scope.mutation_stages.materialize_side(
            operation_id,
            command.projections,
            image="after",
            ordinals=(
                tuple(range(len(command.projections)))
                if ordinals is None
                else tuple(ordinals)
            ),
            receipt=receipt,
        )
        for action in actions:
            scope.file_system._apply(action, receipt)

    async def restore_before(
        self, scope, operation_id, command, receipt, *, ordinals=None
    ) -> None:
        self.inverse_calls += 1
        actions = await scope.mutation_stages.materialize_side(
            operation_id,
            command.projections,
            image="before",
            ordinals=(
                tuple(reversed(range(len(command.projections))))
                if ordinals is None
                else tuple(ordinals)
            ),
            receipt=receipt,
        )
        for action in actions:
            scope.file_system._apply(action, receipt)


class _OrdinalProjectionExecutor(_ProjectionExecutor):
    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.forward_ordinals: list[int] = []
        self.inverse_ordinals: list[int] = []

    async def apply_forward(
        self, scope, operation_id, command, receipt, *, ordinals=None
    ) -> None:
        self.forward_ordinals.extend(ordinals or range(len(command.projections)))
        await super().apply_forward(
            scope,
            operation_id,
            command,
            receipt,
            ordinals=ordinals,
        )

    async def restore_before(
        self, scope, operation_id, command, receipt, *, ordinals=None
    ) -> None:
        self.inverse_ordinals.extend(
            ordinals or reversed(range(len(command.projections)))
        )
        await super().restore_before(
            scope,
            operation_id,
            command,
            receipt,
            ordinals=ordinals,
        )

class _Receipt:
    def assert_current(self) -> None:
        return None


class _Lease:
    def __init__(self, mode: LeaseMode, scope: str) -> None:
        self.mode = mode
        self.scope = scope
        self.owner_task = None
        self._receipt = _Receipt()

    def assert_active_owner(self, *, mode=None, scope=None, **_kwargs) -> None:
        current = asyncio.current_task()
        if self.owner_task is None:
            self.owner_task = current
        if self.owner_task is not current:
            raise RuntimeError("lease owner Task changed")
        if mode is not None and mode is not self.mode:
            raise RuntimeError("lease mode changed")
        if scope is not None and scope != self.scope:
            raise RuntimeError("lease scope changed")

    def fence_receipt(self, scope: str) -> _Receipt:
        self.assert_active_owner(scope=scope)
        return self._receipt


@dataclass
class _RecoveryFixture:
    sessions: async_sessionmaker
    scope: object
    coordinator: object
    stage_root: Path
    projection_root: Path
    operation_id: str
    batch_id: str
    command: MutationCommand

    async def close(self) -> None:
        return None


@pytest.fixture
async def mutation_fixture(space_session, tmp_path):
    sessions = async_sessionmaker(space_session.bind, expire_on_commit=False)
    operation_id = "recovery-op"
    batch_id = "recovery-batch"
    row = {
        "id": "folder-recovery",
        "created_at": "2026-07-21T00:00:00Z",
        "updated_at": "2026-07-21T00:00:00.000Z",
        "version": 1,
        "name": "Recovered",
        "parent_id": None,
        "icon": "folder",
        "color": None,
        "sort_order": 0,
        "is_system": False,
        "trashed_at": None,
    }
    request = MutationRequest.from_payload(
        name="folder.create",
        entity_type="folder",
        entity_id=row["id"],
        payload={"id": row["id"], "name": row["name"]},
        expected_version=None,
    )
    index_blob = json.dumps(
        {"row": row}, ensure_ascii=True, sort_keys=True, separators=(",", ":")
    ).encode("ascii")
    command = MutationCommand.from_effects(
        request=request,
        db_plans=(
            DbMutationPlan(
                table="folders",
                primary_key={"id": row["id"]},
                operation="insert",
                expected_version=None,
                before_row=None,
                after_row=row,
            ),
        ),
        projections=(
            ProjectionPlan(
                ProjectionActionTag.INDEX_REPLACE,
                None,
                ContainedProjectionActionField(
                    f"index/folders/id/{row['id']}"
                ),
                0,
                None,
                index_blob,
            ),
        ),
        sync_events=(
            SyncEventPlan(
                entity_type="folder",
                entity_id=row["id"],
                action="create",
                payload=row,
                version=1,
                created_at=row["created_at"],
            ),
        ),
        result_value={"id": row["id"]},
    )
    stage_root = tmp_path / "stages"
    stage_store = StageStore(_stage_authority(stage_root))
    projection_root = tmp_path / "projection"
    projection = _DiskProjection(projection_root)
    coordinator = SimpleNamespace()
    global_lease = _Lease(LeaseMode.SHARED, "global")
    space_lease = _Lease(LeaseMode.EXCLUSIVE, "space-test")

    scope = SimpleNamespace(
        scope=SimpleNamespace(space_id="space-test"),
        file_system=projection,
        mutation_stages=stage_store,
        session_factory=sessions,
        global_lease=global_lease,
        space_lease=space_lease,
        _runtime=None,
    )

    fixture = _RecoveryFixture(
        sessions,
        scope,
        coordinator,
        stage_root,
        projection_root,
        operation_id,
        batch_id,
        command,
    )
    fixture.global_lease = global_lease
    fixture.space_lease = space_lease
    try:
        yield fixture
    finally:
        stage_store.close()
        await fixture.close()


async def _persist_intent(fixture: _RecoveryFixture, *, publish: bool) -> None:
    journal = MutationJournal(fixture.sessions)
    await journal.create_batch_intent(
        fixture.batch_id,
        "request-hash",
        (fixture.operation_id,),
        (fixture.command,),
        (),
    )
    if publish:
        manifest = await fixture.scope.mutation_stages.publish(
            fixture.operation_id,
            fixture.command.projections,
            lease=fixture.space_lease,
            space_id="space-test",
        )
        await journal.mark_staged(fixture.batch_id, (manifest,))


async def _recover(fixture: _RecoveryFixture, *, fail_forward: bool = False):
    provider = MutationRecovery(
        catalog=CATALOG,
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=_ProjectionExecutor(fail_forward=fail_forward),
    )
    return await provider.recover_under_lease(
        fixture.scope,
        fixture.space_lease,
    )


async def _leave_db_committed(fixture: _RecoveryFixture) -> None:
    journal = MutationJournal(fixture.sessions)
    interpreter = DbMutationInterpreter(CATALOG)
    async with fixture.sessions.begin() as session:
        await interpreter.apply(session, fixture.command.db_plans)
        operation = await session.get(MutationOperation, fixture.operation_id)
        assert operation is not None
        operation.db_before_json = "[null]"
        operation.db_after_json = json.dumps(
            [dict(fixture.command.db_plans[0].after_row)]
        )
        event = fixture.command.sync_events[0]
        spec = CATALOG.get(event.entity_type)
        await record_sync_event(
            session,
            entity_type=spec.effective_sync_entity_type,
            entity_id=event.entity_id,
            action=event.action,
            payload=event.payload,
            operation_id=fixture.operation_id,
            batch_id=fixture.batch_id,
            version=event.version,
            created_at=event.created_at,
            visible=False,
        )
        await journal.transition_in_transaction(
            session,
            fixture.operation_id,
            MutationState.STAGED,
            MutationState.DB_COMMITTED,
        )


async def _publish_without_mark_staged(fixture: _RecoveryFixture) -> None:
    journal = MutationJournal(fixture.sessions)
    await journal.create_batch_intent(
        fixture.batch_id,
        "request-hash",
        (fixture.operation_id,),
        (fixture.command,),
        (),
    )
    await fixture.scope.mutation_stages.publish(
        fixture.operation_id,
        fixture.command.projections,
        lease=fixture.space_lease,
        space_id="space-test",
    )


def _folder_projection_command(
    fixture: _RecoveryFixture,
    entity_ids: tuple[str, ...],
) -> MutationCommand:
    base_plan = fixture.command.db_plans[0]
    base_event = fixture.command.sync_events[0]
    plans = []
    projections = []
    events = []
    for ordinal, entity_id in enumerate(entity_ids):
        after_row = dict(base_plan.after_row or {})
        after_row["id"] = entity_id
        after_row["name"] = entity_id
        plans.append(
            DbMutationPlan(
                table=base_plan.table,
                primary_key={"id": entity_id},
                operation="insert",
                expected_version=None,
                before_row=None,
                after_row=after_row,
            )
        )
        projections.append(
            ProjectionPlan(
                ProjectionActionTag.INDEX_REPLACE,
                None,
                ContainedProjectionActionField(f"index/folders/id/{entity_id}"),
                ordinal,
                None,
                f"projection-{entity_id}".encode(),
            )
        )
        events.append(
            SyncEventPlan(
                entity_type=base_event.entity_type,
                entity_id=entity_id,
                action=base_event.action,
                payload=after_row,
                version=base_event.version,
                created_at=base_event.created_at,
            )
        )
    first = entity_ids[0]
    return MutationCommand.from_effects(
        request=MutationRequest.from_payload(
            name="folder.create",
            entity_type="folder",
            entity_id=first,
            payload={"id": first, "name": first},
            expected_version=None,
        ),
        db_plans=tuple(plans),
        projections=tuple(projections),
        sync_events=tuple(events),
        result_value={"id": first},
    )


async def _arrange_fault(
    fixture: _RecoveryFixture,
    fault_point: FaultPoint,
) -> bool:
    early_abort = {
        FaultPoint.TEMP_STAGE_BLOB,
        FaultPoint.MANIFEST_WRITE,
        FaultPoint.CHILD_STAGE_PUBLISH,
    }
    staged = {
        FaultPoint.STAGED_COMMIT,
        FaultPoint.ORM_FLUSH_SAVEPOINT,
        FaultPoint.LEDGER_INSERT,
    }
    finalizing = {
        FaultPoint.FINALIZING_COMMIT,
        FaultPoint.MARKDOWN_FINALIZE,
        FaultPoint.PATH_FINALIZE,
        FaultPoint.INDEX_COMMIT,
        FaultPoint.FTS_COMMIT,
        FaultPoint.VERSION_TRASH,
        FaultPoint.TERMINAL_VISIBILITY,
    }
    if fault_point is FaultPoint.BEFORE_INTENT:
        return False
    if fault_point in early_abort:
        await _persist_intent(fixture, publish=False)
        return False
    if fault_point in {
        FaultPoint.ATOMIC_STAGE_RENAME,
        FaultPoint.BATCH_MARK_STAGED,
    }:
        await _publish_without_mark_staged(fixture)
        return False
    if fault_point is FaultPoint.ORPHAN_STAGE:
        await fixture.scope.mutation_stages.publish(
            fixture.operation_id,
            fixture.command.projections,
            lease=fixture.space_lease,
            space_id="space-test",
        )
        return False
    await _persist_intent(fixture, publish=True)
    if fault_point in staged:
        return False
    await _leave_db_committed(fixture)
    if fault_point is FaultPoint.OUTER_COMMIT:
        return False
    journal = MutationJournal(fixture.sessions)
    await journal.mark_finalizing(fixture.batch_id)
    if fault_point in finalizing:
        return False
    if fault_point in {FaultPoint.MISSING_AFTER, FaultPoint.BATCH_CHILD_FAILURE}:
        return True
    if fault_point is FaultPoint.RESTART_NONTERMINAL:
        async with fixture.sessions.begin() as session:
            batch = await session.get(MutationBatch, fixture.batch_id)
            operation = await session.get(MutationOperation, fixture.operation_id)
            assert batch is not None and operation is not None
            batch.state = MutationState.COMPENSATING
            operation.state = MutationState.COMPENSATING
        return False
    if fault_point is FaultPoint.CORRUPT_IMAGES:
        state = fixture.scope.file_system._load()
        state["index"]["index/folders/id/folder-recovery"] = b"corrupt".hex()
        fixture.scope.file_system._save(state)
        return True
    raise AssertionError(f"unmapped fault point: {fault_point}")


@pytest.mark.parametrize("fault_point", ALL_FAULT_POINTS)
@pytest.mark.asyncio
async def test_restart_converges_to_declared_all_old_or_all_new(
    mutation_fixture,
    fault_point: FaultPoint,
) -> None:
    assert fault_point in FAULT_OUTCOME
    assert FAULT_OUTCOME[fault_point] in {"all-old", "all-new", "failed-manual"}
    fail_forward = await _arrange_fault(mutation_fixture, fault_point)
    result = await _recover(mutation_fixture, fail_forward=fail_forward)
    async with mutation_fixture.sessions() as session:
        row = await session.get(Folder, "folder-recovery")
        events = tuple(await session.scalars(select(SyncOutbox)))
    projection = mutation_fixture.scope.file_system._load()["index"]
    expected = FAULT_OUTCOME[fault_point]
    if expected == "all-new":
        assert row is not None
        assert projection
        assert len(events) == 1 and events[0].visible is True
        assert result.failed_manual == ()
    elif expected == "all-old":
        assert row is None
        assert projection == {}
        assert events == ()
        assert result.failed_manual == ()
    else:
        assert result.failed_manual == (mutation_fixture.batch_id,)


def test_recovery_action_map_covers_every_nonterminal_state() -> None:
    assert set(RECOVERY_ACTION) == {
        MutationState.INTENT,
        MutationState.STAGED,
        MutationState.DB_COMMITTED,
        MutationState.FINALIZING,
        MutationState.FORWARD_APPLIED,
        MutationState.COMPENSATING,
    }


@pytest.mark.asyncio
async def test_intent_without_published_stage_aborts_whole_batch(mutation_fixture):
    await _persist_intent(mutation_fixture, publish=False)
    result = await _recover(mutation_fixture)
    assert result.aborted == (mutation_fixture.batch_id,)
    async with mutation_fixture.sessions() as session:
        batch = await session.get(MutationBatch, mutation_fixture.batch_id)
        assert batch is not None and MutationState(batch.state) is MutationState.ABORTED
        assert await session.scalar(select(Folder).where(Folder.id == "folder-recovery")) is None
        assert await session.scalar(select(SyncOutbox.id)) is None


@pytest.mark.asyncio
async def test_staged_restart_replays_business_projection_and_visible_ledger(mutation_fixture):
    await _persist_intent(mutation_fixture, publish=True)
    result = await _recover(mutation_fixture)
    assert result.finalized == (mutation_fixture.batch_id,)
    async with mutation_fixture.sessions() as session:
        row = await session.get(Folder, "folder-recovery")
        event = await session.scalar(
            select(SyncOutbox).where(SyncOutbox.batch_id == mutation_fixture.batch_id)
        )
        batch = await session.get(MutationBatch, mutation_fixture.batch_id)
    assert row is not None
    assert event is not None and event.visible is True
    assert batch is not None and MutationState(batch.state) is MutationState.FINALIZED
    assert mutation_fixture.scope.file_system._load()["index"]


@pytest.mark.asyncio
async def test_finalizing_restart_is_idempotent_and_does_not_duplicate_ledger(mutation_fixture):
    await _persist_intent(mutation_fixture, publish=True)
    journal = MutationJournal(mutation_fixture.sessions)
    await _leave_db_committed(mutation_fixture)
    await journal.mark_finalizing(mutation_fixture.batch_id)
    first = await _recover(mutation_fixture)
    second = await _recover(mutation_fixture)
    assert first.finalized == (mutation_fixture.batch_id,)
    assert second.finalized == ()
    async with mutation_fixture.sessions() as session:
        events = tuple(await session.scalars(select(SyncOutbox)))
        assert len(events) == 1 and events[0].visible is True


@pytest.mark.asyncio
async def test_projection_applied_before_restart_advances_without_second_write(
    mutation_fixture,
):
    await _persist_intent(mutation_fixture, publish=True)
    await _leave_db_committed(mutation_fixture)
    journal = MutationJournal(mutation_fixture.sessions)
    await journal.mark_finalizing(mutation_fixture.batch_id)
    executor = _ProjectionExecutor()
    await executor.apply_forward(
        mutation_fixture.scope,
        mutation_fixture.operation_id,
        mutation_fixture.command.persisted(),
        mutation_fixture.space_lease.fence_receipt("space-test"),
    )
    restarted_executor = _ProjectionExecutor()
    result = await MutationRecovery(
        catalog=CATALOG,
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=restarted_executor,
    ).recover_under_lease(
        mutation_fixture.scope,
        mutation_fixture.space_lease,
    )
    assert result.finalized == (mutation_fixture.batch_id,)
    assert executor.forward_calls == 1
    assert restarted_executor.forward_calls == 0


@pytest.mark.asyncio
async def test_forward_failure_compensates_db_projection_and_hidden_ledger(
    mutation_fixture,
):
    await _persist_intent(mutation_fixture, publish=True)
    await _leave_db_committed(mutation_fixture)
    journal = MutationJournal(mutation_fixture.sessions)
    await journal.mark_finalizing(mutation_fixture.batch_id)
    result = await _recover(mutation_fixture, fail_forward=True)
    assert result.compensated == (mutation_fixture.batch_id,)
    async with mutation_fixture.sessions() as session:
        batch = await session.get(MutationBatch, mutation_fixture.batch_id)
        row = await session.get(Folder, "folder-recovery")
        events = tuple(await session.scalars(select(SyncOutbox)))
    assert batch is not None
    assert MutationState(batch.state) is MutationState.COMPENSATED
    assert row is None
    assert events == ()
    assert mutation_fixture.scope.file_system._load()["index"] == {}


@pytest.mark.asyncio
async def test_missing_after_blob_compensates_from_proven_before_authority(
    mutation_fixture,
):
    await _persist_intent(mutation_fixture, publish=True)
    await _leave_db_committed(mutation_fixture)
    journal = MutationJournal(mutation_fixture.sessions)
    await journal.mark_finalizing(mutation_fixture.batch_id)
    key = StageStore.directory_key(mutation_fixture.operation_id)
    (
        mutation_fixture.stage_root
        / ".mutations"
        / key
        / "after"
        / "0.bin"
    ).unlink()

    result = await _recover(mutation_fixture)

    assert result.compensated == (mutation_fixture.batch_id,)
    async with mutation_fixture.sessions() as session:
        assert await session.get(Folder, "folder-recovery") is None
        assert tuple(await session.scalars(select(SyncOutbox))) == ()


@pytest.mark.asyncio
async def test_unprovable_forward_and_inverse_is_durable_failed_manual(mutation_fixture):
    await _persist_intent(mutation_fixture, publish=True)
    async with mutation_fixture.sessions.begin() as session:
        row = await session.get(MutationOperation, mutation_fixture.operation_id)
        assert row is not None
        row.state = MutationState.DB_COMMITTED
        row.db_before_json = "[null]"
        row.db_after_json = "[{}]"
        batch = await session.get(MutationBatch, mutation_fixture.batch_id)
        assert batch is not None
        batch.state = MutationState.DB_COMMITTED
    state = mutation_fixture.scope.file_system._load()
    state["index"]["index/folders/id/folder-recovery"] = hashlib.sha256(b"corrupt").hexdigest()
    mutation_fixture.scope.file_system._save(state)
    result = await _recover(mutation_fixture, fail_forward=True)
    assert result.failed_manual == (mutation_fixture.batch_id,)
    async with mutation_fixture.sessions() as session:
        batch = await session.get(MutationBatch, mutation_fixture.batch_id)
        operation = await session.get(MutationOperation, mutation_fixture.operation_id)
    assert batch is not None and MutationState(batch.state) is MutationState.FAILED_MANUAL
    assert operation is not None and operation.error_code == "mutation_recovery_required"


@pytest.mark.asyncio
async def test_recovery_rejects_nonmatching_space_lease(mutation_fixture):
    provider = MutationRecovery(
        catalog=CATALOG,
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=_ProjectionExecutor(),
    )
    with pytest.raises(Exception):
        await provider.recover_under_lease(
            mutation_fixture.scope,
            SimpleNamespace(assert_active_owner=lambda **_kwargs: None),
        )


@pytest.mark.asyncio
async def test_recovery_result_and_inspection_are_durable_types(mutation_fixture):
    inspection = await MutationRecovery(
        catalog=CATALOG,
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=_ProjectionExecutor(),
    ).inspect(mutation_fixture.scope)
    assert isinstance(inspection, RecoveryInspection)
    assert inspection.clean
    assert isinstance(RecoveryResult((), (), (), ()), RecoveryResult)


@pytest.mark.asyncio
async def test_partial_forward_restart_resumes_only_missing_durable_ordinals(
    mutation_fixture,
):
    command = _folder_projection_command(
        mutation_fixture,
        ("folder-recovery", "folder-recovery-2", "folder-recovery-3"),
    )
    journal = MutationJournal(mutation_fixture.sessions)
    await journal.create_batch_intent(
        mutation_fixture.batch_id,
        "request-hash",
        (mutation_fixture.operation_id,),
        (command,),
        (),
    )
    manifest = await mutation_fixture.scope.mutation_stages.publish(
        mutation_fixture.operation_id,
        command.projections,
        lease=mutation_fixture.space_lease,
        space_id="space-test",
    )
    await journal.mark_staged(mutation_fixture.batch_id, (manifest,))
    receipt = mutation_fixture.space_lease.fence_receipt("space-test")
    executor = _OrdinalProjectionExecutor()
    await executor.apply_forward(
        mutation_fixture.scope,
        mutation_fixture.operation_id,
        command.persisted(),
        receipt,
        ordinals=(0,),
    )
    executor.forward_ordinals.clear()
    result = await MutationRecovery(
        catalog=CATALOG,
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=executor,
    ).recover_under_lease(
        mutation_fixture.scope,
        mutation_fixture.space_lease,
    )
    assert result.finalized == (mutation_fixture.batch_id,)
    assert executor.forward_ordinals == [1, 2]
    async with mutation_fixture.sessions() as session:
        steps = tuple(
            await session.scalars(
                select(MutationStep).order_by(MutationStep.ordinal)
            )
        )
    assert [StepState(step.state) for step in steps] == [StepState.APPLIED] * 3
    assert [step.applied_hash for step in steps] == [
        descriptor.after_sha256 for descriptor in command.persisted().projections
    ]


@pytest.mark.asyncio
async def test_rename_wrong_target_bytes_are_unprovable(mutation_fixture) -> None:
    body = b"authoritative-body"
    plan = ProjectionPlan(
        ProjectionActionTag.PATH_RENAME,
        ContainedProjectionActionField("notes/old.md"),
        ContainedProjectionActionField("notes/new.md"),
        0,
        body,
        body,
    )
    descriptor = MutationCommand.from_effects(
        request=mutation_fixture.command.request,
        db_plans=mutation_fixture.command.db_plans,
        projections=(plan,),
        sync_events=mutation_fixture.command.sync_events,
        result_value=mutation_fixture.command.result_value,
    ).persisted().projections[0]
    state = mutation_fixture.scope.file_system._load()
    state["markdown"]["notes/new.md"] = b"wrong-body".hex()
    mutation_fixture.scope.file_system._save(state)
    provider = MutationRecovery(
        catalog=CATALOG,
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=_ProjectionExecutor(),
    )

    assert await provider._descriptor_state(
        mutation_fixture.scope, descriptor
    ) == "neither"


@pytest.mark.asyncio
async def test_compensation_reverses_children_then_ordinals(mutation_fixture) -> None:
    events: list[tuple[str, int]] = []

    class _OrderExecutor(_ProjectionExecutor):
        async def apply_forward(
            self, scope, operation_id, command, receipt, *, ordinals=None
        ) -> None:
            assert ordinals is not None
            if operation_id == "child-1" and ordinals == (1,):
                raise RuntimeError("injected child projection failure")
            await super().apply_forward(
                scope,
                operation_id,
                command,
                receipt,
                ordinals=ordinals,
            )

        async def restore_before(
            self, scope, operation_id, command, receipt, *, ordinals=None
        ) -> None:
            assert ordinals is not None
            events.append((operation_id, ordinals[0]))
            await super().restore_before(
                scope,
                operation_id,
                command,
                receipt,
                ordinals=ordinals,
            )

    commands = []
    for child in ("child-0", "child-1"):
        command = _folder_projection_command(
            mutation_fixture,
            (f"{child}-0", f"{child}-1"),
        )
        commands.append(command)
    journal = MutationJournal(mutation_fixture.sessions)
    await journal.create_batch_intent(
        mutation_fixture.batch_id,
        "request-hash",
        ("child-0", "child-1"),
        tuple(commands),
        (),
    )
    manifests = []
    for child, command in zip(("child-0", "child-1"), commands, strict=True):
        manifests.append(
            await mutation_fixture.scope.mutation_stages.publish(
                child,
                command.projections,
                lease=mutation_fixture.space_lease,
                space_id="space-test",
            )
        )
    await journal.mark_staged(mutation_fixture.batch_id, tuple(manifests))
    executor = _OrderExecutor()
    result = await MutationRecovery(
        catalog=CATALOG,
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=executor,
    ).recover_under_lease(
        mutation_fixture.scope,
        mutation_fixture.space_lease,
    )
    assert result.compensated == (mutation_fixture.batch_id,)
    assert events == [
        ("child-1", 0),
        ("child-0", 1),
        ("child-0", 0),
    ]
    async with mutation_fixture.sessions() as session:
        steps = tuple(
            await session.scalars(
                select(MutationStep).order_by(
                    MutationStep.operation_id,
                    MutationStep.ordinal,
                )
            )
        )
    assert all(StepState(step.state) is StepState.COMPENSATED for step in steps)
    assert all(step.applied_hash == step.before_hash for step in steps)


@pytest.mark.asyncio
async def test_first_failed_manual_stops_later_batch_recovery(mutation_fixture) -> None:
    journal = MutationJournal(mutation_fixture.sessions)
    first_command = _folder_projection_command(
        mutation_fixture,
        ("failed-manual",),
    )
    second_command = _folder_projection_command(
        mutation_fixture,
        ("later",),
    )
    await journal.create_batch_intent(
        "batch-1",
        "request-hash-1",
        ("operation-1",),
        (first_command,),
        (),
    )
    first_manifest = await mutation_fixture.scope.mutation_stages.publish(
        "operation-1",
        first_command.projections,
        lease=mutation_fixture.space_lease,
        space_id="space-test",
    )
    await journal.mark_staged("batch-1", (first_manifest,))
    await journal.create_batch_intent(
        "batch-2",
        "request-hash-2",
        ("operation-2",),
        (second_command,),
        (),
    )
    state = mutation_fixture.scope.file_system._load()
    first_target = str(first_command.projections[0].target)
    state["index"][first_target] = b"unprovable".hex()
    mutation_fixture.scope.file_system._save(state)

    result = await MutationRecovery(
        catalog=CATALOG,
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=_ProjectionExecutor(),
    ).recover_under_lease(
        mutation_fixture.scope,
        mutation_fixture.space_lease,
    )

    assert result.failed_manual == ("batch-1",)
    async with mutation_fixture.sessions() as session:
        first = await session.get(MutationBatch, "batch-1")
        second = await session.get(MutationBatch, "batch-2")
        second_operation = await session.get(MutationOperation, "operation-2")
    assert first is not None and MutationState(first.state) is MutationState.FAILED_MANUAL
    assert second is not None and MutationState(second.state) is MutationState.INTENT
    assert second_operation is not None
    assert MutationState(second_operation.state) is MutationState.INTENT


@pytest.mark.parametrize(
    ("batch_state", "step_state", "applied_side"),
    [
        (MutationState.FINALIZING, StepState.APPLIED, "after"),
        (MutationState.COMPENSATING, StepState.COMPENSATED, "before"),
    ],
)
@pytest.mark.asyncio
async def test_durable_step_state_never_bypasses_physical_hash_revalidation(
    mutation_fixture,
    batch_state: MutationState,
    step_state: StepState,
    applied_side: str,
) -> None:
    command = _folder_projection_command(mutation_fixture, ("step-proof",))
    journal = MutationJournal(mutation_fixture.sessions)
    await journal.create_batch_intent(
        mutation_fixture.batch_id,
        "request-hash",
        (mutation_fixture.operation_id,),
        (command,),
        (),
    )
    manifest = await mutation_fixture.scope.mutation_stages.publish(
        mutation_fixture.operation_id,
        command.projections,
        lease=mutation_fixture.space_lease,
        space_id="space-test",
    )
    await journal.mark_staged(mutation_fixture.batch_id, (manifest,))
    descriptor = command.persisted().projections[0]
    async with mutation_fixture.sessions.begin() as session:
        batch = await session.get(MutationBatch, mutation_fixture.batch_id)
        operation = await session.get(
            MutationOperation, mutation_fixture.operation_id
        )
        step = await session.scalar(
            select(MutationStep).where(
                MutationStep.operation_id == mutation_fixture.operation_id
            )
        )
        assert batch is not None and operation is not None and step is not None
        batch.state = batch_state
        operation.state = batch_state
        step.state = step_state
        step.applied_hash = (
            descriptor.after_sha256
            if applied_side == "after"
            else descriptor.before_sha256
        )
    state = mutation_fixture.scope.file_system._load()
    state["index"][str(descriptor.target)] = b"wrong-physical-bytes".hex()
    mutation_fixture.scope.file_system._save(state)

    result = await MutationRecovery(
        catalog=CATALOG,
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=_ProjectionExecutor(),
    ).recover_under_lease(
        mutation_fixture.scope,
        mutation_fixture.space_lease,
    )

    assert result.failed_manual == (mutation_fixture.batch_id,)
