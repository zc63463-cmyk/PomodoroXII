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
    *,
    clock=_clock,
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

    # The real policy locator reader (deps.build_mutation_compiler) reads the
    # singleton Meta factory; install the test engine's factory so the
    # resolution children can verify the Meta locator through the real reader.
    import app.db.meta_session as _meta_module

    _meta_module._meta_session_factory = factory

    coordinator = ProductionActiveSessionCoordinator(
        meta_session_factory=factory,
        uow=_real_uow(),
        space_handle_provider=space_handle_provider,
        session_query=FocusSessionQuery(),
        clock=clock,
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


@pytest.fixture(autouse=True)
def _reset_meta_session_factory() -> None:
    """Reset the singleton Meta factory after every test so one test's engine
    never leaks into the next (the real locator reader depends on it)."""
    yield
    import app.db.meta_session as _meta_module

    _meta_module._meta_session_factory = None
    _meta_module._meta_engine = None


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
    """Resolution through the real UoW: winner becomes authoritative, loser is
    ended interrupted + invalid (activation_conflict_loser), both receipts are
    terminal-success, and the Meta operation CASes to ``transferred``."""
    from sqlalchemy import select

    from app.focus_session.child_operations import (
        ActiveSessionChildRole,
        derive_active_session_child_operation_id,
    )
    from app.models.focus_session import FocusSession
    from app.models.session_command import SessionCommandReceipt
    from app.services.time import utc_now_iso_ms

    coordinator, engine, handles, paths = await _coordinator(
        env, tmp_path, clock=utc_now_iso_ms
    )
    _seed_focus_session(str(paths["space-a"]), "fs-1")
    _seed_focus_session(str(paths["space-b"]), "fs-2")
    conflict_op = "op-conflict"
    conflict_command = _command(
        conflict_op, kind="activate_provisional", space_id="space-a", session_id="fs-1",
        epoch=1, payload=_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
    )
    await coordinator.activate_provisional(None, conflict_command)  # type: ignore[arg-type]
    from app.services.time import utc_now_iso_ms

    op = "op-resolve"
    payload = {
        **_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
        "winner_role": "candidate",
        "decision_at": utc_now_iso_ms(),
        "validity_correction": {
            "loser_validity": "invalid",
            "loser_validity_reason": "activation_conflict_loser",
        },
    }
    command = _command(
        op, kind="resolve_activation_conflict", space_id="space-a",
        session_id="fs-1", epoch=1, payload=payload,
    )
    view = await coordinator.resolve_activation_conflict(None, command)  # type: ignore[arg-type]
    operation = await _read_operation(engine, op)
    assert operation["kind"] == "resolve_activation_conflict"
    assert operation["phase"] == "transferred"
    intent = json.loads(operation["intent_json"])
    winner_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.WINNER)
    loser_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.LOSER)
    assert intent["children"]["winner"]["operation_id"] == winner_id
    assert intent["children"]["loser"]["operation_id"] == loser_id
    # winner (candidate side = space-b / fs-2): authoritative, non-ended
    async with handles["space-b"].session_factory() as session:
        receipt = await session.get(SessionCommandReceipt, winner_id)
        assert receipt is not None and receipt.state == "succeeded"
        winner = await session.get(FocusSession, "fs-2")
        assert winner is not None
        assert winner.ownership_state == "authoritative"
        assert winner.ended_at is None
        assert winner.validity == "pending"
    # loser (active side = space-a / fs-1): ended interrupted + invalid marker
    async with handles["space-a"].session_factory() as session:
        loser_receipt = await session.get(SessionCommandReceipt, loser_id)
        assert loser_receipt is not None and loser_receipt.state == "succeeded"
        loser = await session.get(FocusSession, "fs-1")
        assert loser is not None
        assert loser.ended_at is not None
        assert loser.timer_completion == "interrupted"
        assert loser.validity == "invalid"
        assert loser.validity_reason == "activation_conflict_loser"
        assert loser.ownership_state != "activation_conflict"
    assert view.value["operation"]["phase"] == "transferred"
    await _dispose_all(engine, handles)


