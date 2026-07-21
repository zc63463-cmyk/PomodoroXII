from __future__ import annotations

import hashlib
import inspect
import json
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker

import app.mutation.types as mutation_types
from app.errors import IdempotencyConflictError, SpaceRecoveryRequiredError
from app.file_system.engine.base import FileSystemProjectionExecutor, StorageBase
from app.file_system.interfaces import ProjectionAuthoritySnapshot
from app.models.mutation import MutationBatch, MutationOperation
from app.models.note import Note
from app.models.quick_note import QuickNote
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
    bounded_child_operation_id,
)
from app.mutation.unit_of_work import (
    AuthorityOverlay,
    BatchCompilation,
    DbMutationInterpreter,
    MutationCompiler,
    MutationUnitOfWork,
    compile_catalog_entity_command,
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
        self.file_system = self
        self.projection_snapshot = ProjectionAuthoritySnapshot({}, {}, {})
        self._receipt = receipt

    async def snapshot_projection_authority(self) -> ProjectionAuthoritySnapshot:
        return self.projection_snapshot

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


async def _compile_production_batch(uow_fixture, requests, policies=()):
    compiler = MutationCompiler(CATALOG, policies)
    items = tuple(
        mutation_types.PreparedBatchItem(
            index, f"overlay-op-{index}", request.request_hash, request, None
        )
        for index, request in enumerate(requests)
    )
    async with uow_fixture.sessions() as session:
        return await compiler.compile_batch(uow_fixture.scope, items, session)


def _with_projection(base, *, projections):
    return MutationCommand.from_effects(
        request=base.request,
        db_plans=base.db_plans,
        projections=projections,
        sync_events=base.sync_events,
        result_value=base.result_value,
        resolution=base.resolution,
    )


def _canonical_projection_blob(value) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")


def _note_index_blob(row, path: str) -> bytes:
    return _canonical_projection_blob(
        {
            "row": {
                "category": row["category"],
                "content_hash": row["content_hash"],
                "created_at": row["created_at"],
                "current_path": path,
                "folder_id": row["folder_id"],
                "is_deleted": False,
                "level": "L1",
                "note_id": row["id"],
                "status": row["status"],
                "summary": row["summary"],
                "tags": row["tags"],
                "title": row["title"],
                "trashed_at": row["trashed_at"],
                "updated_at": row["updated_at"],
                "word_count": row["word_count"],
            }
        }
    )


def _folder_index_blob(row) -> bytes:
    return _canonical_projection_blob(
        {
            "row": {
                key: row[key]
                for key in (
                    "color",
                    "created_at",
                    "icon",
                    "id",
                    "is_system",
                    "name",
                    "parent_id",
                    "sort_order",
                    "trashed_at",
                    "updated_at",
                )
            }
        }
    )


def _fts_blob(row, body: bytes) -> bytes:
    return _canonical_projection_blob(
        {"content": body.decode("utf-8"), "title": row["title"]}
    )


def _note_create_projections(base, body: bytes, *, path: str | None = None):
    row = base.db_plans[0].after_row
    assert row is not None
    target = path or f"notes/{row['id']}.md"
    return (
        _projection_plan("markdown_write", target, 0, None, body),
        _projection_plan(
            "index_replace",
            f"index/notes/note_id/{row['id']}",
            1,
            None,
            _note_index_blob(row, target),
        ),
        _projection_plan(
            "fts_replace",
            f"fts/{row['id']}",
            2,
            None,
            _fts_blob(row, body),
        ),
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


def test_authority_overlay_rejects_inconsistent_commands_before_state_change() -> None:
    current = {
        "id": "overlay-existing",
        "title": "before",
        "description": "",
        "status": "todo",
        "priority": "medium",
        "tags": "[]",
        "plan": "",
        "completion": "",
        "due_date": None,
        "estimated_pomodoros": 1,
        "actual_pomodoros": 0,
        "archived_at": None,
        "created_at": "2026-07-20T00:00:00Z",
        "updated_at": "2026-07-20T00:00:00Z",
        "version": 1,
    }
    missing = {**current, "id": "overlay-missing"}
    updated_missing = {
        **missing,
        "title": "after",
        "updated_at": "2026-07-20T00:00:01Z",
        "version": 2,
    }
    request = MutationRequest.from_payload(
        name="overlay.probe",
        entity_type="task",
        entity_id="overlay-existing",
        payload={},
        expected_version=None,
    )
    cases = (
        MutationCommand.from_effects(
            request=request,
            db_plans=(
                DbMutationPlan(
                    "tasks",
                    {"id": "overlay-existing"},
                    "insert",
                    None,
                    None,
                    current,
                ),
            ),
            projections=(),
            sync_events=(),
            result_value=current,
        ),
        MutationCommand.from_effects(
            request=request,
            db_plans=(
                DbMutationPlan(
                    "tasks",
                    {"id": "overlay-missing"},
                    "update",
                    1,
                    missing,
                    updated_missing,
                ),
            ),
            projections=(),
            sync_events=(),
            result_value=updated_missing,
        ),
        MutationCommand.from_effects(
            request=request,
            db_plans=(
                DbMutationPlan(
                    "tasks",
                    {"id": "overlay-missing"},
                    "delete",
                    1,
                    missing,
                    None,
                ),
            ),
            projections=(),
            sync_events=(),
            result_value={"id": "overlay-missing"},
        ),
        MutationCommand.from_effects(
            request=request,
            db_plans=(),
            projections=(
                _projection_plan(
                    "path_rename",
                    "notes/missing-target.md",
                    0,
                    None,
                    None,
                    source="notes/missing-source.md",
                ),
            ),
            sync_events=(),
            result_value={"id": "overlay-existing"},
        ),
    )

    for command in cases:
        overlay = AuthorityOverlay(
            CATALOG, {("task", "overlay-existing"): current}
        )
        with pytest.raises(SpaceRecoveryRequiredError):
            overlay.apply(command)
        assert overlay.row("task", "overlay-existing") == current

    new_row = {**current, "id": "overlay-new"}
    insert_with_cas = MutationCommand.from_effects(
        request=request,
        db_plans=(
            DbMutationPlan(
                "tasks",
                {"id": "overlay-new"},
                "insert",
                1,
                None,
                new_row,
            ),
        ),
        projections=(),
        sync_events=(),
        result_value=new_row,
    )
    with pytest.raises(SpaceRecoveryRequiredError):
        AuthorityOverlay(CATALOG, {}).apply(insert_with_cas)


@pytest.mark.asyncio
async def test_batch_overlay_exposes_folder_create_to_note_child(uow_fixture) -> None:
    class FolderChildPolicy:
        entity_types = frozenset({"folder", "note"})

        async def compile(self, context, request):
            if request.entity_type == "note" and request.name == "entity.create":
                folder_id = request.payload.get("folder_id")
                assert isinstance(folder_id, str)
                assert context.authority.row("folder", folder_id) is not None
            base = await compile_catalog_entity_command(context, request)
            if request.entity_type == "folder":
                row = base.db_plans[0].after_row
                assert row is not None
                projection = _projection_plan(
                    "index_replace",
                    f"index/folders/id/{request.entity_id}",
                    0,
                    None,
                    _folder_index_blob(row),
                )
            else:
                return _with_projection(
                    base, projections=_note_create_projections(base, b"")
                )
            return _with_projection(base, projections=(projection,))

    compilation = await _compile_production_batch(
        uow_fixture,
        (
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="folder",
                entity_id="folder-child-parent",
                payload={"name": "Parent"},
                expected_version=None,
            ),
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="note",
                entity_id="note-child",
                payload={
                    "title": "Child",
                    "content_hash": hashlib.sha256(b"").hexdigest(),
                    "folder_id": "folder-child-parent",
                },
                expected_version=None,
            ),
        ),
        policies=(FolderChildPolicy(),),
    )

    assert compilation.rejected == ()
    assert compilation.operation_ids == ("overlay-op-0", "overlay-op-1")
    assert compilation.commands[1].db_plans[0].after_row["folder_id"] == (
        "folder-child-parent"
    )


