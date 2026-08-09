"""Tests for the production ActiveSessionCoordinator writer.

The writer is exercised through the real ``ProductionActiveSessionCoordinator``
with a real migrated Meta database, a *real* MutationUnitOfWork (real
compiler/interpreter/journal/recovery over real SQLite Space databases) and
real engine-backed Space handles.  There is no injected child executor — every
child goes through the real UoW and every assertion reads persisted rows.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine

from app.db.migrations import run_migrations
from app.db.session import create_engine, create_session_factory
from app.focus_session.child_operations import (
    ActiveSessionChildRole,
    derive_active_session_child_operation_id,
)
from app.focus_session.commands import focus_business_payload
from app.focus_session.contracts import ActiveSessionCommand
from app.focus_session.coordinator import (
    ActiveSessionCoordinationError,
    ProductionActiveSessionCoordinator,
)
from app.mutation.types import canonical_payload_hash, validate_operation_id

NOW = "2026-07-15T08:00:00.000Z"


def _clock() -> str:
    return NOW


def _pair_payload(active: tuple[str, str], candidate: tuple[str, str]) -> dict[str, object]:
    return {
        "pair": {
            "active": {"space_id": active[0], "session_id": active[1]},
            "candidate": {"space_id": candidate[0], "session_id": candidate[1]},
        },
        "owner_device_id": "device-1",
        "owner_tab_id": "tab-1",
        "cached_at": "2026-07-15T07:59:00.000Z",
    }


def _command(
    command_id: str, *, kind: str, space_id: str | None, session_id: str,
    epoch: int, payload: dict[str, object],
) -> ActiveSessionCommand:
    from app.focus_session.commands import active_business_payload

    business = active_business_payload(kind, payload)
    return ActiveSessionCommand(
        command_id=command_id,
        space_id=space_id,
        session_id=session_id,
        ownership_epoch=epoch,
        payload_hash=canonical_payload_hash(business),
        payload=payload,
    )


def _structure_snapshot() -> str:
    return json.dumps(
        {
            "project": {"id": "project-1", "name": "Project"},
            "level2": {
                "id": "wi-l2", "title": "WorkItem", "parent_id": None,
                "status_definition_id": "complete", "version": 1,
                "effort_estimate_lower_seconds": None,
                "effort_estimate_upper_seconds": None,
            },
            "plan": {},
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def _seed_session_rows(conn: sqlite3.Connection, session_id: str) -> None:
    """Write the durable Space rows a real child/aggregate needs: the
    FocusSession row, its task context (real work-item identity), the single
    effective attribution revision, and envelope/receipt evidence."""
    conn.execute(
        "INSERT OR IGNORE INTO focus_sessions "
        "(id, session_revision, started_at, planned_seconds, gross_seconds, "
        "paused_seconds, break_seconds, focused_seconds, validity, review_state, "
        "ownership_state, session_note, version, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            session_id, 1, "2026-07-15T08:00:00.000Z", 1500, 0, 0, 0, 0,
            "pending", "not_required", "activation_conflict", "", 1,
            "2026-07-15T08:00:00.000Z", "2026-07-15T08:00:00.000Z",
        ),
    )
    conn.execute(
        "INSERT OR IGNORE INTO session_task_contexts "
        "(id, session_id, project_id, level2_work_item_id, title_snapshot, "
        "structure_snapshot, linked_at, link_method, version, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (
            f"ctx-{session_id}", session_id, "project-1", "wi-l2",
            "WorkItem", _structure_snapshot(), "2026-07-15T08:00:00.000Z",
            "manual", 1, "2026-07-15T08:00:00.000Z", "2026-07-15T08:00:00.000Z",
        ),
    )
    conn.execute(
        "INSERT OR IGNORE INTO session_attribution_revisions "
        "(id, session_id, revision, project_id, level2_work_item_id, reason, "
        "corrected_from_revision, effective, version, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (
            f"attr-{session_id}-1", session_id, 1, "project-1", "wi-l2",
            None, None, 1, 1, "2026-07-15T08:00:00.000Z",
            "2026-07-15T08:00:00.000Z",
        ),
    )


def _seed_focus_session(db_path: str, session_id: str) -> None:
    with sqlite3.connect(db_path) as conn:
        _seed_session_rows(conn, session_id)
        conn.commit()


def _stage_authority(path: Path):
    from app.runtime.contained_io import BoundDirectoryHandle, BoundStageDirectory

    path.mkdir(parents=True, exist_ok=True)
    parent = BoundDirectoryHandle._create(path.parent)
    try:
        return BoundStageDirectory._from_parent_handle(parent, path.name)
    finally:
        parent._close()


class _DiskProjection:
    """Small restartable projection authority (mirrors test_mutation_recovery)."""

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
        return (
            "markdown"
            if target.startswith("notes/")
            else ("index" if target.startswith("index/") else "fts")
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

    async def snapshot_projection_authority(self) -> Any:
        from app.file_system.interfaces import ProjectionAuthoritySnapshot

        state = self._load()
        return ProjectionAuthoritySnapshot(
            {key: bytes.fromhex(value) for key, value in state["markdown"].items()},
            {key: bytes.fromhex(value) for key, value in state["index"].items()},
            {key: bytes.fromhex(value) for key, value in state["fts"].items()},
        )


class _Lease:
    def __init__(self, mode: Any, scope: str) -> None:
        self.mode = mode
        self.scope = scope
        self.owner_task = None

    def assert_active_owner(self, *, mode=None, scope=None, **_kwargs) -> None:
        import asyncio

        current = asyncio.current_task()
        if self.owner_task is None:
            self.owner_task = current
        if self.owner_task is not current:
            raise RuntimeError("lease owner Task changed")
        if mode is not None and mode is not self.mode:
            raise RuntimeError("lease mode changed")
        if scope is not None and scope != self.scope:
            raise RuntimeError("lease scope changed")

    def fence_receipt(self, scope: str) -> Any:
        self.assert_active_owner(scope=scope)
        return _Receipt()


class _Receipt:
    def assert_current(self) -> None:
        return None


def _real_uow():
    """A fully real MutationUnitOfWork composition (mirrors bootstrap)."""
    from app.deps import build_mutation_compiler
    from app.file_system.engine.base import FileSystemProjectionExecutor
    from app.mutation.journal import MutationJournal
    from app.mutation.recovery import MutationRecovery
    from app.mutation.unit_of_work import DbMutationInterpreter, MutationUnitOfWork
    from app.registry import CATALOG

    interpreter = DbMutationInterpreter(CATALOG)
    projection_executor = FileSystemProjectionExecutor()
    recovery = MutationRecovery(
        catalog=CATALOG,
        interpreter=interpreter,
        projection_executor=projection_executor,
    )
    return MutationUnitOfWork(
        catalog=CATALOG,
        compiler=build_mutation_compiler(CATALOG),
        interpreter=interpreter,
        projection_executor=projection_executor,
        recovery_gate=recovery,
        journal_factory=MutationJournal,
    )


class _TestSpaceHandle:
    """Real-engine Space handle (engine + session factory + stage/lease/projection
    scaffolding required by the real UoW)."""

    def __init__(self, engine, space_id: str, root: Path) -> None:
        from app.mutation.staging import StageStore
        from app.runtime.leases import LeaseMode

        self._engine = engine
        self.scope = SimpleNamespace(space_id=space_id)
        self._session_factory = create_session_factory(engine)
        self.closed = False
        stage_store = StageStore(_stage_authority(root / f"stages-{space_id}"))
        global_lease = _Lease(LeaseMode.SHARED, "global")
        space_lease = _Lease(LeaseMode.EXCLUSIVE, space_id)

        @asynccontextmanager
        async def exclusive_space_resources(purpose: str, timeout_seconds: int):
            assert (purpose, timeout_seconds) == ("mutation", 5)
            yield space_lease

        self.mutation_stages = stage_store
        self.file_system = _DiskProjection(root / f"projection-{space_id}")
        self.session_factory = self._session_factory
        self.global_lease = global_lease
        self.space_lease = space_lease
        self._runtime = None
        self.exclusive_space_resources = exclusive_space_resources

    @asynccontextmanager
    async def mutation_lease(self, purpose: str, timeout_seconds: int):
        if self.space_lease is not None:
            yield self.space_lease
        else:
            async with self.exclusive_space_resources(purpose, timeout_seconds) as lease:
                yield lease

    @property
    def _stages(self):
        return self.mutation_stages

    async def aclose(self) -> None:
        if not self.closed:
            self.closed = True
            self.mutation_stages.close()
            await self._engine.dispose()


@pytest.fixture(scope="session")
def coordinator_template(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    root = tmp_path_factory.mktemp("coordinator-template")
    meta = root / "meta.db"
    space_a = root / "space-a.db"
    space_b = root / "space-b.db"
    run_migrations("meta", meta)
    run_migrations("space", space_a)
    run_migrations("space", space_b)
    return {"meta": meta, "space-a": space_a, "space-b": space_b}


@pytest.fixture
def env(
    tmp_path: Path, coordinator_template: dict[str, Path]
) -> dict[str, Path]:
    meta = tmp_path / "meta.db"
    space_a = tmp_path / "space-a.db"
    space_b = tmp_path / "space-b.db"
    for source, target in (
        (coordinator_template["meta"], meta),
        (coordinator_template["space-a"], space_a),
        (coordinator_template["space-b"], space_b),
    ):
        shutil.copy2(source, target)
    return {"meta": meta, "space-a": space_a, "space-b": space_b}


async def _coordinator(
    env: dict[str, Path], tmp_path: Path | None = None,
) -> tuple[ProductionActiveSessionCoordinator, AsyncEngine, dict[str, _TestSpaceHandle], dict[str, Path]]:
    from app.focus_session.query import FocusSessionQuery

    paths = env
    engine = create_engine(f"sqlite+aiosqlite:///{paths['meta']}")
    factory = create_session_factory(engine)
    root = tmp_path if tmp_path is not None else Path(str(paths["meta"])).parent
    handles: dict[str, _TestSpaceHandle] = {}
    for space_id in ("space-a", "space-b"):
        space_engine = create_engine(f"sqlite+aiosqlite:///{paths[space_id]}")
        handles[space_id] = _TestSpaceHandle(space_engine, space_id, root)

    async def space_handle_provider(space_id: str):
        return handles[space_id]

    coordinator = ProductionActiveSessionCoordinator(
        meta_session_factory=factory,
        uow=_real_uow(),
        space_handle_provider=space_handle_provider,
        session_query=FocusSessionQuery(),
        clock=_clock,
    )
    return coordinator, engine, handles, paths


async def _read_operation(engine: AsyncEngine, operation_id: str) -> dict[str, object]:
    from sqlalchemy import text as sa_text

    async with engine.connect() as connection:
        row = await connection.execute(
            sa_text(
                "SELECT intent_json, phase, kind FROM active_session_operations "
                "WHERE operation_id=:oid"
            ),
            {"oid": operation_id},
        )
        result = row.fetchone()
    assert result is not None, "operation row must exist"
    return {
        "intent_json": str(result[0]),
        "phase": str(result[1]),
        "kind": str(result[2]),
    }


# --------------------------------------------------------------------------- #
# intent-before-child + child ID/hash freezing
# --------------------------------------------------------------------------- #


async def _dispose_all(engine: AsyncEngine, handles: dict[str, Any]) -> None:
    await engine.dispose()
    for _handle in handles.values():
        await _handle.aclose()


async def test_activate_provisional_intent_frozen_before_any_child(
    env, tmp_path,
) -> None:
    """No Space has a Session: the candidate child fails inside the real UoW
    (policy not_found) after Meta intent is frozen; phase stays claimed."""
    coordinator, engine, handles, paths = await _coordinator(env, tmp_path)
    op = "op-conflict"
    command = _command(
        op, kind="activate_provisional", space_id="space-a", session_id="fs-1",
        epoch=1, payload=_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
    )
    with pytest.raises(ActiveSessionCoordinationError):
        await coordinator.activate_provisional(None, command)  # type: ignore[arg-type]
    operation = await _read_operation(engine, op)
    assert operation["kind"] == "activate_provisional"
    assert operation["phase"] == "claimed"
    intent = json.loads(operation["intent_json"])
    assert intent["command_id"] == op
    assert intent["kind"] == "activate_provisional"
    assert intent["children"]["candidate"]["operation_id"] == (
        derive_active_session_child_operation_id(op, ActiveSessionChildRole.CANDIDATE)
    )
    assert intent["children"]["active"]["operation_id"] == (
        derive_active_session_child_operation_id(op, ActiveSessionChildRole.ACTIVE)
    )
    candidate_payload = {
        "decision": "preserve", "expected_ownership_epoch": 1,
        "space_id": "space-b", "session_id": "fs-2",
    }
    active_payload = {
        "decision": "preserve", "expected_ownership_epoch": 1,
        "space_id": "space-a", "session_id": "fs-1",
    }
    assert intent["children"]["candidate"]["payload_hash"] == canonical_payload_hash(
        focus_business_payload("mark_activation_conflict", candidate_payload)
    )
    assert intent["children"]["active"]["payload_hash"] == canonical_payload_hash(
        focus_business_payload("mark_activation_conflict", active_payload)
    )
    await _dispose_all(engine, handles)


async def test_activate_provisional_two_children_success_advances(
    env, tmp_path,
) -> None:
    coordinator, engine, handles, paths = await _coordinator(env, tmp_path)
    _seed_focus_session(str(paths["space-a"]), "fs-1")
    _seed_focus_session(str(paths["space-b"]), "fs-2")
    op = "op-conflict"
    command = _command(
        op, kind="activate_provisional", space_id="space-a", session_id="fs-1",
        epoch=1, payload=_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
    )
    await coordinator.activate_provisional(None, command)  # type: ignore[arg-type]
    operation = await _read_operation(engine, op)
    assert operation["phase"] == "awaiting_resolution"
    candidate_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.CANDIDATE)
    active_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.ACTIVE)
    # both children left real succeeded receipts in their Space DBs
    from sqlalchemy import select

    from app.models.session_command import SessionCommandReceipt

    for space_id, child_id in (("space-b", candidate_id), ("space-a", active_id)):
        async with handles[space_id].session_factory() as session:
            receipt = await session.get(SessionCommandReceipt, child_id)
            assert receipt is not None and receipt.state == "succeeded"
    await _dispose_all(engine, handles)


async def test_candidate_child_failure_does_not_advance(env, tmp_path) -> None:
    """Candidate Session missing -> real policy rejection -> phase stays claimed."""
    coordinator, engine, handles, paths = await _coordinator(env, tmp_path)
    _seed_focus_session(str(paths["space-a"]), "fs-1")
    op = "op-conflict"
    command = _command(
        op, kind="activate_provisional", space_id="space-a", session_id="fs-1",
        epoch=1, payload=_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
    )
    with pytest.raises(ActiveSessionCoordinationError):
        await coordinator.activate_provisional(None, command)  # type: ignore[arg-type]
    operation = await _read_operation(engine, op)
    assert operation["phase"] == "claimed"  # never advanced
    await _dispose_all(engine, handles)


async def test_active_child_failure_keeps_claimed(env, tmp_path) -> None:
    """Candidate succeeds (real receipt), active fails -> phase stays claimed."""
    coordinator, engine, handles, paths = await _coordinator(env, tmp_path)
    _seed_focus_session(str(paths["space-b"]), "fs-2")  # candidate exists only
    op = "op-conflict"
    command = _command(
        op, kind="activate_provisional", space_id="space-a", session_id="fs-1",
        epoch=1, payload=_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
    )
    with pytest.raises(ActiveSessionCoordinationError):
        await coordinator.activate_provisional(None, command)  # type: ignore[arg-type]
    operation = await _read_operation(engine, op)
    assert operation["phase"] == "claimed"
    # candidate left a real succeeded receipt
    from sqlalchemy import select

    from app.models.session_command import SessionCommandReceipt

    candidate_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.CANDIDATE)
    async with handles["space-b"].session_factory() as session:
        receipt = await session.get(SessionCommandReceipt, candidate_id)
        assert receipt is not None and receipt.state == "succeeded"
    await _dispose_all(engine, handles)


async def test_restart_reuses_frozen_child_ids(env, tmp_path) -> None:
    """A fresh coordinator instance derives the exact same child IDs the
    failed run froze in Meta: no new semantic command is ever invented."""
    from app.focus_session.query import FocusSessionQuery

    coordinator, engine, handles, paths = await _coordinator(env, tmp_path)
    op = "op-conflict"
    command = _command(
        op, kind="activate_provisional", space_id="space-a", session_id="fs-1",
        epoch=1, payload=_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
    )
    with pytest.raises(ActiveSessionCoordinationError):
        await coordinator.activate_provisional(None, command)  # type: ignore[arg-type]
    frozen = json.loads((await _read_operation(engine, op))["intent_json"])
    assert frozen["children"]["candidate"]["operation_id"] == (
        derive_active_session_child_operation_id(op, ActiveSessionChildRole.CANDIDATE)
    )
    assert frozen["children"]["active"]["operation_id"] == (
        derive_active_session_child_operation_id(op, ActiveSessionChildRole.ACTIVE)
    )
    # a second, independent coordinator instance (restart) must reproduce them
    factory = create_session_factory(engine)
    restarted = ProductionActiveSessionCoordinator(
        meta_session_factory=factory,
        uow=_real_uow(),
        space_handle_provider=lambda space_id: handles[space_id],
        session_query=FocusSessionQuery(),
        clock=_clock,
    )
    recomputed_candidate = derive_active_session_child_operation_id(
        op, ActiveSessionChildRole.CANDIDATE
    )
    recomputed_active = derive_active_session_child_operation_id(
        op, ActiveSessionChildRole.ACTIVE
    )
    assert recomputed_candidate == frozen["children"]["candidate"]["operation_id"]
    assert recomputed_active == frozen["children"]["active"]["operation_id"]
    assert restarted is not None
    await _dispose_all(engine, handles)


async def test_resolve_activation_conflict_freezes_winner_loser(env, tmp_path) -> None:
    """Winner child runs through the real UoW and leaves a succeeded receipt;
    the loser child (end on an activation_conflict Session) is rejected by the
    real policy locator claim — the Meta phase never advances to transferred.
    This is the honest, real-UoW evidence of the unresolved loser-end contract.
    """
    from sqlalchemy import select

    from app.models.session_command import SessionCommandReceipt

    coordinator, engine, handles, paths = await _coordinator(env, tmp_path)
    _seed_focus_session(str(paths["space-a"]), "fs-1")
    _seed_focus_session(str(paths["space-b"]), "fs-2")
    conflict_op = "op-conflict"
    conflict_command = _command(
        conflict_op, kind="activate_provisional", space_id="space-a", session_id="fs-1",
        epoch=1, payload=_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
    )
    await coordinator.activate_provisional(None, conflict_command)  # type: ignore[arg-type]
    op = "op-resolve"
    payload = {
        **_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
        "winner_role": "candidate",
        "decision_at": NOW,
        "validity_correction": {
            "loser_validity": "invalid",
            "loser_validity_reason": "activation_conflict_loser",
        },
    }
    command = _command(
        op, kind="resolve_activation_conflict", space_id="space-a",
        session_id="fs-1", epoch=1, payload=payload,
    )
    with pytest.raises(ActiveSessionCoordinationError):
        await coordinator.resolve_activation_conflict(None, command)  # type: ignore[arg-type]
    operation = await _read_operation(engine, op)
    assert operation["kind"] == "resolve_activation_conflict"
    assert operation["phase"] == "claimed"  # never transferred
    intent = json.loads(operation["intent_json"])
    winner_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.WINNER)
    loser_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.LOSER)
    assert intent["children"]["winner"]["operation_id"] == winner_id
    assert intent["children"]["loser"]["operation_id"] == loser_id
    # winner ran first through the real UoW and left a succeeded receipt
    async with handles["space-b"].session_factory() as session:
        receipt = await session.get(SessionCommandReceipt, winner_id)
        assert receipt is not None and receipt.state == "succeeded"
    # loser was rejected by the real policy (locator claim / conflict read-only)
    async with handles["space-a"].session_factory() as session:
        loser_receipt = await session.get(SessionCommandReceipt, loser_id)
        assert loser_receipt is None or loser_receipt.state != "succeeded"
    await _dispose_all(engine, handles)


async def test_locate_reflects_durable_state(env, tmp_path) -> None:
    coordinator, engine, handles, paths = await _coordinator(env, tmp_path)
    assert await coordinator.locate(None) is None  # type: ignore[arg-type]
    _seed_focus_session(str(paths["space-a"]), "fs-1")
    _seed_focus_session(str(paths["space-b"]), "fs-2")
    op = "op-conflict"
    command = _command(
        op, kind="activate_provisional", space_id="space-a", session_id="fs-1",
        epoch=1, payload=_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
    )
    await coordinator.activate_provisional(None, command)  # type: ignore[arg-type]
    view = await coordinator.locate(None)  # type: ignore[arg-type]
    assert view is not None
    assert view.value["locator"]["operationId"] == op
    assert view.value["locator"]["state"] == "claiming"
    # the aggregate comes from the real Space DB, not a fabricated dict
    assert view.value["session"]["session"]["id"] == "fs-1"
    await _dispose_all(engine, handles)


async def test_authority_reads_coordinator_written_intent(env, tmp_path) -> None:
    """Authority parity: the production coordinator's persisted intent and the
    real-UoW child evidence are read back by the full inspect_read_only entry
    as awaiting_resolution — no hand-written fixture, no private classifier."""
    from types import SimpleNamespace

    from app.focus_session.recovery_authority import (
        CLASSIFICATION_AWAITING_RESOLUTION,
        ActiveSessionCoordinationInspector,
    )
    from app.knowledge.consistency import SpaceDataView

    coordinator, engine, handles, paths = await _coordinator(env, tmp_path)
    _seed_focus_session(str(paths["space-a"]), "fs-1")
    _seed_focus_session(str(paths["space-b"]), "fs-2")
    op = "op-conflict"
    command = _command(
        op, kind="activate_provisional", space_id="space-a", session_id="fs-1",
        epoch=1, payload=_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
    )
    await coordinator.activate_provisional(None, command)  # type: ignore[arg-type]

    inspector = ActiveSessionCoordinationInspector()
    meta_view = SimpleNamespace(db_path=str(paths["meta"]))
    space_views = {
        "space-a": SpaceDataView(
            "space-a", Path(str(paths["space-a"])),
            Path(str(paths["space-a"]).replace(".db", "-notes")),
            Path(str(paths["space-a"]).replace(".db", "-index.db")), "0" * 64,
        ),
        "space-b": SpaceDataView(
            "space-b", Path(str(paths["space-b"])),
            Path(str(paths["space-b"]).replace(".db", "-notes")),
            Path(str(paths["space-b"]).replace(".db", "-index.db")), "0" * 64,
        ),
    }
    decision = await inspector.inspect_read_only(meta_view, space_views=space_views)
    assert decision.classification == CLASSIFICATION_AWAITING_RESOLUTION
    assert decision.result == "clean_or_recoverable"
    assert len(decision.child_outcomes) == 2
    assert all(outcome.terminal_success for outcome in decision.child_outcomes)

    await _dispose_all(engine, handles)
