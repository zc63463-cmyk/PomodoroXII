"""Focused red tests for immutable command reconciliation."""

from types import SimpleNamespace

import pytest

from app.errors import AppError
from app.focus_session.command_reconciler import SessionCommandReconciler
from app.focus_session.commands import focus_business_payload
from app.focus_session.contracts import FocusSessionCommand
from app.focus_session.receipts import receipt_view
from app.mutation.types import canonical_payload_hash


def _command(*, root: str = "root-1", replay_safe: bool = True) -> FocusSessionCommand:
    payload = {
        "command_ids": ["cmd-a", "cmd-b"],
        "replay_safe": replay_safe,
        "abandon_command_ids": [],
        "decision_at": None,
    }
    return FocusSessionCommand(
        command_id=root,
        space_id="space-1",
        session_id="session-1",
        ownership_epoch=None,
        payload_hash=canonical_payload_hash(
            focus_business_payload("reconcile_commands", payload)
        ),
        payload=payload,
    )


class _Query:
    def __init__(self) -> None:
        self.receipts = {}

    async def selected_envelopes_by_ids(self, scope, session_id, command_ids):
        return tuple(
            SimpleNamespace(
                command_id=command_id,
                space_id="space-1",
                session_id=session_id,
                work_item_id=f"wi-{command_id}",
                expected_version=1,
                target_transition="complete",
                replay_safe=True,
                payload_hash=canonical_payload_hash({"status_definition_id": "sys-status-completed"}),
                created_at="2026-08-04T08:00:00Z",
                session_revision=1,
            )
            for command_id in command_ids
        )

    async def receipt(self, scope, command_id):
        return self.receipts.get(command_id)

    async def load(self, scope, session_id):
        return {
            "session": {
                "id": session_id,
                "startedAt": "2026-08-04T08:00:00Z",
                "pauseStartedAt": None,
                "endedAt": "2026-08-04T08:10:00Z",
            }
        }


class _Stored:
    def __init__(self) -> None:
        self.outcomes = {}
        self.calls = []

    async def query_original(self, scope, command_id, expected_request):
        self.calls.append(command_id)
        return self.outcomes.get(command_id)


class _TaskSpace:
    def __init__(self) -> None:
        self.calls = []

    async def execute(self, scope, command):
        self.calls.append(command.command_id)
        return SimpleNamespace(command_id=command.command_id, value={"ok": True})


class _Writer:
    def __init__(self) -> None:
        self.calls = []

    async def record_pending(self, scope, envelope):
        self.calls.append(("pending", envelope.command_id))
        return {"commandId": envelope.command_id, "state": "pending"}

    async def record(self, scope, envelope, outcome, *, expected_coordination=None):
        self.calls.append(("record", envelope.command_id, outcome, expected_coordination))
        return {"commandId": envelope.command_id, "state": "succeeded"}


@pytest.mark.asyncio
async def test_unknown_queries_original_before_replay() -> None:
    query = _Query()
    stored = _Stored()
    task_space = _TaskSpace()
    writer = _Writer()
    reconciler = SessionCommandReconciler(task_space, stored, writer, query)
    stored.outcomes["cmd-a"] = SimpleNamespace(command_id="cmd-a", value={"original": True})
    admission = {
        "ordered_command_ids": ["cmd-a", "cmd-b"],
        "decisions": {
            "cmd-a": {"kind": "observe", "receipt_state": "pending"},
            "cmd-b": {"kind": "observe", "receipt_state": "pending"},
        },
    }

    await reconciler.reconcile(SimpleNamespace(scope=SimpleNamespace(space_id="space-1")), _command(), admission=admission)

    assert task_space.calls == []
    assert writer.calls[0][0:2] == ("record", "cmd-a")
    assert writer.calls[1] == ("pending", "cmd-b")


@pytest.mark.asyncio
async def test_replay_requires_exact_claim_and_double_permission() -> None:
    query = _Query()
    stored = _Stored()
    task_space = _TaskSpace()
    writer = _Writer()
    reconciler = SessionCommandReconciler(task_space, stored, writer, query)
    query.receipts = {
        command_id: SimpleNamespace(
            command_id=command_id,
            state="pending",
            result_json='{"_reconcileCoordination":{"kind":"replay_claimed","rootCommandId":"root-1"}}',
        )
        for command_id in ("cmd-a", "cmd-b")
    }
    admission = {
        "ordered_command_ids": ["cmd-a", "cmd-b"],
        "decisions": {
            command_id: {"kind": "replay_claimed", "root_command_id": "root-1"}
            for command_id in ("cmd-a", "cmd-b")
        },
    }

    await reconciler.reconcile(SimpleNamespace(scope=SimpleNamespace(space_id="space-1")), _command(replay_safe=True), admission=admission)

    assert task_space.calls == ["cmd-a", "cmd-b"]
    assert [call[0] for call in writer.calls] == ["record", "record"]


@pytest.mark.asyncio
async def test_abandoned_receipt_queries_stored_terminal_truth_before_short_circuit() -> None:
    query = _Query()
    stored = _Stored()
    task_space = _TaskSpace()
    writer = _Writer()
    reconciler = SessionCommandReconciler(task_space, stored, writer, query)
    query.receipts = {
        "cmd-a": SimpleNamespace(
            command_id="cmd-a",
            state="abandoned",
            error_code=None,
            retryable=False,
            details_json=None,
            result_json='{"decision":"abandoned"}',
            updated_at="2026-08-04T08:00:00Z",
        )
    }
    stored.outcomes["cmd-a"] = SimpleNamespace(command_id="cmd-a", value={"original": True})
    admission = {
        "ordered_command_ids": ["cmd-a", "cmd-b"],
        "decisions": {
            "cmd-a": {"kind": "abandoned", "root_command_id": "root-1", "decision_at": "2026-08-04T08:00:00Z"},
            "cmd-b": {"kind": "observe", "receipt_state": "pending"},
        },
    }

    with pytest.raises(AppError) as captured:
        await reconciler.reconcile(
            SimpleNamespace(scope=SimpleNamespace(space_id="space-1")),
            _command(),
            admission=admission,
        )

    assert captured.value.code == "active_session_recovery_required"
    assert stored.calls == ["cmd-a"]
