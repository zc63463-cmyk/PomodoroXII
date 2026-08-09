"""Tests for the production ActiveSessionCoordinator writer.

The writer is exercised through the real ``ProductionActiveSessionCoordinator``
entry points with a real migrated Meta database.  Space child execution goes
through an injected real-SQLite executor (the production wiring binds the UoW
there); every assertion reads the *persisted* Meta/space rows, never a fake.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path
from types import SimpleNamespace

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


def _seed_session_rows(conn: sqlite3.Connection, session_id: str) -> None:
    """Write the durable Space rows the aggregate response reads back: the
    FocusSession row, the single effective attribution revision and the
    envelope/receipt evidence.  Context/plan/outcome rows are intentionally
    absent (the shared query projects them as None/empty, never fabricated)."""
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


class _FlakySpaceExecutor:
    """Real-SQLite durable child executor; optional crash after N calls.

    Every successful call writes the envelope/receipt *and* the FocusSession
    aggregate rows into the real Space DB, then returns the durable receipt
    state ``succeeded`` — the coordinator only advances an operation on a
    terminal-success receipt, never on a fire-and-forget callback.
    """

    def __init__(self, space_paths: dict[str, Path], fail_after: int | None = None) -> None:
        self.space_paths = space_paths
        self.fail_after = fail_after
        self.calls: list[str] = []

    async def __call__(self, space_id: str, child_id: str, command):
        from app.focus_session.contracts import CommandReceiptState as _State

        self.calls.append(child_id)
        if self.fail_after is not None and len(self.calls) > self.fail_after:
            raise ActiveSessionCoordinationError("simulated crash")
        with sqlite3.connect(self.space_paths[space_id]) as conn:
            _seed_session_rows(conn, str(command.session_id))
            conn.execute(
                "INSERT INTO session_command_envelopes VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    command.command_id, command.space_id, command.session_id, 1,
                    "wi-l2", 1, "complete", 1, command.payload_hash,
                    "2026-07-15T08:00:00.000Z",
                ),
            )
            conn.execute(
                "INSERT INTO session_command_receipts VALUES (?,?,?,?,?,?,?)",
                (command.command_id, "succeeded", None, 0, None, None,
                 "2026-07-15T08:01:00.000Z"),
            )
            conn.commit()
        return _State.SUCCEEDED


class _TestSpaceHandle:
    """Minimal real-engine Space handle (engine + session factory + scope)."""

    def __init__(self, engine, space_id: str) -> None:
        self._engine = engine
        self.scope = SimpleNamespace(space_id=space_id)
        self._session_factory = create_session_factory(engine)
        self.closed = False

    @property
    def session_factory(self):
        return self._session_factory

    async def aclose(self) -> None:
        if not self.closed:
            self.closed = True
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
) -> tuple[dict[str, Path], _FlakySpaceExecutor]:
    meta = tmp_path / "meta.db"
    space_a = tmp_path / "space-a.db"
    space_b = tmp_path / "space-b.db"
    for source, target in (
        (coordinator_template["meta"], meta),
        (coordinator_template["space-a"], space_a),
        (coordinator_template["space-b"], space_b),
    ):
        shutil.copy2(source, target)
    paths = {"meta": meta, "space-a": space_a, "space-b": space_b}
    return paths, _FlakySpaceExecutor({"space-a": space_a, "space-b": space_b})


async def _coordinator(
    env: tuple[dict[str, Path], _FlakySpaceExecutor],
) -> tuple[ProductionActiveSessionCoordinator, AsyncEngine, _FlakySpaceExecutor, dict[str, _TestSpaceHandle]]:
    from app.focus_session.query import FocusSessionQuery

    paths, executor = env
    engine = create_engine(f"sqlite+aiosqlite:///{paths['meta']}")
    factory = create_session_factory(engine)
    handles: dict[str, _TestSpaceHandle] = {}
    for space_id in ("space-a", "space-b"):
        space_engine = create_engine(f"sqlite+aiosqlite:///{paths[space_id]}")
        handles[space_id] = _TestSpaceHandle(space_engine, space_id)

    async def space_handle_provider(space_id: str):
        return handles[space_id]

    coordinator = ProductionActiveSessionCoordinator(
        meta_session_factory=factory,
        uow=None,  # type: ignore[arg-type] - child channel is the injected executor
        space_handle_provider=space_handle_provider,
        session_query=FocusSessionQuery(),
        clock=_clock,
        child_executor=executor,
    )
    return coordinator, engine, executor, handles


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


async def test_activate_provisional_intent_frozen_before_any_child(env) -> None:
    coordinator, engine, executor, handles = await _coordinator(env)
    op = "op-conflict"
    executor.fail_after = 0  # crash before the first child executes
    command = _command(
        op, kind="activate_provisional", space_id="space-a", session_id="fs-1",
        epoch=1, payload=_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
    )
    with pytest.raises(ActiveSessionCoordinationError):
        await coordinator.activate_provisional(None, command)  # type: ignore[arg-type]
    # the candidate child was initiated but crashed before any envelope write
    assert len(executor.calls) == 1
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
    # hashes are canonical over the real business payloads (guards excluded)
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
    await engine.dispose()
    for _handle in handles.values():
        await _handle.aclose()


async def test_activate_provisional_two_children_success_advances(env) -> None:
    coordinator, engine, executor, handles = await _coordinator(env)
    op = "op-conflict"
    command = _command(
        op, kind="activate_provisional", space_id="space-a", session_id="fs-1",
        epoch=1, payload=_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
    )
    await coordinator.activate_provisional(None, command)  # type: ignore[arg-type]
    assert len(executor.calls) == 2
    candidate_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.CANDIDATE)
    active_id = derive_active_session_child_operation_id(op, ActiveSessionChildRole.ACTIVE)
    assert executor.calls == [candidate_id, active_id]  # deterministic order
    operation = await _read_operation(engine, op)
    assert operation["phase"] == "awaiting_resolution"
    await engine.dispose()
    for _handle in handles.values():
        await _handle.aclose()


async def test_candidate_child_failure_does_not_advance(env) -> None:
    coordinator, engine, executor, handles = await _coordinator(env)
    op = "op-conflict"
    executor.fail_after = 0  # candidate child fails
    command = _command(
        op, kind="activate_provisional", space_id="space-a", session_id="fs-1",
        epoch=1, payload=_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
    )
    with pytest.raises(ActiveSessionCoordinationError):
        await coordinator.activate_provisional(None, command)  # type: ignore[arg-type]
    operation = await _read_operation(engine, op)
    assert operation["phase"] == "claimed"  # never advanced
    await engine.dispose()
    for _handle in handles.values():
        await _handle.aclose()


async def test_active_child_failure_keeps_claimed(env) -> None:
    coordinator, engine, executor, handles = await _coordinator(env)
    op = "op-conflict"
    executor.fail_after = 1  # candidate ok, active fails
    command = _command(
        op, kind="activate_provisional", space_id="space-a", session_id="fs-1",
        epoch=1, payload=_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
    )
    with pytest.raises(ActiveSessionCoordinationError):
        await coordinator.activate_provisional(None, command)  # type: ignore[arg-type]
    operation = await _read_operation(engine, op)
    assert operation["phase"] == "claimed"
    # candidate completed, active was initiated but crashed
    assert len(executor.calls) == 2
    await engine.dispose()
    for _handle in handles.values():
        await _handle.aclose()


async def test_restart_reuses_frozen_child_ids(env) -> None:
    """A fresh coordinator instance derives the exact same child IDs the
    crashed run froze in Meta: no new semantic command is ever invented."""
    coordinator, engine, executor, handles = await _coordinator(env)
    op = "op-conflict"
    command = _command(
        op, kind="activate_provisional", space_id="space-a", session_id="fs-1",
        epoch=1, payload=_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
    )
    executor.fail_after = 0
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
    from app.focus_session.query import FocusSessionQuery

    factory = create_session_factory(engine)
    restarted = ProductionActiveSessionCoordinator(
        meta_session_factory=factory,
        uow=None,  # type: ignore[arg-type]
        space_handle_provider=lambda space_id: handles[space_id],
        session_query=FocusSessionQuery(),
        clock=_clock,
        child_executor=executor,
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
    await engine.dispose()
    for _handle in handles.values():
        await _handle.aclose()


async def test_resolve_activation_conflict_freezes_winner_loser(env) -> None:
    coordinator, engine, executor, handles = await _coordinator(env)
    # resolution runs under the claiming locator created by the conflict flow
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
    await coordinator.resolve_activation_conflict(None, command)  # type: ignore[arg-type]
    operation = await _read_operation(engine, op)
    assert operation["kind"] == "resolve_activation_conflict"
    assert operation["phase"] == "transferred"
    intent = json.loads(operation["intent_json"])
    assert intent["children"]["winner"]["operation_id"] == (
        derive_active_session_child_operation_id(op, ActiveSessionChildRole.WINNER)
    )
    assert intent["children"]["loser"]["operation_id"] == (
        derive_active_session_child_operation_id(op, ActiveSessionChildRole.LOSER)
    )
    assert len(executor.calls) == 4  # conflict pair (2) + resolution pair (2)
    # winner runs before loser in the deterministic order
    assert executor.calls[2] == derive_active_session_child_operation_id(
        op, ActiveSessionChildRole.WINNER
    )
    assert executor.calls[3] == derive_active_session_child_operation_id(
        op, ActiveSessionChildRole.LOSER
    )
    await engine.dispose()
    for _handle in handles.values():
        await _handle.aclose()


async def test_locate_reflects_durable_state(env) -> None:
    coordinator, engine, executor, handles = await _coordinator(env)
    assert await coordinator.locate(None) is None  # type: ignore[arg-type]
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
    await engine.dispose()
    for _handle in handles.values():
        await _handle.aclose()


async def test_authority_reads_coordinator_written_intent(env) -> None:
    """Authority parity: the production coordinator's persisted intent and the
    real-SQLite child evidence are read back by the full inspect_read_only
    entry as awaiting_resolution — no hand-written fixture, no private helper."""
    from types import SimpleNamespace

    from app.focus_session.recovery_authority import (
        CLASSIFICATION_AWAITING_RESOLUTION,
        ActiveSessionCoordinationInspector,
    )
    from app.knowledge.consistency import SpaceDataView

    coordinator, engine, executor, handles = await _coordinator(env)
    op = "op-conflict"
    command = _command(
        op, kind="activate_provisional", space_id="space-a", session_id="fs-1",
        epoch=1, payload=_pair_payload(("space-a", "fs-1"), ("space-b", "fs-2")),
    )
    await coordinator.activate_provisional(None, command)  # type: ignore[arg-type]
    assert len(executor.calls) == 2  # candidate + active, both terminal-success

    inspector = ActiveSessionCoordinationInspector()
    meta_view = SimpleNamespace(db_path=str(env[0]["meta"]))
    space_views = {
        "space-a": SpaceDataView(
            "space-a", Path(str(env[0]["space-a"])),
            Path(str(env[0]["space-a"]).replace(".db", "-notes")),
            Path(str(env[0]["space-a"]).replace(".db", "-index.db")), "0" * 64,
        ),
        "space-b": SpaceDataView(
            "space-b", Path(str(env[0]["space-b"])),
            Path(str(env[0]["space-b"]).replace(".db", "-notes")),
            Path(str(env[0]["space-b"]).replace(".db", "-index.db")), "0" * 64,
        ),
    }
    decision = await inspector.inspect_read_only(meta_view, space_views=space_views)
    assert decision.classification == CLASSIFICATION_AWAITING_RESOLUTION
    assert decision.result == "clean_or_recoverable"
    assert len(decision.child_outcomes) == 2
    assert all(outcome.terminal_success for outcome in decision.child_outcomes)

    await engine.dispose()
    for _handle in handles.values():
        await _handle.aclose()