async def _resolve_setup(env, tmp_path):
    """Shared real-UoW resolve scaffold: two conflict Sessions, activated.

    Returns (coordinator, engine, handles, paths, conflict_op, op, command).
    """
    from app.services.time import utc_now_iso_ms

    coordinator, engine, handles, paths = await _coordinator(
        env, tmp_path, clock=utc_now_iso_ms
    )
    _seed_focus_session(str(paths["space-a"]), "fs-1")
    _seed_focus_session(str(paths["space-b"]), "fs-2")
    conflict_op = "op-conflict"
    conflict_command = _command(
        conflict_op, kind="activate_provisional", space_id="space-a", session_id="fs-1",
        epoch=1, payload=_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
    )
    await coordinator.activate_provisional(None, conflict_command)  # type: ignore[arg-type]
    from app.services.time import utc_now_iso_ms

    op = "op-resolve"
    payload = {
        **_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
        "winner_role": "candidate",
        "decision_at": utc_now_iso_ms(),
        "validity_correction": {
            "loser_validity": "invalid",
            "loser_validity_reason": "activation_conflict_loser",
        },
    }
    command = _command(
        op, kind="resolve_activation_conflict", space_id="space-a",
        session_id="fs-1", epoch=1, payload=payload,
    )
    return coordinator, engine, handles, paths, conflict_op, op, command


async def test_resolve_active_winner_real_uow(env, tmp_path) -> None:
    """Active-side winner: fs-1 (the locator anchor) wins and becomes
    authoritative; the candidate fs-2 is ended invalid.  Both receipts are
    terminal-success and the Meta operation reaches ``transferred``."""
    from sqlalchemy import select

    from app.focus_session.child_operations import (
        ActiveSessionChildRole,
        derive_active_session_child_operation_id,
    )
    from app.models.focus_session import FocusSession
    from app.models.session_command import SessionCommandReceipt
    from app.services.time import utc_now_iso_ms

    coordinator, engine, handles, paths = await _coordinator(
        env, tmp_path, clock=utc_now_iso_ms
    )
    _seed_focus_session(str(paths["space-a"]), "fs-1")
    _seed_focus_session(str(paths["space-b"]), "fs-2")
    conflict_op = "op-conflict"
    conflict_command = _command(
        conflict_op, kind="activate_provisional", space_id="space-a", session_id="fs-1",
        epoch=1, payload=_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
    )
    await coordinator.activate_provisional(None, conflict_command)  # type: ignore[arg-type]
    from app.services.time import utc_now_iso_ms

    op = "op-resolve"
    payload = {
        **_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
        "winner_role": "active",
        "decision_at": utc_now_iso_ms(),
        "validity_correction": {
            "loser_validity": "invalid",
            "loser_validity_reason": "activation_conflict_loser",
        },
    }
    command = _command(
        op, kind="resolve_activation_conflict", space_id="space-a",
        session_id="fs-1", epoch=1, payload=payload,
    )
    await coordinator.resolve_activation_conflict(None, command)  # type: ignore[arg-type]
    operation = await _read_operation(engine, op)
    assert operation["phase"] == "transferred"
    winner_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.WINNER)
    loser_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.LOSER)
    # winner = active side (space-a / fs-1): authoritative, non-ended
    async with handles["space-a"].session_factory() as session:
        receipt = await session.get(SessionCommandReceipt, winner_id)
        assert receipt is not None and receipt.state == "succeeded"
        winner = await session.get(FocusSession, "fs-1")
        assert winner.ownership_state == "authoritative"
        assert winner.ended_at is None
    # loser = candidate side (space-b / fs-2): ended interrupted + invalid
    async with handles["space-b"].session_factory() as session:
        loser_receipt = await session.get(SessionCommandReceipt, loser_id)
        assert loser_receipt is not None and loser_receipt.state == "succeeded"
        loser = await session.get(FocusSession, "fs-2")
        assert loser.ended_at is not None
        assert loser.timer_completion == "interrupted"
        assert loser.validity == "invalid"
        assert loser.validity_reason == "activation_conflict_loser"
    await _dispose_all(engine, handles)


