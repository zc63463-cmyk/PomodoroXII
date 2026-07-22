"""Tests for centralized entity invariants in EntityCommand and domain policies.

Covers:
1. Folder cycle detection (FolderDomainPolicy)
2. Relation endpoint existence (RelationDomainPolicy)
3. Sync wire entity_id authority (EntityCommand.from_sync_event)
4. Folder cascade soft delete (FolderDomainPolicy)
5. Rejection precedence: cycle before version conflict
"""

from __future__ import annotations

from collections.abc import Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import Integer, String, text
from sqlalchemy.ext.asyncio import async_sessionmaker
from sqlalchemy.orm import Mapped, mapped_column

from app.commands import EntityCommand, FolderDomainPolicy, RelationDomainPolicy
from app.db.base import Base as SpaceBase
from app.errors import MutationRejectedError
from app.mutation.journal import MutationJournal
from app.mutation.recovery import MutationRecovery
from app.mutation.staging import StageStore
from app.mutation.types import MutationRuleViolation
from app.mutation.unit_of_work import (
    DbMutationInterpreter,
    MutationCompiler,
    MutationUnitOfWork,
)
from app.registry import REGISTRY
from app.registry.catalog import CompiledEntityCatalog
from app.registry.entities import EntityCategory, EntitySpec, FieldSpec, StorageType
from app.runtime.leases import LeaseMode
from tests.test_mutation_recovery import (
    _DiskProjection,
    _Lease,
    _ProjectionExecutor,
    _stage_authority,
)


class _StrictFixture(SpaceBase):
    """Test-only entity using strict_cas conflict policy."""

    __tablename__ = "strict_fixtures"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    title: Mapped[str] = mapped_column(String(500), nullable=False, default="")


_STRICT_FIXTURE_SPEC = EntitySpec(
    name="strict_fixture",
    model_path="tests.test_entity_invariants._StrictFixture",
    table_name="strict_fixtures",
    storage_type=StorageType.DB_ONLY,
    category=EntityCategory.BUSINESS,
    sync_enabled=True,
    soft_delete=False,
    fields=(
        FieldSpec("id", "string", nullable=False),
        FieldSpec("created_at", "datetime", nullable=False),
        FieldSpec("updated_at", "datetime", nullable=False),
        FieldSpec("version", "integer", nullable=False, default=1),
        FieldSpec("title", "string", nullable=False, default=""),
    ),
    sync_conflict_policy="strict_cas",
    mcp_schema_enabled=False,
)

_TEST_CATALOG = CompiledEntityCatalog.compile(
    [*REGISTRY.list(), _STRICT_FIXTURE_SPEC],
    version="test",
)


@dataclass
class _SyncEvent:
    entity_type: str
    entity_id: str
    action: str
    payload: Mapping[str, object]
    client_updated_at: str = "2026-07-14T00:00:00.000Z"
    expected_version: int | None = None


class _MutationScope:
    """A closeable mutation scope with independent stages."""

    def __init__(self, fixture: EntityFixture) -> None:
        fixture._scope_counter += 1
        stage_dir = fixture._stage_root / f"scope-{fixture._scope_counter}"
        self._stage_store = StageStore(_stage_authority(stage_dir))
        self._fixture = fixture
        self.scope = SimpleNamespace(space_id="space-test")
        self.file_system = fixture._file_system
        self.mutation_stages = self._stage_store
        self.session_factory = fixture._sessions
        self.global_lease = fixture._global_lease
        self.space_lease = fixture._space_lease
        self._runtime = None

        @asynccontextmanager
        async def exclusive_space_resources(purpose: str, timeout_seconds: int):
            yield self._fixture._space_lease

        self.exclusive_space_resources = exclusive_space_resources

    async def aclose(self) -> None:
        self._stage_store.close()