@pytest.mark.asyncio
async def test_batch_overlay_exposes_quick_note_create_to_junction_child(uow_fixture) -> None:
    class JunctionParentPolicy:
        entity_types = frozenset({"task_quick_note"})

        async def compile(self, context, request):
            if request.name == "entity.create":
                quick_note_id = request.payload.get("quick_note_id")
                assert isinstance(quick_note_id, str)
                assert context.authority.row("quick_note", quick_note_id) is not None
            return await compile_catalog_entity_command(context, request)

    compilation = await _compile_production_batch(
        uow_fixture,
        (
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="quick_note",
                entity_id="quick-note-parent",
                payload={"content": "captured"},
                expected_version=None,
            ),
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="task_quick_note",
                entity_id="task-quick-note-link",
                payload={"task_id": "task-parent", "quick_note_id": "quick-note-parent"},
                expected_version=None,
            ),
        ),
        policies=(JunctionParentPolicy(),),
    )

    assert compilation.rejected == ()
    assert compilation.commands[1].db_plans[0].after_row["quick_note_id"] == (
        "quick-note-parent"
    )


@pytest.mark.asyncio
async def test_batch_overlay_exposes_quick_note_create_to_schedule_junction_child(
    uow_fixture,
) -> None:
    class NoteJunctionPolicy:
        entity_types = frozenset({"quick_note", "schedule_quick_note"})

        async def compile(self, context, request):
            if request.entity_type == "schedule_quick_note":
                quick_note_id = request.payload.get("quick_note_id")
                assert context.authority.row("quick_note", quick_note_id) is not None
            return await compile_catalog_entity_command(context, request)

    compilation = await _compile_production_batch(
        uow_fixture,
        (
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="quick_note",
                entity_id="junction-note-parent",
                payload={"content": "Parent"},
                expected_version=None,
            ),
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="schedule_quick_note",
                entity_id="schedule-note-link",
                payload={
                    "schedule_id": "schedule-parent",
                    "quick_note_id": "junction-note-parent",
                },
                expected_version=None,
            ),
        ),
        policies=(NoteJunctionPolicy(),),
    )

    assert compilation.rejected == ()
    assert compilation.commands[1].db_plans[0].after_row["quick_note_id"] == (
        "junction-note-parent"
    )


@pytest.mark.asyncio
async def test_batch_overlay_carries_consecutive_note_body_updates(uow_fixture) -> None:
    existing = Note(
        id="body-note",
        title="Body",
        content_hash=hashlib.sha256(b"original").hexdigest(),
        word_count=1,
        summary="",
        tags="[]",
        category=None,
        folder_id=None,
        status="active",
        trashed_at=None,
        created_at="2026-07-20T00:00:00Z",
        updated_at="2026-07-20T00:00:00Z",
        version=1,
    )
    async with uow_fixture.sessions.begin() as session:
        session.add(existing)
    note_fields = CATALOG.get("note").field_names
    existing_row = {field: getattr(existing, field) for field in note_fields}
    target = "notes/body-note.md"
    uow_fixture.scope.projection_snapshot = ProjectionAuthoritySnapshot(
        {target: b"original"},
        {"index/notes/note_id/body-note": _note_index_blob(existing_row, target)},
        {"fts/body-note": _fts_blob(existing_row, b"original")},
    )

    class BodyPolicy:
        entity_types = frozenset({"note"})

        async def compile(self, context, request):
            base = await compile_catalog_entity_command(context, request)
            target = "notes/body-note.md"
            before = context.authority.markdown(target)
            assert before is not None
            body = b"first" if request.expected_version == 1 else b"second"
            assert before == (b"original" if request.expected_version == 1 else b"first")
            _, _, tag_type, plan_type = _projection_api()
            row = base.db_plans[0].after_row
            assert row is not None
            index_target = f"index/notes/note_id/{request.entity_id}"
            fts_target = f"fts/{request.entity_id}"
            projections = (
                plan_type(
                    tag_type.MARKDOWN_WRITE,
                    None,
                    mutation_types.ContainedProjectionActionField(target),
                    0,
                    before,
                    body,
                ),
                plan_type(
                    tag_type.INDEX_REPLACE,
                    None,
                    mutation_types.ContainedProjectionActionField(index_target),
                    1,
                    context.authority.derived_projection(
                        tag_type.INDEX_REPLACE, index_target
                    ),
                    _note_index_blob(row, target),
                ),
                plan_type(
                    tag_type.FTS_REPLACE,
                    None,
                    mutation_types.ContainedProjectionActionField(fts_target),
                    2,
                    context.authority.derived_projection(
                        tag_type.FTS_REPLACE, fts_target
                    ),
                    _fts_blob(row, body),
                ),
            )
            return _with_projection(base, projections=projections)

    compilation = await _compile_production_batch(
        uow_fixture,
        (
            MutationRequest.from_payload(
                name="entity.update",
                entity_type="note",
                entity_id="body-note",
                payload={"content_hash": hashlib.sha256(b"first").hexdigest()},
                expected_version=1,
            ),
            MutationRequest.from_payload(
                name="entity.update",
                entity_type="note",
                entity_id="body-note",
                payload={"content_hash": hashlib.sha256(b"second").hexdigest()},
                expected_version=2,
            ),
        ),
        policies=(BodyPolicy(),),
    )

    assert compilation.rejected == ()
    assert compilation.commands[1].projections[0].before == b"first"
    async with uow_fixture.sessions() as session:
        stored = await session.get(Note, "body-note")
    assert stored is not None
    assert stored.content_hash == hashlib.sha256(b"original").hexdigest()


