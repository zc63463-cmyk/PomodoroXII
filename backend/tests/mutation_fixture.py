"""Reusable S3 mutation test support with constructor-injected policies."""

from __future__ import annotations

import asyncio
import json
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.file_system.interfaces import ProjectionAuthoritySnapshot
from app.models.sync_outbox import SyncOutbox
from app.mutation.journal import MutationJournal
from app.mutation.recovery import MutationRecovery
from app.mutation.staging import StageStore
from app.mutation.unit_of_work import (
    DbMutationInterpreter,
    MutationCompiler,
    MutationDomainPolicy,
    MutationUnitOfWork,
)
from app.registry.catalog import CompiledEntityCatalog
from app.registry.entities import EntityCategory
from app.runtime.contained_io import BoundDirectoryHandle, BoundStageDirectory
from app.runtime.leases import LeaseMode


def _stage_authority(path: Path) -> BoundStageDirectory:
    path.mkdir(parents=True, exist_ok=True)
    parent = BoundDirectoryHandle._create(path.parent)
    try:
        return BoundStageDirectory._from_parent_handle(parent, path.name)
    finally:
        parent._close()


class _DiskProjectionAuthority:
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

    @staticmethod
    def _bucket(target: str) -> str:
        if target.startswith("notes/"):
            return "markdown"
        return "index" if target.startswith("index/") else "fts"

    def _apply(self, action, receipt) -> None:
        receipt.assert_current()
        state = self._load()
        target = str(action.target)
        if action.tag.value == "path_rename":
            source = str(action.source)
            value = state[self._bucket(source)].pop(source, None)
            if value is None:
                value = state[self._bucket(target)].get(target)
            if value is not None:
                state[self._bucket(target)][target] = value
        elif action.tag.value == "path_remove":
            state[self._bucket(target)].pop(target, None)
        elif action.blob is None:
            state[self._bucket(target)].pop(target, None)
        else:
            state[self._bucket(target)][target] = action.blob.hex()
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
            {key: bytes.fromhex(value) for key, value in state["markdown"].items()},
            {key: bytes.fromhex(value) for key, value in state["index"].items()},
            {key: bytes.fromhex(value) for key, value in state["fts"].items()},
        )


class _ProjectionExecutor:
    def __init__(self) -> None:
        self.fail_forward = False

    async def apply_forward(
        self,
        scope,
        operation_id,
        command,
        receipt,
        *,
        ordinals=None,
    ) -> None:
        if self.fail_forward:
            raise RuntimeError("injected projection forward failure")
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
        self,
        scope,
        operation_id,
        command,
        receipt,
        *,
        ordinals=None,
    ) -> None:
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