class EntityFixture:
    """End-to-end mutation fixture with FolderDomainPolicy and RelationDomainPolicy."""

    def __init__(
        self,
        session_factory: async_sessionmaker,
        stage_root: Path,
        projection_root: Path,
    ) -> None:
        self._sessions = session_factory
        self._stage_root = Path(stage_root)
        self._projection_root = Path(projection_root)
        self._scope_counter = 0
        self._file_system = _DiskProjection(projection_root)
        self._global_lease = _Lease(LeaseMode.SHARED, "global")
        self._space_lease = _Lease(LeaseMode.EXCLUSIVE, "space-test")
        self.catalog = _TEST_CATALOG
        self.compiler = MutationCompiler(
            self.catalog,
            policies=[FolderDomainPolicy(), RelationDomainPolicy()],
        )
        self.commands = EntityCommand(self.catalog)
        self.uow = MutationUnitOfWork(
            catalog=self.catalog,
            compiler=self.compiler,
            interpreter=DbMutationInterpreter(self.catalog),
            projection_executor=_ProjectionExecutor(),
            recovery_gate=MutationRecovery(
                catalog=self.catalog,
                interpreter=DbMutationInterpreter(self.catalog),
                projection_executor=_ProjectionExecutor(),
            ),
            journal_factory=MutationJournal,
        )

    async def setup(self) -> None:
        async with self._sessions.begin() as session:
            await session.execute(
                text(
                    "CREATE TABLE IF NOT EXISTS strict_fixtures ("
                    "id VARCHAR(36) PRIMARY KEY, "
                    "created_at VARCHAR(32) NOT NULL, "
                    "updated_at VARCHAR(32) NOT NULL, "
                    "version INTEGER NOT NULL DEFAULT 1, "
                    "title VARCHAR(500) NOT NULL DEFAULT '')"
                )
            )

    async def teardown(self) -> None:
        pass

    def open_mutation_scope(self) -> _MutationScope:
        return _MutationScope(self)

    async def folder_tree(self, *ids: str) -> None:
        now = "2026-07-21T00:00:00.000Z"
        scope = self.open_mutation_scope()
        try:
            for i, folder_id in enumerate(ids):
                parent_id = ids[i - 1] if i > 0 else None
                payload: dict[str, object] = {
                    "id": folder_id,
                    "name": folder_id,
                    "parent_id": parent_id,
                    "icon": "\U0001f4c1",
                    "color": None,
                    "sort_order": 0,
                    "is_system": False,
                    "trashed_at": None,
                    "created_at": now,
                    "updated_at": now,
                    "version": 1,
                }
                request = self.commands.create(
                    scope, "folder", payload, expected_version=None
                )
                await self.uow.execute(scope, request, f"seed-folder-{folder_id}")
        finally:
            await scope.aclose()

    async def create_schedule(self, schedule_id: str) -> None:
        now = "2026-07-21T00:00:00.000Z"
        scope = self.open_mutation_scope()
        try:
            payload: dict[str, object] = {
                "id": schedule_id,
                "title": "Test Schedule",
                "due_at": "2026-07-22T00:00:00.000Z",
                "completed_at": None,
                "priority": "medium",
                "color": "#3b82f6",
                "all_day": False,
                "start_time": None,
                "end_time": None,
                "created_at": now,
                "updated_at": now,
                "version": 1,
            }
            request = self.commands.create(
                scope, "schedule", payload, expected_version=None
            )
            await self.uow.execute(scope, request, f"seed-schedule-{schedule_id}")
        finally:
            await scope.aclose()

    async def seed_schedule(
        self, schedule_id: str, *, version: int, updated_at: str
    ) -> None:
        async with self._sessions.begin() as session:
            await session.execute(
                text(
                    "INSERT INTO schedules "
                    "(id, created_at, updated_at, version, title, due_at, "
                    "completed_at, priority, color, all_day, start_time, end_time) "
                    "VALUES (:id, :ts, :ts, :ver, 'Seeded', "
                    "'2026-07-22T00:00:00.000Z', NULL, 'medium', '#3b82f6', 0, "
                    "NULL, NULL)"
                ),
                {"id": schedule_id, "ts": updated_at, "ver": version},
            )

    async def seed_strict_cas_entity(
        self, entity_id: str, *, version: int, updated_at: str
    ) -> None:
        async with self._sessions.begin() as session:
            await session.execute(
                text(
                    "INSERT INTO strict_fixtures "
                    "(id, created_at, updated_at, version, title) "
                    "VALUES (:id, :ts, :ts, :ver, '')"
                ),
                {"id": entity_id, "ts": updated_at, "ver": version},
            )

    async def list_folders(self) -> dict[str, dict[str, object]]:
        async with self._sessions() as session:
            result = await session.execute(
                text("SELECT id, trashed_at, parent_id, version FROM folders")
            )
            return {
                row[0]: {
                    "trashed_at": row[1],
                    "parent_id": row[2],
                    "version": row[3],
                }
                for row in result
            }

    def sync_event(
        self,
        *,
        action: str,
        entity_id: str,
        payload: Mapping[str, object],
        client_updated_at: str = "2026-07-14T00:00:00.000Z",
        expected_version: int | None = None,
    ) -> _SyncEvent:
        return _SyncEvent(
            entity_type="schedule",
            entity_id=entity_id,
            action=action,
            payload=payload,
            client_updated_at=client_updated_at,
            expected_version=expected_version,
        )


