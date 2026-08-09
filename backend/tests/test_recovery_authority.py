"""Tests for the TS2 ActiveSession recovery authority contract.

Every scenario uses real SQLite databases (``run_migrations``) plus the real
read-only ORM query path exercised by
``app.focus_session.recovery_authority.ActiveSessionCoordinationInspector``.
No inspector is faked and no ``SpaceRuntimeHandle`` is fabricated.  Each
damage scenario asserts: the decision is not clean, the classification is
``recovery_required`` (fail closed), and no exception escaped.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.db.migrations import run_migrations
from app.focus_session.child_operations import (
    ActiveSessionChildRole,
    derive_active_session_child_operation_id,
)
from app.focus_session.commands import focus_business_payload
from app.focus_session.recovery_authority import (
    CLASSIFICATION_ACTIVE_CONSISTENT,
    CLASSIFICATION_AWAITING_RESOLUTION,
    CLASSIFICATION_EMPTY,
    CLASSIFICATION_RECOVERABLE_CLAIMING,
    CLASSIFICATION_RECOVERABLE_RELEASING,
    CLASSIFICATION_RECOVERY_REQUIRED,
    RESULT_CLEAN_OR_RECOVERABLE,
    RESULT_NOT_CLEAN,
    ActiveSessionCoordinationInspector,
    ActiveSessionRecoveryDecision,
    ActiveSessionRecoveryView,
    _readonly_engine,
)
from app.knowledge.consistency import SpaceDataView
from app.mutation.types import bounded_child_operation_id, canonical_payload_hash

NOW = datetime(2026, 8, 1, tzinfo=timezone.utc)

_INTENT_EXCLUDED = frozenset(
    {"command_id", "space_id", "session_id", "ownership_epoch", "payload_hash", "kind",
     "pair", "children"}
)

META_LOCATOR = (
    "INSERT INTO active_session_locator VALUES (?,?,?,?,?,?,?,?,?,?)"
)
META_OPERATION = (
    "INSERT INTO active_session_operations "
    "(operation_id,kind,payload_hash,intent_json,phase,result_descriptor_json,"
    "related_operation_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
)


# --------------------------------------------------------------------------- #
# Row construction helpers
# --------------------------------------------------------------------------- #


def _make_intent(
    *,
    operation_id: str,
    kind: str,
    space_id: str,
    session_id: str,
    epoch: int,
    business: dict[str, object] | None = None,
    pair: dict[str, object] | None = None,
    children: dict[str, str] | None = None,
    winner_role: str | None = None,
) -> dict[str, object]:
    intent: dict[str, object] = {
        "command_id": operation_id,
        "space_id": space_id,
        "session_id": session_id,
        "ownership_epoch": epoch,
        "kind": kind,
        **(dict(business or {})),
    }
    if pair is not None:
        intent["pair"] = pair
    if children is not None:
        intent["children"] = children
    if winner_role is not None:
        intent["winner_role"] = winner_role
    return intent


def _payload_hash_for(intent: dict[str, object]) -> str:
    business = {key: value for key, value in intent.items() if key not in _INTENT_EXCLUDED}
    return canonical_payload_hash(business)


def _insert_locator(
    conn: sqlite3.Connection,
    *,
    space_id: str,
    session_id: str,
    operation_id: str,
    state: str = "active",
    epoch: int = 1,
    lease: str = "2099-01-01T00:00:00.000Z",
    updated_at: str = "2026-07-14T00:00:00.000Z",
) -> None:
    conn.execute(
        META_LOCATOR,
        (
            "active", space_id, session_id, operation_id, state,
            "device-1", "tab-1", epoch, lease, updated_at,
        ),
    )


def _insert_operation(
    conn: sqlite3.Connection,
    *,
    operation_id: str,
    kind: str,
    phase: str,
    intent: dict[str, object],
    related: str | None = None,
    descriptor: str | None = None,
    payload_hash: str | None = None,
    created_at: str = "2026-07-14T00:00:00.000Z",
    updated_at: str = "2026-07-14T00:00:00.000Z",
) -> None:
    full_intent = dict(intent)
    resolved_hash = payload_hash if payload_hash is not None else _payload_hash_for(full_intent)
    # The intent contract carries the persisted payload_hash as an identity key.
    full_intent["payload_hash"] = resolved_hash
    conn.execute(
        META_OPERATION,
        (
            operation_id,
            kind,
            resolved_hash,
            json.dumps(full_intent, sort_keys=True),
            phase,
            descriptor,
            related,
            created_at,
            updated_at,
        ),
    )


def _insert_session(
    conn: sqlite3.Connection,
    *,
    session_id: str,
    space_id: str,
    ended: bool = False,
    ownership_state: str = "authoritative",
    validity: str = "valid",
    validity_reason: str | None = None,
    started_at: str = "2026-07-15T08:00:00.000Z",
) -> None:
    conn.execute(
        "INSERT INTO focus_sessions "
        "(id, created_at, updated_at, version, session_revision, started_at, ended_at,"
        " pause_started_at, planned_seconds, gross_seconds, paused_seconds, break_seconds,"
        " focused_seconds, timer_completion, validity, validity_reason, overall_progress,"
        " mood, session_note, review_state, ownership_state)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            session_id, started_at, started_at, 1, 1, started_at,
            started_at if ended else None, None, 1500, 1500, 0, 0, 1500,
            "completed" if ended else None, validity, validity_reason, None, None, "",
            "not_required", ownership_state,
        ),
    )


def _insert_envelope(
    conn: sqlite3.Connection,
    *,
    command_id: str,
    space_id: str,
    session_id: str,
    payload_hash: str,
    created_at: str = "2026-07-15T08:00:00.000Z",
) -> None:
    conn.execute(
        "INSERT INTO session_command_envelopes VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            command_id, space_id, session_id, 1, "wi-l2", 1, "complete", 1,
            payload_hash, created_at,
        ),
    )


def _insert_receipt(
    conn: sqlite3.Connection,
    *,
    command_id: str,
    state: str,
    updated_at: str = "2026-07-15T08:01:00.000Z",
) -> None:
    conn.execute(
        "INSERT INTO session_command_receipts VALUES (?,?,?,?,?,?,?)",
        (command_id, state, None, 0, None, None, updated_at),
    )


def _insert_attribution(
    conn: sqlite3.Connection, *, session_id: str, project_id: str = "proj-1"
) -> None:
    conn.execute(
        "INSERT INTO session_attribution_revisions "
        "(id, created_at, updated_at, version, session_id, revision, project_id,"
        " level2_work_item_id, reason, corrected_from_revision, effective)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (
            f"attr-{session_id}", "2026-07-15T08:00:00.000Z",
            "2026-07-15T08:00:00.000Z", 1, session_id, 1, project_id,
            "wi-l2", None, None, 1,
        ),
    )


def _pair(active_space: str, active_session: str, candidate_space: str, candidate_session: str) -> dict[str, object]:
    return {
        "active": {"space_id": active_space, "session_id": active_session},
        "candidate": {"space_id": candidate_space, "session_id": candidate_session},
    }


# --------------------------------------------------------------------------- #
# Fixture
# --------------------------------------------------------------------------- #


class Env(SimpleNamespace):
    pass


@pytest.fixture(scope="session")
def authority_db_template(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    """Migrate one meta + two space database template per session.

    Each test copies the template instead of re-running every migration, which
    both speeds the suite up and avoids repeated Windows file-lock churn from
    the pxii VFS migration path.
    """
    root = tmp_path_factory.mktemp("authority-template")
    meta_db = root / "meta.db"
    space_a = root / "space-a.db"
    space_b = root / "space-b.db"
    run_migrations("meta", meta_db)
    run_migrations("space", space_a)
    run_migrations("space", space_b)
    return {"meta": meta_db, "space-a": space_a, "space-b": space_b}


@pytest.fixture
def env(
    tmp_path: Path, authority_db_template: dict[str, Path]
) -> Env:
    import shutil

    meta_db = tmp_path / "meta.db"
    space_a = tmp_path / "space-a.db"
    space_b = tmp_path / "space-b.db"
    for source, target in (
        (authority_db_template["meta"], meta_db),
        (authority_db_template["space-a"], space_a),
        (authority_db_template["space-b"], space_b),
    ):
        shutil.copy2(source, target)
    views = {
        "space-a": SpaceDataView(
            "space-a", space_a, tmp_path / "notes-a", tmp_path / "index-a.db", "0" * 64
        ),
        "space-b": SpaceDataView(
            "space-b", space_b, tmp_path / "notes-b", tmp_path / "index-b.db", "0" * 64
        ),
    }
    return Env(
        meta_db=meta_db,
        spaces={"space-a": space_a, "space-b": space_b},
        views=views,
    )


async def _inspect(
    env: Env,
    *,
    space_views: dict[str, SpaceDataView] | None = None,
    now: datetime = NOW,
) -> ActiveSessionRecoveryDecision:
    inspector = ActiveSessionCoordinationInspector(now=now)
    return await inspector.inspect_read_only(
        ActiveSessionRecoveryView(env.meta_db),
        space_views=space_views if space_views is not None else env.views,
    )


# --------------------------------------------------------------------------- #
# Proven (clean/recoverable) paths
# --------------------------------------------------------------------------- #


async def test_empty_clean(env: Env) -> None:
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_EMPTY
    assert decision.result == RESULT_CLEAN_OR_RECOVERABLE
    assert decision.failure_code is None
    assert decision.locator is None and decision.operation is None


async def test_active_completed_matching_nonterminal_session(env: Env) -> None:
    op = "op-active"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op)
        _insert_operation(conn, operation_id=op, kind="start", phase="completed", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_ACTIVE_CONSISTENT
    assert decision.result == RESULT_CLEAN_OR_RECOVERABLE
    assert decision.failure_code is None
    assert decision.locator.session_id == "fs-1"
    assert decision.operation.kind == "start"
    assert len(decision.session_facts) == 1
    assert decision.session_facts[0].ended is False


async def test_active_completed_with_ended_session_fails_closed(env: Env) -> None:
    op = "op-active"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op)
        _insert_operation(conn, operation_id=op, kind="start", phase="completed", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=True)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.result == RESULT_NOT_CLEAN
    assert decision.failure_code == "session_unexpected_terminal"


async def test_active_completed_missing_session_fails_closed(env: Env) -> None:
    op = "op-active"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op)
        _insert_operation(conn, operation_id=op, kind="start", phase="completed", intent=intent)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "session_missing"


async def test_claiming_claimed_start_child_success_recoverable(env: Env) -> None:
    op = "op-claim"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op, state="claiming")
        _insert_operation(conn, operation_id=op, kind="start", phase="claimed", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
        _insert_envelope(conn, command_id=op, space_id="space-a", session_id="fs-1",
                         payload_hash=_payload_hash_for(intent))
        _insert_receipt(conn, command_id=op, state="succeeded")
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERABLE_CLAIMING
    assert decision.result == RESULT_CLEAN_OR_RECOVERABLE
    assert len(decision.child_outcomes) == 1
    assert decision.child_outcomes[0].role == "original"
    assert decision.child_outcomes[0].terminal_success


async def test_claiming_claimed_end_child_success_ended_recoverable(env: Env) -> None:
    op = "op-end"
    intent = _make_intent(
        operation_id=op, kind="end", space_id="space-a", session_id="fs-1",
        epoch=1, business={"occurred_at": "2026-07-15T08:25:00.000Z",
                           "timer_completion": "completed", "validity": "valid",
                           "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op, state="claiming")
        _insert_operation(conn, operation_id=op, kind="end", phase="claimed", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=True)
        _insert_envelope(conn, command_id=op, space_id="space-a", session_id="fs-1",
                         payload_hash=_payload_hash_for(intent))
        _insert_receipt(conn, command_id=op, state="succeeded")
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERABLE_RELEASING
    assert decision.result == RESULT_CLEAN_OR_RECOVERABLE
    assert decision.session_facts[0].ended is True


async def test_releasing_space_committed_ended_recoverable(env: Env) -> None:
    op = "op-release"
    intent = _make_intent(
        operation_id=op, kind="end", space_id="space-a", session_id="fs-1",
        epoch=1, business={"occurred_at": "2026-07-15T08:25:00.000Z",
                           "timer_completion": "completed", "validity": "valid",
                           "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op, state="releasing")
        _insert_operation(conn, operation_id=op, kind="end", phase="space_committed", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=True)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERABLE_RELEASING
    assert decision.result == RESULT_CLEAN_OR_RECOVERABLE
    assert decision.session_facts[0].ended is True


async def test_releasing_space_committed_nonterminal_fails_closed(env: Env) -> None:
    op = "op-release"
    intent = _make_intent(
        operation_id=op, kind="end", space_id="space-a", session_id="fs-1",
        epoch=1, business={"occurred_at": "2026-07-15T08:25:00.000Z",
                           "timer_completion": "completed", "validity": "valid",
                           "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op, state="releasing")
        _insert_operation(conn, operation_id=op, kind="end", phase="space_committed", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "session_unexpected_nonterminal"


async def _install_conflict_pair(
    env: Env,
    *,
    phase: str,
    operation_id: str = "op-conflict",
    active_space: str = "space-a",
    active_session: str = "fs-1",
    candidate_space: str = "space-b",
    candidate_session: str = "fs-2",
    candidate_state: str = "succeeded",
    active_state: str = "succeeded",
    pair_override: dict[str, object] | None = None,
) -> dict[str, object]:
    pair = pair_override or _pair(active_space, active_session, candidate_space, candidate_session)
    candidate_child = derive_active_session_child_operation_id(
        operation_id, ActiveSessionChildRole.CANDIDATE
    )
    active_child = derive_active_session_child_operation_id(
        operation_id, ActiveSessionChildRole.ACTIVE
    )
    candidate_payload = {
        "decision": "preserve", "expected_ownership_epoch": 1,
        "space_id": candidate_space, "session_id": candidate_session,
    }
    active_payload = {
        "decision": "preserve", "expected_ownership_epoch": 1,
        "space_id": active_space, "session_id": active_session,
    }
    candidate_hash = canonical_payload_hash(
        focus_business_payload("mark_activation_conflict", candidate_payload)
    )
    active_hash = canonical_payload_hash(
        focus_business_payload("mark_activation_conflict", active_payload)
    )
    children = {
        "candidate": {"operation_id": candidate_child, "payload_hash": candidate_hash},
        "active": {"operation_id": active_child, "payload_hash": active_hash},
    }
    intent = _make_intent(
        operation_id=operation_id, kind="activate_provisional",
        space_id=active_space, session_id=active_session, epoch=1,
        business={"cached_at": "2026-07-15T07:59:00.000Z"},
        pair=pair, children=children,
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id=active_space, session_id=active_session,
                        operation_id=operation_id, state="claiming")
        _insert_operation(conn, operation_id=operation_id, kind="activate_provisional",
                          phase=phase, intent=intent)
    with sqlite3.connect(env.spaces[active_space]) as conn:
        _insert_session(conn, session_id=active_session, space_id=active_space,
                        ended=False, ownership_state="activation_conflict")
        _insert_envelope(conn, command_id=active_child, space_id=active_space,
                         session_id=active_session, payload_hash=active_hash)
        _insert_receipt(conn, command_id=active_child, state=active_state)
    with sqlite3.connect(env.spaces[candidate_space]) as conn:
        _insert_session(conn, session_id=candidate_session, space_id=candidate_space,
                        ended=False, ownership_state="activation_conflict")
        _insert_envelope(conn, command_id=candidate_child, space_id=candidate_space,
                         session_id=candidate_session, payload_hash=candidate_hash)
        _insert_receipt(conn, command_id=candidate_child, state=candidate_state)
    return intent


async def test_claiming_awaiting_resolution_valid_pair(env: Env) -> None:
    await _install_conflict_pair(env, phase="awaiting_resolution")
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_AWAITING_RESOLUTION
    assert decision.result == RESULT_CLEAN_OR_RECOVERABLE
    assert decision.failure_code is None
async def test_claiming_claimed_conflict_children_all_success(env: Env) -> None:
    await _install_conflict_pair(env, phase="claimed")
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_AWAITING_RESOLUTION
    assert decision.result == RESULT_CLEAN_OR_RECOVERABLE
    assert decision.failure_code is None
async def test_claiming_transferred_resolution_children_success(env: Env) -> None:
    op = "op-resolve"
    pair = _pair("space-a", "fs-1", "space-b", "fs-2")
    winner_child = derive_active_session_child_operation_id(op, ActiveSessionChildRole.WINNER)
    loser_child = derive_active_session_child_operation_id(op, ActiveSessionChildRole.LOSER)
    winner_hash = canonical_payload_hash({"role": "winner", "command_id": winner_child})
    loser_hash = canonical_payload_hash({"role": "loser", "command_id": loser_child})
    children = {
        "winner": {"operation_id": winner_child, "payload_hash": winner_hash},
        "loser": {"operation_id": loser_child, "payload_hash": loser_hash},
    }
    intent = _make_intent(
        operation_id=op, kind="resolve_activation_conflict",
        space_id="space-a", session_id="fs-1", epoch=2,
        business={"decision_at": "2026-07-15T09:00:00.000Z"},
        pair=pair, children=children, winner_role="candidate",
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1",
                        operation_id=op, state="claiming", epoch=2)
        _insert_operation(conn, operation_id=op, kind="resolve_activation_conflict",
                          phase="transferred", intent=intent)
    # winner = candidate (space-b/fs-2, authoritative, still running);
    # loser = active (space-a/fs-1, ended interrupted and marked invalid).
    with sqlite3.connect(env.spaces["space-b"]) as conn:
        _insert_session(conn, session_id="fs-2", space_id="space-b", ended=False)
        _insert_envelope(conn, command_id=winner_child, space_id="space-b",
                         session_id="fs-2", payload_hash=winner_hash)
        _insert_receipt(conn, command_id=winner_child, state="succeeded")
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=True,
                        ownership_state="activation_conflict", validity="invalid",
                        validity_reason="activation_conflict_loser")
        _insert_envelope(conn, command_id=loser_child, space_id="space-a",
                         session_id="fs-1", payload_hash=loser_hash)
        _insert_receipt(conn, command_id=loser_child, state="succeeded")
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERABLE_CLAIMING
    assert decision.result == RESULT_CLEAN_OR_RECOVERABLE
    assert decision.failure_code is None
    assert len(decision.child_outcomes) == 2
    assert all(outcome.terminal_success for outcome in decision.child_outcomes)
    assert len(decision.session_facts) == 2
# --------------------------------------------------------------------------- #
# Damage cases (all must fail closed without exceptions)
# --------------------------------------------------------------------------- #


async def test_missing_operation_fails_closed(env: Env) -> None:
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id="op-gone")
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "operation_missing"


async def test_intent_hash_mismatch_fails_closed(env: Env) -> None:
    op = "op-badhash"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op)
        _insert_operation(conn, operation_id=op, kind="start", phase="completed",
                          intent=intent, payload_hash="1" * 64)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "intent_invalid"


async def test_malformed_intent_json_fails_closed(env: Env) -> None:
    op = "op-badintent"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op)
        conn.execute(
            META_OPERATION,
            (op, "start", _payload_hash_for(intent), "not-json{", "completed",
             None, None, "2026-07-14T00:00:00.000Z", "2026-07-14T00:00:00.000Z"),
        )
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "intent_invalid"


async def test_unknown_child_fails_closed(env: Env) -> None:
    op = "op-unknown"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op, state="claiming")
        _insert_operation(conn, operation_id=op, kind="start", phase="claimed", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
        _insert_envelope(conn, command_id=op, space_id="space-a", session_id="fs-1",
                         payload_hash=_payload_hash_for(intent))
        _insert_receipt(conn, command_id=op, state="unknown")
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "child_unknown"
    assert decision.child_outcomes[0].unknown is True


async def test_pending_child_fails_closed(env: Env) -> None:
    op = "op-pending"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op, state="claiming")
        _insert_operation(conn, operation_id=op, kind="start", phase="claimed", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
        _insert_envelope(conn, command_id=op, space_id="space-a", session_id="fs-1",
                         payload_hash=_payload_hash_for(intent))
        _insert_receipt(conn, command_id=op, state="pending")
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "child_pending"


async def test_terminal_rejected_child_fails_closed(env: Env) -> None:
    op = "op-rejected"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op, state="claiming")
        _insert_operation(conn, operation_id=op, kind="start", phase="claimed", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
        _insert_envelope(conn, command_id=op, space_id="space-a", session_id="fs-1",
                         payload_hash=_payload_hash_for(intent))
        _insert_receipt(conn, command_id=op, state="failed")
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "child_rejected"
    assert decision.child_outcomes[0].terminal_rejected is True


async def test_missing_child_envelope_fails_closed(env: Env) -> None:
    op = "op-noreceipt"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op, state="claiming")
        _insert_operation(conn, operation_id=op, kind="start", phase="claimed", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "child_missing"


async def test_child_space_mismatch_fails_closed(env: Env) -> None:
    op = "op-space"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op, state="claiming")
        _insert_operation(conn, operation_id=op, kind="start", phase="claimed", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
        # envelope claims a different space
        _insert_envelope(conn, command_id=op, space_id="space-b", session_id="fs-1",
                         payload_hash=_payload_hash_for(intent))
        _insert_receipt(conn, command_id=op, state="succeeded")
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "child_identity_mismatch"


async def test_child_session_mismatch_fails_closed(env: Env) -> None:
    op = "op-session"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op, state="claiming")
        _insert_operation(conn, operation_id=op, kind="start", phase="claimed", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
        # envelope claims a different session
        _insert_envelope(conn, command_id=op, space_id="space-a", session_id="fs-other",
                         payload_hash=_payload_hash_for(intent))
        _insert_receipt(conn, command_id=op, state="succeeded")
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "child_identity_mismatch"


async def test_conflict_bad_pair_fails_closed(env: Env) -> None:
    # locator anchors fs-1 but the pair marks fs-9 as the active identity.
    pair_override = _pair("space-a", "fs-9", "space-b", "fs-2")
    await _install_conflict_pair(
        env, phase="awaiting_resolution", pair_override=pair_override
    )
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "conflict_pair_invalid"


async def test_conflict_pair_missing_fails_closed(env: Env) -> None:
    op = "op-nopair"
    children = {
        "candidate": derive_active_session_child_operation_id(op, ActiveSessionChildRole.CANDIDATE),
        "active": derive_active_session_child_operation_id(op, ActiveSessionChildRole.ACTIVE),
    }
    intent = _make_intent(
        operation_id=op, kind="activate_provisional",
        space_id="space-a", session_id="fs-1",
        epoch=1, business={"cached_at": "2026-07-15T07:59:00.000Z"},
        children=children,
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1",
                        operation_id=op, state="claiming")
        _insert_operation(conn, operation_id=op, kind="activate_provisional",
                          phase="awaiting_resolution", intent=intent)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "conflict_pair_missing"


async def test_conflict_child_not_all_success_fails_closed(env: Env) -> None:
    await _install_conflict_pair(env, phase="claimed", candidate_state="failed")
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.result == RESULT_NOT_CLEAN
    assert decision.failure_code == "child_rejected"
async def test_takeover_claim_without_children_declaration_fails_closed(env: Env) -> None:
    op = "op-takeover"
    intent = _make_intent(
        operation_id=op, kind="takeover", space_id="space-a", session_id="fs-1",
        epoch=2, business={"new_owner_device_id": "device-2", "new_owner_tab_id": "tab-2"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1",
                        operation_id=op, state="claiming", epoch=2)
        _insert_operation(conn, operation_id=op, kind="takeover", phase="claimed", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "unproven_combination"


async def test_active_lease_expired_fails_closed(env: Env) -> None:
    op = "op-active"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op,
                        lease="2026-07-01T00:00:00.000Z")
        _insert_operation(conn, operation_id=op, kind="start", phase="completed", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "lease_expired"


async def test_duplicate_conflicting_child_fails_closed(env: Env) -> None:
    op = "op-dupe"
    shared = derive_active_session_child_operation_id(op, ActiveSessionChildRole.CANDIDATE)
    shared_hash = canonical_payload_hash({"role": "candidate", "command_id": shared})
    pair = _pair("space-a", "fs-1", "space-b", "fs-2")
    intent = _make_intent(
        operation_id=op, kind="activate_provisional",
        space_id="space-a", session_id="fs-1", epoch=1,
        business={"cached_at": "2026-07-15T07:59:00.000Z"},
        pair=pair,
        children={
            "candidate": {"operation_id": shared, "payload_hash": shared_hash},
            "active": {"operation_id": shared, "payload_hash": shared_hash},
        },
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1",
                        operation_id=op, state="claiming")
        _insert_operation(conn, operation_id=op, kind="activate_provisional",
                          phase="claimed", intent=intent)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.result == RESULT_NOT_CLEAN
    assert decision.failure_code == "children_declaration_conflict"
async def test_relation_self_cycle_fails_closed(env: Env) -> None:
    op = "op-cycle"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op)
        _insert_operation(conn, operation_id=op, kind="start", phase="completed",
                          intent=intent, related=op)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "relation_cycle"


async def test_missing_related_operation_fails_closed(env: Env) -> None:
    op = "op-parent"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op)
        _insert_operation(conn, operation_id=op, kind="start", phase="completed",
                          intent=intent, related="op-ghost")
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "relation_missing"


async def test_malformed_locator_timestamp_fails_closed(env: Env) -> None:
    with sqlite3.connect(env.meta_db) as conn:
        conn.execute(
            META_LOCATOR,
            ("active", "space-a", "fs-1", "op-1", "active", "device-1", "tab-1", 1,
             "not-a-timestamp", "2026-07-14T00:00:00.000Z"),
        )
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "invalid_locator"


async def test_malformed_descriptor_fails_closed(env: Env) -> None:
    op = "op-descriptor"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op)
        _insert_operation(conn, operation_id=op, kind="start", phase="completed",
                          intent=intent, descriptor="not-a-json-object")
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "invalid_operation"


async def test_missing_locator_table_fails_closed(env: Env) -> None:
    with sqlite3.connect(env.meta_db) as conn:
        conn.execute("DROP TABLE active_session_locator")
        conn.commit()
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "missing_coordination_schema"


async def test_missing_operation_column_fails_closed(env: Env) -> None:
    with sqlite3.connect(env.meta_db) as conn:
        conn.execute("ALTER TABLE active_session_operations DROP COLUMN intent_json")
        conn.commit()
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "missing_coordination_schema"


async def test_multiple_locators_fails_closed(env: Env) -> None:
    with sqlite3.connect(env.meta_db) as conn:
        # bypass the singleton CHECK constraint by rebuilding the table
        conn.execute("DROP TABLE active_session_locator")
        conn.execute(
            "CREATE TABLE active_session_locator ("
            "singleton_key VARCHAR(16) NOT NULL, space_id VARCHAR(36) NOT NULL,"
            "session_id VARCHAR(36) NOT NULL, operation_id VARCHAR(128) NOT NULL,"
            "state VARCHAR(20) NOT NULL, owner_device_id VARCHAR(64) NOT NULL,"
            "owner_tab_id VARCHAR(64) NOT NULL, ownership_epoch INTEGER NOT NULL,"
            "lease_expires_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL)"
        )
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id="op-1")
        _insert_locator(conn, space_id="space-b", session_id="fs-2", operation_id="op-2")
        conn.commit()
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "multiple_locators"


async def test_state_phase_inconsistent_fails_closed(env: Env) -> None:
    op = "op-bad"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op)
        _insert_operation(conn, operation_id=op, kind="start", phase="claimed", intent=intent)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "state_phase_inconsistent"


async def test_manual_intervention_fails_closed(env: Env) -> None:
    op = "op-manual"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op)
        _insert_operation(conn, operation_id=op, kind="start", phase="manual_intervention", intent=intent)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "manual_intervention"


async def test_invalid_locator_epoch_fails_closed(env: Env) -> None:
    with sqlite3.connect(env.meta_db) as conn:
        # Rebuild the locator table without the positive-epoch CHECK so the
        # authority (not the database) must reject the nonpositive epoch.
        conn.execute("DROP TABLE active_session_locator")
        conn.execute(
            "CREATE TABLE active_session_locator ("
            "singleton_key VARCHAR(16) NOT NULL, space_id VARCHAR(36) NOT NULL,"
            "session_id VARCHAR(36) NOT NULL, operation_id VARCHAR(128) NOT NULL,"
            "state VARCHAR(20) NOT NULL, owner_device_id VARCHAR(64) NOT NULL,"
            "owner_tab_id VARCHAR(64) NOT NULL, ownership_epoch INTEGER NOT NULL,"
            "lease_expires_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL)"
        )
        conn.execute(
            META_LOCATOR,
            ("active", "space-a", "fs-1", "op-1", "active", "device-1", "tab-1", 0,
             "2099-01-01T00:00:00.000Z", "2026-07-14T00:00:00.000Z"),
        )
        conn.commit()
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "invalid_locator"


async def test_active_without_space_view_fails_closed(env: Env) -> None:
    op = "op-active"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op)
        _insert_operation(conn, operation_id=op, kind="start", phase="completed", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
    decision = await _inspect(env, space_views={})
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "space_view_missing"


async def test_resolution_rejected_child_fails_closed(env: Env) -> None:
    op = "op-resolve-rejected"
    pair = _pair("space-a", "fs-1", "space-b", "fs-2")
    winner_child = derive_active_session_child_operation_id(op, ActiveSessionChildRole.WINNER)
    loser_child = derive_active_session_child_operation_id(op, ActiveSessionChildRole.LOSER)
    winner_hash = canonical_payload_hash({"role": "winner", "command_id": winner_child})
    loser_hash = canonical_payload_hash({"role": "loser", "command_id": loser_child})
    children = {
        "winner": {"operation_id": winner_child, "payload_hash": winner_hash},
        "loser": {"operation_id": loser_child, "payload_hash": loser_hash},
    }
    intent = _make_intent(
        operation_id=op, kind="resolve_activation_conflict",
        space_id="space-a", session_id="fs-1", epoch=2,
        business={"decision_at": "2026-07-15T09:00:00.000Z"},
        pair=pair, children=children, winner_role="candidate",
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1",
                        operation_id=op, state="claiming", epoch=2)
        _insert_operation(conn, operation_id=op, kind="resolve_activation_conflict",
                          phase="transferred", intent=intent)
    with sqlite3.connect(env.spaces["space-b"]) as conn:
        _insert_session(conn, session_id="fs-2", space_id="space-b", ended=False)
        _insert_envelope(conn, command_id=winner_child, space_id="space-b",
                         session_id="fs-2", payload_hash=winner_hash)
        _insert_receipt(conn, command_id=winner_child, state="conflict")
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=True)
        _insert_envelope(conn, command_id=loser_child, space_id="space-a",
                         session_id="fs-1", payload_hash=loser_hash)
        _insert_receipt(conn, command_id=loser_child, state="succeeded")
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.result == RESULT_NOT_CLEAN
    assert decision.failure_code == "child_rejected"
# --------------------------------------------------------------------------- #
# Cross-cutting guarantees
# --------------------------------------------------------------------------- #


async def test_read_only_enforcement(env: Env) -> None:
    engine = _readonly_engine(env.meta_db)
    from sqlalchemy import text

    async with engine.connect() as connection:
        with pytest.raises(Exception):
            await connection.execute(text("INSERT INTO meta_settings (id, key, value) VALUES ('x','x','x')"))
            await connection.commit()
    await engine.dispose()


async def test_decision_serialization_is_deterministic(env: Env) -> None:
    op = "op-active"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op)
        _insert_operation(conn, operation_id=op, kind="start", phase="completed", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
    first = await _inspect(env)
    second = await _inspect(env)
    assert first.to_canonical_json() == second.to_canonical_json()
    decoded = json.loads(first.to_canonical_json())
    assert decoded["classification"] == CLASSIFICATION_ACTIVE_CONSISTENT
    assert decoded["result"] == RESULT_CLEAN_OR_RECOVERABLE
    assert decoded["locator"]["session_id"] == "fs-1"
    assert decoded["failure_code"] is None


async def test_no_connection_leak(env: Env, monkeypatch) -> None:
    from app.focus_session import recovery_authority as module

    opened: list = []
    original_readonly_engine = module._readonly_engine

    def tracking_engine(path):
        engine = original_readonly_engine(path)
        opened.append(engine)
        return engine

    monkeypatch.setattr(module, "_readonly_engine", tracking_engine)
    op = "op-active"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op)
        _insert_operation(conn, operation_id=op, kind="start", phase="completed", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
    await _inspect(env)
    assert opened, "expected at least one readonly engine"
    for engine in opened:
        assert engine.pool.checkedout() == 0
    # all engines must be disposed (no outstanding connections)


async def test_focus_session_query_loads_from_readonly_copy(env: Env) -> None:
    from app.db.session import create_engine, create_session_factory
    from app.focus_session.query import FocusSessionQuery

    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
        _insert_attribution(conn, session_id="fs-1")
    engine = create_engine(
        f"sqlite+aiosqlite:///file:{env.spaces['space-a'].resolve().as_posix()}?mode=ro&uri=true"
    )
    scope = SimpleNamespace(
        scope=SimpleNamespace(space_id="space-a"),
        session_factory=create_session_factory(engine),
    )
    loaded = await FocusSessionQuery().load(scope, "fs-1")
    assert loaded["session"]["id"] == "fs-1"
    assert loaded["session"]["spaceId"] == "space-a"
    await engine.dispose()

# --------------------------------------------------------------------------- #
# Review round 2: awaiting_resolution child evidence matrix (problem 1)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "candidate_state,active_state,expected_code",
    (
        ("failed", "succeeded", "child_rejected"),
        ("conflict", "succeeded", "child_rejected"),
        ("succeeded", "failed", "child_rejected"),
        ("unknown", "succeeded", "child_unknown"),
        ("succeeded", "pending", "child_pending"),
        ("pending", "succeeded", "child_pending"),
    ),
)
async def test_awaiting_resolution_child_outcome_fails_closed(
    env: Env, candidate_state: str, active_state: str, expected_code: str
) -> None:
    await _install_conflict_pair(
        env, phase="awaiting_resolution",
        candidate_state=candidate_state, active_state=active_state,
    )
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.result == RESULT_NOT_CLEAN
    assert decision.failure_code == expected_code
async def test_awaiting_resolution_missing_child_receipt_fails_closed(env: Env) -> None:
    op = "op-noreceipt"
    pair = _pair("space-a", "fs-1", "space-b", "fs-2")
    candidate_child = derive_active_session_child_operation_id(op, ActiveSessionChildRole.CANDIDATE)
    active_child = derive_active_session_child_operation_id(op, ActiveSessionChildRole.ACTIVE)
    candidate_hash = canonical_payload_hash({"role": "candidate", "command_id": candidate_child})
    active_hash = canonical_payload_hash({"role": "active", "command_id": active_child})
    children = {
        "candidate": {"operation_id": candidate_child, "payload_hash": candidate_hash},
        "active": {"operation_id": active_child, "payload_hash": active_hash},
    }
    intent = _make_intent(
        operation_id=op, kind="activate_provisional",
        space_id="space-a", session_id="fs-1", epoch=1,
        business={"cached_at": "2026-07-15T07:59:00.000Z"},
        pair=pair, children=children,
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1",
                        operation_id=op, state="claiming")
        _insert_operation(conn, operation_id=op, kind="activate_provisional",
                          phase="awaiting_resolution", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a",
                        ended=False, ownership_state="activation_conflict")
        _insert_envelope(conn, command_id=active_child, space_id="space-a",
                         session_id="fs-1", payload_hash=active_hash)
        _insert_receipt(conn, command_id=active_child, state="succeeded")
    with sqlite3.connect(env.spaces["space-b"]) as conn:
        _insert_session(conn, session_id="fs-2", space_id="space-b",
                        ended=False, ownership_state="activation_conflict")
        _insert_envelope(conn, command_id=candidate_child, space_id="space-b",
                         session_id="fs-2", payload_hash=candidate_hash)
        # no receipt for the candidate child
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.result == RESULT_NOT_CLEAN
    assert decision.failure_code == "child_missing"
async def test_awaiting_resolution_missing_child_envelope_fails_closed(env: Env) -> None:
    op = "op-noenvelope"
    pair = _pair("space-a", "fs-1", "space-b", "fs-2")
    candidate_child = derive_active_session_child_operation_id(op, ActiveSessionChildRole.CANDIDATE)
    active_child = derive_active_session_child_operation_id(op, ActiveSessionChildRole.ACTIVE)
    candidate_hash = canonical_payload_hash({"role": "candidate", "command_id": candidate_child})
    active_hash = canonical_payload_hash({"role": "active", "command_id": active_child})
    children = {
        "candidate": {"operation_id": candidate_child, "payload_hash": candidate_hash},
        "active": {"operation_id": active_child, "payload_hash": active_hash},
    }
    intent = _make_intent(
        operation_id=op, kind="activate_provisional",
        space_id="space-a", session_id="fs-1", epoch=1,
        business={"cached_at": "2026-07-15T07:59:00.000Z"},
        pair=pair, children=children,
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1",
                        operation_id=op, state="claiming")
        _insert_operation(conn, operation_id=op, kind="activate_provisional",
                          phase="awaiting_resolution", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a",
                        ended=False, ownership_state="activation_conflict")
        _insert_envelope(conn, command_id=active_child, space_id="space-a",
                         session_id="fs-1", payload_hash=active_hash)
        _insert_receipt(conn, command_id=active_child, state="succeeded")
    with sqlite3.connect(env.spaces["space-b"]) as conn:
        _insert_session(conn, session_id="fs-2", space_id="space-b",
                        ended=False, ownership_state="activation_conflict")
        # no envelope at all for the candidate child
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.result == RESULT_NOT_CLEAN
    assert decision.failure_code == "child_missing"
# --------------------------------------------------------------------------- #
# Review round 2: transferred winner/loser matrix (problem 2)
# --------------------------------------------------------------------------- #


async def _install_resolution(
    env: Env,
    *,
    winner_role: str = "candidate",
    winner_kwargs: dict[str, object] | None = None,
    loser_kwargs: dict[str, object] | None = None,
) -> dict[str, object]:
    op = "op-resolve"
    pair = _pair("space-a", "fs-1", "space-b", "fs-2")
    winner_child = derive_active_session_child_operation_id(op, ActiveSessionChildRole.WINNER)
    loser_child = derive_active_session_child_operation_id(op, ActiveSessionChildRole.LOSER)
    winner_hash = canonical_payload_hash({"role": "winner", "command_id": winner_child})
    loser_hash = canonical_payload_hash({"role": "loser", "command_id": loser_child})
    children = {
        "winner": {"operation_id": winner_child, "payload_hash": winner_hash},
        "loser": {"operation_id": loser_child, "payload_hash": loser_hash},
    }
    intent = _make_intent(
        operation_id=op, kind="resolve_activation_conflict",
        space_id="space-a", session_id="fs-1", epoch=2,
        business={"decision_at": "2026-07-15T09:00:00.000Z"},
        pair=pair, children=children, winner_role=winner_role,
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1",
                        operation_id=op, state="claiming", epoch=2)
        _insert_operation(conn, operation_id=op, kind="resolve_activation_conflict",
                          phase="transferred", intent=intent)
    if winner_role == "candidate":
        winner_space, winner_session = "space-b", "fs-2"
        loser_space, loser_session = "space-a", "fs-1"
    else:
        winner_space, winner_session = "space-a", "fs-1"
        loser_space, loser_session = "space-b", "fs-2"
    wkwargs = dict(winner_kwargs or {})
    lkwargs = dict(loser_kwargs or {})
    with sqlite3.connect(env.spaces[winner_space]) as conn:
        if not wkwargs.pop("missing", False):
            _insert_session(conn, session_id=winner_session, space_id=winner_space, **wkwargs)
        _insert_envelope(conn, command_id=winner_child, space_id=winner_space,
                         session_id=winner_session, payload_hash=winner_hash)
        _insert_receipt(conn, command_id=winner_child, state="succeeded")
    with sqlite3.connect(env.spaces[loser_space]) as conn:
        if not lkwargs.pop("missing", False):
            _insert_session(conn, session_id=loser_session, space_id=loser_space, **lkwargs)
        _insert_envelope(conn, command_id=loser_child, space_id=loser_space,
                         session_id=loser_session, payload_hash=loser_hash)
        _insert_receipt(conn, command_id=loser_child, state="succeeded")
    return intent


def _resolution_loser_kwargs() -> dict[str, object]:
    return {
        "ended": True,
        "ownership_state": "activation_conflict",
        "validity": "invalid",
        "validity_reason": "activation_conflict_loser",
    }


async def test_transferred_candidate_winner_clean(env: Env) -> None:
    await _install_resolution(
        env, winner_role="candidate",
        winner_kwargs={"ended": False},
        loser_kwargs=_resolution_loser_kwargs(),
    )
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERABLE_CLAIMING
    assert decision.result == RESULT_CLEAN_OR_RECOVERABLE
    assert decision.failure_code is None
    assert len(decision.child_outcomes) == 2
    assert all(outcome.terminal_success for outcome in decision.child_outcomes)
    assert len(decision.session_facts) == 2
async def test_transferred_active_winner_clean(env: Env) -> None:
    await _install_resolution(
        env, winner_role="active",
        winner_kwargs={"ended": False},
        loser_kwargs=_resolution_loser_kwargs(),
    )
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERABLE_CLAIMING
    assert decision.result == RESULT_CLEAN_OR_RECOVERABLE
    assert decision.failure_code is None
    assert len(decision.child_outcomes) == 2
    assert all(outcome.terminal_success for outcome in decision.child_outcomes)
    assert len(decision.session_facts) == 2
async def test_transferred_winner_missing_fails_closed(env: Env) -> None:
    await _install_resolution(
        env, winner_role="candidate",
        winner_kwargs={"missing": True},
        loser_kwargs=_resolution_loser_kwargs(),
    )
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.result == RESULT_NOT_CLEAN
    assert decision.failure_code == "session_missing"
async def test_transferred_winner_ended_fails_closed(env: Env) -> None:
    await _install_resolution(
        env, winner_role="candidate",
        winner_kwargs={"ended": True},
        loser_kwargs=_resolution_loser_kwargs(),
    )
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.result == RESULT_NOT_CLEAN
    assert decision.failure_code == "session_unexpected_terminal"
async def test_transferred_winner_ownership_invalid_fails_closed(env: Env) -> None:
    await _install_resolution(
        env, winner_role="candidate",
        winner_kwargs={"ended": False, "ownership_state": "activation_conflict"},
        loser_kwargs=_resolution_loser_kwargs(),
    )
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.result == RESULT_NOT_CLEAN
    assert decision.failure_code == "session_ownership_invalid"
async def test_transferred_loser_not_ended_fails_closed(env: Env) -> None:
    await _install_resolution(
        env, winner_role="candidate",
        winner_kwargs={"ended": False},
        loser_kwargs={
            "ended": False,
            "ownership_state": "activation_conflict",
            "validity": "invalid",
            "validity_reason": "activation_conflict_loser",
        },
    )
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.result == RESULT_NOT_CLEAN
    assert decision.failure_code == "session_unexpected_nonterminal"
async def test_transferred_loser_not_marked_invalid_fails_closed(env: Env) -> None:
    await _install_resolution(
        env, winner_role="candidate",
        winner_kwargs={"ended": False},
        loser_kwargs={"ended": True, "ownership_state": "activation_conflict"},
    )
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.result == RESULT_NOT_CLEAN
    assert decision.failure_code == "session_invalid_marker_mismatch"
async def test_transferred_loser_missing_fails_closed(env: Env) -> None:
    await _install_resolution(
        env, winner_role="candidate",
        winner_kwargs={"ended": False},
        loser_kwargs={"missing": True},
    )
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.result == RESULT_NOT_CLEAN
    assert decision.failure_code == "session_missing"
# --------------------------------------------------------------------------- #
# Review round 2: exact child payload identity (problem 3)
# --------------------------------------------------------------------------- #


async def test_original_child_payload_hash_mismatch_fails_closed(env: Env) -> None:
    op = "op-hash"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1",
                        operation_id=op, state="claiming")
        _insert_operation(conn, operation_id=op, kind="start", phase="claimed", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
        _insert_envelope(conn, command_id=op, space_id="space-a", session_id="fs-1",
                         payload_hash="1" * 64)
        _insert_receipt(conn, command_id=op, state="succeeded")
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "child_payload_hash_mismatch"


async def test_named_child_payload_hash_mismatch_fails_closed(env: Env) -> None:
    op = "op-hash2"
    pair = _pair("space-a", "fs-1", "space-b", "fs-2")
    candidate_child = derive_active_session_child_operation_id(op, ActiveSessionChildRole.CANDIDATE)
    active_child = derive_active_session_child_operation_id(op, ActiveSessionChildRole.ACTIVE)
    candidate_hash = canonical_payload_hash({"role": "candidate", "command_id": candidate_child})
    active_hash = canonical_payload_hash({"role": "active", "command_id": active_child})
    children = {
        "candidate": {"operation_id": candidate_child, "payload_hash": candidate_hash},
        "active": {"operation_id": active_child, "payload_hash": active_hash},
    }
    intent = _make_intent(
        operation_id=op, kind="activate_provisional",
        space_id="space-a", session_id="fs-1", epoch=1,
        business={"cached_at": "2026-07-15T07:59:00.000Z"},
        pair=pair, children=children,
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1",
                        operation_id=op, state="claiming")
        _insert_operation(conn, operation_id=op, kind="activate_provisional",
                          phase="awaiting_resolution", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a",
                        ended=False, ownership_state="activation_conflict")
        _insert_envelope(conn, command_id=active_child, space_id="space-a",
                         session_id="fs-1", payload_hash=active_hash)
        _insert_receipt(conn, command_id=active_child, state="succeeded")
    with sqlite3.connect(env.spaces["space-b"]) as conn:
        _insert_session(conn, session_id="fs-2", space_id="space-b",
                        ended=False, ownership_state="activation_conflict")
        _insert_envelope(conn, command_id=candidate_child, space_id="space-b",
                         session_id="fs-2", payload_hash="2" * 64)
        _insert_receipt(conn, command_id=candidate_child, state="succeeded")
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.result == RESULT_NOT_CLEAN
    assert decision.failure_code == "child_payload_hash_mismatch"
async def test_string_only_children_declaration_fails_closed(env: Env) -> None:
    op = "op-legacy"
    pair = _pair("space-a", "fs-1", "space-b", "fs-2")
    intent = _make_intent(
        operation_id=op, kind="activate_provisional",
        space_id="space-a", session_id="fs-1", epoch=1,
        business={"cached_at": "2026-07-15T07:59:00.000Z"},
        pair=pair,
        children={
            "candidate": derive_active_session_child_operation_id(op, ActiveSessionChildRole.CANDIDATE),
            "active": derive_active_session_child_operation_id(op, ActiveSessionChildRole.ACTIVE),
        },
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1",
                        operation_id=op, state="claiming")
        _insert_operation(conn, operation_id=op, kind="activate_provisional",
                          phase="claimed", intent=intent)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "children_declaration_invalid"


# --------------------------------------------------------------------------- #
# Review round 2: relation chain (problem 4)
# --------------------------------------------------------------------------- #


def _insert_chain_operation(
    conn: sqlite3.Connection, *, operation_id: str, related: str | None
) -> None:
    intent = _make_intent(
        operation_id=operation_id, kind="start", space_id="space-a",
        session_id="fs-1", epoch=1,
        business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    _insert_operation(conn, operation_id=operation_id, kind="start",
                      phase="completed", intent=intent, related=related)


async def test_relation_single_level_chain_passes(env: Env) -> None:
    op = "op-root"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op)
        _insert_operation(conn, operation_id=op, kind="start", phase="completed",
                          intent=intent, related="op-child-1")
        _insert_chain_operation(conn, operation_id="op-child-1", related=None)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_ACTIVE_CONSISTENT
    assert decision.result == RESULT_CLEAN_OR_RECOVERABLE
    assert decision.failure_code is None


async def test_relation_multi_level_chain_passes(env: Env) -> None:
    op = "op-root"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op)
        _insert_operation(conn, operation_id=op, kind="start", phase="completed",
                          intent=intent, related="op-c1")
        _insert_chain_operation(conn, operation_id="op-c1", related="op-c2")
        _insert_chain_operation(conn, operation_id="op-c2", related=None)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_ACTIVE_CONSISTENT
    assert decision.failure_code is None


async def test_relation_multi_node_cycle_fails_closed(env: Env) -> None:
    op = "op-root"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op)
        _insert_operation(conn, operation_id=op, kind="start", phase="completed",
                          intent=intent, related="op-c1")
        _insert_chain_operation(conn, operation_id="op-c1", related=op)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "relation_cycle"


async def test_relation_child_space_mismatch_fails_closed(env: Env) -> None:
    op = "op-root"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    child_intent = _make_intent(
        operation_id="op-c1", kind="start", space_id="space-b", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op)
        _insert_operation(conn, operation_id=op, kind="start", phase="completed",
                          intent=intent, related="op-c1")
        _insert_operation(conn, operation_id="op-c1", kind="start", phase="completed",
                          intent=child_intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "relation_invalid"


async def test_relation_child_session_mismatch_fails_closed(env: Env) -> None:
    op = "op-root"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    child_intent = _make_intent(
        operation_id="op-c1", kind="start", space_id="space-a", session_id="fs-other",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op)
        _insert_operation(conn, operation_id=op, kind="start", phase="completed",
                          intent=intent, related="op-c1")
        _insert_operation(conn, operation_id="op-c1", kind="start", phase="completed",
                          intent=child_intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "relation_invalid"


async def test_relation_chain_beyond_depth_fails_closed(env: Env) -> None:
    op = "op-0"
    intent = _make_intent(
        operation_id=op, kind="start", space_id="space-a", session_id="fs-1",
        epoch=1, business={"planned_seconds": 1500, "owner_device_id": "device-1"},
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1", operation_id=op)
        _insert_operation(conn, operation_id=op, kind="start", phase="completed",
                          intent=intent, related="op-1")
        for index in range(1, 10):
            _insert_chain_operation(
                conn, operation_id=f"op-{index}",
                related=None if index == 9 else f"op-{index + 1}",
            )
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a", ended=False)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "relation_invalid"


# --------------------------------------------------------------------------- #
# Review round 2: legacy relation binding must not compare child to parent id
# --------------------------------------------------------------------------- #


async def test_verify_child_derivation_uses_shared_contract() -> None:
    """The authority derivation check passes exactly the IDs produced by the
    shared public contract and rejects every other ID (mismatch)."""
    from app.focus_session.child_operations import (
        ActiveSessionChildRole,
        derive_active_session_child_operation_id,
    )
    from app.focus_session.recovery_authority import _verify_child_derivation

    parent = "op-parent"
    intent: dict[str, object] = {
        "children": {
            "candidate": {
                "operation_id": derive_active_session_child_operation_id(
                    parent, ActiveSessionChildRole.CANDIDATE
                ),
                "payload_hash": "a" * 64,
            },
            "active": {
                "operation_id": derive_active_session_child_operation_id(
                    parent, ActiveSessionChildRole.ACTIVE
                ),
                "payload_hash": "a" * 64,
            },
            "winner": {
                "operation_id": derive_active_session_child_operation_id(
                    parent, ActiveSessionChildRole.WINNER
                ),
                "payload_hash": "a" * 64,
            },
            "loser": {
                "operation_id": derive_active_session_child_operation_id(
                    parent, ActiveSessionChildRole.LOSER
                ),
                "payload_hash": "a" * 64,
            },
        }
    }
    assert _verify_child_derivation(parent, intent, ("candidate", "active")) is None
    assert _verify_child_derivation(parent, intent, ("winner", "loser")) is None
    # a well-formed but non-derived ID fails with the mismatch code
    intent["children"]["candidate"]["operation_id"] = "childp:9:op-parent:other"
    assert (
        _verify_child_derivation(parent, intent, ("candidate", "active"))
        == "child_id_derivation_mismatch"
    )


async def test_named_child_forged_success_fails_closed_at_entry(env: Env) -> None:
    """Entry-level: forged terminal-success envelopes+receipts whose child IDs
    are NOT the deterministic derivations of the parent operation are rejected
    by the full inspect_read_only flow (child_id_derivation_mismatch)."""
    op = "op-provisional"
    pair = _pair("space-a", "fs-1", "space-b", "fs-2")
    # forged: plausible-looking but non-derived IDs
    candidate_child = "childp:9:op-provisional:conflict:forged"
    active_child = "childp:9:op-provisional:conflict:forged-2"
    candidate_hash = canonical_payload_hash({"role": "candidate", "command_id": candidate_child})
    active_hash = canonical_payload_hash({"role": "active", "command_id": active_child})
    children = {
        "candidate": {"operation_id": candidate_child, "payload_hash": candidate_hash},
        "active": {"operation_id": active_child, "payload_hash": active_hash},
    }
    intent = _make_intent(
        operation_id=op, kind="activate_provisional",
        space_id="space-a", session_id="fs-1", epoch=1,
        business={"cached_at": "2026-07-15T07:59:00.000Z"},
        pair=pair, children=children,
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1",
                        operation_id=op, state="claiming")
        _insert_operation(conn, operation_id=op, kind="activate_provisional",
                          phase="awaiting_resolution", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a",
                        ended=False, ownership_state="activation_conflict")
        _insert_envelope(conn, command_id=active_child, space_id="space-a",
                         session_id="fs-1", payload_hash=active_hash)
        _insert_receipt(conn, command_id=active_child, state="succeeded")
    with sqlite3.connect(env.spaces["space-b"]) as conn:
        _insert_session(conn, session_id="fs-2", space_id="space-b",
                        ended=False, ownership_state="activation_conflict")
        _insert_envelope(conn, command_id=candidate_child, space_id="space-b",
                         session_id="fs-2", payload_hash=candidate_hash)
        _insert_receipt(conn, command_id=candidate_child, state="succeeded")
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.result == RESULT_NOT_CLEAN
    assert decision.failure_code == "child_id_derivation_mismatch"


async def test_named_child_cross_parent_replay_rejected(env: Env) -> None:
    """A child derived for ANOTHER parent operation (cross-parent replay) must
    never pass the derivation check at the inspect entry."""
    op = "op-provisional"
    other_parent = "op-other-parent"
    pair = _pair("space-a", "fs-1", "space-b", "fs-2")
    candidate_child = derive_active_session_child_operation_id(other_parent, ActiveSessionChildRole.CANDIDATE)
    active_child = derive_active_session_child_operation_id(other_parent, ActiveSessionChildRole.ACTIVE)
    candidate_hash = canonical_payload_hash({"role": "candidate", "command_id": candidate_child})
    active_hash = canonical_payload_hash({"role": "active", "command_id": active_child})
    children = {
        "candidate": {"operation_id": candidate_child, "payload_hash": candidate_hash},
        "active": {"operation_id": active_child, "payload_hash": active_hash},
    }
    intent = _make_intent(
        operation_id=op, kind="activate_provisional",
        space_id="space-a", session_id="fs-1", epoch=1,
        business={"cached_at": "2026-07-15T07:59:00.000Z"},
        pair=pair, children=children,
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1",
                        operation_id=op, state="claiming")
        _insert_operation(conn, operation_id=op, kind="activate_provisional",
                          phase="awaiting_resolution", intent=intent)
    with sqlite3.connect(env.spaces["space-a"]) as conn:
        _insert_session(conn, session_id="fs-1", space_id="space-a",
                        ended=False, ownership_state="activation_conflict")
        _insert_envelope(conn, command_id=active_child, space_id="space-a",
                         session_id="fs-1", payload_hash=active_hash)
        _insert_receipt(conn, command_id=active_child, state="succeeded")
    with sqlite3.connect(env.spaces["space-b"]) as conn:
        _insert_session(conn, session_id="fs-2", space_id="space-b",
                        ended=False, ownership_state="activation_conflict")
        _insert_envelope(conn, command_id=candidate_child, space_id="space-b",
                         session_id="fs-2", payload_hash=candidate_hash)
        _insert_receipt(conn, command_id=candidate_child, state="succeeded")
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "child_id_derivation_mismatch"


async def test_named_child_arbitrary_operation_id_rejected(env: Env) -> None:
    """A plausible-looking but arbitrary operation ID must never be accepted
    merely because it is a well-formed ASCII identifier."""
    op = "op-provisional"
    pair = _pair("space-a", "fs-1", "space-b", "fs-2")
    children = {
        "candidate": {"operation_id": "random-op-123", "payload_hash": "a" * 64},
        "active": {"operation_id": "another-op-456", "payload_hash": "a" * 64},
    }
    intent = _make_intent(
        operation_id=op, kind="activate_provisional",
        space_id="space-a", session_id="fs-1", epoch=1,
        business={"cached_at": "2026-07-15T07:59:00.000Z"},
        pair=pair, children=children,
    )
    with sqlite3.connect(env.meta_db) as conn:
        _insert_locator(conn, space_id="space-a", session_id="fs-1",
                        operation_id=op, state="claiming")
        _insert_operation(conn, operation_id=op, kind="activate_provisional",
                          phase="awaiting_resolution", intent=intent)
    decision = await _inspect(env)
    assert decision.classification == CLASSIFICATION_RECOVERY_REQUIRED
    assert decision.failure_code == "child_id_derivation_mismatch"