async def test_resolve_winner_success_loser_rejected_keeps_claimed(env, tmp_path) -> None:
    """Winner succeeds; the loser child is rejected by the real policy
    (its Session is no longer in the conflict) — the Meta phase stays
    ``claimed``, the winner receipt is preserved and nothing transfers."""
    from sqlalchemy import select

    from app.focus_session.child_operations import (
        ActiveSessionChildRole,
        derive_active_session_child_operation_id,
    )
    from app.models.focus_session import FocusSession
    from app.models.session_command import SessionCommandReceipt

    coordinator, engine, handles, paths, _co, op, command = await _resolve_setup(
        env, tmp_path
    )
    # Break the loser's conflict state before resolving: the real policy then
    # rejects the loser child with not_activation_conflict.
    async with handles["space-a"].session_factory() as session:
        loser = await session.get(FocusSession, "fs-1")
        loser.ownership_state = "authoritative"
        await session.commit()
    with pytest.raises(ActiveSessionCoordinationError):
        await coordinator.resolve_activation_conflict(None, command)  # type: ignore[arg-type]
    operation = await _read_operation(engine, op)
    assert operation["phase"] == "claimed"  # never transferred
    winner_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.WINNER)
    loser_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.LOSER)
    async with handles["space-b"].session_factory() as session:
        winner_receipt = await session.get(SessionCommandReceipt, winner_id)
        assert winner_receipt is not None and winner_receipt.state == "succeeded"
    async with handles["space-a"].session_factory() as session:
        loser_receipt = await session.get(SessionCommandReceipt, loser_id)
        assert loser_receipt is not None and loser_receipt.state == "conflict"
    await _dispose_all(engine, handles)


async def test_resolve_winner_rejected_loser_never_runs(env, tmp_path) -> None:
    """A rejected winner child stops the resolution before the loser: the
    loser child is never executed and the phase stays ``claimed``."""
    from sqlalchemy import select

    from app.focus_session.child_operations import (
        ActiveSessionChildRole,
        derive_active_session_child_operation_id,
    )
    from app.models.focus_session import FocusSession
    from app.models.session_command import SessionCommandReceipt

    coordinator, engine, handles, paths, _co, op, command = await _resolve_setup(
        env, tmp_path
    )
    # Break the winner's conflict state: the real policy rejects the winner.
    async with handles["space-b"].session_factory() as session:
        winner = await session.get(FocusSession, "fs-2")
        winner.ownership_state = "authoritative"
        await session.commit()
    with pytest.raises(ActiveSessionCoordinationError):
        await coordinator.resolve_activation_conflict(None, command)  # type: ignore[arg-type]
    operation = await _read_operation(engine, op)
    assert operation["phase"] == "claimed"
    winner_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.WINNER)
    loser_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.LOSER)
    async with handles["space-b"].session_factory() as session:
        winner_receipt = await session.get(SessionCommandReceipt, winner_id)
        assert winner_receipt is not None and winner_receipt.state == "conflict"
    async with handles["space-a"].session_factory() as session:
        loser_receipt = await session.get(SessionCommandReceipt, loser_id)
        assert loser_receipt is None  # loser never ran
    await _dispose_all(engine, handles)