@pytest.mark.asyncio
async def test_batch_overlay_carries_move_target_into_metadata_update(uow_fixture) -> None:
    existing = Note(
        id="move-note",
        title="Original",
        content_hash=hashlib.sha256(b"body").hexdigest(),
        word_count=1,
        summary="",
        tags="[]",
        category=None,
        folder_id="folder-one",
        status="active",
        trashed_at=None,
        created_at="2026-07-20T00:00:00Z",
        updated_at="2026-07-20T00:00:00Z",
        version=1,
    )
    async with uow_fixture.sessions.begin() as session:
        session.add(existing)
    note_fields = CATALOG.get("note").field_names
    existing_row = {field: getattr(existing, field) for field in note_fields}
    target = "notes/folder-one/move-note-Original.md"
    uow_fixture.scope.projection_snapshot = ProjectionAuthoritySnapshot(
        {target: b"body"},
        {"index/notes/note_id/move-note": _note_index_blob(existing_row, target)},
        {"fts/move-note": _fts_blob(existing_row, b"body")},
    )

    class MoveMetadataPolicy:
        entity_types = frozenset({"note"})

        async def compile(self, context, request):
            base = await compile_catalog_entity_command(context, request)
            current = context.authority.row("note", request.entity_id)
            assert current is not None
            source = (
                f"notes/{current['folder_id']}/{request.entity_id}-{current['title']}.md"
            )
            target_folder = request.payload.get("folder_id", current["folder_id"])
            target_title = request.payload.get("title", current["title"])
            target = f"notes/{target_folder}/{request.entity_id}-{target_title}.md"
            assert context.authority.markdown(source) == b"body"
            _, _, tag_type, plan_type = _projection_api()
            row = base.db_plans[0].after_row
            assert row is not None
            index_target = f"index/notes/note_id/{request.entity_id}"
            projections = [
                plan_type(
                    tag_type.PATH_RENAME,
                    mutation_types.ContainedProjectionActionField(source),
                    mutation_types.ContainedProjectionActionField(target),
                    0,
                    None,
                    None,
                ),
                plan_type(
                    tag_type.INDEX_REPLACE,
                    None,
                    mutation_types.ContainedProjectionActionField(index_target),
                    1,
                    context.authority.derived_projection(
                        tag_type.INDEX_REPLACE, index_target
                    ),
                    _note_index_blob(row, target),
                ),
            ]
            if request.payload.get("title") is not None:
                fts_target = f"fts/{request.entity_id}"
                projections.append(
                    plan_type(
                        tag_type.FTS_REPLACE,
                        None,
                        mutation_types.ContainedProjectionActionField(fts_target),
                        2,
                        context.authority.derived_projection(
                            tag_type.FTS_REPLACE, fts_target
                        ),
                        _fts_blob(row, b"body"),
                    )
                )
            return _with_projection(
                base,
                projections=tuple(projections),
            )

    compilation = await _compile_production_batch(
        uow_fixture,
        (
            MutationRequest.from_payload(
                name="entity.update",
                entity_type="note",
                entity_id="move-note",
                payload={"folder_id": "folder-two"},
                expected_version=1,
            ),
            MutationRequest.from_payload(
                name="entity.update",
                entity_type="note",
                entity_id="move-note",
                payload={"title": "Renamed"},
                expected_version=2,
            ),
        ),
        policies=(MoveMetadataPolicy(),),
    )

    assert compilation.rejected == ()
    second = compilation.commands[1].projections[0]
    assert str(second.source) == "notes/folder-two/move-note-Original.md"
    assert str(second.target) == "notes/folder-two/move-note-Renamed.md"


@pytest.mark.asyncio
async def test_batch_overlay_carries_quick_note_conversion_children(uow_fixture) -> None:
    async with uow_fixture.sessions.begin() as session:
        session.add(
            QuickNote(
                id="conversion-quick-note",
                content="captured",
                mood=None,
                tags="[]",
                pinned=False,
                archived_at=None,
                archive_file_path=None,
                folder_id=None,
                trashed_at=None,
                migrated_to_note_id=None,
                session_id=None,
                created_at="2026-07-20T00:00:00Z",
                updated_at="2026-07-20T00:00:00Z",
                version=1,
            )
        )

    class ConversionPolicy:
        entity_types = frozenset({"note", "memo_comment"})

        async def compile(self, context, request):
            if request.entity_type == "note" and request.name == "entity.create":
                assert context.authority.row("quick_note", "conversion-quick-note") is not None
            if request.entity_type == "memo_comment" and request.name == "entity.create":
                note_id = request.payload.get("note_id")
                assert context.authority.row("note", note_id) is not None
                quick_note = context.authority.row("quick_note", "conversion-quick-note")
                assert quick_note is not None
                assert quick_note["migrated_to_note_id"] == "converted-note"
            base = await compile_catalog_entity_command(context, request)
            if request.entity_type == "note":
                return _with_projection(
                    base,
                    projections=_note_create_projections(base, b"captured"),
                )
            return base

    compilation = await _compile_production_batch(
        uow_fixture,
        (
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="note",
                entity_id="converted-note",
                payload={
                    "title": "Converted",
                    "content_hash": hashlib.sha256(b"captured").hexdigest(),
                },
                expected_version=None,
            ),
            MutationRequest.from_payload(
                name="entity.update",
                entity_type="quick_note",
                entity_id="conversion-quick-note",
                payload={
                    "archived_at": "2026-07-20T00:00:01Z",
                    "migrated_to_note_id": "converted-note",
                },
                expected_version=1,
            ),
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="memo_comment",
                entity_id="converted-comment",
                payload={"note_id": "converted-note", "content": "copied"},
                expected_version=None,
            ),
        ),
        policies=(ConversionPolicy(),),
    )

    assert compilation.rejected == ()
    assert compilation.commands[2].db_plans[0].after_row["note_id"] == "converted-note"


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
async def test_timestamp_lww_remote_win_executes_against_authoritative_version(
    uow_fixture,
) -> None:
    async with uow_fixture.sessions.begin() as session:
        session.add(
            Task(
                id="remote-win-task",
                title="local",
                created_at="2026-07-20T00:00:00Z",
                updated_at="2026-07-20T00:00:03Z",
                version=3,
            )
        )
    request = MutationRequest.from_payload(
        name="entity.update",
        entity_type="task",
        entity_id="remote-win-task",
        payload={"title": "remote"},
        expected_version=2,
        client_updated_at="2026-07-20T00:00:03.1Z",
    )
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=MutationCompiler(CATALOG),
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=FileSystemProjectionExecutor(),
        recovery_gate=_CleanGate(),
        journal_factory=MutationJournal,
    )

    result = await uow.execute(uow_fixture.scope, request, "remote-win-operation")
    async with uow_fixture.sessions() as session:
        stored = await session.get(Task, "remote-win-task")

    assert result.resolution == "remote"
    assert stored is not None and stored.title == "remote" and stored.version == 4


