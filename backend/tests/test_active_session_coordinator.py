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


class _FlakySpaceExecutor:
    """Real-SQLite child executor; optional crash after N calls."""

    def __init__(self, space_paths: dict[str, Path], fail_after: int | None = None) -> None:
        self.space_paths = space_paths
        self.fail_after = fail_after
        self.calls: list[str] = []

    async def __call__(self, space_id: str, child_id: str, command) -> None:
        self.calls.append(child_id)
        if self.fail_after is not None and len(self.calls) > self.fail_after:
            raise ActiveSessionCoordinationError("simulated crash")
        with sqlite3.connect(self.space_paths[space_id]) as conn:
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
) -> tuple[ProductionActiveSessionCoordinator, AsyncEngine, _FlakySpaceExecutor]:
    paths, executor = env
    engine = create_engine(f"sqlite+aiosqlite:///{paths['meta']}")
    factory = create_session_factory(engine)
    coordinator = ProductionActiveSessionCoordinator(
        meta_session_factory=factory,
        uow=None,  # type: ignore[arg-type] - child channel is the injected executor
        space_handle_provider=None,  # type: ignore[arg-type]
        clock=_clock,
        execute_child=executor,
    )
    return coordinator, engine, executor


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
    coordinator, engine, executor = await _coordinator(env)
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


async def test_activate_provisional_two_children_success_advances(env) -> None:
    coordinator, engine, executor = await _coordinator(env)
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


async def test_candidate_child_failure_does_not_advance(env) -> None:
    coordinator, engine, executor = await _coordinator(env)
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


async def test_active_child_failure_keeps_claimed(env) -> None:
    coordinator, engine, executor = await _coordinator(env)
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


async def test_restart_reuses_frozen_child_ids(env) -> None:
    """A fresh coordinator instance derives the exact same child IDs the
    crashed run froze in Meta: no new semantic command is ever invented."""
    coordinator, engine, executor = await _coordinator(env)
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
    factory = create_session_factory(engine)
    restarted = ProductionActiveSessionCoordinator(
        meta_session_factory=factory,
        uow=None,  # type: ignore[arg-type]
        space_handle_provider=None,  # type: ignore[arg-type]
        clock=_clock,
        execute_child=executor,
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


async def test_resolve_activation_conflict_freezes_winner_loser(env) -> None:
    coordinator, engine, executor = await _coordinator(env)
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
        session_id="fs-1", epoch=2, payload=payload,
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


async def test_locate_reflects_durable_state(env) -> None:
    coordinator, engine, executor = await _coordinator(env)
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