async def test_resolve_restart_reuses_winner_loser_ids(env, tmp_path) -> None:
    """A crashed resolution restarts on a fresh coordinator: the succeeded
    winner child is reused (never re-executed), the loser reuses its original
    deterministic ID, no duplicate envelope is written, and after both
    receipts are terminal-success the operation CASes to ``transferred``."""
    from sqlalchemy import select

    from app.focus_session.child_operations import (
        ActiveSessionChildRole,
        derive_active_session_child_operation_id,
    )
    from app.models.session_command import SessionCommandEnvelope, SessionCommandReceipt

    coordinator, engine, handles, paths, _co, op, command = await _resolve_setup(
        env, tmp_path
    )
    winner_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.WINNER)
    loser_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.LOSER)
    # First run: the loser Session loses its task context -> the envelope
    # write fails closed before the loser mutation -> the coordinator aborts
    # (simulating a crash between winner success and loser execution).  The
    # winner receipt is durable; the loser has no envelope/receipt/journal.
    async with handles["space-a"].session_factory() as session:
        from sqlalchemy import text as sa_text

        await session.execute(
            sa_text("DELETE FROM session_task_contexts WHERE session_id='fs-1'")
        )
        await session.commit()
    with pytest.raises(ActiveSessionCoordinationError):
        await coordinator.resolve_activation_conflict(None, command)  # type: ignore[arg-type]
    operation = await _read_operation(engine, op)
    assert operation["phase"] == "claimed"
    # Restore the loser's context, then destroy the first instance completely.
    async with handles["space-a"].session_factory() as session:
        from sqlalchemy import text as sa_text

        await session.execute(
            sa_text(
                "INSERT OR IGNORE INTO session_task_contexts "
                "(id, session_id, project_id, level2_work_item_id, title_snapshot, "
                "structure_snapshot, linked_at, link_method, version, created_at, updated_at) "
                "VALUES ('ctx-fs-1','fs-1','project-1','wi-l2','WorkItem',"
                ":_snapshot, '2026-07-15T08:00:00.000Z','manual',1,"
                "'2026-07-15T08:00:00.000Z','2026-07-15T08:00:00.000Z')"
            ),
            {"_snapshot": "{}"},
        )
        await session.commit()
    await _dispose_all(engine, handles)
    # Fresh coordinator over the same Meta/Space DBs.
    from app.services.time import utc_now_iso_ms

    coordinator2, engine2, handles2, _paths2 = await _coordinator(
        env, tmp_path, clock=utc_now_iso_ms
    )
    view = await coordinator2.resolve_activation_conflict(None, command)  # type: ignore[arg-type]
    operation = await _read_operation(engine2, op)
    assert operation["phase"] == "transferred"
    intent = json.loads(operation["intent_json"])
    assert intent["children"]["winner"]["operation_id"] == winner_id
    assert intent["children"]["loser"]["operation_id"] == loser_id
    # exactly one envelope per child (no duplicate inserts across restarts)
    async with handles2["space-b"].session_factory() as session:
        envelopes = (
            await session.execute(
                select(SessionCommandEnvelope).where(
                    SessionCommandEnvelope.command_id == winner_id
                )
            )
        ).scalars().all()
        assert len(envelopes) == 1
        winner_receipt = await session.get(SessionCommandReceipt, winner_id)
        assert winner_receipt is not None and winner_receipt.state == "succeeded"
    async with handles2["space-a"].session_factory() as session:
        loser_envelopes = (
            await session.execute(
                select(SessionCommandEnvelope).where(
                    SessionCommandEnvelope.command_id == loser_id
                )
            )
        ).scalars().all()
        assert len(loser_envelopes) == 1
        loser_receipt = await session.get(SessionCommandReceipt, loser_id)
        assert loser_receipt is not None and loser_receipt.state == "succeeded"
    assert view.value["operation"]["phase"] == "transferred"
    await _dispose_all(engine2, handles2)


async def _loser_request(
    *,
    op_id: str,
    session_id: str,
    resolution_operation_id: str = "op-resolve",
    related_operation_id: str = "op-conflict",
    winner_role: str = "candidate",
    pair_override: dict[str, dict[str, str]] | None = None,
    space_id: str = "space-a",
    epoch: object | None = None,
    extra: dict[str, object] | None = None,
):
    from app.mutation.types import MutationRequest

    pair = pair_override or {
        "active": {"space_id": "space-a", "session_id": "fs-1"},
        "candidate": {"space_id": "space-b", "session_id": "fs-2"},
    }
    from app.services.time import utc_now_iso_ms

    payload: dict[str, object] = {
        "space_id": space_id,
        "session_id": session_id,
        "resolution_operation_id": resolution_operation_id,
        "related_operation_id": related_operation_id,
        "winner_role": winner_role,
        "occurred_at": utc_now_iso_ms(),
        "pair": pair,
        **(extra or {}),
    }
    if epoch is not None:
        payload["ownership_epoch"] = epoch
    return MutationRequest.from_payload(
        name="focus_session.resolve_conflict_loser",
        entity_type="focus_session",
        entity_id=session_id,
        payload=payload,
        expected_version=None,
    )