@pytest.fixture
async def entity_fixture(space_session, tmp_path):
    sessions = async_sessionmaker(space_session.bind, expire_on_commit=False)
    stage_root = tmp_path / "stages"
    projection_root = tmp_path / "projections"
    fixture = EntityFixture(
        session_factory=sessions,
        stage_root=stage_root,
        projection_root=projection_root,
    )
    await fixture.setup()
    yield fixture
    await fixture.teardown()


# --- Tests ---


async def test_folder_cycle_is_rejected_by_the_shared_command(entity_fixture):
    """FolderDomainPolicy rejects cycles when updating parent_id."""
    await entity_fixture.folder_tree("a", "b", "c")
    scope = entity_fixture.open_mutation_scope()
    try:
        request = entity_fixture.commands.update(
            scope, "folder", "a", {"parent_id": "c"}, expected_version=1
        )
        with pytest.raises(MutationRejectedError) as exc_info:
            await entity_fixture.uow.execute(scope, request, "op-cycle-test")
        assert exc_info.value.rejection.code == "cycle_detected"
    finally:
        await scope.aclose()


async def test_relation_requires_both_endpoints(entity_fixture):
    """RelationDomainPolicy rejects junction creates with missing endpoints."""
    await entity_fixture.create_schedule("s2")
    scope = entity_fixture.open_mutation_scope()
    try:
        now = "2026-07-21T00:00:00.000Z"
        payload: dict[str, object] = {
            "id": "sqn-1",
            "schedule_id": "s2",
            "quick_note_id": "missing",
            "created_at": now,
            "updated_at": now,
            "version": 1,
        }
        request = entity_fixture.commands.create(
            scope, "schedule_quick_note", payload, expected_version=None
        )
        with pytest.raises(MutationRejectedError) as exc_info:
            await entity_fixture.uow.execute(scope, request, "op-relation-test")
        assert exc_info.value.rejection.code == "relation_endpoint_missing"
    finally:
        await scope.aclose()


@pytest.mark.parametrize("action", ["create", "update"])
async def test_sync_wire_entity_id_is_the_only_primary_key_authority(
    entity_fixture, action
):
    """EntityCommand.from_sync_event rejects payload id mismatching sync entity_id."""
    commands = entity_fixture.commands
    match_payload = {"id": "sched-1", "title": "Test"}
    if action == "update":
        match_payload = {"id": "sched-1", "title": "Updated"}
    event = _SyncEvent(
        entity_type="schedule",
        entity_id="sched-1",
        action=action,
        payload=match_payload,
    )
    request = commands.from_sync_event(None, event)
    assert request.entity_id == "sched-1"
    mismatched_event = _SyncEvent(
        entity_type="schedule",
        entity_id="sched-1",
        action=action,
        payload={"id": "different"},
    )
    with pytest.raises(MutationRuleViolation, match="entity_id_mismatch"):
        commands.from_sync_event(None, mismatched_event)


async def test_folder_delete_uses_cascade_soft_delete(entity_fixture):
    """FolderDomainPolicy cascade-soft-deletes the folder and all descendants."""
    await entity_fixture.folder_tree("parent", "child")
    scope = entity_fixture.open_mutation_scope()
    try:
        request = entity_fixture.commands.delete(
            scope, "folder", "parent", expected_version=1
        )
        await entity_fixture.uow.execute(scope, request, "op-cascade-delete")
    finally:
        await scope.aclose()
    rows = await entity_fixture.list_folders()
    assert rows["parent"]["trashed_at"] is not None
    assert rows["child"]["trashed_at"] is not None