@pytest.mark.asyncio
async def test_timestamp_lww_remote_delete_executes_against_authoritative_version(
    uow_fixture,
) -> None:
    async with uow_fixture.sessions.begin() as session:
        session.add(
            Task(
                id="remote-delete-task",
                title="local",
                created_at="2026-07-20T00:00:00Z",
                updated_at="2026-07-20T00:00:02Z",
                version=3,
            )
        )
    request = MutationRequest.from_payload(
        name="entity.delete",
        entity_type="task",
        entity_id="remote-delete-task",
        payload={},
        expected_version=2,
        client_updated_at="2026-07-20T00:00:03Z",
    )
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=MutationCompiler(CATALOG),
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=FileSystemProjectionExecutor(),
        recovery_gate=_CleanGate(),
        journal_factory=MutationJournal,
    )

    result = await uow.execute(uow_fixture.scope, request, "remote-delete-operation")
    async with uow_fixture.sessions() as session:
        stored = await session.get(Task, "remote-delete-task")

    assert result.resolution == "remote"
    assert stored is None


@pytest.mark.asyncio
async def test_strict_cas_rejects_update_without_expected_version(uow_fixture) -> None:
    async with uow_fixture.sessions.begin() as session:
        session.add(
            Task(
                id="strict-cas-task",
                title="before",
                created_at="2026-07-20T00:00:00Z",
                updated_at="2026-07-20T00:00:00Z",
                version=1,
            )
        )
    strict_catalog = replace(
        CATALOG,
        _by_name={
            **CATALOG._by_name,
            "task": replace(CATALOG.get("task"), sync_conflict_policy="strict_cas"),
        },
    )
    request = MutationRequest.from_payload(
        name="entity.update",
        entity_type="task",
        entity_id="strict-cas-task",
        payload={"title": "after"},
        expected_version=None,
    )
    item = mutation_types.PreparedBatchItem(
        0, "strict-cas-operation", request.request_hash, request, None
    )

    async with uow_fixture.sessions() as session:
        compilation = await MutationCompiler(strict_catalog).compile_batch(
            uow_fixture.scope, (item,), session
        )

    assert compilation.commands == ()
    assert tuple(item.code for item in compilation.rejected) == ("version_conflict",)


@pytest.mark.asyncio
async def test_production_compiler_injects_closed_plan_factories(uow_fixture) -> None:
    class FactoryPolicy:
        entity_types = frozenset({"task"})

        async def compile(self, context, request):
            task_model = context.catalog.model_for("task")
            before = task_model(
                id=request.entity_id,
                title="before",
                description="",
                status="todo",
                priority="medium",
                tags="[]",
                plan="",
                completion="",
                due_date=None,
                estimated_pomodoros=1,
                actual_pomodoros=0,
                archived_at=None,
                created_at="2026-07-20T00:00:00Z",
                updated_at="2026-07-20T00:00:00Z",
                version=1,
            )
            after = task_model(
                id=request.entity_id,
                title="after",
                description="",
                status="todo",
                priority="medium",
                tags="[]",
                plan="",
                completion="",
                due_date=None,
                estimated_pomodoros=1,
                actual_pomodoros=0,
                archived_at=None,
                created_at="2026-07-20T00:00:00Z",
                updated_at="2026-07-20T00:00:01Z",
                version=2,
            )
            moved = task_model(
                id="factory-task-moved",
                title="after",
                description="",
                status="todo",
                priority="medium",
                tags="[]",
                plan="",
                completion="",
                due_date=None,
                estimated_pomodoros=1,
                actual_pomodoros=0,
                archived_at=None,
                created_at="2026-07-20T00:00:00Z",
                updated_at="2026-07-20T00:00:01Z",
                version=2,
            )
            db_insert = context.db.insert(before)
            db_update = context.db.update(before, after)
            db_delete = context.db.delete(after)
            sync_create = context.sync.create(before)
            sync_update = context.sync.update(after)
            sync_delete = context.sync.delete(
                after, deleted_at="2026-07-20T00:00:02Z"
            )
            assert db_insert.table == "tasks" and db_insert.operation == "insert"
            assert db_update.expected_version == 1
            assert db_delete.expected_version == 2
            assert sync_create.entity_type == "task" and sync_create.version == 1
            assert sync_update.entity_type == "task" and sync_update.version == 2
            assert sync_delete.action == "delete" and sync_delete.version == 3
            with pytest.raises(ValueError, match="primary key"):
                context.db.update(before, moved)
            return context.command(
                request=request,
                db_plans=(db_insert,),
                sync_events=(sync_create,),
                value={"id": request.entity_id},
            )

    request = MutationRequest.from_payload(
        name="factory.probe",
        entity_type="task",
        entity_id="factory-task",
        payload={},
        expected_version=None,
    )
    item = mutation_types.PreparedBatchItem(
        0, "factory-operation", request.request_hash, request, None
    )
    async with uow_fixture.sessions() as session:
        compiled = await MutationCompiler(CATALOG, (FactoryPolicy(),)).compile_batch(
            uow_fixture.scope, (item,), session
        )

    assert compiled.operation_ids == ("factory-operation",)
    assert compiled.commands[0].db_plans[0].after_row["title"] == "before"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("entity_type", "payload"),
    (
        ("note", {"title": "Unsafe", "content_hash": "body"}),
        ("folder", {"name": "Unsafe"}),
    ),
)
async def test_production_compiler_requires_policy_for_projection_backed_entity(
    uow_fixture, entity_type, payload
) -> None:
    request = MutationRequest.from_payload(
        name="entity.create",
        entity_type=entity_type,
        entity_id=f"unsafe-{entity_type}",
        payload=payload,
        expected_version=None,
    )
    item = mutation_types.PreparedBatchItem(
        0, f"unsafe-{entity_type}-operation", request.request_hash, request, None
    )

    async with uow_fixture.sessions() as session:
        with pytest.raises(
            SpaceRecoveryRequiredError, match="projection-backed entity"
        ):
            await MutationCompiler(CATALOG).compile_batch(
                uow_fixture.scope, (item,), session
            )