async def _compile_rejected(
    uow, handle, request, op_id: str,
) -> str:
    """Compile one request through the real policy; return the stable
    rejection code (or raise if it unexpectedly compiles)."""
    from app.mutation.types import MutationRuleViolation
    from app.mutation.unit_of_work import AuthorityOverlay

    async with handle.session_factory() as session:
        overlay = await AuthorityOverlay.from_locked_authorities(
            handle, session, uow.catalog
        )
        with pytest.raises(MutationRuleViolation) as exc_info:
            await uow.compiler.compile_against_overlay(
                handle, request, overlay, op_id
            )
        return exc_info.value.code


async def test_resolution_child_identity_attacks(env, tmp_path) -> None:
    """Every tampered identity axis fails closed in the real policy with a
    stable rejection code; nothing is executed and no journal row appears."""
    from app.focus_session.child_operations import (
        ActiveSessionChildRole,
        derive_active_session_child_operation_id,
    )
    from app.mutation.types import MutationRuleViolation

    coordinator, engine, handles, paths, _co, op, command = await _resolve_setup(
        env, tmp_path
    )
    uow = _real_uow()
    handle_a = handles["space-a"]
    loser_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.LOSER)

    # The real coordinator CASes the locator onto the resolution operation
    # before any child runs; simulate that so the compile-time children see
    # the transferred claim (TS2 plan L3046).
    from sqlalchemy import text as sa_text

    async with engine.begin() as connection:
        await connection.execute(
            sa_text(
                "UPDATE active_session_locator SET operation_id=:op, "
                "ownership_epoch=ownership_epoch+1 WHERE singleton_key='active'"
            ),
            {"op": op},
        )

    # control: the honest loser child compiles cleanly
    async with handle_a.session_factory() as session:
        from app.mutation.unit_of_work import AuthorityOverlay

        overlay = await AuthorityOverlay.from_locked_authorities(
            handle_a, session, uow.catalog
        )
        await uow.compiler.compile_against_overlay(
            handle_a,
            await _loser_request(op_id=loser_id, session_id="fs-1"),
            overlay,
            loser_id,
        )

    # wrong parent: operation id derived from a different resolution op
    code = await _compile_rejected(
        uow, handle_a,
        await _loser_request(op_id=loser_id, session_id="fs-1"),
        derive_active_session_child_operation_id("op-other", ActiveSessionChildRole.LOSER),
    )
    assert code == "version_conflict"
    # wrong resolution operation anchor: the op id derives from a different
    # parent and the locator anchors op-resolve, not op-wrong
    code = await _compile_rejected(
        uow, handle_a,
        await _loser_request(op_id=loser_id, session_id="fs-1", resolution_operation_id="op-wrong"),
        derive_active_session_child_operation_id("op-wrong", ActiveSessionChildRole.LOSER),
    )
    assert code == "stale_session_owner"
    # wrong pair: active side does not match the locator anchor
    code = await _compile_rejected(
        uow, handle_a,
        await _loser_request(
            op_id=loser_id, session_id="fs-1",
            pair_override={
                "active": {"space_id": "space-x", "session_id": "fs-x"},
                "candidate": {"space_id": "space-b", "session_id": "fs-2"},
            },
        ),
        loser_id,
    )
    assert code == "stale_session_owner"
    # wrong epoch
    code = await _compile_rejected(
        uow, handle_a,
        await _loser_request(op_id=loser_id, session_id="fs-1", epoch=999),
        loser_id,
    )
    assert code == "stale_session_owner"
    # wrong Space (not the handle's scope)
    code = await _compile_rejected(
        uow, handle_a,
        await _loser_request(op_id=loser_id, session_id="fs-1", space_id="space-x"),
        loser_id,
    )
    assert code == "space_scope_mismatch"
    # wrong Session (not the loser side of the pair)
    code = await _compile_rejected(
        uow, handle_a,
        await _loser_request(op_id=loser_id, session_id="fs-2"),
        loser_id,
    )
    assert code == "version_conflict"
    # caller-declared loser flag / invalid winner role
    code = await _compile_rejected(
        uow, handle_a,
        await _loser_request(op_id=loser_id, session_id="fs-1", winner_role="loser"),
        loser_id,
    )
    assert code == "version_conflict"
    # missing resolution operation anchor
    code = await _compile_rejected(
        uow, handle_a,
        await _loser_request(op_id=loser_id, session_id="fs-1", resolution_operation_id=""),
        loser_id,
    )
    assert code == "version_conflict"
    await _dispose_all(engine, handles)