async def test_rejection_precedence_cycle_before_version_conflict(entity_fixture):
    """Cycle detection runs before CAS version check in FolderDomainPolicy."""
    await entity_fixture.folder_tree("a", "b", "c")
    scope = entity_fixture.open_mutation_scope()
    try:
        request = entity_fixture.commands.update(
            scope, "folder", "a", {"parent_id": "c"}, expected_version=999
        )
        with pytest.raises(MutationRejectedError) as exc_info:
            await entity_fixture.uow.execute(scope, request, "op-precedence-test")
        assert exc_info.value.rejection.code == "cycle_detected"
    finally:
        await scope.aclose()



# --- Task 2: Junction endpoint metadata from catalog ---


def test_junction_endpoints_not_hardcoded():
    """JUNCTION_ENDPOINTS hardcoded dict must not exist - metadata comes from catalog."""
    import app.commands.entity as entity_module
    assert not hasattr(entity_module, "JUNCTION_ENDPOINTS"), (
        "JUNCTION_ENDPOINTS must be removed - use catalog junction metadata instead"
    )


def test_catalog_exposes_junction_endpoints():
    """CompiledEntityCatalog exposes junction endpoint metadata from EntitySpec."""
    endpoints = _TEST_CATALOG.junction_endpoints_for("schedule_quick_note")
    assert endpoints is not None
    assert ("schedule_id", "schedule") in endpoints
    assert ("quick_note_id", "quick_note") in endpoints
    # Non-junction entities return None.
    assert _TEST_CATALOG.junction_endpoints_for("schedule") is None


def test_relation_uses_catalog_metadata_not_hardcoded():
    """RelationDomainPolicy.compile uses context.catalog, not JUNCTION_ENDPOINTS."""
    import inspect

    from app.commands.entity import RelationDomainPolicy
    source = inspect.getsource(RelationDomainPolicy)
    assert "JUNCTION_ENDPOINTS" not in source, (
        "RelationDomainPolicy must not reference JUNCTION_ENDPOINTS"
    )
    assert "junction_endpoints_for" in source, (
        "RelationDomainPolicy must use catalog.junction_endpoints_for()"
    )
    assert "removesuffix" not in source, (
        "RelationDomainPolicy must not use removesuffix - use catalog metadata"
    )


# --- Task 3: SyncEventLike contract and direct attribute access ---


def test_sync_event_like_requires_expected_version_and_client_updated_at():
    """SyncEventLike must declare expected_version and client_updated_at."""
    import typing

    from app.commands.entity import SyncEventLike
    hints = typing.get_type_hints(SyncEventLike)
    assert "expected_version" in hints, (
        "SyncEventLike must declare expected_version"
    )
    assert "client_updated_at" in hints, (
        "SyncEventLike must declare client_updated_at"
    )
    assert hints["client_updated_at"] is str, (
        "client_updated_at must be str (not Optional)"
    )


def test_from_sync_event_uses_direct_attribute_access():
    """from_sync_event must access event.expected_version and event.client_updated_at directly."""
    import inspect

    from app.commands.entity import EntityCommand
    source = inspect.getsource(EntityCommand.from_sync_event)
    assert "getattr" not in source, (
        "from_sync_event must not use getattr — direct attribute access required"
    )
    assert "event.expected_version" in source, (
        "from_sync_event must access event.expected_version directly"
    )
    assert "event.client_updated_at" in source, (
        "from_sync_event must access event.client_updated_at directly"
    )


async def test_from_sync_event_rejects_non_canonical_timestamp(entity_fixture):
    """from_sync_event must fail-closed on invalid client_updated_at."""
    commands = entity_fixture.commands
    bad_event = _SyncEvent(
        entity_type="schedule",
        entity_id="sched-1",
        action="create",
        payload={"id": "sched-1", "title": "Test"},
        client_updated_at="not-a-timestamp",
    )
    with pytest.raises((ValueError, MutationRuleViolation)):
        commands.from_sync_event(None, bad_event)


def test_from_sync_event_rejects_type_mismatched_id():
    """from_sync_event must not use str() coercion for ID comparison."""
    import inspect

    from app.commands.entity import EntityCommand
    source = inspect.getsource(EntityCommand.from_sync_event)
    assert "str(supplied_id)" not in source, (
        "from_sync_event must not use str() coercion — precise comparison required"
    )