@pytest.mark.asyncio
async def test_production_compiler_rejects_incomplete_registered_policy(
    uow_fixture,
) -> None:
    class IncompleteNotePolicy:
        entity_types = frozenset({"note"})

        async def compile(self, context, request):
            return await compile_catalog_entity_command(context, request)

    class MissingSyncPolicy:
        entity_types = frozenset({"task"})

        async def compile(self, context, request):
            base = await compile_catalog_entity_command(context, request)
            return context.command(
                request=request,
                db_plans=base.db_plans,
                sync_events=(),
                value=base.result_value,
            )

    class CrossEntityPolicy:
        entity_types = frozenset({"note"})

        async def compile(self, context, request):
            task_request = MutationRequest.from_payload(
                name="entity.create",
                entity_type="task",
                entity_id="cross-entity-task",
                payload={"title": "cross"},
                expected_version=None,
            )
            task_command = await compile_catalog_entity_command(
                context, task_request
            )
            return context.command(
                request=request,
                db_plans=task_command.db_plans,
                projections=(
                    _projection_plan(
                        "markdown_write",
                        "notes/cross-entity-note.md",
                        0,
                        None,
                        b"cross",
                    ),
                ),
                sync_events=task_command.sync_events,
                value={"id": request.entity_id},
            )

    class DivergentSyncPolicy:
        entity_types = frozenset({"task"})

        async def compile(self, context, request):
            base = await compile_catalog_entity_command(context, request)
            event = base.sync_events[0]
            payload = {**event.payload, "title": "different-ledger-title"}
            divergent = SyncEventPlan(
                event.entity_type,
                event.entity_id,
                event.action,
                payload,
                event.version,
                event.created_at,
            )
            return context.command(
                request=request,
                db_plans=base.db_plans,
                sync_events=(divergent,),
                value=base.result_value,
            )

    class WrongTargetNotePolicy:
        entity_types = frozenset({"note"})

        async def compile(self, context, request):
            base = await compile_catalog_entity_command(context, request)
            projections = list(_note_create_projections(base, b"wrong target"))
            projections[0] = _projection_plan(
                "markdown_write",
                "notes/another-note.md",
                0,
                None,
                b"wrong target",
            )
            return _with_projection(base, projections=tuple(projections))

    cases = (
        (
            IncompleteNotePolicy(),
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="note",
                entity_id="incomplete-note",
                payload={"title": "Incomplete"},
                expected_version=None,
            ),
            "complete bound projections",
        ),
        (
            MissingSyncPolicy(),
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="task",
                entity_id="missing-sync-task",
                payload={"title": "Missing sync"},
                expected_version=None,
            ),
            "sync event is missing",
        ),
        (
            CrossEntityPolicy(),
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="note",
                entity_id="cross-entity-note",
                payload={"title": "Cross"},
                expected_version=None,
            ),
            "request entity",
        ),
        (
            DivergentSyncPolicy(),
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="task",
                entity_id="divergent-sync-task",
                payload={"title": "Database title"},
                expected_version=None,
            ),
            "after image",
        ),
        (
            WrongTargetNotePolicy(),
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="note",
                entity_id="wrong-target-note",
                payload={
                    "content_hash": hashlib.sha256(b"wrong target").hexdigest(),
                    "title": "Wrong target",
                },
                expected_version=None,
            ),
            "authoritative Markdown after-body",
        ),
    )
    for index, (policy, request, message) in enumerate(cases):
        item = mutation_types.PreparedBatchItem(
            0, f"incomplete-policy-{index}", request.request_hash, request, None
        )
        async with uow_fixture.sessions() as session:
            with pytest.raises(SpaceRecoveryRequiredError, match=message):
                await MutationCompiler(CATALOG, (policy,)).compile_batch(
                    uow_fixture.scope, (item,), session
                )


@pytest.mark.asyncio
async def test_production_compiler_accepts_event_only_multi_effect_command(
    uow_fixture,
) -> None:
    class EventOnlyPolicy:
        entity_types = frozenset({"task"})

        async def compile(self, context, request):
            base = await compile_catalog_entity_command(context, request)
            first = base.sync_events[0]
            second_payload = {**first.payload, "id": "event-only-second"}
            second = SyncEventPlan(
                first.entity_type,
                "event-only-second",
                first.action,
                second_payload,
                first.version,
                first.created_at,
            )
            return context.command(
                request=request,
                db_plans=(),
                sync_events=(first, second),
                value={"event_ids": (first.entity_id, second.entity_id)},
            )

    request = MutationRequest.from_payload(
        name="entity.create",
        entity_type="task",
        entity_id="event-only-first",
        payload={"title": "event-only"},
        expected_version=None,
    )
    item = mutation_types.PreparedBatchItem(
        0, "event-only-operation", request.request_hash, request, None
    )

    async with uow_fixture.sessions() as session:
        compilation = await MutationCompiler(
            CATALOG, (EventOnlyPolicy(),)
        ).compile_batch(uow_fixture.scope, (item,), session)

    assert compilation.operation_ids == ("event-only-operation",)
    assert compilation.commands[0].db_plans == ()
    assert tuple(
        event.entity_id for event in compilation.commands[0].sync_events
    ) == ("event-only-first", "event-only-second")