class MutationFixture:
    """Restartable S3 fixture shared by domain-policy integration tests."""

    def __init__(
        self,
        *,
        sessions: async_sessionmaker,
        scope,
        uow: MutationUnitOfWork,
        catalog: CompiledEntityCatalog,
        policies: tuple[MutationDomainPolicy, ...],
        stage_root: Path,
        projection_root: Path,
        database_path: Path,
        file_system: _DiskProjectionAuthority,
        stage_store: StageStore,
        projection_executor: _ProjectionExecutor,
    ) -> None:
        self._sessions = sessions
        self.scope = scope
        self.uow = uow
        self.catalog = catalog
        self._policies = policies
        self._stage_root = stage_root
        self._projection_root = projection_root
        self._database_path = database_path
        self._file_system = file_system
        self._stage_store = stage_store
        self._projection_executor = projection_executor
        self._closed = False

    def overlay_snapshot(self):
        database: list[tuple[str, tuple[tuple[object, ...], ...]]] = []
        with sqlite3.connect(self._database_path) as connection:
            for spec in self.catalog.list():
                if spec.category is EntityCategory.META:
                    continue
                table = spec.table_name.replace('"', '""')
                primary_key = spec.primary_key.replace('"', '""')
                rows = tuple(
                    tuple(row)
                    for row in connection.execute(
                        f'SELECT * FROM "{table}" ORDER BY "{primary_key}"'
                    )
                )
                database.append((spec.name, rows))
        state = self._file_system._load()
        projections = (
            tuple(sorted(state["markdown"].items())),
            tuple(sorted(state["index"].items())),
            tuple(sorted(state["fts"].items())),
        )
        return tuple(database), projections

    async def visible_events(self, **filters):
        async with self._sessions() as session:
            statement = select(SyncOutbox).where(SyncOutbox.visible.is_(True))
            for key, value in filters.items():
                if key == "operation_id":
                    statement = statement.where(SyncOutbox.operation_id == value)
                elif key == "entity_type":
                    statement = statement.where(SyncOutbox.entity_type == value)
                elif key == "batch_id":
                    statement = statement.where(SyncOutbox.batch_id == value)
            result = await session.execute(statement.order_by(SyncOutbox.id))
            return tuple(
                SimpleNamespace(
                    entity_type=row.entity_type,
                    entity_id=row.entity_id,
                    action=row.action,
                    payload=json.loads(row.payload) if row.payload else {},
                    operation_id=row.operation_id,
                    batch_id=row.batch_id,
                    version=row.version,
                    created_at=row.created_at,
                )
                for row in result.scalars()
            )

    def inject_fault(self, name: str) -> None:
        if name == "db_commit":
            original_commit = self.uow._commit_business

            async def fail_once(*args, **kwargs):
                # Commit the business transaction first, then fail before the
                # visibility/finalization barrier.  Recovery can therefore
                # observe the real DB_COMMITTED journal boundary.
                self.uow._commit_business = original_commit
                await original_commit(*args, **kwargs)
                raise RuntimeError("injected db commit failure")

            self.uow._commit_business = fail_once
            return
        if name != "projection_forward":
            raise ValueError(f"unknown mutation fixture fault: {name}")
        self._projection_executor.fail_forward = True

    async def restart(self) -> MutationFixture:
        self.close()
        return build_mutation_fixture(
            sessions=self._sessions,
            catalog=self.catalog,
            policies=self._policies,
            stage_root=self._stage_root,
            projection_root=self._projection_root,
            database_path=self._database_path,
        )

    async def recover(self):
        recovery = MutationRecovery(
            catalog=self.catalog,
            interpreter=DbMutationInterpreter(self.catalog),
            projection_executor=_ProjectionExecutor(),
        )
        return await recovery.recover_under_lease(self.scope, self.scope.space_lease)

    def close(self) -> None:
        if not self._closed:
            self._stage_store.close()
            self._closed = True


def build_mutation_fixture(
    *,
    sessions: async_sessionmaker,
    catalog: CompiledEntityCatalog,
    policies: tuple[MutationDomainPolicy, ...],
    stage_root: Path,
    projection_root: Path,
    database_path: Path,
) -> MutationFixture:
    stage_store = StageStore(_stage_authority(stage_root))
    file_system = _DiskProjectionAuthority(projection_root)
    projection_executor = _ProjectionExecutor()
    global_lease = _Lease(LeaseMode.SHARED, "global")
    space_lease = _Lease(LeaseMode.EXCLUSIVE, "space-test")

    @asynccontextmanager
    async def exclusive_space_resources(purpose: str, timeout_seconds: float):
        yield space_lease

    scope = SimpleNamespace(
        scope=SimpleNamespace(space_id="space-test"),
        file_system=file_system,
        mutation_stages=stage_store,
        session_factory=sessions,
        global_lease=global_lease,
        space_lease=space_lease,
        _runtime=None,
        exclusive_space_resources=exclusive_space_resources,
    )
    interpreter = DbMutationInterpreter(catalog)
    recovery = MutationRecovery(
        catalog=catalog,
        interpreter=interpreter,
        projection_executor=_ProjectionExecutor(),
    )
    uow = MutationUnitOfWork(
        catalog=catalog,
        compiler=MutationCompiler(catalog, policies=policies),
        interpreter=interpreter,
        projection_executor=projection_executor,
        recovery_gate=recovery,
        journal_factory=MutationJournal,
    )
    return MutationFixture(
        sessions=sessions,
        scope=scope,
        uow=uow,
        catalog=catalog,
        policies=policies,
        stage_root=stage_root,
        projection_root=projection_root,
        database_path=database_path,
        file_system=file_system,
        stage_store=stage_store,
        projection_executor=projection_executor,
    )