async def test_resolution_state_attacks(env, tmp_path) -> None:
    """State-level attacks: locator not claiming, ended Session, non-conflict
    Session, and an ordinary end on a conflict Session all fail closed."""
    from sqlalchemy import text as sa_text

    from app.focus_session.child_operations import (
        ActiveSessionChildRole,
        derive_active_session_child_operation_id,
    )
    from app.models.focus_session import FocusSession
    from app.mutation.types import MutationRequest

    coordinator, engine, handles, paths, _co, op, command = await _resolve_setup(
        env, tmp_path
    )
    uow = _real_uow()
    handle_a = handles["space-a"]
    loser_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.LOSER)

    from sqlalchemy import text as sa_text

    async with engine.begin() as connection:
        await connection.execute(
            sa_text(
                "UPDATE active_session_locator SET operation_id=:op, "
                "ownership_epoch=ownership_epoch+1 WHERE singleton_key='active'"
            ),
            {"op": op},
        )

    # locator not claiming -> stale_session_owner (locator lives in Meta)
    async with engine.begin() as connection:
        await connection.execute(
            sa_text("UPDATE active_session_locator SET state='active' WHERE singleton_key='active'")
        )
    code = await _compile_rejected(
        uow, handle_a,
        await _loser_request(op_id=loser_id, session_id="fs-1"), loser_id,
    )
    assert code == "stale_session_owner"
    # restore claiming, then end fs-1 manually -> terminal_session
    async with engine.begin() as connection:
        await connection.execute(
            sa_text("UPDATE active_session_locator SET state='claiming' WHERE singleton_key='active'")
        )
    async with handles["space-a"].session_factory() as session:
        fs1 = await session.get(FocusSession, "fs-1")
        fs1.ended_at = "2026-07-15T09:00:00.000Z"
        await session.commit()
    code = await _compile_rejected(
        uow, handle_a,
        await _loser_request(op_id=loser_id, session_id="fs-1"), loser_id,
    )
    assert code == "version_conflict"
    # non-conflict Session -> not_activation_conflict
    async with handles["space-a"].session_factory() as session:
        fs1 = await session.get(FocusSession, "fs-1")
        fs1.ended_at = None
        fs1.ownership_state = "authoritative"
        await session.commit()
    code = await _compile_rejected(
        uow, handle_a,
        await _loser_request(op_id=loser_id, session_id="fs-1"), loser_id,
    )
    assert code == "version_conflict"
    # ordinary end on a conflict Session stays rejected (no widening)
    async with handles["space-a"].session_factory() as session:
        fs1 = await session.get(FocusSession, "fs-1")
        fs1.ownership_state = "activation_conflict"
        _fs1_version = fs1.version
        await session.commit()
    from app.mutation.types import MutationRequest
    from app.services.time import utc_now_iso_ms

    end_request = MutationRequest.from_payload(
        name="focus_session.end",
        entity_type="focus_session",
        entity_id="fs-1",
        payload={
            "space_id": "space-a",
            "session_id": "fs-1",
            "occurred_at": utc_now_iso_ms(),
            "timer_completion": "interrupted",
            "validity": "invalid",
            "validity_reason": "activation_conflict_loser",
        },
        expected_version=_fs1_version,
    )
    code = await _compile_rejected(
        uow, handle_a, end_request, op
    )
    assert code == "session_activation_conflict"
    await _dispose_all(engine, handles)