@pytest.mark.asyncio
async def test_note_projection_rejects_prefix_collision_with_authoritative_path(
    uow_fixture,
) -> None:
    def note(note_id: str, title: str, content: bytes) -> Note:
        return Note(
            id=note_id,
            title=title,
            content_hash=hashlib.sha256(content).hexdigest(),
            word_count=1,
            summary="",
            tags="[]",
            category=None,
            folder_id=None,
            status="active",
            trashed_at=None,
            created_at="2026-07-20T00:00:00Z",
            updated_at="2026-07-20T00:00:00Z",
            version=1,
        )

    first = note("n1", "Title", b"first body")
    second = note("n1-other", "Title", b"second body")
    async with uow_fixture.sessions.begin() as session:
        session.add_all((first, second))

    note_fields = CATALOG.get("note").field_names
    first_row = {field: getattr(first, field) for field in note_fields}
    second_row = {field: getattr(second, field) for field in note_fields}
    first_path = "notes/n1-title.md"
    colliding_path = "notes/n1-other-title.md"
    first_index = _note_index_blob(first_row, first_path)
    second_index = _note_index_blob(second_row, colliding_path)
    first_fts = _fts_blob(first_row, b"first body")
    second_fts = _fts_blob(second_row, b"second body")
    uow_fixture.scope.projection_snapshot = ProjectionAuthoritySnapshot(
        {
            first_path: b"first body",
            colliding_path: b"second body",
        },
        {
            "index/notes/note_id/n1": first_index,
            "index/notes/note_id/n1-other": second_index,
        },
        {
            "fts/n1": first_fts,
            "fts/n1-other": second_fts,
        },
    )

    class CollidingDeletePolicy:
        entity_types = frozenset({"note"})

        async def compile(self, context, request):
            base = await compile_catalog_entity_command(context, request)
            return _with_projection(
                base,
                projections=(
                    _projection_plan(
                        "path_remove",
                        colliding_path,
                        0,
                        b"second body",
                        None,
                    ),
                    _projection_plan(
                        "index_replace",
                        "index/notes/note_id/n1",
                        1,
                        first_index,
                        None,
                    ),
                    _projection_plan(
                        "fts_replace",
                        "fts/n1",
                        2,
                        first_fts,
                        None,
                    ),
                ),
            )

    request = MutationRequest.from_payload(
        name="entity.delete",
        entity_type="note",
        entity_id="n1",
        payload={},
        expected_version=1,
    )
    item = mutation_types.PreparedBatchItem(
        0, "note-prefix-collision", request.request_hash, request, None
    )

    async with uow_fixture.sessions() as session:
        with pytest.raises(
            SpaceRecoveryRequiredError, match="complete bound projections"
        ):
            await MutationCompiler(
                CATALOG, (CollidingDeletePolicy(),)
            ).compile_batch(uow_fixture.scope, (item,), session)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("index_field", "index_value"),
    (("title", "Divergent"), ("level", "L9")),
)
async def test_note_projection_rejects_index_row_divergent_from_db_after_image(
    uow_fixture, index_field, index_value
) -> None:
    body = b"authoritative body"

    class DivergentIndexPolicy:
        entity_types = frozenset({"note"})

        async def compile(self, context, request):
            base = await compile_catalog_entity_command(context, request)
            row = base.db_plans[0].after_row
            assert row is not None
            projections = list(_note_create_projections(base, body))
            index_payload = json.loads(
                _note_index_blob(row, f"notes/{request.entity_id}.md")
            )
            index_payload["row"][index_field] = index_value
            projections[1] = _projection_plan(
                "index_replace",
                f"index/notes/note_id/{request.entity_id}",
                1,
                None,
                _canonical_projection_blob(index_payload),
            )
            return _with_projection(base, projections=tuple(projections))

    request = MutationRequest.from_payload(
        name="entity.create",
        entity_type="note",
        entity_id="divergent-index-note",
        payload={
            "content_hash": hashlib.sha256(body).hexdigest(),
            "title": "Authoritative",
        },
        expected_version=None,
    )
    item = mutation_types.PreparedBatchItem(
        0, "divergent-index-operation", request.request_hash, request, None
    )

    async with uow_fixture.sessions() as session:
        with pytest.raises(
            SpaceRecoveryRequiredError, match="index row.*database image"
        ):
            await MutationCompiler(
                CATALOG, (DivergentIndexPolicy(),)
            ).compile_batch(uow_fixture.scope, (item,), session)


@pytest.mark.asyncio
async def test_business_receipt_preserves_null_insert_before_and_delete_after(
    uow_fixture,
) -> None:
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=MutationCompiler(CATALOG),
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=uow_fixture.executor,
        recovery_gate=_CleanGate(),
        journal_factory=MutationJournal,
    )
    created = MutationRequest.from_payload(
        name="entity.create",
        entity_type="task",
        entity_id="receipt-image-task",
        payload={"title": "created"},
        expected_version=None,
    )
    deleted = MutationRequest.from_payload(
        name="entity.delete",
        entity_type="task",
        entity_id="receipt-image-task",
        payload={},
        expected_version=1,
    )

    await uow.execute_batch(
        uow_fixture.scope,
        (created, deleted),
        "receipt-image-batch",
        operation_ids=("receipt-image-create", "receipt-image-delete"),
    )

    async with uow_fixture.sessions() as session:
        create_operation = await session.get(
            MutationOperation, "receipt-image-create"
        )
        delete_operation = await session.get(
            MutationOperation, "receipt-image-delete"
        )
    assert create_operation is not None
    assert delete_operation is not None
    assert json.loads(create_operation.db_before_json) == [None]
    assert json.loads(create_operation.db_after_json)[0]["id"] == "receipt-image-task"
    assert json.loads(delete_operation.db_before_json)[0]["id"] == "receipt-image-task"
    assert json.loads(delete_operation.db_after_json) == [None]


def test_interpreter_decode_rejects_effects_outside_compiled_catalog() -> None:
    request = MutationRequest.from_payload(
        name="decode.probe",
        entity_type="task",
        entity_id="decode-task",
        payload={},
        expected_version=None,
    )
    complete_task = {
        "id": "decode-task",
        "title": "decode",
        "description": "",
        "status": "todo",
        "priority": "medium",
        "tags": "[]",
        "plan": "",
        "completion": "",
        "due_date": None,
        "estimated_pomodoros": 1,
        "actual_pomodoros": 0,
        "archived_at": None,
        "created_at": "2026-07-20T00:00:00Z",
        "updated_at": "2026-07-20T00:00:00Z",
        "version": 1,
    }
    note_request = MutationRequest.from_payload(
        name="entity.create",
        entity_type="note",
        entity_id="decode-note",
        payload={"title": "Decode note"},
        expected_version=None,
    )
    commands = (
        MutationCommand.from_effects(
            request=request,
            db_plans=(
                DbMutationPlan(
                    "unknown_table",
                    {"id": "decode-task"},
                    "insert",
                    None,
                    None,
                    {"id": "decode-task"},
                ),
            ),
            projections=(),
            sync_events=(),
            result_value={"id": "decode-task"},
        ),
        MutationCommand.from_effects(
            request=note_request,
            db_plans=(
                DbMutationPlan(
                    "tasks",
                    {"id": "decode-task"},
                    "insert",
                    None,
                    None,
                    complete_task,
                ),
            ),
            projections=(),
            sync_events=(
                SyncEventPlan(
                    "task",
                    "decode-task",
                    "create",
                    complete_task,
                    1,
                    "2026-07-20T00:00:00Z",
                ),
            ),
            result_value={"id": "decode-note"},
        ),
        MutationCommand.from_effects(
            request=request,
            db_plans=(
                DbMutationPlan(
                    "tasks",
                    {"id": "decode-task"},
                    "insert",
                    None,
                    None,
                    complete_task,
                ),
            ),
            projections=(),
            sync_events=(
                SyncEventPlan(
                    "task",
                    "decode-task",
                    "create",
                    {**complete_task, "title": "different ledger title"},
                    1,
                    "2026-07-20T00:00:00Z",
                ),
            ),
            result_value={"id": "decode-task"},
        ),
        MutationCommand.from_effects(
            request=request,
            db_plans=(),
            projections=(),
            sync_events=(
                SyncEventPlan(
                    "unknown_entity",
                    "decode-task",
                    "create",
                    {"id": "decode-task"},
                    1,
                    "2026-07-20T00:00:00Z",
                ),
            ),
            result_value={"id": "decode-task"},
        ),
        MutationCommand.from_effects(
            request=request,
            db_plans=(
                DbMutationPlan(
                    "tasks",
                    {"id": "decode-task"},
                    "insert",
                    None,
                    complete_task,
                    complete_task,
                ),
            ),
            projections=(),
            sync_events=(),
            result_value={"id": "decode-task"},
        ),
        MutationCommand.from_effects(
            request=request,
            db_plans=(),
            projections=(),
            sync_events=(
                SyncEventPlan(
                    "task",
                    "decode-task",
                    "create",
                    {"id": "decode-task"},
                    1,
                    "2026-07-20T00:00:00Z",
                ),
            ),
            result_value={"id": "decode-task"},
        ),
    )
    interpreter = DbMutationInterpreter(CATALOG)

    for command in commands:
        encoded = mutation_types.persisted_command_bytes(command.persisted()).decode(
            "utf-8"
        )
        with pytest.raises(SpaceRecoveryRequiredError):
            interpreter.decode_command(encoded)


@pytest.mark.asyncio
async def test_production_compiler_persists_aliases_through_invisible_and_visible_ledger(
    uow_fixture, monkeypatch
) -> None:
    internal_names = ("quick_note", "time_block", "schedule_quick_note")
    payloads = (
        {"content": "alias"},
        {
            "date": "2026-07-20",
            "start_time": "09:00",
            "end_time": "10:00",
        },
        {"schedule_id": "schedule-alias", "quick_note_id": "alias-0"},
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
            name="entity.create",
            entity_type=entity_type,
            entity_id=f"alias-{index}",
            payload=payloads[index],
            expected_version=None,
        )
        for index, entity_type in enumerate(internal_names)
    )
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=MutationCompiler(CATALOG),
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
async def test_internal_hashed_child_ids_persist_parent_suffix_mapping(
    uow_fixture,
) -> None:
    batch_id = "b" * 128
    result = await uow_fixture.uow.execute_batch(
        uow_fixture.scope,
        (_request("derived-1"), _request("derived-2")),
        batch_id,
    )
    expected = {
        bounded_child_operation_id(batch_id, "0000"): {
            "parent_id": batch_id,
            "suffix": "0000",
        },
        bounded_child_operation_id(batch_id, "0001"): {
            "parent_id": batch_id,
            "suffix": "0001",
        },
    }
    async with uow_fixture.sessions() as session:
        batch = await session.get(MutationBatch, batch_id)

    assert tuple(item.operation_id for item in result.applied) == tuple(expected)
    assert result.operation_id_derivations == expected
    assert batch is not None
    assert json.loads(batch.result_json)["operation_id_derivations"] == expected
    retry = await uow_fixture.uow.execute_batch(
        uow_fixture.scope,
        (_request("derived-1"), _request("derived-2")),
        batch_id,
    )
    assert retry == result
    assert "operation_id_derivations" not in inspect.signature(
        MutationUnitOfWork.execute_prepared_batch
    ).parameters


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

        def _apply_markdown_write(self, scope, action, receipt) -> None:
            self.observed.append("markdown_write")

        def _apply_path_rename(self, scope, action, receipt) -> None:
            self.observed.append("path_rename")

        def _apply_path_remove(self, scope, action, receipt) -> None:
            self.observed.append("path_remove")

        def _apply_index_replace(self, scope, action, receipt) -> None:
            self.observed.append("index_replace")

        def _apply_fts_replace(self, scope, action, receipt) -> None:
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

    def _apply_markdown_write(self, scope, action, receipt) -> None:
        self._record(action)

    def _apply_path_rename(self, scope, action, receipt) -> None:
        self._record(action)

    def _apply_path_remove(self, scope, action, receipt) -> None:
        self._record(action)

    def _apply_index_replace(self, scope, action, receipt) -> None:
        self._record(action)

    def _apply_fts_replace(self, scope, action, receipt) -> None:
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
                (await file_system.snapshot_projection_authority()).fts[
                    "fts/n-production"
                ],
                canonical({"content": "fresh searchable term", "title": "Original"}),
            ),
        )
        scope = SimpleNamespace(
            mutation_stages=stages,
            file_system=file_system,
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
async def test_production_note_policy_executes_db_markdown_index_fts_and_ledger(
    uow_fixture, tmp_path
) -> None:
    from app.file_system.api import open_contained_file_system
    from app.runtime.contained_io import open_bound_space
    from app.runtime.scope import _walk_existing_ancestors

    root = tmp_path / "production-note-uow"
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
    coordinator = RuntimeLeaseCoordinator(tmp_path / ".runtime-production-note-uow")
    global_lease = await coordinator.acquire_global(LeaseMode.SHARED, "test", 2)
    space_id = "space-production-note-uow"
    space_lease = await coordinator.acquire_spaces(
        [space_id], LeaseMode.EXCLUSIVE, "mutation", 2
    )

    class RuntimeScope:
        session_factory = uow_fixture.sessions
        scope = SimpleNamespace(space_id=space_id)
        mutation_stages = stages

        def __init__(self) -> None:
            self.file_system = file_system

        @asynccontextmanager
        async def exclusive_space_resources(self, purpose, timeout_seconds):
            assert (purpose, timeout_seconds) == ("mutation", 5)
            yield space_lease

    body = b"compiled body"
    note_id = "n-compiled-production"

    class NotePolicy:
        entity_types = frozenset({"note"})

        async def compile(self, context, request):
            base = await compile_catalog_entity_command(context, request)
            return _with_projection(
                base,
                projections=_note_create_projections(
                    base,
                    body,
                    path=f"notes/{note_id}-compiled.md",
                ),
            )

    request = MutationRequest.from_payload(
        name="entity.create",
        entity_type="note",
        entity_id=note_id,
        payload={
            "content_hash": hashlib.sha256(body).hexdigest(),
            "title": "Compiled",
            "word_count": 2,
        },
        expected_version=None,
    )
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=MutationCompiler(CATALOG, (NotePolicy(),)),
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=FileSystemProjectionExecutor(),
        recovery_gate=_CleanGate(),
        journal_factory=MutationJournal,
    )
    try:
        result = await uow.execute(RuntimeScope(), request, "production-note-operation")
        async with uow_fixture.sessions() as session:
            stored = await session.get(Note, note_id)
            event = await session.scalar(
                select(SyncOutbox).where(
                    SyncOutbox.operation_id == "production-note-operation"
                )
            )

        assert result.state is MutationState.FINALIZED
        assert stored is not None and stored.content_hash == hashlib.sha256(body).hexdigest()
        assert await file_system.read_note(note_id) == body.decode("utf-8")
        assert [item.note_id for item in await file_system.search("compiled body")] == [
            note_id
        ]
        assert event is not None and event.visible is True
        assert json.loads(event.payload) == {
            **{field: getattr(stored, field) for field in CATALOG.get("note").field_names},
            "content": body.decode("utf-8"),
        }
    finally:
        stages.close()
        await file_system.close()
        await space_lease.release()
        await global_lease.release()
        await opens.close_all()