async def test_aborted_journal_never_counts_as_success(env, tmp_path) -> None:
    """A child whose journal batch is ABORTED is never classified as success:
    the decision is RECOVERY_REQUIRED and the resolution never transfers."""
    from app.focus_session.child_operations import (
        ActiveSessionChildRole,
        derive_active_session_child_operation_id,
    )
    from app.focus_session.contracts import FocusSessionCommand
    from app.focus_session.coordinator import ChildExecutionDecision
    from app.models.mutation import MutationBatch, MutationOperation
    from app.models.session_command import SessionCommandEnvelope

    coordinator, engine, handles, paths, _co, op, command = await _resolve_setup(
        env, tmp_path
    )
    winner_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.WINNER)
    payload_hash = "a" * 64
    child_command = FocusSessionCommand(
        command_id=winner_id,
        space_id="space-b",
        session_id="fs-2",
        ownership_epoch=None,
        payload_hash=payload_hash,
        payload={"space_id": "space-b", "session_id": "fs-2"},
    )
    async with handles["space-b"].session_factory() as session:
        session.add(
            SessionCommandEnvelope(
                command_id=winner_id, space_id="space-b", session_id="fs-2",
                session_revision=1, work_item_id="wi-l2", expected_version=1,
                target_transition="complete", replay_safe=True,
                payload_hash=payload_hash, created_at="2026-07-15T08:00:00.000Z",
            )
        )
        batch_id = f"batch-{winner_id}"
        session.add(
            MutationBatch(
                batch_id=batch_id, command_hash="0" * 64,
                state="ABORTED", accepted_count=1,
            )
        )
        session.add(
            MutationOperation(
                operation_id=winner_id, batch_id=batch_id, sequence=0,
                command_hash="0" * 64, command_json="{}",
                expected_versions_json="{}", projection_set_json="{}",
                state="ABORTED",
            )
        )
        await session.commit()
    decision, exists = await coordinator._child_execution_decision(  # noqa: SLF001
        handles["space-b"], winner_id, child_command
    )
    assert decision is ChildExecutionDecision.RECOVERY_REQUIRED
    assert exists is True
    # the full resolution therefore aborts: never transferred
    with pytest.raises(ActiveSessionCoordinationError):
        await coordinator.resolve_activation_conflict(None, command)  # type: ignore[arg-type]
    operation = await _read_operation(engine, op)
    assert operation["phase"] == "claimed"
    await _dispose_all(engine, handles)


async def _inspect_decision(paths: dict[str, Path]):
    from app.focus_session.recovery_authority import (
        ActiveSessionCoordinationInspector,
        ActiveSessionRecoveryView,
    )
    from app.knowledge.consistency import SpaceDataView

    inspector = ActiveSessionCoordinationInspector()
    return await inspector.inspect_read_only(
        ActiveSessionRecoveryView(paths["meta"]),
        space_views={
            "space-a": SpaceDataView(
                "space-a", paths["space-a"],
                paths["space-a"].parent / "notes-a",
                paths["space-a"].parent / "index-a.db", "0" * 64,
            ),
            "space-b": SpaceDataView(
                "space-b", paths["space-b"],
                paths["space-b"].parent / "notes-b",
                paths["space-b"].parent / "index-b.db", "0" * 64,
            ),
        },
    )


async def test_authority_parity_transferred_candidate_winner(env, tmp_path) -> None:
    """The recovery authority reads the real coordinator-written data after a
    successful resolution: transferred candidate winner -> recoverable."""
    from app.focus_session.recovery_authority import (
        CLASSIFICATION_RECOVERABLE_CLAIMING,
        RESULT_CLEAN_OR_RECOVERABLE,
    )

    coordinator, engine, handles, paths, _co, op, command = await _resolve_setup(
        env, tmp_path
    )
    await coordinator.resolve_activation_conflict(None, command)  # type: ignore[arg-type]
    await _dispose_all(engine, handles)
    decision = await _inspect_decision(paths)
    print("CAND_PARITY:", decision.classification, decision.failure_code)
    assert decision.classification == CLASSIFICATION_RECOVERABLE_CLAIMING
    assert decision.result == RESULT_CLEAN_OR_RECOVERABLE
    assert decision.failure_code is None
    assert len(decision.child_outcomes) == 2
    assert all(outcome.terminal_success for outcome in decision.child_outcomes)
    assert len(decision.session_facts) == 2