@pytest.mark.asyncio
async def test_authority_overlay_loads_existing_index_and_fts_authority(
    uow_fixture, tmp_path
) -> None:
    from app.file_system.api import open_contained_file_system
    from app.runtime.contained_io import open_bound_space
    from app.runtime.scope import _walk_existing_ancestors

    root = tmp_path / "overlay-contained-space"
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
    try:
        await file_system.create_folder(
            "Existing", external_id="f-existing"
        )
        await file_system.create_note(
            title="Existing note",
            content="existing searchable body",
            folder_id="f-existing",
            external_id="n-existing",
        )
        scope = SimpleNamespace(file_system=file_system)
        async with uow_fixture.sessions() as session:
            overlay = await AuthorityOverlay.from_locked_authorities(
                scope, session, CATALOG
            )
        tag_type = _projection_api()[2]

        index_blob = overlay.derived_projection(
            tag_type.INDEX_REPLACE, "index/folders/id/f-existing"
        )
        fts_blob = overlay.derived_projection(
            tag_type.FTS_REPLACE, "fts/n-existing"
        )
        assert index_blob is not None
        assert json.loads(index_blob)["row"]["name"] == "Existing"
        assert fts_blob is not None
        assert json.loads(fts_blob) == {
            "content": "existing searchable body",
            "title": "Existing note",
        }
    finally:
        await file_system.close()
        await opens.close_all()


@pytest.mark.asyncio
async def test_fts_projection_rechecks_fence_between_delete_and_insert(
    tmp_path, monkeypatch
) -> None:
    from app.file_system.api import open_contained_file_system
    from app.runtime.contained_io import open_bound_space
    from app.runtime.scope import _walk_existing_ancestors

    class StaleAfterFirstWrite:
        def __init__(self) -> None:
            self.checks = 0

        def assert_current(self) -> None:
            self.checks += 1
            if self.checks == 2:
                raise RuntimeError("stale between FTS writes")

    root = tmp_path / "fts-fence-space"
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
    try:
        await file_system.create_note(
            title="Fence",
            content="original searchable phrase",
            external_id="n-fence",
        )
        action = _materialized_action(
            "fts_replace",
            "fts/n-fence",
            0,
            json.dumps(
                {"content": "replacement phrase", "title": "Fence"},
                ensure_ascii=True,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("ascii"),
        )
        receipt = StaleAfterFirstWrite()
        executed_sql: list[str] = []
        original_connect = file_system._connect

        class RecordingConnection:
            def __init__(self, connection) -> None:
                self.connection = connection

            def execute(self, statement, *args, **kwargs):
                executed_sql.append(statement)
                return self.connection.execute(statement, *args, **kwargs)

            def commit(self) -> None:
                self.connection.commit()

        from contextlib import contextmanager

        @contextmanager
        def recording_connect():
            with original_connect() as connection:
                yield RecordingConnection(connection)

        monkeypatch.setattr(file_system, "_connect", recording_connect)

        with pytest.raises(RuntimeError, match="stale between FTS writes"):
            file_system._apply_projection_fts_replace(action, receipt)

        assert receipt.checks == 2
        assert not any(
            statement.lstrip().startswith("INSERT INTO notes_fts")
            for statement in executed_sql
        )
        assert [item.note_id for item in await file_system.search("original searchable phrase")] == [
            "n-fence"
        ]
        assert await file_system.search("replacement phrase") == []
    finally:
        await file_system.close()
        await opens.close_all()


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