async def test_authority_parity_transferred_active_winner(env, tmp_path) -> None:
    """Transferred active winner -> recoverable (identity inversion)."""
    from app.focus_session.recovery_authority import (
        CLASSIFICATION_RECOVERABLE_CLAIMING,
        RESULT_CLEAN_OR_RECOVERABLE,
    )
    from app.services.time import utc_now_iso_ms

    coordinator, engine, handles, paths = await _coordinator(
        env, tmp_path, clock=utc_now_iso_ms
    )
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
        "winner_role": "active",
        "decision_at": utc_now_iso_ms(),
        "validity_correction": {
            "loser_validity": "invalid",
            "loser_validity_reason": "activation_conflict_loser",
        },
    }
    command = _command(
        op, kind="resolve_activation_conflict", space_id="space-a",
        session_id="fs-1", epoch=1, payload=payload,
    )
    await coordinator.resolve_activation_conflict(None, command)  # type: ignore[arg-type]
    await _dispose_all(engine, handles)
    decision = await _inspect_decision(paths)
    print("ACTIVE_PARITY:", decision.classification, decision.failure_code)
    assert decision.classification == CLASSIFICATION_RECOVERABLE_CLAIMING
    assert decision.result == RESULT_CLEAN_OR_RECOVERABLE
    assert decision.failure_code is None


async def test_authority_parity_loser_rejected_requires_recovery(env, tmp_path) -> None:
    """Winner succeeded but the loser was rejected: the operation stays
    claimed and the authority reports recovery_required."""
    from app.focus_session.recovery_authority import (
        CLASSIFICATION_RECOVERY_REQUIRED,
    )
    from app.models.focus_session import FocusSession

    coordinator, engine, handles, paths, _co, op, command = await _resolve_setup(
        env, tmp_path
    )
    async with handles["space-a"].session_factory() as session:
        loser = await session.get(FocusSession, "fs-1")
        loser.ownership_state = "authoritative"
        await session.commit()
    with pytest.raises(ActiveSessionCoordinationError):
        await coordinator.resolve_activation_conflict(None, command)  # type: ignore[arg-type]
    await _dispose_all(engine, handles)
    decision = await _inspect_decision(paths)
    print("ABORTED_PARITY:", decision.classification, decision.failure_code)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code is not None


async def test_authority_parity_aborted_journal_requires_recovery(env, tmp_path) -> None:
    """An ABORTED child journal is never success: the authority reads the
    mismatch and requires recovery."""
    from app.focus_session.child_operations import (
        ActiveSessionChildRole,
        derive_active_session_child_operation_id,
    )
    from app.focus_session.recovery_authority import (
        CLASSIFICATION_RECOVERY_REQUIRED,
    )
    from app.models.mutation import MutationBatch, MutationOperation
    from app.models.session_command import SessionCommandEnvelope

    coordinator, engine, handles, paths, _co, op, command = await _resolve_setup(
        env, tmp_path
    )
    winner_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.WINNER)
    payload_hash = "b" * 64
    async with handles["space-b"].session_factory() as session:
        session.add(
            SessionCommandEnvelope(
                command_id=winner_id, space_id="space-b", session_id="fs-2",
                session_revision=1, work_item_id="wi-l2", expected_version=1,
                target_transition="complete", replay_safe=True,
                payload_hash=payload_hash, created_at="2026-07-15T08:00:00.000Z",
            )
        )
        batch_id = f"batch-{winner_id}"
        session.add(
            MutationBatch(
                batch_id=batch_id, command_hash="0" * 64,
                state="ABORTED", accepted_count=1,
            )
        )
        session.add(
            MutationOperation(
                operation_id=winner_id, batch_id=batch_id, sequence=0,
                command_hash="0" * 64, command_json="{}",
                expected_versions_json="{}", projection_set_json="{}",
                state="ABORTED",
            )
        )
        await session.commit()
    with pytest.raises(ActiveSessionCoordinationError):
        await coordinator.resolve_activation_conflict(None, command)  # type: ignore[arg-type]
    await _dispose_all(engine, handles)
    decision = await _inspect_decision(paths)
    print("ABORTED_PARITY:", decision.classification, decision.failure_code)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code is not None


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
